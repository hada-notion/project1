-- 새 학원 최초 설치 전용: Notion 예시 데이터를 비운 뒤 Supabase에 남은 예시 데이터 사본을 비운다.
-- .github/workflows/clear-example-data.yml이 실행한다. 관리자 비밀번호·보안 설정(hada_security_*)과
-- 라이브러리 사본(lib_books, lib_units)은 남긴다. 없는 표는 건너뛴다(예전에 설치한 학원 대비).
begin;
do $$
declare t text;
begin
  foreach t in array array[
    'cr_activities', 'cr_records', 'cr_attendance', 'cr_sessions',
    'report_cache', 'report_source_cache', 'report_source_sync_state',
    'attendance_records', 'sync_cursors',
    'kiosk_today', 'kiosk_prepared',
    'sync_queue', 'dashboard_date_locks',
    'legal_document_numbers', 'legal_number_counters',
    'neis_school_jobs', 'neis_manual_runs'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('delete from public.%I', t);
      raise notice '% 비움', t;
    end if;
  end loop;
end $$;
commit;
