# Phase 3 — signal rules (approved by owner, 25 Nov 2026)

Interpretation of spec §6–7 used by `supabase/functions/_shared/strategy.ts`. Every parameter
comes from `app_config.settings` (capital, risk_pct, max_trades, max_sl_pts, gap_pct,
gap_wait_until, no_trade_band, entry_start, entry_end, ema_fast, ema_slow, ema_touch_pct,
trigger_buffer, sl_buffer, target_r). CE rules below; PE is the exact mirror.

## When
1. Scan after every 15-min candle close: 09:31, 09:46 … 15:16 IST (pg_cron `candle_scan`).
   EMA20/EMA50 run continuously across days on 15-min closes (seeded with an SMA; ≥10 days history).
2. Signal candle **B** = the last closed candle. Its close time must be 09:30–14:30.

## Filters
3. Bias from B's close: above CPR top → CE only; below CPR bottom → PE only. Inside CPR, or within
   ±no_trade_band of PDC → no signal.
4. Gap: |today's 09:15 open − PDC| / PDC > gap_pct % → no signal candle closing before gap_wait_until (10:00).

## Setup
5. Trend: EMA20 > EMA50, EMA20 > EMA20 three candles earlier, B.close > EMA50.
6. Pullback A = the 3 candles before B: at least one low ≤ EMA20 × (1 + ema_touch_pct); none of A nor B
   closed below EMA50.
7. Confirmation B: green, and close in the top third of its range OR bullish engulfing
   (previous candle red, B.open ≤ prev.close and B.close ≥ prev.open).
8. Trigger = B.high + trigger_buffer. SL = lowest low of A − sl_buffer. R = trigger − SL.
   Target = trigger + target_r × R.

## Skips (signal stored + Telegram, status SKIPPED with reason)
9. R > max_sl_pts → "SL too wide".
10. Nearest level above the trigger (PDH, R1, R2, max call-OI strike, CPR edges) closer than target_r × R
    → "no room". No level above → passes.
11. Strike: ATM (nearest strike to spot) on the trade expiry; if |delta| < 0.5 use 1 strike ITM.
    Premium SL = LTP − R×|delta|, premium target = LTP + target_r×R×|delta|.
    Lots = floor(capital × risk_pct% ÷ (R × |delta| × lot_size)); 0 → "risk too high for 1 lot".
    Also SKIPPED: outside 09:30–14:30, gap rule, max trades reached, another signal pending/open.

## Lifecycle (Phase 3 part)
12. PENDING → at the next scan, if the next 15-min candle's high ≥ trigger (PE: low ≤ trigger) →
    TRIGGERED, else CANCELLED. Max `max_trades` triggered per day; one pending/open signal at a time.
    SL / target / 15:15 exit on 1-min candles and paper P&L are Phase 4 — until then a TRIGGERED
    signal stays open for the rest of the day (so no further signals that day).
13. Telegram for PENDING (spec format), TRIGGERED, CANCELLED and SKIPPED setups. Nothing when no setup forms.
14. Dashboard "Signals" tab. 15. Unit tests for CE and PE and every skip reason.
