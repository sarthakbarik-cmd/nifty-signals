-- Level-2 auto-protect: the Oracle "executor" (fixed IP) + Dhan daily token. Secrets live only in the private schema.
create extension if not exists pgcrypto with schema extensions;

create table private.executors (
  id uuid primary key,
  secret_sha text not null,              -- sha256 hex of the executor's own random secret (never stored in clear)
  code text not null,                    -- 6-char pairing code shown on the server and on the dashboard
  ip text, version text,
  paired boolean not null default false,
  created_at timestamptz not null default now(), paired_at timestamptz, last_seen timestamptz
);

create table private.dhan_token (
  id int primary key default 1 check (id = 1),
  client_id text not null, token text not null, saved_at timestamptz not null default now(), expires_at timestamptz not null
);

-- Service-role-only RPCs (called from the `trader` Edge Function)
create or replace function public.srv_exec_hello(p_id uuid, p_secret_sha text, p_code text, p_ip text, p_version text)
returns text language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if exists (select 1 from private.executors where id = p_id) then
    update private.executors set ip = p_ip, version = p_version where id = p_id;
    return (select case when paired then 'paired' else 'pending' end from private.executors where id = p_id);
  end if;
  select count(*) into n from private.executors where not paired and created_at > now() - interval '10 minutes';
  if n >= 3 then return 'busy'; end if;
  delete from private.executors where not paired and created_at < now() - interval '1 day';
  insert into private.executors(id, secret_sha, code, ip, version) values (p_id, p_secret_sha, upper(p_code), p_ip, p_version);
  return 'pending';
end $$;

create or replace function public.srv_exec_auth(p_id uuid, p_secret text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare ok boolean;
begin
  update private.executors set last_seen = now()
   where id = p_id and paired and secret_sha = encode(extensions.digest(p_secret, 'sha256'), 'hex')
  returning true into ok;
  return coalesce(ok, false);
end $$;

create or replace function public.srv_exec_list()
returns table(id uuid, code text, ip text, version text, paired boolean, created_at timestamptz, last_seen timestamptz)
language sql security definer set search_path = '' as $$
  select id, code, ip, version, paired, created_at, last_seen from private.executors order by created_at desc limit 5;
$$;

create or replace function public.srv_exec_approve(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update private.executors set paired = false where paired and id <> p_id;     -- one active server at a time
  update private.executors set paired = true, paired_at = now() where id = p_id and not paired;
  return found;
end $$;

create or replace function public.srv_exec_revoke(p_id uuid)
returns boolean language sql security definer set search_path = '' as $$
  with d as (delete from private.executors where id = p_id returning 1) select exists (select 1 from d);
$$;

create or replace function public.srv_dhan_save(p_client text, p_token text)
returns void language sql security definer set search_path = '' as $$
  insert into private.dhan_token(id, client_id, token, saved_at, expires_at) values (1, p_client, p_token, now(), now() + interval '23 hours 30 minutes')
  on conflict (id) do update set client_id = excluded.client_id, token = excluded.token, saved_at = now(), expires_at = excluded.expires_at;
$$;

create or replace function public.srv_dhan_get()
returns table(client_id text, token text, saved_at timestamptz, expires_at timestamptz)
language sql security definer set search_path = '' as $$
  select client_id, token, saved_at, expires_at from private.dhan_token where expires_at > now();
$$;

do $$ declare f text; begin
  foreach f in array array['srv_exec_hello(uuid,text,text,text,text)','srv_exec_auth(uuid,text)','srv_exec_list()','srv_exec_approve(uuid)',
                           'srv_exec_revoke(uuid)','srv_dhan_save(text,text)','srv_dhan_get()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

update public.app_config set value = value || jsonb_build_object('protect_floor', 1000), updated_at = now() where key = 'settings';
