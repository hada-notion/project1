-- sync_queue: 동기화 웹훅(Notion 버튼/자동화)이 동시에 많이 들어와도, 실제 처리는 "생성된 순서대로
-- 하나씩만" 하도록 만드는 대기열이다. (2026-09-18, 큐 기반 순차 처리 도입)
--
-- 배경: 지금까지 sync-report-cache 등 웹훅 함수들은 요청을 받는 즉시 EdgeRuntime.waitUntil로
-- "따로따로" 백그라운드 처리를 했다(2026-09-10 도입, _shared/backgroundTask.ts). 이 방식은 요청
-- 하나하나는 타임아웃 없이 끝나지만, 서로 다른 요청들 사이의 순서/조율이 전혀 없어서 등록/학습기록/
-- 학습활동/보고서/정규교재/일정 DB 여러 곳에서 동시에 웹훅이 몰리면 같은 등록의 report_cache 행을
-- 여러 인스턴스가 동시에 갱신하며 경쟁하거나, Notion API 레이트리밋에 함께 걸릴 위험이 있었다.
--
-- 이제 웹훅 함수는 (1) 이 테이블에 작업 1건을 적재하고 (2) 즉시 202를 반환하기만 한다. 실제 처리는
-- process-sync-queue 워커가 sync_queue_worker_lock으로 동시에 두 번 돌지 않게 보장하면서, 쌓인
-- 순서대로 하나씩 꺼내(claim_next_sync_queue_item) 처리한다. 아무리 많이 동시에 들어와도 대기열에
-- 쌓일 뿐 유실되지 않고, 전부 순차적으로 처리된다.

create table if not exists public.sync_queue (
  id bigint generated always as identity primary key,
  target text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists sync_queue_pending_idx on public.sync_queue (created_at) where status = 'pending';
create index if not exists sync_queue_status_idx on public.sync_queue (status);
create index if not exists sync_queue_target_idx on public.sync_queue (target);

alter table public.sync_queue enable row level security;
revoke all on public.sync_queue from anon, authenticated;

-- 대기 중인 작업을 "생성된 순서대로" 딱 하나만 꺼내서 processing으로 표시한다.
-- FOR UPDATE SKIP LOCKED로, 혹시 여러 호출이 겹쳐도 같은 행을 두 번 집지 않는다.
create or replace function public.claim_next_sync_queue_item()
returns setof public.sync_queue
language plpgsql
security invoker
as $$
declare
  claimed_id bigint;
begin
  select id into claimed_id
  from public.sync_queue
  where status = 'pending'
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

revoke all on function public.claim_next_sync_queue_item() from public;
grant execute on function public.claim_next_sync_queue_item() to service_role;

-- sync_queue_worker_lock: process-sync-queue 워커가 "이 순간 딱 하나만 실행 중"이도록 보장하는
-- 리스(lease) 잠금. Edge Function 호출은 각각 별도의 짧은 연결/세션이라 세션 기반 advisory lock이
-- 호출 사이에 유지되지 않으므로, 대신 테이블 행 하나를 원자적으로 UPDATE하는 방식으로 잠금을
-- 구현한다. lease가 만료되면(예: 워커가 중간에 죽어서 잠금을 못 풀었을 때) 자동으로 풀리므로
-- 영구 교착 상태에 빠지지 않는다.
create table if not exists public.sync_queue_worker_lock (
  id int primary key,
  locked_until timestamptz,
  constraint sync_queue_worker_lock_single_row check (id = 1)
);
insert into public.sync_queue_worker_lock (id, locked_until)
values (1, null)
on conflict (id) do nothing;

alter table public.sync_queue_worker_lock enable row level security;
revoke all on public.sync_queue_worker_lock from anon, authenticated;

create or replace function public.try_acquire_sync_queue_lock(lease_seconds int default 120)
returns boolean
language sql
security invoker
as $$
  update public.sync_queue_worker_lock
  set locked_until = now() + (lease_seconds || ' seconds')::interval
  where id = 1
    and (locked_until is null or locked_until < now())
  returning true;
$$;

create or replace function public.release_sync_queue_lock()
returns void
language sql
security invoker
as $$
  update public.sync_queue_worker_lock set locked_until = null where id = 1;
$$;

revoke all on function public.try_acquire_sync_queue_lock(int) from public;
revoke all on function public.release_sync_queue_lock() from public;
grant execute on function public.try_acquire_sync_queue_lock(int) to service_role;
grant execute on function public.release_sync_queue_lock() to service_role;

-- 안전망: 웹훅 함수가 적재 직후 부르는 즉시 트리거(wakeSyncQueueWorker)가 실패/유실되거나, 처리
-- 도중 워커가 시간 예산을 다 써서 멈춰도, 큐에 쌓인 작업이 방지되지 않도록 pg_cron으로 매분
-- process-sync-queue를 깨운다.
create extension if not exists pg_cron;
create extension if not exists pg_net;

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
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"source":"cron"}'::jsonb
  );
  $cron$
);
