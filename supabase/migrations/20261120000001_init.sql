-- Nifty signal app — Phases 1–2 schema (Supabase).
-- SIGNALS ONLY: nothing here (or anywhere in the app) places orders.
--
-- public.*   tables the owner's dashboard can READ (RLS: owner only)
-- private.*  server-only state (Upstox token, OAuth state, owner) — not exposed by the API
-- Edge Functions use the service role and SECURITY DEFINER RPCs that only service_role may execute.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ------------------------------------------------------------------ private state
create table private.owner (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

create table private.upstox_token (
  id int primary key default 1 check (id = 1),
  token text not null,
  expires_at timestamptz not null,
  issued_at timestamptz not null default now()
);

create table private.oauth_state (
  id int primary key default 1 check (id = 1),
  state text not null,
  user_id uuid not null,
  expires_at timestamptz not null
);

-- ------------------------------------------------------------------ owner check (used by RLS)
create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.owner o where o.user_id = (select auth.uid()));
$$;
revoke all on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated, service_role;

-- ------------------------------------------------------------------ public tables
create table public.app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
comment on table public.app_config is
  'settings (owner-editable rule params), upstox_status, holidays, instruments, app (dashboard_url, redirect_uri)';

create table public.candles_15m (
  date date primary key,
  instrument text not null,
  count int not null,
  candles jsonb not null,
  source text not null,
  fetched_at timestamptz not null default now()
);

create table public.candles_1m (like public.candles_15m including all);

create table public.candles_daily (
  date date primary key,
  instrument text not null,
  t text not null,
  o double precision not null,
  h double precision not null,
  l double precision not null,
  c double precision not null,   -- NSE official close (used as PDC)
  v bigint not null default 0,
  oi bigint not null default 0,
  source text not null,
  fetched_at timestamptz not null default now()
);

create table public.data_checks (
  date date primary key,
  status text not null check (status in ('ok', 'warn', 'error')),
  counts jsonb not null,
  daily jsonb,
  issues jsonb not null default '[]',
  levels_for date,
  checked_at timestamptz not null default now()
);

-- Levels FOR the session `date`, computed from the daily candle of `based_on`.
create table public.levels (
  date date primary key,
  based_on date,
  p double precision, bc double precision, tc double precision,
  r1 double precision, r2 double precision, s1 double precision, s2 double precision,
  pdh double precision, pdl double precision, pdc double precision,
  cpr_width double precision,
  no_trade jsonb,
  -- filled at 09:20 from the option chain
  max_call_oi double precision, max_call_oi_oi bigint,
  max_put_oi double precision, max_put_oi_oi bigint,
  call_oi_top jsonb, put_oi_top jsonb,
  oi_expiry date, oi_spot double precision, oi_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.logs (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  job text not null,
  level text not null check (level in ('info', 'warn', 'error')),
  message text not null,
  data jsonb not null default '{}'
);
create index logs_ts_idx on public.logs (ts desc);

-- ------------------------------------------------------------------ RLS: owner reads, server writes
alter table public.app_config    enable row level security;
alter table public.candles_15m   enable row level security;
alter table public.candles_1m    enable row level security;
alter table public.candles_daily enable row level security;
alter table public.data_checks   enable row level security;
alter table public.levels        enable row level security;
alter table public.logs          enable row level security;

create policy "owner reads config" on public.app_config for select to authenticated
  using ((select public.is_owner()));
create policy "owner edits settings" on public.app_config for update to authenticated
  using ((select public.is_owner()) and key = 'settings')
  with check ((select public.is_owner()) and key = 'settings');

create policy "owner reads" on public.candles_15m   for select to authenticated using ((select public.is_owner()));
create policy "owner reads" on public.candles_1m    for select to authenticated using ((select public.is_owner()));
create policy "owner reads" on public.candles_daily for select to authenticated using ((select public.is_owner()));
create policy "owner reads" on public.data_checks   for select to authenticated using ((select public.is_owner()));
create policy "owner reads" on public.levels        for select to authenticated using ((select public.is_owner()));
create policy "owner reads" on public.logs          for select to authenticated using ((select public.is_owner()));

-- ------------------------------------------------------------------ server-only RPCs (service_role)
create or replace function public.srv_is_owner(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.owner where user_id = uid);
$$;

create or replace function public.srv_get_token()
returns text language sql stable security definer set search_path = '' as $$
  select token from private.upstox_token where expires_at > now();
$$;

create or replace function public.srv_save_token(p_token text, p_expires_at timestamptz)
returns void language sql security definer set search_path = '' as $$
  insert into private.upstox_token (id, token, expires_at, issued_at) values (1, p_token, p_expires_at, now())
  on conflict (id) do update set token = excluded.token, expires_at = excluded.expires_at, issued_at = now();
$$;

create or replace function public.srv_save_oauth_state(p_state text, p_user uuid)
returns void language sql security definer set search_path = '' as $$
  insert into private.oauth_state (id, state, user_id, expires_at) values (1, p_state, p_user, now() + interval '10 minutes')
  on conflict (id) do update set state = excluded.state, user_id = excluded.user_id, expires_at = excluded.expires_at;
$$;

-- One-time use: always deletes the pending state; true only if it matched and was unexpired.
create or replace function public.srv_consume_oauth_state(p_state text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare ok boolean;
begin
  delete from private.oauth_state
   where id = 1
   returning (state = p_state and expires_at > now()) into ok;
  return coalesce(ok, false) and coalesce(p_state, '') <> '';
end;
$$;

-- The scheduler authenticates to the Edge Function with a random secret kept in Vault.
create or replace function public.srv_check_cron_secret(p_secret text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(p_secret, '') <> ''
     and exists (select 1 from vault.decrypted_secrets where name = 'cron_secret' and decrypted_secret = p_secret);
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'srv_is_owner(uuid)', 'srv_get_token()', 'srv_save_token(text, timestamptz)',
    'srv_save_oauth_state(text, uuid)', 'srv_consume_oauth_state(text)', 'srv_check_cron_secret(text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ------------------------------------------------------------------ scheduler (pg_cron runs in UTC)
-- cron_secret: random, generated inside the database; nobody ever types or sees it.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cron_secret', 'Edge Function auth for pg_cron jobs');

create or replace function private.call_api(p_action text)
returns bigint language sql security definer set search_path = '' as $$
  select net.http_post(
    url := (select value->>'project_url' from public.app_config where key = 'app') || '/functions/v1/api',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := jsonb_build_object('action', p_action),
    timeout_milliseconds := 150000
  );
$$;

-- 09:20 IST = 03:50 UTC; 15:45 IST = 10:15 UTC; Mon–Fri. Holidays are skipped inside the function.
select cron.schedule('premarket_check', '50 3 * * 1-5', $$ select private.call_api('premarket_check') $$);
select cron.schedule('daily_levels',   '15 10 * * 1-5', $$ select private.call_api('daily_levels') $$);
