-- attendance_records: 출석(학원) DB의 원자료를 Supabase에 증분으로 누적해두는 테이블.
--
-- report_cache(완성품 캐시)와 달리, 이 테이블은 "리포트를 만들 때마다 통째로 다시 계산"하지 않고
-- Notion 출석 DB에서 생성/수정된 만큼만(증분) 반영한다 (sync-attendance Edge Function).
-- sync-report-cache는 리포트를 조립할 때 이제 Notion 출석 DB를 조회하지 않고 이 테이블만 읽는다.
--
-- 원자료 아키텍처 1단계(출석 도메인)이며, 이후 학습기록/과제·시험/성적/공지도 같은 패턴으로 옮길 계획.

create table if not exists public.attendance_records (
  notion_page_id text primary key,
  registration_id text not null,
  class_iso timestamptz,
  status text not null default '',
  check_in text not null default '',
  check_out text not null default '',
  teacher_comment text not null default '',
  study_log_ids jsonb not null default '[]'::jsonb,
  notion_last_edited_time timestamptz not null,
  synced_at timestamptz not null default now()
);

create index if not exists attendance_records_registration_id_idx on public.attendance_records (registration_id);
create index if not exists attendance_records_class_iso_idx on public.attendance_records (class_iso);

alter table public.attendance_records enable row level security;

-- anon/authenticated 역할에는 어떤 정책도 부여하지 않으므로 기본적으로 접근이 전부 막힌다.
-- 오직 Edge Function이 SB_SERVICE_ROLE_KEY(서비스 역할, RLS 우회)로만 접근한다.
revoke all on public.attendance_records from anon, authenticated;

-- sync_cursors: 원자료 증분 동기화(sync-attendance 등)가 "마지막으로 어디까지 가져갔는지"를
-- 기록해두는 공용 커서 테이블. source 하나당 한 행 (예: "attendance").
create table if not exists public.sync_cursors (
  source text primary key,
  last_synced_at timestamptz not null
);

alter table public.sync_cursors enable row level security;
revoke all on public.sync_cursors from anon, authenticated;
