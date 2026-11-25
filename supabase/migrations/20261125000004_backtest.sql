-- Research only: backtest results for SL/target variants A–D (no live effect).
create table public.backtest_trades (
  id bigint generated always as identity primary key,
  variant text not null check (variant in ('A', 'B', 'C', 'D')),
  date date not null, side text not null, b_time text not null,
  status text not null check (status in ('SKIPPED', 'CANCELLED', 'TARGET', 'SL', 'TIME_EXIT')),
  reason text,
  trigger double precision, sl double precision, target double precision, r double precision, spec_r double precision,
  entry_time text, exit_time text, exit_price double precision, r_mult double precision, pnl_pts double precision,
  run_at timestamptz not null default now()
);
create index backtest_trades_variant_date on public.backtest_trades (variant, date);
alter table public.backtest_trades enable row level security;
create policy "owner reads" on public.backtest_trades for select to authenticated using ((select public.is_owner()));
