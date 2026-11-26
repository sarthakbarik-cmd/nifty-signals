-- Research only: Opening Range Breakout variants H (every day) and I (narrow-CPR days).
alter table public.backtest_trades drop constraint backtest_trades_variant_check;
alter table public.backtest_trades add constraint backtest_trades_variant_check check (variant in ('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'));
