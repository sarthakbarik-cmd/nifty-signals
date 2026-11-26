-- Research only: quick +10 premium target on B's signals. L: SL 10 premium; M: B's ATR stop.
alter table public.backtest_trades drop constraint backtest_trades_variant_check;
alter table public.backtest_trades add constraint backtest_trades_variant_check check (variant in ('A','B','C','D','E','F','G','H','I','J','K','L','M'));
