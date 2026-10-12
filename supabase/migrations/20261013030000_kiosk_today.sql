-- 키오스크 "오늘 출석 준비" (v2.5.37).
--
-- 매일 새벽 kiosk-prepare가 오늘 수강 중인 등록과 오늘 출석 페이지를 Notion에서 읽어 여기에 저장하고,
-- kiosk-checkin은 이 표로 Notion 조회(등록 확인·오늘 출석 찾기·DB ID)를 건너뛴다. 표에 없으면 예전 방식.
-- 오늘(KST) 것만 보관한다. 전화번호는 원문이 아니라 SHA-256 해시만 저장한다.
-- 서버 함수(service_role)만 읽고 쓴다. 브라우저(anon/authenticated)에는 열지 않는다.

create table if not exists public.kiosk_today (
  registration_id text primary key,
  kst_date date not null,
  student_name text not null default '',
  class_ids jsonb not null default '[]'::jsonb,
  phone_hashes text[] not null default '{}',
  attendance_page_id text,
  attendance_status text not null default '',
  checkin_at timestamptz,
  checkout_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.kiosk_prepared (
  id smallint primary key default 1 check (id = 1),
  kst_date date not null,
  prepared_at timestamptz not null,
  source text not null default '',
  student_db_id text not null default '',
  attendance_db_id text not null default '',
  row_count integer not null default 0
);

alter table public.kiosk_today enable row level security;
alter table public.kiosk_prepared enable row level security;
revoke all on public.kiosk_today from anon, authenticated;
revoke all on public.kiosk_prepared from anon, authenticated;

-- 매일 04:00 KST(19:00 UTC)에 오늘 준비. 이 학원 프로젝트 주소로 바꿔 적용한다(운영 적용 시 치환 대상).
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'kiosk-prepare-daily') then
    perform cron.unschedule('kiosk-prepare-daily');
  end if;
end $$;

select cron.schedule(
  'kiosk-prepare-daily',
  '0 19 * * *',
  $cron$
  select net.http_post(
    url := 'https://twczhsxybkcvjkdfdxvs.supabase.co/functions/v1/kiosk-prepare',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-admin-key', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_queue_admin_key' limit 1)
    ),
    body := '{"source":"cron"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $cron$
);
