-- sync_queue_worker_lock 리스 연장 함수. (2026-09-21, 워커 락 리스 연장 도입)
--
-- 배경: process-sync-queue는 잠금을 120초 리스로 얻고, 전체 처리 루프 예산은 100초(TIME_BUDGET_MS)라서
-- 평소에는 20초 여유가 있다. 하지만 target 핸들러 중 하나가 유난히 느린 외부 호출(Notion API 재시도 등)에
-- 걸려 단일 항목 처리가 오래 걸리면, 루프 예산 체크 시점 사이에 120초를 넘겨 리스가 만료될 수 있다. 리스가
-- 만료된 상태에서 pg_cron이 매분 깨우는 다음 실행이 새로 잠금을 얻어버리면, 두 워커가 동시에 처리하며
-- 같은 작업을 중복 처리할 위험이 생긴다. 이를 막기 위해, 워커가 처리를 계속 진행 중일 때 주기적으로
-- 리스를 갱신(연장)할 수 있는 함수를 추가한다. try_acquire_sync_queue_lock과 달리 만료 여부를 검사하지
-- 않고 무조건 연장한다 -- 이미 잠금을 획득해 처리 중인 자기 자신이 호출하는 것이므로, 만료 검사를 하면
-- 오히려 이미 만료돼버린 경우 연장에 실패해 원래 취지를 살릴 수 없다.
create or replace function public.renew_sync_queue_lock(lease_seconds int default 120)
returns void
language sql
security invoker
as $$
  update public.sync_queue_worker_lock
  set locked_until = now() + (lease_seconds || ' seconds')::interval
  where id = 1;
$$;

revoke all on function public.renew_sync_queue_lock(int) from public;
grant execute on function public.renew_sync_queue_lock(int) to service_role;
