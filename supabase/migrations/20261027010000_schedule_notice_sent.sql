-- (v2.8.0) 월간 일정 안내: 학원 전체 일정을 한 학생에게 한 번만 보내기 위한 기록.
-- 월간 일정 안내는 반마다 보낸다(_shared/scheduleNotice.ts). 두 반을 듣는 학생은 반마다 한 통씩 받는데,
-- 학원 전체 일정(휴원 등)까지 반마다 들어가면 같은 내용을 두 번 받는다. 그래서 학원 전체 일정은 보낸 학생·일정을
-- 여기에 적고, 다음 반 안내에서는 뺀다. 반 일정은 그 반에만 있으므로 적지 않는다.
-- 학생·일정 값은 Notion 페이지 id(개인정보 아님). Edge Function(service_role)만 읽고 쓴다.

create table if not exists public.schedule_notice_sent (
  student_id text not null,
  event_id text not null,
  month text not null,
  sent_at timestamptz not null default now(),
  primary key (student_id, event_id)
);

alter table public.schedule_notice_sent enable row level security;
revoke all on public.schedule_notice_sent from anon, authenticated;
