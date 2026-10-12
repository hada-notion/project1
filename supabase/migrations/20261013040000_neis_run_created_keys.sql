-- v2.5.52: 학사일정 가져오기 재시도 때 같은 일정을 두 번 만들지 않도록, 이번 실행에서 Notion에 만든 일정의
-- NEIS 동기화키 → 페이지 id를 실행 기록에 남긴다. Notion 데이터베이스 조회는 방금 만든 페이지를 몇 초 늦게
-- 돌려줄 수 있어(429로 재시도할 때 실제로 "축제" 일정이 중복 생성됨), 재시도는 이 기록을 먼저 본다.
alter table public.neis_manual_runs add column if not exists created_keys jsonb not null default '{}'::jsonb;

-- 새 학년도·새 학교 코드로 처음부터 다시 시작할 때만 기록을 비운다(같은 실행을 이어갈 때는 유지).
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
      from_date=p_from,to_date=p_to,status='pending',snapshot=null,row_cursor=0,attempts=0,lease_token=null,lease_until=null,last_error=null,
      created_keys='{}'::jsonb,updated_at=now()
      where school_page_id=p_school returning *;
  else
    return query insert into public.neis_manual_runs(school_page_id,office_code,school_code,academic_year,from_date,to_date)
      values(p_school,p_office,p_code,p_year,p_from,p_to) returning *;
  end if;
end $$;
revoke all on function public.begin_neis_manual_run(text,text,text,integer,text,text) from public,anon,authenticated;
grant execute on function public.begin_neis_manual_run(text,text,text,integer,text,text) to service_role;
