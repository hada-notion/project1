-- 보고서 원본 페이지별 마지막 반영 지문. Notion의 `동기화 필요` 수식으로 먼저 후보를
-- 좁힌 뒤, 동일 내용의 중복 편집은 이 지문으로 한 번 더 걸러낸다.
create table if not exists public.report_source_sync_state (
  notion_page_id text primary key,
  source_type text not null check (source_type in ('attendance', 'learning_record', 'study_activity', 'report')),
  registration_ids text[] not null default '{}',
  source_hash text not null,
  source_modified_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists report_source_sync_state_registration_ids_idx
  on public.report_source_sync_state using gin (registration_ids);
create index if not exists report_source_sync_state_synced_at_idx
  on public.report_source_sync_state (synced_at);

alter table public.report_source_sync_state enable row level security;
revoke all on public.report_source_sync_state from anon, authenticated;
