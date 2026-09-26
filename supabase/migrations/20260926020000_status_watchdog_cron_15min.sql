-- status-watchdog 실행 주기를 5분 -> 15분으로 완화. (2026-09-26, 아키텍처 정리)
--
-- 배경: 20260922150000_status_watchdog_cron.sql에서 5분 주기로 등록했었다. status-watchdog의 각
-- 대상(현재 29개) 기본 stale 임계값이 15분이므로, 5분 주기는 Notion API 호출량(시간당 최대 348회)
-- 대비 회수 지연 개선 효과가 크지 않다고 판단해, 다른 안전망 cron들(예: sync-attendance 증분,
-- 매시간 15분)과 비슷한 수준으로 완화한다. 15분 주기여도 항목이 stale 임계값(15분)을 넘긴 뒤
-- 최대 15분 안에는 여전히 회수되며, Notion API 호출량은 시간당 최대 116회로 줄어든다.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'status-watchdog-every-5-minutes') then
    perform cron.unschedule('status-watchdog-every-5-minutes');
  end if;
end $$;

select cron.schedule(
  'status-watchdog-every-15-minutes',
  '*/15 * * * *',
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
