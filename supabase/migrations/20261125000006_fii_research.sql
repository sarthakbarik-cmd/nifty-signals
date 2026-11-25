-- Research only: NSE end-of-day participant-wise OI (FII etc.) and Nifty daily OHLC from NSE archives.
create table public.participant_oi (
  date date not null, client_type text not null,
  fut_idx_long bigint, fut_idx_short bigint, fut_stk_long bigint, fut_stk_short bigint,
  opt_idx_call_long bigint, opt_idx_put_long bigint, opt_idx_call_short bigint, opt_idx_put_short bigint,
  primary key (date, client_type)
);
create table public.nifty_eod (date date primary key, o double precision, h double precision, l double precision, c double precision);
alter table public.participant_oi enable row level security;
alter table public.nifty_eod enable row level security;
create policy "owner reads" on public.participant_oi for select to authenticated using ((select public.is_owner()));
create policy "owner reads" on public.nifty_eod for select to authenticated using ((select public.is_owner()));
create table private.fetch_queue (req_id bigint primary key, kind text not null, date date not null);
