-- report_source_cache: 반별 일일보고서를 학생 1명씩 여러 Edge Function 호출로 체이닝할 때,
-- 같은 그룹 수업의 학습기록/교재/클래스 등 공용 Notion 페이지를 매 학생마다 다시 읽지 않도록
-- 한 체인 안에서만 공유하는 짧은 수명의 원본 페이지 캐시.
--
-- run_key는 반별 전송 실행마다 새로 만들어지며, 체인이 끝나면 해당 run_key 행을 삭제한다.
-- 중간 중단으로 남은 행은 다음 실행 시작 시 2일 지난 행을 정리한다.
create table if not exists public.report_source_cache (
  run_key text not null,
  notion_page_id text not null,
  page_json jsonb not null,
  cached_at timestamptz not null default now(),
  primary key (run_key, notion_page_id)
);

create index if not exists report_source_cache_cached_at_idx
  on public.report_source_cache (cached_at);

alter table public.report_source_cache enable row level security;
revoke all on public.report_source_cache from anon, authenticated;
