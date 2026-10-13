-- Shared class (teacher) password for the class room page (v2.5.65). The owner sets it in admin settings;
-- teachers log in with it for a 30-day session that may only call class-room. It has its own hash, version
-- and lockout. Changing the owner password ends every session, class sessions included (same as kiosk).
-- Same function as 20261013020000 plus class-owner, class-login, class-set and the class session kind.
-- Every DELETE/UPDATE has WHERE.
alter table public.hada_security_state
 add column if not exists class_password_hash text,
 add column if not exists class_version integer not null default 1,
 add column if not exists class_changed_at timestamptz,
 add column if not exists class_login_failures integer not null default 0,
 add column if not exists class_locked_until timestamptz;
alter table public.hada_security_sessions drop constraint if exists hada_security_sessions_kind_check;
alter table public.hada_security_sessions add constraint hada_security_sessions_kind_check check(kind in ('admin','kiosk','class'));
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
 -- Every action locks the singleton to serialize init, login, change, reset and webhook rotation.
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
   delete from public.hada_security_sessions where true;
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
  -- Webhook keys and an open rotation are kept: the Notion headers do not change with the password.
  update public.hada_security_state set password_hash=null,must_change=true,version=s.version+1,
   login_failures=0,locked_until=null where id=1;
  delete from public.hada_security_sessions where true;
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
  if p_data->>'candidate'=s.webhook_hash or p_data->>'candidate'=s.previous_webhook_hash then
   -- During a rotation, count calls per function and key so the owner sees which buttons still use the old key.
   if s.previous_webhook_hash is not null and coalesce(p_data->>'route','') ~ '^[a-z0-9-]{1,64}$' then
    insert into public.hada_security_webhook_usage(route,key_kind,calls,last_at)
     values(p_data->>'route',case when p_data->>'candidate'=s.webhook_hash then 'new' else 'old' end,1,v_now)
     on conflict(route,key_kind) do update set calls=public.hada_security_webhook_usage.calls+1,last_at=excluded.last_at;
   end if;
   return jsonb_build_object('kind','webhook');
  end if;
  -- While the initial password is still active, no browser session may reach business routes.
  if s.must_change then return jsonb_build_object('kind','none'); end if;
  select kind into sess_kind from public.hada_security_sessions where token_hash=p_data->>'candidate' and version=s.version and expires_at>v_now;
  if sess_kind='admin' then return jsonb_build_object('kind','session'); end if;
  if sess_kind='kiosk' then return jsonb_build_object('kind','kiosk'); end if;
  if sess_kind='class' then return jsonb_build_object('kind','class'); end if;
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
 -- Shared class (teacher) password: its own hash, version and lockout, a 30-day session limited to the class room.
 -- Teachers can only log in after the owner replaced the initial password and set a class password.
 if p_action in ('class-owner','class-login') then
  if s.must_change then return jsonb_build_object('error','원장님이 관리자 초기 비밀번호를 먼저 변경해야 합니다.','status',409); end if;
  if s.class_password_hash is null then return jsonb_build_object('error','수업용 비밀번호가 아직 없습니다. 원장님이 관리자 설정에서 정해 주세요.','status',409); end if;
  if s.class_locked_until>v_now then return jsonb_build_object('error','로그인 시도가 제한되었습니다. 15분 후 다시 시도해 주세요.','status',429); end if;
 end if;
 if p_action='class-owner' then
  return jsonb_build_object('password_hash',s.class_password_hash,'class_version',s.class_version);
 end if;
 if p_action='class-login' then
  if s.class_version<>(p_data->>'class_version')::integer then return jsonb_build_object('error','수업용 비밀번호가 바뀌었습니다. 다시 로그인해 주세요.','status',409); end if;
  if not coalesce((p_data->>'verified')::boolean,false) then
   update public.hada_security_state set class_login_failures=case when class_locked_until<=v_now then 1 else class_login_failures+1 end,
    class_locked_until=case when class_login_failures>=4 and (class_locked_until is null or class_locked_until>v_now) then v_now+interval '15 minutes' else null end where id=1;
   return jsonb_build_object('error','비밀번호가 올바르지 않습니다.','status',401);
  end if;
  if coalesce(p_data->>'token_hash','') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('error','세션 형식 오류','status',400); end if;
  delete from public.hada_security_sessions where expires_at<=v_now or version<>s.version;
  insert into public.hada_security_sessions(token_hash,version,kind,expires_at) values(p_data->>'token_hash',s.version,'class',v_now+interval '30 days');
  update public.hada_security_state set class_login_failures=0,class_locked_until=null where id=1;
  return jsonb_build_object('ok',true);
 end if;
 if not exists(select 1 from public.hada_security_sessions where token_hash=p_data->>'session_hash' and version=s.version and kind='admin' and expires_at>v_now) then
  return jsonb_build_object('error','다시 로그인해 주세요.','status',401);
 end if;
 if p_action='profile' then
  return jsonb_build_object('password_hash',s.password_hash,'changed_at',s.changed_at,'version',s.version,'must_change',s.must_change,
   'class_password_set',s.class_password_hash is not null,'class_changed_at',s.class_changed_at);
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
  delete from public.hada_security_sessions where true;
  insert into public.hada_security_audit(event,version) values('password_and_internal_key_changed',s.version+1);
  return jsonb_build_object('ok',true,'changed_at',v_now);
 end if;
 -- Class password: admin session only, after the initial password was changed. Ends every class session.
 if p_action='class-set' then
  if s.must_change then return jsonb_build_object('error','초기 비밀번호를 먼저 변경해 주세요.','status',409); end if;
  if coalesce(p_data->>'password_hash','') !~ '^pbkdf2-sha256\$600000\$[0-9a-f]{32}\$[0-9a-f]{64}$' then
   return jsonb_build_object('error','보안 설정 형식 오류','status',400);
  end if;
  update public.hada_security_state set class_password_hash=p_data->>'password_hash',class_version=s.class_version+1,
   class_changed_at=v_now,class_login_failures=0,class_locked_until=null where id=1;
  delete from public.hada_security_sessions where kind='class';
  insert into public.hada_security_audit(event,version) values('class_password_set',s.version);
  return jsonb_build_object('ok',true,'changed_at',v_now);
 end if;
 -- Webhook key rotation: admin session only, never while the initial password is active.
 if p_action like 'webhook-%' and s.must_change then
  return jsonb_build_object('error','초기 비밀번호를 먼저 변경해 주세요.','status',409);
 end if;
 if p_action='webhook-status' then
  return jsonb_build_object('rotating',s.previous_webhook_hash is not null,'started_at',s.webhook_rotation_started,
   'changed_at',s.webhook_changed_at,
   'checks',coalesce((select jsonb_object_agg(c.item,c.checked_at) from public.hada_security_webhook_checks c),'{}'::jsonb),
   'usage',coalesce((select jsonb_agg(jsonb_build_object('route',u.route,'key',u.key_kind,'calls',u.calls,'last_at',u.last_at) order by u.route,u.key_kind)
    from public.hada_security_webhook_usage u),'[]'::jsonb));
 end if;
 if p_action='webhook-start' then
  if s.previous_webhook_hash is not null then
   return jsonb_build_object('error','이미 웹훅 키 교체가 진행 중입니다.','status',409);
  end if;
  if coalesce(p_data->>'webhook_hash','') !~ '^[0-9a-f]{64}$' or p_data->>'webhook_hash' in (s.webhook_hash,s.internal_hash) then
   return jsonb_build_object('error','보안 설정 형식 오류','status',400);
  end if;
  delete from public.hada_security_webhook_usage where true;
  delete from public.hada_security_webhook_checks where true;
  update public.hada_security_state set previous_webhook_hash=webhook_hash,webhook_hash=p_data->>'webhook_hash',
   webhook_rotation_started=v_now where id=1;
  insert into public.hada_security_audit(event,version) values('webhook_rotation_started',s.version);
  return jsonb_build_object('ok',true,'started_at',v_now);
 end if;
 if p_action in ('webhook-finish','webhook-cancel','webhook-check') and s.previous_webhook_hash is null then
  return jsonb_build_object('error','진행 중인 웹훅 키 교체가 없습니다.','status',409);
 end if;
 if p_action='webhook-finish' then
  -- Not an error: the caller shows the recent old-key calls and asks the owner to confirm.
  if not coalesce((p_data->>'force')::boolean,false) and exists(select 1 from public.hada_security_webhook_usage
   where key_kind='old' and last_at>v_now-interval '7 days') then
   return jsonb_build_object('ok',false,'needs_confirm',true);
  end if;
  update public.hada_security_state set previous_webhook_hash=null,webhook_rotation_started=null,webhook_changed_at=v_now where id=1;
  delete from public.hada_security_webhook_checks where true;
  insert into public.hada_security_audit(event,version) values('webhook_rotation_finished',s.version);
  return jsonb_build_object('ok',true,'changed_at',v_now);
 end if;
 if p_action='webhook-cancel' then
  update public.hada_security_state set webhook_hash=previous_webhook_hash,previous_webhook_hash=null,webhook_rotation_started=null where id=1;
  delete from public.hada_security_webhook_usage where true;
  delete from public.hada_security_webhook_checks where true;
  insert into public.hada_security_audit(event,version) values('webhook_rotation_cancelled',s.version);
  return jsonb_build_object('ok',true);
 end if;
 if p_action='webhook-check' then
  -- Manual checklist mark for one Notion button/automation (item ids come from admin_settings.js).
  if coalesce(p_data->>'item','') !~ '^[a-z0-9-]{1,64}$' then
   return jsonb_build_object('error','항목 형식 오류','status',400);
  end if;
  if coalesce((p_data->>'checked')::boolean,false) then
   if (select count(*) from public.hada_security_webhook_checks)>=300 then
    return jsonb_build_object('error','항목이 너무 많습니다.','status',400);
   end if;
   insert into public.hada_security_webhook_checks(item,checked_at) values(p_data->>'item',v_now)
    on conflict(item) do update set checked_at=excluded.checked_at;
  else
   delete from public.hada_security_webhook_checks where item=p_data->>'item';
  end if;
  return jsonb_build_object('ok',true,'checked_at',v_now);
 end if;
 -- Cached Notion links for the checklist (database and its "웹훅등록" view), refreshed on demand.
 if p_action='links-get' then
  return jsonb_build_object('updated_at',(select max(l.updated_at) from public.hada_security_notion_links l),
   'links',coalesce((select jsonb_object_agg(l.name,jsonb_build_object('db',l.db_url,'view',l.view_url)) from public.hada_security_notion_links l),'{}'::jsonb));
 end if;
 if p_action='links-set' then
  if jsonb_typeof(p_data->'links') is distinct from 'array' or jsonb_array_length(p_data->'links')>100 then
   return jsonb_build_object('error','링크 형식 오류','status',400);
  end if;
  delete from public.hada_security_notion_links where true;
  insert into public.hada_security_notion_links(name,db_url,view_url,updated_at)
   select e->>'name',e->>'db',nullif(e->>'view',''),v_now from jsonb_array_elements(p_data->'links') e
   where coalesce(e->>'name','') ~ '^.{1,64}$'
    and coalesce(e->>'db','') ~ '^https://www\.notion\.so/[0-9a-f]{32}$'
    and coalesce(e->>'view','') ~ '^(https://www\.notion\.so/[0-9a-f]{32}\?v=[0-9a-f]{32})?$'
   on conflict(name) do nothing;
  return jsonb_build_object('ok',true);
 end if;
 return jsonb_build_object('error','지원하지 않는 서버 작업','status',400);
end $$;
revoke all on function public.hada_security_command(text,jsonb) from public, anon, authenticated;
grant execute on function public.hada_security_command(text,jsonb) to service_role;
