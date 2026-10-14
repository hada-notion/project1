-- v2.5.116: 수업 관리 읽기 전환(설계 docs/설계-수업관리-복사본.md 5단계)에 필요한 출석 열 두 개.
--
-- 보강 대기실(day)이 보여 주는 반 이름(Notion 출석 "클래스(보고서)")과 Notion 원문 수업 시각 글자(출석 "수업일시")다.
-- 기존 행은 빈 값으로 두고, 동기화 함수가 다음에 그 행을 쓸 때(바뀐 것만 5분마다, 매일 밤 대조) 채운다.
-- 접근 권한은 표와 같다(RLS 켜짐, 정책 없음, anon·authenticated 회수).

alter table public.cr_attendance add column if not exists class_label text not null default '';
alter table public.cr_attendance add column if not exists class_start_text text;
