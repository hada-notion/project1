-- sync_queue.audited_at: sync-failure-audit Edge Function이 "이미 자동화 로그(학원) DB에 보고한
-- 실패 항목"을 표시하는 컬럼. (2026-09-23, 🚨 동기화 실패 알림(학원) DB 통합)
--
-- 배경: "🚨 동기화 실패 알림(학원) DB"가 2026-09-18에 스키마만 만들어진 채 실제로 쓰는 코드가
-- 전혀 없어서 항상 비어 있었다(자동화 검수 체크리스트에서 발견). 사용자 결정: 별도 DB를 유지하는
-- 대신 기존 "전송로그(학원) DB"를 "자동화 로그(학원) DB"로 확장해서 알림톡 발송 로그와 동기화
-- 실패 로그를 한 곳에서 관리하기로 함. 이 컬럼은 sync_queue에 실제로 실패 집계 기능을 붙이기
-- 위한 것이다.
--
-- 설계: 실패(status='failed')로 확정된 항목을 주기적으로 스캔해서 "자동화 로그" DB에 요약 1건을
-- 남기고, 보고한 항목마다 audited_at을 채운다. 다음 스캔에서는 audited_at is null인 것만 다시
-- 보므로 중복 보고나 놓치는 항목 없이 정확히 한 번씩만 집계된다 (고정 시간창 방식과 달리 cron
-- 주기 지연/중단에도 안전함).
alter table public.sync_queue add column if not exists audited_at timestamptz;

create index if not exists sync_queue_unaudited_failed_idx
  on public.sync_queue (created_at)
  where status = 'failed' and audited_at is null;

-- sync-failure-audit를 주기적으로 자동 호출하는 pg_cron 등록. process-sync-queue-every-minute/
-- status-watchdog-every-5-minutes와 동일한 pg_cron + pg_net 패턴, 같은 Vault 시크릿
-- (sync_queue_admin_key) 재사용 — 별도 Vault 등록 불필요.
--
-- 주기: 30분마다. 실패 집계는 상태 회수(watchdog, 5분)만큼 긴급하지 않고, 실패 1건마다 알림
-- 로그를 남기면 소음이 커지므로 어느 정도 모아서 보고하는 것이 낫다.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-failure-audit-every-30-minutes') then
    perform cron.unschedule('sync-failure-audit-every-30-minutes');
  end if;
end $$;

select cron.schedule(
  'sync-failure-audit-every-30-minutes',
  '*/30 * * * *',
  $cron$
  select net.http_post(
    url := 'https://twczhsxybkcvjkdfdxvs.supabase.co/functions/v1/sync-failure-audit',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-admin-key', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_queue_admin_key' limit 1)
    ),
    body := '{"source":"cron"}'::jsonb
  );
  $cron$
);
