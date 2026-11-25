-- Research only: allow "half and half" pullback variants E–G and store their extra details.
alter table public.backtest_trades drop constraint backtest_trades_variant_check;
alter table public.backtest_trades add constraint backtest_trades_variant_check check (variant in ('A', 'B', 'C', 'D', 'E', 'F', 'G'));
alter table public.backtest_trades add column extra jsonb;
