-- sync_queue 재시도/복구 규칙 (2026-09-18 밤)
--
-- 지금까지는 두 가지 문제가 있었다:
--   1) 처리 중(status='processing')에 워커 프로세스 자체가 죽어버리면(배포 중 재시작, 메모리 부족
--      등) 그 작업은 영원히 processing 상태로 멈춰있었다. claim_next_sync_queue_item()은 pending만
--      찾기 때문에 다시 집히지 않았다.
--   2) 처리 중 오류가 나서 catch에서 잡히는 경우(일시적인 Notion API 오류/네트워크 오류 등 포함)에도
--      곧바로 failed로 확정되어, 단 한 번의 실패로 재시도 없이 끝났다.
--
-- 이 마이그레이션은 recover_stale_sync_queue_items()를 추가한다: started_at으로부터 일정 시간
-- (기본 15분)이 지나도 여전히 processing인 항목을 찾아, 재시도 여지가 있으면(attempts < max_attempts)
-- pending으로 되돌리고, 재시도 한도를 넘겼으면 failed로 확정한다.
--
-- 15분은 이 워커의 항목당 실제 처리 시간(전체 루프 예산 100초, 잠금 리스 120초)보다 훨씬 여유있게
-- 큰 값으로 일부러 잡았다 -- 너무 짧게 잡으면 아직 정상적으로 느리게 처리 중인 작업을 오작동으로
-- 잘못 판단해 되돌리게 되고, 그러면 원래 작업을 하던 워커와 새로 그 작업을 집은 워커가 동시에 같은
-- 작업을 처리하는(중복 생성) 위험이 생긴다. 함수별로 실제 처리 시간 편차가 있을 수 있지만, 지금은
-- 실측 데이터가 없으므로 모든 target에 안전 마진이 큰 값 하나를 통일해서 적용하고, 나중에
-- started_at/finished_at 실측치가 쌓이면 필요 시 조정한다.
--
-- process-sync-queue/index.ts는 이제 (a) 매 실행 시작 시 recover_stale_sync_queue_items()를 먼저
-- 호출하고, (b) 개별 작업 처리 중 오류가 나면 곧바로 failed 대신 markSyncQueueItemFailedOrRetry로
-- 시도 횟수를 확인해 재시도/실패를 결정한다 (해당 로직은 TypeScript 쪽에서 처리하며, 이 마이그레이션은
-- SQL 함수만 추가한다).

create or replace function public.recover_stale_sync_queue_items(
  stale_after_seconds int default 900,
  max_attempts int default 3
)
returns table(recovered_id bigint, new_status text)
language plpgsql
security invoker
as $$
begin
  return query
  update public.sync_queue q
  set
    status = case when q.attempts >= max_attempts then 'failed' else 'pending' end,
    updated_at = now(),
    finished_at = case when q.attempts >= max_attempts then now() else null end,
    last_error = coalesce(q.last_error, '') ||
      case
        when q.attempts >= max_attempts then E'\n[자동복구] 처리 중 상태로 오래 멈춰 있어 재시도 한도를 초과하여 실패로 확정됨'
        else E'\n[자동복구] 처리 중 상태로 오래 멈춰 있어 다시 대기열로 되돌림'
      end
  where q.status = 'processing'
    and q.started_at is not null
    and q.started_at < now() - (stale_after_seconds || ' seconds')::interval
  returning q.id, q.status;
end;
$$;

revoke all on function public.recover_stale_sync_queue_items(int, int) from public;
grant execute on function public.recover_stale_sync_queue_items(int, int) to service_role;
