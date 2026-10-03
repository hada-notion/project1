-- 스케줄을 자동으로 켜지 않는다. 검증 후 docs/학교-학사일정-연결.md의 활성화 SQL 실행.
create table if not exists public.neis_school_jobs (
  id bigint generated always as identity primary key,
  school_page_id text not null,
  office_code text not null,
  school_code text not null,
  from_date text not null,
  to_date text not null,
  status text not null default 'pending' check (status in ('pending','processing','done','failed')),
  snapshot jsonb,
  row_cursor integer not null default 0,
  attempts integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  unique(school_page_id, from_date, to_date)
);
alter table public.neis_school_jobs enable row level security;
revoke all on public.neis_school_jobs from anon, authenticated;
grant all on public.neis_school_jobs to service_role;
grant usage, select on sequence public.neis_school_jobs_id_seq to service_role;
create or replace function public.claim_neis_school_job()
returns setof public.neis_school_jobs language plpgsql security definer set search_path = public as $$
declare picked bigint; token uuid := gen_random_uuid();
begin
  update public.neis_school_jobs set status='failed', last_error=coalesce(last_error, '처리 임대 만료/재시도 소진'), lease_until=null
    where status='processing' and lease_until < now() and attempts >= 5;
  select id into picked from public.neis_school_jobs
  where (status = 'pending' or (status = 'processing' and lease_until < now())) and attempts < 5
  order by updated_at, id for update skip locked limit 1;
  if picked is null then return; end if;
  return query update public.neis_school_jobs set status = 'processing', lease_token = token,
    lease_until = now() + interval '15 minutes', attempts = attempts + 1, updated_at = now()
    where id = picked returning *;
end $$;
revoke all on function public.claim_neis_school_job() from public, anon, authenticated;
grant execute on function public.claim_neis_school_job() to service_role;
