-- backfill-assignment-deadlines를 주기적으로 자동 호출하는 pg_cron 등록.
-- (2026-09-24, 분리 큐 재설계) generate-classes가 새 출석을 만들 때 "과제마감 백필 상태"를
-- "⏳ 대기열"로 표시하면 즉시 wakeAssignmentDeadlineWorker()로 이 함수를 깨우지만(즉시 트리거는
-- 실패해도 조용히 무시됨 -- generate-classes/index.ts 참고), 그 즉시 트리거가 실패/유실되거나
-- 처리 중 함수 자체가 멈춘 경우를 위한 안전망이 필요하다. status-watchdog-every-5-minutes
-- (20260922150000_status_watchdog_cron.sql)와 동일한 pg_cron + pg_net 패턴을 그대로 재사용하고,
-- 인증도 같은 Vault 시크릿(sync_queue_admin_key)을 공유한다 -- 별도 Vault 등록이 필요 없다.
--
-- 주기: 10분마다. 이 큐는 대부분 즉시 트리거로 바로 처리되고, 이 크론은 정말 "멈춰있는 경우"만
-- 건져올리는 역할이라 status-watchdog(5분)보다는 조금 더 여유 있게 잡았다. 항목이 없으면
-- backfill-assignment-deadlines는 대기열 조회 1회만 하고 즉시 끝나므로 부담이 거의 없다.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'backfill-assignment-deadlines-every-10min') then
    perform cron.unschedule('backfill-assignment-deadlines-every-10min');
  end if;
end $$;

select cron.schedule(
  'backfill-assignment-deadlines-every-10min',
  '*/10 * * * *',
  $cron$
  select net.http_post(
    url := 'https://twczhsxybkcvjkdfdxvs.supabase.co/functions/v1/backfill-assignment-deadlines',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-admin-key', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_queue_admin_key' limit 1)
    ),
    body := '{"source":"cron"}'::jsonb
  );
  $cron$
);
