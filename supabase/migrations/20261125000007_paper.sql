-- Phase 4: paper trading (main plan = variant B) + background (shadow) variants. SIGNALS ONLY (paper; no orders).
create table public.shadow_trades (like public.backtest_trades including all);
alter table public.shadow_trades enable row level security;
create policy "owner reads" on public.shadow_trades for select to authenticated using ((select public.is_owner()));

-- Call any of our Edge Functions with the scheduler secret.
create or replace function private.call_fn(p_fn text, p_action text)
returns bigint language sql security definer set search_path = '' as $$
  select net.http_post(
    url := (select value->>'project_url' from public.app_config where key = 'app') || '/functions/v1/' || p_fn,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := jsonb_build_object('action', p_action),
    timeout_milliseconds := 150000);
$$;
revoke all on function private.call_fn(text, text) from public, anon, authenticated;

-- 15-min scan moves to the `paper` function; 1-min tracker (exits fast when nothing is open);
-- evening background variants + paper summary at 15:55 IST (after the 15:45 job stored today's candles).
select cron.schedule('candle_scan', '1,16,31,46 4-9 * * 1-5', $$ select private.call_fn('paper', 'candle_scan') $$);
select cron.schedule('track', '* 4-9 * * 1-5', $$ select private.call_fn('paper', 'track') $$);
select cron.schedule('paper_eod', '25 10 * * 1-5', $$ select private.call_fn('paper', 'paper_eod') $$);

-- Main plan = variant B (ATR stop), paper mode, ₹2,000 daily paper-loss limit, ₹60 costs per trade.
update public.app_config set value = value || jsonb_build_object(
  'sl_mode', 'atr', 'paper_mode', true, 'daily_loss_limit_rs', 2000, 'cost_per_trade', 60, 'paper_start', '2026-11-26'),
  updated_at = now() where key = 'settings';
