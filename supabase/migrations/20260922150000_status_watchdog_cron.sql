-- status-watchdog를 주기적으로 자동 호출하는 pg_cron 등록. (2026-09-22, 처리 상태 관리 리팩토링 Phase 4)
--
-- 배경: Phase 2/3에서 만든 status-watchdog(_shared/statusTracking.ts의 sweepStaleStatus를 여러
-- (데이터소스, 상태 스펙) 조합에 대해 실행하는 엔드포인트)는 지금까지 관리자가 필요할 때 수동으로만
-- 호출했다. 실제 운영 중 조용히 멈춰있는 항목을 사람이 알아채기 전에 자동으로 회수하려면 주기적인
-- 호출이 필요하다. process-sync-queue-every-minute(20260918190000_create_sync_queue.sql)와 같은
-- pg_cron + pg_net 패턴을 그대로 재사용하고, 인증도 같은 Vault 시크릿(sync_queue_admin_key)을
-- 공유한다 -- 별도 Vault 등록이 필요 없다(20260921020000_process_sync_queue_cron_auth.sql에서
-- 이미 등록됨, ADMIN_SECRET과 같은 값이어야 함).
--
-- 주기: 5분마다. status-watchdog의 각 대상(현재 29개) 기본 stale 임계값은 15분이므로, 5분 주기면
-- 멈춘 작업이 임계값을 넘긴 뒤 최대 5분 안에 회수된다. Notion API 호출량(대상마다 쿼리 1회씩,
-- 총 29회/5분 = 시간당 최대 348회)은 Notion API 레이트리밋(초당 3회 ≈ 시간당 10,800회)에 비해
-- 여유가 충분하다.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'status-watchdog-every-5-minutes') then
    perform cron.unschedule('status-watchdog-every-5-minutes');
  end if;
end $$;

select cron.schedule(
  'status-watchdog-every-5-minutes',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url := 'https://twczhsxybkcvjkdfdxvs.supabase.co/functions/v1/status-watchdog',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-admin-key', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_queue_admin_key' limit 1)
    ),
    body := '{"source":"cron"}'::jsonb
  );
  $cron$
);
