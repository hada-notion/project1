-- Owner credentials are not readable through anon/authenticated REST clients.
-- New authentication is opt-in: ADMIN_SECURITY_ENABLED=true after configuration.
create table public.hada_security_state (
 id smallint primary key check(id=1), email text, password_hash text,
 internal_key text, internal_hash text, webhook_hash text,
 previous_internal_hash text, previous_until timestamptz,
 version integer not null default 0, changed_at timestamptz,
 setup_hash text, setup_expires timestamptz,
 login_failures integer not null default 0, locked_until timestamptz
);
-- kind=kiosk: long-lived session for the front-desk kiosk, limited to check-in routes and
-- never allowed to read the owner profile or change credentials.
create table public.hada_security_sessions (
 token_hash text primary key, version integer not null,
 kind text not null default 'admin' check(kind in ('admin','kiosk')),
 expires_at timestamptz not null default now()+interval '12 hours'
);
create table public.hada_security_otp (
 id uuid primary key, purpose text not null check(purpose in ('setup','change')),
 email text not null, context_hash text not null, version integer not null,
 code_hash text not null, expires_at timestamptz not null default now()+interval '10 minutes',
 attempts integer not null default 0, consumed boolean not null default false,
 created_at timestamptz not null default now()
);
create table public.hada_security_limits (
 bucket text primary key, hits integer not null, reset_at timestamptz not null
);
create table public.hada_security_audit (
 id bigint generated always as identity primary key,
 event text not null, version integer not null, occurred_at timestamptz not null default now()
);
alter table public.hada_security_state enable row level security;
alter table public.hada_security_sessions enable row level security;
alter table public.hada_security_otp enable row level security;
alter table public.hada_security_limits enable row level security;
alter table public.hada_security_audit enable row level security;
revoke all on public.hada_security_state, public.hada_security_sessions, public.hada_security_otp, public.hada_security_limits, public.hada_security_audit from public, anon, authenticated, service_role;

