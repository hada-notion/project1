-- v2.5.99: 출석 원자료(attendance_records)에 실제 등원·하원 시각을 함께 담는다.
--
-- 키오스크가 Notion 출석 "등원스템프"·"하원스템프"에 찍은 시각은 출석 동기화(buildAttendanceRow)가 Notion 출석 페이지를
-- 읽을 때 이미 함께 받아 오지만, 지금까지는 저장하지 않고 버렸다. 기존 check_in·check_out 칸은 이름과 달리 "수업일시"의
-- 시작·끝 시각(HH:MM)이라 그대로 두고(다른 곳 영향 없음), 실제 시각은 새 칸에 둔다. 비어 있으면 아직 찍지 않았거나
-- 이 버전 이전에 저장된 행이다(다음 동기화·리포트 재계산 때 채워진다). 접근 권한은 테이블 설정(RLS, 서비스 역할만) 그대로.
alter table public.attendance_records
  add column if not exists arrived_at timestamptz,
  add column if not exists left_at timestamptz;
