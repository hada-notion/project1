-- v2.5.114: 수업 관리 복사본 예약 실행(설계 docs/설계-수업관리-복사본.md 3단계).
--
-- 함수 sync-class-room-copy(v2.5.113)를 Supabase 안에서 pg_cron + pg_net으로 부른다. 관리자 키는 다른 예약 작업
-- (process-sync-queue, kiosk-prepare, status-watchdog)과 같이 Vault의 sync_queue_admin_key를 실행 시점에 읽는다
-- (관리자 보안 설정이 키를 바꿀 때 함께 바뀌므로 코드·GitHub에 비밀값이 없다). 함수 주소는 다른 예약 작업과 같은
-- 이 프로젝트 주소다(학원에 배포할 때 학원 주소로 바꾼다 — docs/updates/v2.5.114.md).
--
-- 1) 처음 채우기 class-room-copy-first-fill(3분마다): 커서(sync_cursors)가 아직 없는 표를 cr_sessions → cr_attendance
--    → cr_records → cr_activities 순서로 하나씩 reconcile한다(함수가 끝날 때 커서를 남긴다). 네 표 모두 커서가 생기면
--    스스로 예약을 지운다. 같은 표를 두 번 부르더라도 같은 행을 덮어쓸 뿐이라 안전하다.
-- 2) 바뀐 것만 class-room-copy-incremental(5분마다): 네 표 모두 커서가 있을 때만 incremental(네 표)을 부른다.
-- 3) 매일 밤 대조 class-room-copy-reconcile-*(한국 03:00·03:05·03:10·03:15 = UTC 18:00~18:15): 표마다 reconcile
--    (기본 120일 전 ~ 60일 뒤, 수업·출석은 Notion에서 지워진 행도 정리).
-- Notion은 읽기만 하고 Supabase cr_* 표와 sync_cursors(cr_*)에만 쓴다. 수업 관리는 아직 복사본을 읽지 않는다.

do $$
declare j text;
begin
  foreach j in array array['class-room-copy-first-fill','class-room-copy-incremental',
    'class-room-copy-reconcile-sessions','class-room-copy-reconcile-attendance',
    'class-room-copy-reconcile-records','class-room-copy-reconcile-activities'] loop
    if exists (select 1 from cron.job where jobname = j) then
      perform cron.unschedule(j);
    end if;
  end loop;
end $$;

-- 함수 호출 한 번(본문 jsonb). 예약 작업들이 함께 쓴다.
create or replace function public.class_room_copy_call(body jsonb) returns void
language sql security definer set search_path = public as $fn$
  select net.http_post(
    url := 'https://twczhsxybkcvjkdfdxvs.supabase.co/functions/v1/sync-class-room-copy',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-admin-key', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_queue_admin_key' limit 1)
    ),
    body := body,
    timeout_milliseconds := 150000
  );
$fn$;
revoke all on function public.class_room_copy_call(jsonb) from public, anon, authenticated;

-- 처음 채우기 한 단계: 커서가 없는 첫 표를 reconcile, 모두 있으면 예약을 지운다.
create or replace function public.class_room_copy_first_fill_step() returns text
language plpgsql security definer set search_path = public as $fn$
declare t text;
begin
  foreach t in array array['cr_sessions','cr_attendance','cr_records','cr_activities'] loop
    if not exists (select 1 from public.sync_cursors where source = t) then
      perform public.class_room_copy_call(jsonb_build_object('mode','reconcile','table',t));
      return t;
    end if;
  end loop;
  if exists (select 1 from cron.job where jobname = 'class-room-copy-first-fill') then
    perform cron.unschedule('class-room-copy-first-fill');
  end if;
  return 'done';
end;
$fn$;
revoke all on function public.class_room_copy_first_fill_step() from public, anon, authenticated;

-- 바뀐 것만: 네 표 모두 처음 채우기가 끝났을 때만.
create or replace function public.class_room_copy_incremental_step() returns text
language plpgsql security definer set search_path = public as $fn$
begin
  if (select count(*) from public.sync_cursors where source in ('cr_sessions','cr_attendance','cr_records','cr_activities')) < 4 then
    return 'waiting';
  end if;
  perform public.class_room_copy_call(jsonb_build_object('mode','incremental'));
  return 'called';
end;
$fn$;
revoke all on function public.class_room_copy_incremental_step() from public, anon, authenticated;

select cron.schedule('class-room-copy-first-fill', '*/3 * * * *', $cron$ select public.class_room_copy_first_fill_step(); $cron$);
select cron.schedule('class-room-copy-incremental', '*/5 * * * *', $cron$ select public.class_room_copy_incremental_step(); $cron$);
select cron.schedule('class-room-copy-reconcile-sessions', '0 18 * * *', $cron$ select public.class_room_copy_call('{"mode":"reconcile","table":"cr_sessions"}'::jsonb); $cron$);
select cron.schedule('class-room-copy-reconcile-attendance', '5 18 * * *', $cron$ select public.class_room_copy_call('{"mode":"reconcile","table":"cr_attendance"}'::jsonb); $cron$);
select cron.schedule('class-room-copy-reconcile-records', '10 18 * * *', $cron$ select public.class_room_copy_call('{"mode":"reconcile","table":"cr_records"}'::jsonb); $cron$);
select cron.schedule('class-room-copy-reconcile-activities', '15 18 * * *', $cron$ select public.class_room_copy_call('{"mode":"reconcile","table":"cr_activities"}'::jsonb); $cron$);
