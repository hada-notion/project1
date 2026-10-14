-- v2.5.112: 수업 관리(class_room.html) 전용 Notion 복사본 — 수업·출석·학습기록·학습활동.
--
-- 수업 관리 함수(class-room)가 Notion을 직접 읽어 동작마다 1~4초씩 걸리던 것을 Supabase 읽기로 바꾸기 위한 표다
-- (설계: docs/설계-수업관리-복사본.md). 이 마이그레이션은 빈 표만 만든다. 채우기(동기화 함수)·읽기 전환은 다음 단계에서 하고,
-- 그 전까지는 아무도 이 표를 읽거나 쓰지 않는다.
--
-- 학부모 리포트의 출석 원자료(attendance_records)와 일부러 나눈다. 리포트는 "정리되지 않은 중간 상태를 학부모에게 자동으로
-- 내보내지 않는다"(v2.5.13)는 원칙으로 정기 동기화를 끈 상태이고, 수업 관리는 선생님용이라 수 분 단위로 맞춘다.
--
-- 열은 수업 관리 화면이 쓰는 값만 둔다(docs/화면-데이터-목록.md). Notion 원문 시각 글자(start_text 등)는 화면이 받던 형식을
-- 그대로 돌려주기 위해, timestamptz 열은 기간 검색·정렬용으로 함께 둔다. notion_edited_at = Notion last_edited_time.
-- 접근: 기존 원자료 표처럼 RLS를 켜고 정책을 두지 않아 anon·authenticated는 막히고, 함수(서비스 역할)만 읽고 쓴다.

create table if not exists public.cr_sessions (
  id text primary key,
  name text not null default '',
  start_text text,
  end_text text,
  starts_at timestamptz,
  class_ids text[] not null default '{}',
  class_name text not null default '',
  class_emoji text not null default '',
  teacher_ids text[] not null default '{}',
  is_makeup boolean not null default false,
  attendance_ids text[] not null default '{}',
  record_ids text[] not null default '{}',
  attendance_summary text not null default '',
  notion_edited_at timestamptz not null,
  synced_at timestamptz not null default now()
);
create index if not exists cr_sessions_starts_at_idx on public.cr_sessions (starts_at);
create index if not exists cr_sessions_class_ids_idx on public.cr_sessions using gin (class_ids);
create index if not exists cr_sessions_teacher_ids_idx on public.cr_sessions using gin (teacher_ids);

create table if not exists public.cr_attendance (
  id text primary key,
  session_ids text[] not null default '{}',
  registration_id text,
  student_name text not null default '',
  status text not null default '',
  class_at timestamptz,
  arrived_at timestamptz,
  left_at timestamptz,
  memo text not null default '',
  comment text not null default '',
  due_activity_ids text[] not null default '{}',
  notion_edited_at timestamptz not null,
  synced_at timestamptz not null default now()
);
create index if not exists cr_attendance_session_ids_idx on public.cr_attendance using gin (session_ids);
create index if not exists cr_attendance_class_at_idx on public.cr_attendance (class_at);

create table if not exists public.cr_records (
  id text primary key,
  title text not null default '',
  kind text not null default '',
  session_ids text[] not null default '{}',
  book_id text,
  progress_book_id text,
  subject text not null default '',
  topic text not null default '',
  range text not null default '',
  unit text not null default '',
  content text not null default '',
  is_makeup boolean not null default false,
  registration_ids text[] not null default '{}',
  activity_ids text[] not null default '{}',
  activity_status text not null default '',
  notion_edited_at timestamptz not null,
  synced_at timestamptz not null default now()
);
create index if not exists cr_records_session_ids_idx on public.cr_records using gin (session_ids);

create table if not exists public.cr_activities (
  id text primary key,
  title text not null default '',
  record_id text,
  attendance_id text,
  registration_id text,
  student_name text not null default '',
  homework_status text not null default '',
  due_at timestamptz,
  due_on date,
  correct numeric,
  total numeric,
  notion_edited_at timestamptz not null,
  synced_at timestamptz not null default now()
);
create index if not exists cr_activities_record_id_idx on public.cr_activities (record_id);
create index if not exists cr_activities_due_on_idx on public.cr_activities (due_on);

alter table public.cr_sessions enable row level security;
alter table public.cr_attendance enable row level security;
alter table public.cr_records enable row level security;
alter table public.cr_activities enable row level security;
revoke all on public.cr_sessions from anon, authenticated;
revoke all on public.cr_attendance from anon, authenticated;
revoke all on public.cr_records from anon, authenticated;
revoke all on public.cr_activities from anon, authenticated;
