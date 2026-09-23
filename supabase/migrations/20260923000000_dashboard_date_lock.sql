-- dashboard_date_locks: findOrCreateDashboard()(dashboardLinkTarget.ts)가 같은 날짜의
-- 대시보드(학원) 페이지를 두 번 만드는 것을 막기 위한 날짜별 단기 잠금. (2026-09-23, 대시보드
-- 중복 생성 방지)
--
-- 배경: findOrCreateDashboard()는 "이 날짜의 대시보드가 이미 있는지 조회 -> 없으면 새로 만들기"
-- 패턴인데, 이 두 단계가 원자적이지 않다. 같은 날짜를 대상으로 하는 두 호출이 거의 동시에 조회
-- 단계를 지나가면 둘 다 "없음"으로 보고 각자 새 대시보드를 만들어, 같은 날짜에 대시보드 페이지가
-- 여러 개 생기는 문제가 실제로 발생했다(사용자 보고, 2026-09-23). 특히
-- nightly-dashboard-link-audit이 mapWithConcurrency(..., 3, ...)으로 "오늘 편집됐지만 대시보드
-- relation이 비어있는" 수업/출석 여러 건을 동시에 처리할 때 발생하기 쉬웠다 -- 여러 반이 같은
-- 요일에 몰려 있으면, 동시에 처리되는 최대 3건 중 여러 건이 같은 날짜(수업일시)를 가리키는 경우가
-- 흔하기 때문이다.
--
-- sync_queue_worker_lock(20260918190000_create_sync_queue.sql)과 동일한 이유로(Edge Function
-- 호출은 매번 별도의 짧은 연결이라 세션 기반 advisory lock이 호출 사이에 유지되지 않음) 세션
-- lock 대신 테이블 행 기반 리스(lease) 잠금을 쓴다. 다만 그 잠금은 고정된 1행이었던 반면, 이
-- 잠금은 날짜마다 별도로 필요하므로 date_key를 기본키로 하는 행이 여러 개 있을 수 있다.

create table if not exists public.dashboard_date_locks (
  date_key text primary key,
  locked_until timestamptz not null
);

alter table public.dashboard_date_locks enable row level security;
revoke all on public.dashboard_date_locks from anon, authenticated;

-- 잠금을 얻으면 true, 이미 다른 곳이(만료되지 않은 리스로) 잡고 있으면 아무 행도 반환되지 않아
-- null(=false로 취급)이 된다. 그 날짜의 잠금 행이 아직 없으면 새로 만들면서 바로 잠그고, 있으면
-- 리스가 만료된 경우에만 다시 잠근다(죽은 호출이 잠금을 영원히 쥐고 있는 상황 방지).
create or replace function public.try_acquire_dashboard_date_lock(p_date_key text, lease_seconds int default 30)
returns boolean
language sql
security invoker
as $$
  insert into public.dashboard_date_locks (date_key, locked_until)
  values (p_date_key, now() + (lease_seconds || ' seconds')::interval)
  on conflict (date_key) do update
    set locked_until = now() + (lease_seconds || ' seconds')::interval
  where public.dashboard_date_locks.locked_until < now()
  returning true;
$$;

-- 처리가 끝나면 즉시 다음 대기자가 리스 만료를 기다리지 않고 바로 시도할 수 있도록 행을 지운다.
create or replace function public.release_dashboard_date_lock(p_date_key text)
returns void
language sql
security invoker
as $$
  delete from public.dashboard_date_locks where date_key = p_date_key;
$$;

revoke all on function public.try_acquire_dashboard_date_lock(text, int) from public;
revoke all on function public.release_dashboard_date_lock(text) from public;
grant execute on function public.try_acquire_dashboard_date_lock(text, int) to service_role;
grant execute on function public.release_dashboard_date_lock(text) to service_role;
