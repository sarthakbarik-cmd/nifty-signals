-- Research only: trades priced with real expired-option candles (Upstox Plus). test = naked | spread | condor.
create table public.option_bt (
  id bigint generated always as identity primary key,
  test text not null, date date not null, expiry date, side text, status text not null, reason text,
  entry_time text, exit_day date, exit_time text, legs jsonb, entry_value double precision, exit_value double precision,
  pnl_rs double precision, extra jsonb, run_at timestamptz not null default now()
);
create index option_bt_test_date on public.option_bt (test, date);
alter table public.option_bt enable row level security;
create policy "owner reads" on public.option_bt for select to authenticated using ((select public.is_owner()));
