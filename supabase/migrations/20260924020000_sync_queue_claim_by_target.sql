-- sync-dashboard-link 전용 레인 분리 (2026-09-24, PART: sync_queue 분리큐 1단계)
--
-- 실측 근거 (사용자가 직접 Supabase SQL Editor에서 조회):
--   target                          | count | avg_wait      | max_wait
--   sync-dashboard-link             | 1056  | 885.47s(~15분) | 6856.86s(~1h54m)
--   cascade-delete                  |  298  | 366.38s(~6분)  | 2016.43s(~34분)
--   sync-class-report-cache         |    3  |  96.55s       |  195.70s
--   create-learning-record          |    1  |   0.85s       |    0.85s
--
-- sync-dashboard-link는 generate-classes/kiosk-checkin이 수업/출석 페이지를 대량 생성할 때마다
-- 건마다 하나씩 큐에 쌓여 물량이 압도적으로 많다(위 1056건). 기존 process-sync-queue는 target
-- 구분 없이 "생성된 순서대로" 단일 레인에서 하나씩 처리했기 때문에, sync-dashboard-link의 대량
-- 적체가 cascade-delete(삭제 버튼) 등 무관한 다른 작업까지 뒤에서 오래 기다리게 만들었다
-- (레인 기아). sync-dashboard-link의 중복 생성 방지는 이미 withDashboardDateLock(날짜별 advisory
-- lock, 20260923000000 마이그레이션)이 별도로 보장하므로, sync_queue의 엄격한 순차 처리가 이
-- target에 대해서는 더 이상 정합성을 위해 필요하지 않다 -- 안전하게 별도 레인으로 뗄 수 있다.
--
-- claim_next_sync_queue_item()은 그대로 두고(다른 6개 target이 계속 사용), target 목록으로
-- 필터링해서 꺼내는 새 함수를 추가한다. process-sync-queue/index.ts는 이제 이 함수를 이용해
-- sync-dashboard-link 전용 레인과, 나머지 6개 target용 레인을 각각 독립적으로 동시에 돌린다
-- (레인 내부는 여전히 한 번에 하나씩 -- 동시성을 늘리는 게 아니라, 서로 다른 target이 서로를
-- 막지 않게 줄을 분리하는 것).
create or replace function public.claim_next_sync_queue_item_for_targets(p_targets text[])
returns setof public.sync_queue
language plpgsql
security invoker
as $$
declare
  claimed_id bigint;
begin
  select id into claimed_id
  from public.sync_queue
  where status = 'pending' and target = any(p_targets)
  order by created_at asc, id asc
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  return query
    update public.sync_queue
    set status = 'processing', attempts = attempts + 1, started_at = now(), updated_at = now()
    where id = claimed_id
    returning *;
end;
$$;

revoke all on function public.claim_next_sync_queue_item_for_targets(text[]) from public;
grant execute on function public.claim_next_sync_queue_item_for_targets(text[]) to service_role;
