# Nifty Option-Buying Signal App — Phases 1–3 on Supabase

**Signals only.** Nothing here places, modifies or cancels orders. Upstox is used read-only
(login, profile, candles, holidays, option contracts, option chain). A unit test fails if any
order/GTT endpoint appears in the code.

| Part | Where it runs |
|---|---|
| Database (candles, levels, logs, settings) | Supabase Postgres, project `nifty-signals` (Mumbai, `ap-south-1`) |
| Scheduled jobs (09:20, 15:45 IST, Mon–Fri) | Supabase `pg_cron` → Edge Function `api` |
| Upstox login redirect | Edge Function `upstox-callback` |
| Dashboard | Static site in `docs/`, served by GitHub Pages |
| Secrets (Upstox key/secret, Telegram) | Supabase Edge Function secrets (never in code or the database) |

## Phase 3 — signals
- Rules exactly as approved in `PHASE3_RULES.md`; engine in `supabase/functions/_shared/strategy.ts`, scan in `scan.ts`.
- `candle_scan` runs after every 15-min close (09:31 … 15:16 IST). Each decision is logged with its reason;
  setups are stored in `signals` (PENDING → TRIGGERED / CANCELLED, or SKIPPED with reason) and sent to Telegram.
- Daily: 08:45 approval request → tap Approve; 09:20 plan; 15-min scans; 15:45 data check + next day's levels.

## Layout
```
supabase/
  migrations/20261120000001_init.sql   tables, owner-only RLS, private schema, scheduler
  functions/
    api/index.ts                       scheduled jobs + dashboard actions
    upstox-callback/index.ts           Upstox OAuth redirect target
    _shared/time.ts                    IST maths, trading days, session slots, token expiry
    _shared/candles.ts                 1m→15m roll-up, data checks
    _shared/levels.ts                  pivots/CPR/no-trade zone, max-OI strikes, trade-expiry rule
    _shared/upstox.ts                  read-only Upstox client (retry once; 401 → re-login)
    _shared/jobs.ts                    job logic (fetch, store, levels, premarket)
    _shared/store.ts                   all database reads/writes
    _shared/notify.ts                  Telegram
  tests/                               Deno unit tests (offline: fake store + fake Upstox)
docs/                                  dashboard (GitHub Pages)
```
`strategy.py` and `tracker.py` from the spec become `strategy.ts` and `tracker.ts` in Phases 3–4.

## Security model
- **Owner only.** Every table has row-level security. Only the user listed in `private.owner` can read it, and the browser can write only `app_config.settings`. All other writes come from the Edge Functions.
- **Private schema.** The Upstox token, the one-time OAuth state and the owner list live in `private.*`. The API never exposes that schema; the functions reach it only through `srv_*` functions that only the server role may run.
- **Scheduler authentication.** `pg_cron` calls the `api` function with a random secret that was generated inside the database and is kept in Supabase Vault. Nobody types it or sees it.
- **Dashboard actions.** The dashboard sends your Supabase login token, and the function checks that you are the owner.
- **Publishable key.** The key in `docs/config.js` is meant to be public. RLS protects the data.
- **Advisor warning.** Supabase's security advisor flags one intentional item: `public.is_owner()` can be called by signed-in users. It only answers "am I the owner?" for the caller.

## Database
| Table | Contents |
|---|---|
| `app_config` | key → JSON: `settings` (rule parameters, editable), `upstox_status`, `holidays`, `instruments` (lot size, expiries, trade expiry), `app` (URLs) |
| `candles_15m`, `candles_1m` | one row per day, `candles` JSON array of `{t,o,h,l,c,v,oi}` |
| `candles_daily` | daily OHLC; `c` is NSE's official close, used as PDC |
| `data_checks` | per-day validation report: `ok`, `warn` or `error`, plus the issues found |
| `levels` | levels **for** that session: p, bc, tc, r1, r2, s1, s2, pdh, pdl, pdc, cpr_width, no_trade; from 09:20 also max_call_oi, max_put_oi (+ OI, the top 3 strikes, the expiry used and the spot price) |
| `logs` | every job run and every error |

