-- Research only: quick-trade variants J (no SL) and K (SL −25 premium).
alter table public.backtest_trades drop constraint backtest_trades_variant_check;
alter table public.backtest_trades add constraint backtest_trades_variant_check check (variant in ('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'));
