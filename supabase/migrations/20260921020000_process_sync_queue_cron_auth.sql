-- process-sync-queue에 관리자 키(x-admin-key) 인증을 추가하면서, 이 함수를 부르는 두 경로 중
-- pg_cron의 매분 안전망 호출(20260918190000_create_sync_queue.sql에서 생성)도 헤더를 갖춰야
-- 401로 막히지 않는다.
--
-- 코드에 비밀값을 그대로 적지 않기 위해, Supabase Vault에 미리 등록해 둔 비밀값을 SQL 실행
-- 시점에 조회해서 헤더에 넣는다. 이 마이그레이션이 적용되기 "전"에 Supabase 대시보드에서 아래
-- 작업이 먼저 되어 있어야 한다(대시보드 접근 권한이 없어 이 부분은 AI가 대신할 수 없음):
--   Database → Vault → "Add new secret" → Name: sync_queue_admin_key,
--   Secret value: 현재 관리자 키(Edge Function Secrets의 ADMIN_SECRET과 동일한 값)
-- 관리자 키를 나중에 admin.html에서 재발급하면, 이 Vault 시크릿 값도 대시보드에서 함께 갱신해야
-- pg_cron 안전망 호출이 계속 정상 인증된다(코드/마이그레이션 재배포는 필요 없음).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'process-sync-queue-every-minute') then
    perform cron.unschedule('process-sync-queue-every-minute');
  end if;
end $$;

select cron.schedule(
  'process-sync-queue-every-minute',
  '* * * * *',
  $cron$
  select net.http_post(
    url := 'https://twczhsxybkcvjkdfdxvs.supabase.co/functions/v1/process-sync-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-admin-key', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_queue_admin_key' limit 1)
    ),
    body := '{"source":"cron"}'::jsonb
  );
  $cron$
);
