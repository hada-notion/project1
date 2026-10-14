-- v2.5.126: 학습기록 "선택 단원"(수업 관리에서 고른 단원) — 수업 관리 복사본에 고른 단원 id 열.
-- unit 열은 그대로 쓰되, 고른 단원이 있으면 그 이름들이 들어간다(_shared/selectedUnits.ts). 새 열은 화면이 체크 상태를 되살릴 때 쓴다.
alter table public.cr_records add column if not exists unit_ids text[] not null default '{}';
