-- Practice (paper) trading + real-account discipline watcher. The app still NEVER places real orders;
-- the watcher only reads positions and switches Upstox's Kill Switch for NSE_FO/BSE_FO.
create table public.practice_trades (
  id bigint generated always as identity primary key,
  date date not null, underlying text not null, instrument_key text not null, symbol text, side text, strike double precision, expiry date,
  lots int not null, lot_size int not null, qty int not null,
  entry_at timestamptz not null, entry_price double precision not null,
  sl_pts double precision not null, tgt_pts double precision not null, sl_price double precision not null, target_price double precision not null,
  trail boolean not null default false, high_water double precision, last_price double precision,
  status text not null default 'OPEN' check (status in ('OPEN', 'SL', 'TARGET', 'CAP', 'TRAIL', 'BREAKEVEN', 'MANUAL', 'TIME')),
  exit_at timestamptz, exit_price double precision, pnl_rs double precision,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index practice_trades_date on public.practice_trades (date desc);
alter table public.practice_trades enable row level security;
create policy "owner reads" on public.practice_trades for select to authenticated using ((select public.is_owner()));

-- Watcher limits (owner's choice): −₹3,000 loss / +₹1,500 target → lock F&O; unlock next trading morning.
update public.app_config set value = value || jsonb_build_object('guard_enabled', true, 'guard_loss', 3000, 'guard_target', 1500,
  'practice_rules', jsonb_build_object('loss_limit', 3000, 'per_trade_cap', 1500, 'max_trades', 3, 'cooldown_min', 30)), updated_at = now()
where key = 'settings';

-- Every minute 09:00–15:59 IST (03:30–10:29 UTC) on weekdays; the function checks the exact window and holidays.
select cron.schedule('guard', '* 3-10 * * 1-5', $$ select private.call_fn('trader', 'guard') $$);
