-- v2.5.12 simplification (applied after 20261011010000_admin_security.sql).
-- No email/OTP and no one-time setup link: the owner password starts as the published initial
-- value and must be changed before any business page can use it. The initial password hash,
-- internal key and webhook hash are created by the Edge Function (init), never by this file.
alter table public.hada_security_state add column if not exists must_change boolean not null default true;
-- The OTP table was only used by the removed email flow and has never held data.
drop table if exists public.hada_security_otp;

create or replace function public.hada_security_command(p_action text,p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare
 s public.hada_security_state%rowtype;
 lim public.hada_security_limits%rowtype;
 sess_kind text;
 secret_id uuid;
 secret_count integer;
 v_now timestamptz := clock_timestamp();
begin
 if p_action='init' then
  insert into public.hada_security_state(id) values(1) on conflict do nothing;
 end if;
 -- Every action locks the singleton to serialize init, login, change and reset.
 select * into s from public.hada_security_state where id=1 for update;
 if p_action='status' then
  return jsonb_build_object('initialized',coalesce(s.version,0)>0,'password_set',s.password_hash is not null);
 end if;
 if p_action='init' then
  if coalesce(p_data->>'password_hash','') !~ '^pbkdf2-sha256\$600000\$[0-9a-f]{32}\$[0-9a-f]{64}$' then
   return jsonb_build_object('error','보안 설정 형식 오류','status',400);
  end if;
  if s.version=0 then
   if coalesce(p_data->>'internal_key','') !~ '^[0-9a-f]{64}$' or coalesce(p_data->>'internal_hash','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_data->>'webhook_hash','') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('error','보안 설정 형식 오류','status',400);
   end if;
   -- Vault and state change in one transaction; any Vault failure rolls back the init.
   select count(*) into secret_count from vault.secrets where name='sync_queue_admin_key';
   if secret_count>1 then raise exception 'Duplicate scheduled credential'; end if;
   if secret_count=0 then perform vault.create_secret(p_data->>'internal_key','sync_queue_admin_key');
   else
    select id into secret_id from vault.secrets where name='sync_queue_admin_key';
    perform vault.update_secret(secret_id,p_data->>'internal_key');
   end if;
   update public.hada_security_state set password_hash=p_data->>'password_hash',must_change=true,
    internal_key=p_data->>'internal_key',internal_hash=p_data->>'internal_hash',webhook_hash=p_data->>'webhook_hash',
    version=1,changed_at=v_now,login_failures=0,locked_until=null where id=1;
   insert into public.hada_security_audit(event,version) values('initialized',1);
   return jsonb_build_object('ok',true,'initialized',true);
  end if;
  if s.password_hash is null then
   -- Completes a reset requested by the deploy manager: back to the initial password.
   update public.hada_security_state set password_hash=p_data->>'password_hash',must_change=true,
    version=s.version+1,login_failures=0,locked_until=null where id=1;
   delete from public.hada_security_sessions;
   insert into public.hada_security_audit(event,version) values('reset_applied',s.version+1);
   return jsonb_build_object('ok',true,'reset',true);
  end if;
  return jsonb_build_object('ok',true);
 end if;
 if s.id is null or s.version=0 then
  if p_action='authorize' then return jsonb_build_object('kind','uninitialized'); end if;
  if p_action='internal' then return jsonb_build_object('internal_key',null); end if;
  return jsonb_build_object('error','관리자 보안 초기 설정이 아직 없습니다.','status',503);
 end if;
 if p_action='reset' then
  -- Service-role only (deploy manager script). The next init sets the initial password again.
  update public.hada_security_state set password_hash=null,must_change=true,version=s.version+1,
   login_failures=0,locked_until=null where id=1;
  delete from public.hada_security_sessions;
  insert into public.hada_security_audit(event,version) values('reset_requested',s.version+1);
  return jsonb_build_object('ok',true);
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
 if p_action='internal' then return jsonb_build_object('internal_key',s.internal_key); end if;
 if p_action='authorize' then
  if p_data->>'candidate'=s.internal_hash or (p_data->>'candidate'=s.previous_internal_hash and s.previous_until>v_now) then
   return jsonb_build_object('kind','internal');
  end if;
  if p_data->>'candidate'=s.webhook_hash then return jsonb_build_object('kind','webhook'); end if;
  -- While the initial password is still active, no browser session may reach business routes.
  if s.must_change then return jsonb_build_object('kind','none'); end if;
  select kind into sess_kind from public.hada_security_sessions where token_hash=p_data->>'candidate' and version=s.version and expires_at>v_now;
  if sess_kind='admin' then return jsonb_build_object('kind','session'); end if;
  if sess_kind='kiosk' then return jsonb_build_object('kind','kiosk'); end if;
  return jsonb_build_object('kind','none');
 end if;
 if p_action='owner' then
  if s.password_hash is null then return jsonb_build_object('error','비밀번호 초기화를 처리하고 있습니다. 잠시 후 다시 시도해 주세요.','status',409); end if;
  if s.locked_until>v_now then return jsonb_build_object('error','로그인 시도가 제한되었습니다. 15분 후 다시 시도해 주세요.','status',429); end if;
  return jsonb_build_object('password_hash',s.password_hash,'version',s.version,'must_change',s.must_change);
 end if;
 if p_action='login' then
  if s.version<>(p_data->>'version')::integer then return jsonb_build_object('error','설정이 변경되었습니다. 다시 로그인해 주세요.','status',409); end if;
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
 if p_action='logout' then
  delete from public.hada_security_sessions where token_hash=p_data->>'session_hash';return jsonb_build_object('ok',true);
 end if;
 if not exists(select 1 from public.hada_security_sessions where token_hash=p_data->>'session_hash' and version=s.version and kind='admin' and expires_at>v_now) then
  return jsonb_build_object('error','다시 로그인해 주세요.','status',401);
 end if;
 if p_action='profile' then
  return jsonb_build_object('password_hash',s.password_hash,'changed_at',s.changed_at,'version',s.version,'must_change',s.must_change);
 end if;
 if p_action='change' then
  if s.version<>(p_data->>'expected_version')::integer then
   return jsonb_build_object('error','설정이 변경되었습니다. 다시 로그인해 주세요.','status',409);
  end if;
  if coalesce(p_data->>'password_hash','') !~ '^pbkdf2-sha256\$600000\$[0-9a-f]{32}\$[0-9a-f]{64}$'
   or coalesce(p_data->>'internal_key','') !~ '^[0-9a-f]{64}$'
   or coalesce(p_data->>'internal_hash','') !~ '^[0-9a-f]{64}$' then
   return jsonb_build_object('error','보안 설정 형식 오류','status',400);
  end if;
  -- Vault and authoritative state rotate in one transaction; any failure rolls back everything.
  select count(*) into secret_count from vault.secrets where name='sync_queue_admin_key';
  if secret_count>1 then raise exception 'Duplicate scheduled credential'; end if;
  if secret_count=0 then perform vault.create_secret(p_data->>'internal_key','sync_queue_admin_key');
  else
   select id into secret_id from vault.secrets where name='sync_queue_admin_key';
   perform vault.update_secret(secret_id,p_data->>'internal_key');
  end if;
  update public.hada_security_state set password_hash=p_data->>'password_hash',must_change=false,
   previous_internal_hash=internal_hash,previous_until=v_now+interval '5 minutes',
   internal_key=p_data->>'internal_key',internal_hash=p_data->>'internal_hash',
   version=s.version+1,changed_at=v_now,login_failures=0,locked_until=null where id=1;
  delete from public.hada_security_sessions;
  insert into public.hada_security_audit(event,version) values('password_and_internal_key_changed',s.version+1);
  return jsonb_build_object('ok',true,'changed_at',v_now);
 end if;
 return jsonb_build_object('error','지원하지 않는 서버 작업','status',400);
end $$;
revoke all on function public.hada_security_command(text,jsonb) from public, anon, authenticated;
grant execute on function public.hada_security_command(text,jsonb) to service_role;
