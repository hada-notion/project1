-- 수동 버튼 실행만 사용. 새로운 정기 작업은 등록하지 않는다.
do $$
declare old_job record;
begin
  if exists (select 1 from pg_extension where extname='pg_cron') then
    for old_job in select jobid from cron.job where jobname in ('neis-schools-daily-enqueue','neis-schools-process') loop
      perform cron.unschedule(old_job.jobid);
    end loop;
  end if;
end $$;
create table if not exists public.neis_manual_runs (
  id uuid primary key default gen_random_uuid(),
  school_page_id text unique not null,
  office_code text not null,
  school_code text not null,
  academic_year integer not null,
  from_date text not null,
  to_date text not null,
  status text not null default 'pending' check (status in ('pending','processing','done','failed')),
  snapshot jsonb,
  row_cursor integer not null default 0,
  attempts integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);
alter table public.neis_manual_runs enable row level security;
revoke all on public.neis_manual_runs from anon, authenticated;
grant all on public.neis_manual_runs to service_role;
create or replace function public.begin_neis_manual_run(p_school text,p_office text,p_code text,p_year integer,p_from text,p_to text)
returns setof public.neis_manual_runs language plpgsql security definer set search_path=public as $$
declare previous public.neis_manual_runs;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_school, 73615));
  select * into previous from public.neis_manual_runs where school_page_id=p_school for update;
  if found then
    if (previous.status='processing' and previous.lease_until > now()) or (previous.status='pending' and previous.updated_at > now()-interval '3 minutes') then
      return next previous; return;
    end if;
    if previous.status <> 'done' and previous.academic_year=p_year and previous.office_code=p_office and previous.school_code=p_code then
      return query update public.neis_manual_runs set status='pending',attempts=0,lease_until=null,updated_at=now() where school_page_id=p_school returning *;
      return;
    end if;
    return query update public.neis_manual_runs set id=gen_random_uuid(),office_code=p_office,school_code=p_code,academic_year=p_year,
      from_date=p_from,to_date=p_to,status='pending',snapshot=null,row_cursor=0,attempts=0,lease_token=null,lease_until=null,last_error=null,updated_at=now()
      where school_page_id=p_school returning *;
  else
    return query insert into public.neis_manual_runs(school_page_id,office_code,school_code,academic_year,from_date,to_date)
      values(p_school,p_office,p_code,p_year,p_from,p_to) returning *;
  end if;
end $$;
create or replace function public.claim_neis_manual_run(p_run_id uuid)
returns setof public.neis_manual_runs language plpgsql security definer set search_path=public as $$
begin
  return query update public.neis_manual_runs set status='processing',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',attempts=attempts+1,updated_at=now()
    where id=p_run_id and attempts<3 and (status='pending' or (status='processing' and lease_until<now())) returning *;
end $$;
revoke all on function public.begin_neis_manual_run(text,text,text,integer,text,text) from public,anon,authenticated;
revoke all on function public.claim_neis_manual_run(uuid) from public,anon,authenticated;
grant execute on function public.begin_neis_manual_run(text,text,text,integer,text,text) to service_role;
grant execute on function public.claim_neis_manual_run(uuid) to service_role;
