-- report_cache: 학부모 리포트 웹앱(student_report.html)이 조회하는 저장(캐시) 테이블.
--
-- 기존 구상(제로 셋업 가이드 부록 B)은 매 요청마다 Notion을 실시간으로 조회하는 구조였지만,
-- 이번 요청은 "수파베이스에 저장해놓고 보는" 방식을 원하므로 다르게 설계한다:
--   sync-report-cache(주기적 GitHub Actions cron + 등록 DB의 수동 버튼)가 Notion을 읽어서
--   이 테이블에 미리 계산해 저장해두고, get-report-fast/get-report-detail은 Notion을 전혀
--   조회하지 않고 이 테이블만 읽어서 응답한다.
--
-- 브라우저(student_report.html)는 이 테이블에 직접 접근하지 않는다 (RLS로 차단됨).
-- 오직 Edge Function이 SB_SERVICE_ROLE_KEY(서비스 역할, RLS 우회)로만 접근한다.

create table if not exists public.report_cache (
  access_token text primary key,
  registration_id text not null unique,
  student_key text not null,
  link_disabled boolean not null default false,
  -- 학생 단위 필드 (이름/연락처/성적/형제자매 등). 형제자매의 등록끼리는 student_key가 달라도
  -- 서로의 access_token을 참조하도록 student_fields.siblings에 저장해둔다.
  student_fields jsonb not null default '{}'::jsonb,
  -- get-report-fast 응답의 registrations[] 배열 항목 하나 (이 등록 1건의 개요)
  registration_overview jsonb not null default '{}'::jsonb,
  -- get-report-detail 응답 그대로 (이 등록 1건의 상세 데이터: 출석/학습기록/과제/시험/선생님 코멘트 등)
  registration_detail jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists report_cache_student_key_idx on public.report_cache (student_key);

alter table public.report_cache enable row level security;

-- anon/authenticated 역할에는 어떤 정책도 부여하지 않으므로 기본적으로 접근이 전부 막힌다.
-- 혹시 모를 기본 권한 부여에 대비해 명시적으로도 회수해둔다.
revoke all on public.report_cache from anon, authenticated;