-- Only trusted Edge Functions and the initial provisioning script can call this RPC.
create or replace function public.hada_security_command(p_action text,p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare
 s public.hada_security_state%rowtype;
 c public.hada_security_otp%rowtype;
 lim public.hada_security_limits%rowtype;
 valid_session boolean;
 sess_kind text;
 secret_id uuid;
 secret_count integer;
 new_version integer;
 v_now timestamptz := clock_timestamp();
begin
 -- Every RPC locks the singleton to serialize owner setup, OTP and rotations.
 -- Provision creates the singleton; all other actions fail closed when it is absent.
 if p_action='provision' then
  if coalesce(p_data->>'setup_hash','') !~ '^[0-9a-f]{64}$' then
   return jsonb_build_object('error','설정 토큰 형식 오류','status',400);
  end if;
  insert into public.hada_security_state(id) values(1) on conflict do nothing;
 end if;
 select * into s from public.hada_security_state where id=1 for update;
 if p_action='status' then return jsonb_build_object('configured',coalesce(s.version,0)>0); end if;
 if s.id is null then return jsonb_build_object('error','일회용 최초 설정 링크를 먼저 발급해 주세요.','status',503); end if;
 if p_action='provision' then
  if s.version>0 then return jsonb_build_object('error','이미 소유자 설정이 완료되었습니다.','status',409); end if;
  update public.hada_security_state set setup_hash=p_data->>'setup_hash',setup_expires=v_now+interval '48 hours' where id=1;
  update public.hada_security_otp set consumed=true;
  return jsonb_build_object('ok',true,'expires_at',v_now+interval '48 hours');
 end if;
 if p_action='limit' then
  if length(p_data->>'bucket')>128 or (p_data->>'max')::integer not between 1 and 1000 or (p_data->>'seconds')::integer not between 1 and 86400 then
   return jsonb_build_object('error','요청 제한 설정 오류','status',400);
  end if;
  insert into public.hada_security_limits(bucket,hits,reset_at) values(p_data->>'bucket',0,v_now) on conflict do nothing;
  select * into lim from public.hada_security_limits where bucket=p_data->>'bucket' for update;
  if lim.reset_at<=v_now then
   update public.hada_security_limits set hits=1,reset_at=v_now+make_interval(secs=>(p_data->>'seconds')::integer) where bucket=lim.bucket;
  elsif lim.hits>=(p_data->>'max')::integer then return jsonb_build_object('error','요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.','status',429);
  else update public.hada_security_limits set hits=hits+1 where bucket=lim.bucket; end if;
  return jsonb_build_object('ok',true);
 end if;
 if p_action='setup-context' then
  if s.version>0 or s.setup_expires<=v_now or s.setup_hash is null or s.setup_hash<>p_data->>'setup_hash' then
   return jsonb_build_object('error','최초 설정 링크가 만료되었거나 유효하지 않습니다.','status',401);
  end if;
  return jsonb_build_object('version',s.version);
 end if;
 if p_action='internal' then return jsonb_build_object('internal_key',s.internal_key); end if;
 if p_action='authorize' then
  if s.version=0 then return jsonb_build_object('kind','none'); end if;
  if p_data->>'candidate'=s.internal_hash or (p_data->>'candidate'=s.previous_internal_hash and s.previous_until>v_now) then
   return jsonb_build_object('kind','internal');
  end if;
  if p_data->>'candidate'=s.webhook_hash then return jsonb_build_object('kind','webhook'); end if;
  select kind into sess_kind from public.hada_security_sessions where token_hash=p_data->>'candidate' and version=s.version and expires_at>v_now;
  if sess_kind='admin' then return jsonb_build_object('kind','session'); end if;
  if sess_kind='kiosk' then return jsonb_build_object('kind','kiosk'); end if;
  return jsonb_build_object('kind','none');
 end if;
 if p_action='owner' then
  if s.version=0 then return jsonb_build_object('error','소유자 최초 설정을 완료해 주세요.','status',409); end if;
  if s.locked_until>v_now then return jsonb_build_object('error','로그인 시도가 제한되었습니다. 15분 후 다시 시도해 주세요.','status',429); end if;
  return jsonb_build_object('password_hash',s.password_hash,'version',s.version);
 end if;
 if p_action='login' then
  if s.version=0 or s.version<>(p_data->>'version')::integer then return jsonb_build_object('error','설정이 변경되었습니다. 다시 로그인해 주세요.','status',409); end if;
  if s.locked_until>v_now then return jsonb_build_object('error','15분 후 다시 로그인해 주세요.','status',429); end if;
  if not coalesce((p_data->>'verified')::boolean,false) then
   update public.hada_security_state set login_failures=case when locked_until<=v_now then 1 else login_failures+1 end,
    locked_until=case when login_failures>=4 and (locked_until is null or locked_until>v_now) then v_now+interval '15 minutes' else null end where id=1;
   return jsonb_build_object('error','비밀번호가 올바르지 않습니다.','status',401);
  end if;
  if coalesce(p_data->>'token_hash','') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('error','세션 형식 오류','status',400); end if;
  sess_kind:=coalesce(p_data->>'kind','admin');
  if sess_kind not in ('admin','kiosk') then return jsonb_build_object('error','세션 종류 오류','status',400); end if;
  delete from public.hada_security_sessions where expires_at<=v_now or version<>s.version;
  insert into public.hada_security_sessions(token_hash,version,kind,expires_at)
   values(p_data->>'token_hash',s.version,sess_kind,v_now+case when sess_kind='kiosk' then interval '30 days' else interval '12 hours' end);
  update public.hada_security_state set login_failures=0,locked_until=null where id=1;
  return jsonb_build_object('ok',true);
 end if;
 valid_session:=exists(select 1 from public.hada_security_sessions where token_hash=p_data->>'session_hash' and version=s.version and kind='admin' and expires_at>v_now);
 if p_action='logout' then
  delete from public.hada_security_sessions where token_hash=p_data->>'session_hash';return jsonb_build_object('ok',true);
 end if;
 if p_action='profile' then
  if not valid_session then return jsonb_build_object('error','다시 로그인해 주세요.','status',401); end if;
  return jsonb_build_object('email',s.email,'password_hash',s.password_hash,'changed_at',s.changed_at,'version',s.version);
 end if;
 if p_action='begin-otp' then
  if s.version<>(p_data->>'version')::integer then return jsonb_build_object('error','설정이 변경되었습니다.','status',409); end if;
  if p_data->>'purpose'='setup' then
   if s.version>0 or s.setup_hash<>p_data->>'context_hash' or s.setup_hash is null or s.setup_expires<=v_now then
    return jsonb_build_object('error','최초 설정 링크가 유효하지 않습니다.','status',401);
   end if;
  elsif p_data->>'purpose'='change' then
   if not exists(select 1 from public.hada_security_sessions where token_hash=p_data->>'context_hash' and version=s.version and kind='admin' and expires_at>v_now) or s.email<>p_data->>'email' then
    return jsonb_build_object('error','다시 로그인해 주세요.','status',401);
   end if;
  else return jsonb_build_object('error','인증 목적 오류','status',400); end if;
  if exists(select 1 from public.hada_security_otp where context_hash=p_data->>'context_hash' and created_at>v_now-interval '60 seconds') then
   return jsonb_build_object('error','인증번호는 60초 후 다시 요청할 수 있습니다.','status',429);
  end if;
  delete from public.hada_security_otp where expires_at<v_now-interval '1 day';
  update public.hada_security_otp set consumed=true where context_hash=p_data->>'context_hash';
  insert into public.hada_security_otp(id,purpose,email,context_hash,version,code_hash)
   values((p_data->>'id')::uuid,p_data->>'purpose',p_data->>'email',p_data->>'context_hash',s.version,p_data->>'code_hash');
  return jsonb_build_object('ok',true);
 end if;
 if p_action='cancel-otp' then update public.hada_security_otp set consumed=true where id=(p_data->>'id')::uuid;return jsonb_build_object('ok',true); end if;
 if p_action='complete' then
  select * into c from public.hada_security_otp where id=(p_data->>'id')::uuid for update;
  if c.id is null or c.consumed or c.expires_at<=v_now or c.attempts>=5 or c.version<>s.version or c.purpose<>p_data->>'purpose' or c.context_hash<>p_data->>'context_hash' or s.version<>(p_data->>'expected_version')::integer then
   return jsonb_build_object('error','인증이 만료되었거나 유효하지 않습니다. 새 인증번호를 요청해 주세요.','status',401);
  end if;
  if c.purpose='setup' then
   if s.version>0 or s.setup_hash is null or s.setup_expires<=v_now or s.setup_hash<>c.context_hash then
    return jsonb_build_object('error','최초 설정 링크가 만료되었습니다.','status',401);
   end if;
  elsif not exists(select 1 from public.hada_security_sessions where token_hash=c.context_hash and version=s.version and kind='admin' and expires_at>v_now) then
   return jsonb_build_object('error','다시 로그인해 주세요.','status',401);
  end if;
  if c.code_hash<>p_data->>'code_hash' then
   update public.hada_security_otp set attempts=attempts+1 where id=c.id;
   return jsonb_build_object('error','인증번호가 올바르지 않습니다.','status',401);
  end if;
  if coalesce(p_data->>'password_hash','') !~ '^pbkdf2-sha256\$600000\$[0-9a-f]{32}\$[0-9a-f]{64}$'
   or coalesce(p_data->>'internal_key','') !~ '^[0-9a-f]{64}$'
   or coalesce(p_data->>'internal_hash','') !~ '^[0-9a-f]{64}$'
   or (s.version=0 and coalesce(p_data->>'webhook_hash','') !~ '^[0-9a-f]{64}$') then
   return jsonb_build_object('error','보안 설정 형식 오류','status',400);
  end if;
  -- Vault and authoritative state rotate in one PostgreSQL transaction.
  -- Any Vault failure rolls back the new password, key, OTP consumption and audit.
  select count(*) into secret_count from vault.secrets where name='sync_queue_admin_key';
  if secret_count>1 then raise exception 'Duplicate scheduled credential'; end if;
  if secret_count=0 then perform vault.create_secret(p_data->>'internal_key','sync_queue_admin_key');
  else
   select id into secret_id from vault.secrets where name='sync_queue_admin_key';
   perform vault.update_secret(secret_id,p_data->>'internal_key');
  end if;
  new_version:=s.version+1;
  update public.hada_security_state set email=c.email,password_hash=p_data->>'password_hash',
   previous_internal_hash=internal_hash,previous_until=v_now+interval '5 minutes',
   internal_key=p_data->>'internal_key',internal_hash=p_data->>'internal_hash',
   webhook_hash=case when version=0 then p_data->>'webhook_hash' else webhook_hash end,
   version=new_version,changed_at=v_now,setup_hash=null,setup_expires=null,login_failures=0,locked_until=null where id=1;
  delete from public.hada_security_sessions;
  update public.hada_security_otp set consumed=true;
  insert into public.hada_security_audit(event,version) values(case when c.purpose='setup' then 'owner_setup' else 'password_and_internal_key_changed' end,new_version);
  return jsonb_build_object('ok',true,'changed_at',v_now);
 end if;
 return jsonb_build_object('error','지원하지 않는 서버 작업','status',400);
end $$;
revoke all on function public.hada_security_command(text,jsonb) from public, anon, authenticated;
grant execute on function public.hada_security_command(text,jsonb) to service_role;
