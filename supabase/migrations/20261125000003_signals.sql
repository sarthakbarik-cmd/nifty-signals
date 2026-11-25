-- Phase 3: signals + the 15-minute candle-close scan. SIGNALS ONLY (paper; no orders).
create table public.signals (
  id bigint generated always as identity primary key,
  date date not null,
  b_time text not null,                         -- signal candle (B) start, IST HH:MM
  side text not null check (side in ('CE', 'PE')),
  status text not null check (status in ('PENDING', 'TRIGGERED', 'CANCELLED', 'SKIPPED', 'TARGET', 'SL', 'TIME_EXIT')),
  reason text,
  trigger double precision not null,
  sl double precision not null,
  target double precision not null,
  r double precision not null,
  valid_until text,
  strike double precision, expiry date, option_key text, delta double precision, ltp double precision,
  prem_sl double precision, prem_target double precision,
  lot_size int, lots int, risk_rs double precision,
  triggered_at text,
  -- Phase 4 (paper fills / exits)
  entry_premium double precision, exit_premium double precision, exit_reason text, closed_at text, pnl_rs double precision,
  details jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (date, b_time)                          -- one decision per signal candle
);
create index signals_date_idx on public.signals (date desc);

alter table public.signals enable row level security;
create policy "owner reads" on public.signals for select to authenticated using ((select public.is_owner()));

-- Scan after every 15-min candle close: 09:31 … 15:16 IST = 04:01 … 09:46 UTC, Mon–Fri.
select cron.schedule('candle_scan', '1,16,31,46 4-9 * * 1-5', $$ select private.call_api('candle_scan') $$);
