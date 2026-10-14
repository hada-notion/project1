-- v2.5.125: 라이브러리(교재)·단원목록 Notion 복사본.
--
-- 라이브러리 화면(textbook-api)·수업 관리 교재(class-room books)·학부모 리포트 교재 카드가 교재와 단원을 Notion에서
-- 매번 읽던 것을 Supabase 읽기로 바꾸기 위한 표다. 수업 관리 [기록 만들기]는 이 단원목록으로 범위에 맞는 단원을
-- 바로 보여 준다. Notion이 원본이고, 이 표는 사본이다.
--
-- 맞추는 방법(_shared/libraryCopy.ts)
--   - 10분마다 전체 대조(library-copy-reconcile): 라이브러리·단원목록 DB 전체를 읽어 upsert하고 Notion에 없는 행은 지운다.
--     교재가 수십~수백 권이라 전체를 읽어도 가볍다. 처음 한 번 성공하면 sync_cursors(lib_books)가 생기고, 그때부터 읽기가 이 표로 간다.
--   - 함께 쓰기: 라이브러리 화면에서 교재를 등록·편집하면 그 교재와 단원을 바로 다시 맞춘다.
-- cover는 외부 이미지 주소만 넣는다. Notion에 올린 파일(주소가 1시간쯤 뒤 만료)은 cover_file=true로 표시하고 읽을 때 Notion에서 새로 받는다.
-- 접근: 다른 복사본 표처럼 RLS를 켜고 정책을 두지 않아 anon·authenticated는 막히고, 함수(서비스 역할)만 읽고 쓴다.

create table if not exists public.lib_books (
  id text primary key,
  title text not null default '',
  series text not null default '',
  publisher text not null default '',
  cover text not null default '',
  cover_file boolean not null default false,
  isbn13 text not null default '',
  used boolean not null default false,
  pages integer,
  notion_edited_at timestamptz not null,
  synced_at timestamptz not null default now()
);

create table if not exists public.lib_units (
  id text primary key,
  book_id text,
  name text not null default '',
  start_page integer,
  link_count integer not null default 0,
  notion_edited_at timestamptz not null,
  synced_at timestamptz not null default now()
);
create index if not exists lib_units_book_id_idx on public.lib_units (book_id);

alter table public.lib_books enable row level security;
alter table public.lib_units enable row level security;
revoke all on public.lib_books, public.lib_units from anon, authenticated;

-- 10분마다 전체 대조. 함수 주소·관리자 키는 수업 관리 복사본 예약(20261014060000)의 class_room_copy_call을 그대로 쓴다.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'library-copy-reconcile') then
    perform cron.unschedule('library-copy-reconcile');
  end if;
end $$;
select cron.schedule('library-copy-reconcile', '*/10 * * * *', $cron$ select public.class_room_copy_call('{"mode":"library"}'::jsonb); $cron$);
