-- 예시 데이터 비우기 전후 확인용: Supabase 사본 표의 건수만 보여 준다(읽기 전용).
do $$
declare t text; n bigint;
begin
  foreach t in array array[
    'cr_sessions', 'cr_attendance', 'cr_records', 'cr_activities',
    'report_cache', 'attendance_records', 'kiosk_today', 'sync_queue', 'legal_document_numbers'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into n;
      raise notice '%: %건', t, n;
    end if;
  end loop;
end $$;