## Jobs
- **09:20 `premarket_check`**
  - Skips holidays.
  - Checks the Upstox token with a live call; if it's missing or invalid, sends a Telegram reminder.
  - Makes sure today's levels exist, recomputing them if 15:45 was missed.
  - Refreshes lot size and expiries.
  - Reads the option chain (current expiry) and stores the max call-OI and max put-OI strikes.
  - Sends Telegram: today's levels.
- **15:45 `daily_levels`**
  - Stores today's 15-min, 1-min and daily candles and validates them.
  - Computes the next trading day's levels.
  - Sends Telegram: the data check plus tomorrow's levels.

You can also run both from the dashboard. `daily_levels` only runs after 15:31.

## One-time setup (what only you can do)
1. **Owner account.** Supabase → Authentication → Users → *Add user*: your email and a password, with *Auto confirm* ticked. Then tell Claude, which links it as owner. Or run this yourself in the SQL editor: `insert into private.owner(user_id) select id from auth.users;`
2. **Turn off sign-ups.** Authentication → Sign In / Providers → turn off "Allow new users to sign up". RLS protects your data either way, but this keeps strangers from creating accounts.
3. **Secrets.** Supabase → Edge Functions → Secrets: add `UPSTOX_API_KEY`, `UPSTOX_API_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
4. **Upstox app.** In the Upstox developer console, set the Redirect URL to exactly:
   `https://ukqwwlxerebcnhpqhmkm.supabase.co/functions/v1/upstox-callback`
5. **GitHub Pages.** Repo → Settings → Pages → *Deploy from a branch* → `main` / `/docs`. Then set the dashboard URL in the database, so the Upstox login and Telegram can link back to it:
   `update app_config set value = value || '{"dashboard_url":"https://<user>.github.io/<repo>/"}' where key='app';`

## Daily use
- Before 09:20, open the dashboard, sign in, and tap **Login to Upstox**. The token expires at 03:30 IST every day.
- First run: **Data → Fetch candles** for the last 3–4 weeks. Longer ranges are split into 15-day pieces automatically. Then check **Today → Check the maths ✓**.

## Tests
```bash
cd supabase && deno test --allow-read tests/
```
37 tests cover:
- Levels against a hand calculation, and the BC/TC swap
- Max-OI tie-breaks
- The trade-expiry roll, including when a holiday moves the "day before"
- IST and token-expiry maths
- Candle validation: missing, duplicate, off-session, bad OHLC, feed mismatch
- The Upstox client: URLs, retry once, 401 handling, holiday filter, and a no-order-endpoint guard
- The job flows: chunked backfill, holiday skips, never overwriting good data with an empty response, OI merged without erasing pivots

## Limits to know
- **Edge Function CPU.** Each run gets 2 s of CPU (Supabase free plan), so one backfill call covers at most 15 days.
- **HTML pages.** Edge Functions can't serve web pages on the default domain. That's why the dashboard is on GitHub Pages and the Upstox callback redirects back to it.

## Phase 4 — paper trading (main plan = variant B)

- **Live rules:** Phase 3 setup, but SL = trigger ∓ ATR(14) of 15-min candles and target = 2R (variant B, chosen after the 12-month backtest).
- **Paper mode:** every signal is tracked at ≥ 1 lot even if real money would skip it (the alert says why under "Real money").
- **`paper` Edge Function** (pg_cron, scheduler secret): `candle_scan` after each 15-min close; `track` every minute
  (trigger → SL / target / 15:15 exit on 1-min candles, paper fills from the option's real 1-min prices); `paper_eod` at 15:55 IST
  (background variants A–G replayed on the day → `shadow_trades`, plus the evening Telegram summary).
- **Daily loss limit:** no new signals once today's paper loss ≥ `daily_loss_limit_rs` (₹2,000). Costs ₹60 per trade.
- Settings live in `app_config.settings` (`sl_mode`, `paper_mode`, `daily_loss_limit_rs`, `cost_per_trade`, `paper_start`).
- Dashboard **Results** tab: KPIs, closed paper trades, background variants vs the 12-month backtest.
- Research tables: `backtest_trades` (12-month backtest), `participant_oi` + `nifty_eod` (FII test — no next-day edge found).
