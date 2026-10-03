-- Persistent opaque identity numbers; only the server service role can access these records.
create table if not exists public.legal_document_numbers (
 kind text not null check (kind in ('student','receipt')),
 entity_id uuid not null,
 number bigint not null check (number > 0),
 primary key(kind,entity_id), unique(kind,number)
);
alter table public.legal_document_numbers enable row level security;
revoke all on public.legal_document_numbers from public, anon, authenticated;
revoke all on public.legal_document_numbers from service_role;
grant select, insert on public.legal_document_numbers to service_role;
-- Existing registrants: first enrollment date, then stable page identity for same-day ties.
insert into public.legal_document_numbers(kind,entity_id,number) values
('student','3ecba040-586b-8003-b608-d6c86586ee92',1),
('student','3ecba040-586b-8009-a3fe-c123f8d62712',2),
('student','3ecba040-586b-800b-987c-dbc0dd1d5d91',3),
('student','3ecba040-586b-800d-9217-c311e381358d',4),
('student','3ecba040-586b-8010-8941-e324ad5f83a3',5),
('student','3ecba040-586b-801a-8aa1-f4681df97b2e',6),
('student','3ecba040-586b-801f-b160-f9518e766b20',7),
('student','3ecba040-586b-8026-ad7d-e2d00818af2d',8),
('student','3ecba040-586b-8027-9d63-ebd884495387',9),
('student','3ecba040-586b-802e-a55f-cc95a9e3747f',10),
('student','3ecba040-586b-8038-87a3-d445889f89c0',11),
('student','3ecba040-586b-8038-9713-de57799969c1',12),
('student','3ecba040-586b-8039-8ed1-e310c0f01b30',13),
('student','3ecba040-586b-803d-a4f7-d3cf75c3ef93',14),
('student','3ecba040-586b-8042-a0e5-e9248c69b096',15),
('student','3ecba040-586b-8046-9fd4-c77c6778992f',16),
('student','3ecba040-586b-804a-b273-df8f6424f104',17),
('student','3ecba040-586b-8053-a4a2-d2ff8f3833ca',18),
('student','3ecba040-586b-8054-ac6f-e1c5a8e87860',19),
('student','3ecba040-586b-805e-8c91-c4fe0c8bbc4b',20),
('student','3ecba040-586b-8069-9f36-f093904e8eb0',21),
('student','3ecba040-586b-8069-ac50-de238eb84d40',22),
('student','3ecba040-586b-8074-8e4b-e4056b7736bc',23),
('student','3ecba040-586b-807a-bd82-dff39979ee6a',24),
('student','3ecba040-586b-807c-8edb-c49bb6f43b74',25),
('student','3ecba040-586b-807e-b872-f7dc468d9dba',26),
('student','3ecba040-586b-8081-ab7b-f54a45913d17',27),
('student','3ecba040-586b-8082-be3c-e0c0102a53bf',28),
('student','3ecba040-586b-8084-abcc-db76a42fcd2c',29),
('student','3ecba040-586b-8088-8d02-fedcc634f3e6',30),
('student','3ecba040-586b-8091-b736-e3e375f9da5f',31),
('student','3ecba040-586b-8093-b1ef-e57d0908af7e',32),
('student','3ecba040-586b-8096-b069-ea0c870a1faa',33),
('student','3ecba040-586b-8097-9300-f70e65c90d37',34),
('student','3ecba040-586b-809c-a76f-d7400e3c048b',35),
('student','3ecba040-586b-809e-a959-ee3effdfeb44',36),
('student','3ecba040-586b-809f-8f2a-d4859efde3f6',37),
('student','3ecba040-586b-80a3-90b6-e76450f16ad1',38),
('student','3ecba040-586b-80a6-8232-c86ecf630030',39),
('student','3ecba040-586b-80a6-a872-e34ae69d57a6',40),
('student','3ecba040-586b-80a6-b5b2-fc16cd45c695',41),
('student','3ecba040-586b-80ad-8ab8-fa033144421e',42),
('student','3ecba040-586b-80ae-b04a-ea3ae9adb8e7',43),
('student','3ecba040-586b-80af-920b-ef1eff7f8d78',44),
('student','3ecba040-586b-80b9-a903-dfd86e36d498',45),
('student','3ecba040-586b-80bb-b8ae-db18ffe345a6',46),
('student','3ecba040-586b-80c4-b2d0-ff84c5e351d1',47),
('student','3ecba040-586b-80c8-9c55-ea673bdafff4',48),
('student','3ecba040-586b-80c8-bc1a-e94f8b077dfa',49),
('student','3ecba040-586b-80cb-aed3-f8d3534d3c1f',50),
('student','3ecba040-586b-80d0-a7c9-f40a416ab9a5',51),
('student','3ecba040-586b-80d7-8234-d26f21bddfc5',52),
('student','3ecba040-586b-80e1-9921-d25309b478f4',53),
('student','3ecba040-586b-80e5-98cb-deb316cfcaa5',54),
('student','3ecba040-586b-80e5-b198-e7c65a3b1ccb',55),
('student','3ecba040-586b-80e7-8ba3-c72ff21dd465',56),
('student','3ecba040-586b-80eb-bfba-ebd6f7b650c2',57),
('student','3ecba040-586b-80f4-b824-c470a9a23793',58),
('student','3ecba040-586b-80fd-82fc-dc1e7555451c',59),
('student','3ecba040-586b-81f7-86a7-e5a368e9e50c',60)
on conflict (kind,entity_id) do nothing;
create table if not exists public.legal_number_counters(kind text primary key, last_number bigint not null);
alter table public.legal_number_counters enable row level security;
revoke all on public.legal_number_counters from public,anon,authenticated,service_role;
insert into public.legal_number_counters(kind,last_number)
select kind,max(number) from public.legal_document_numbers group by kind
on conflict(kind) do update set last_number=greatest(legal_number_counters.last_number,excluded.last_number);
create or replace function public.reserve_legal_document_number(p_kind text,p_entity_id uuid,p_existing bigint default null)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare n bigint;
begin
 if p_kind not in ('student','receipt') or p_entity_id is null then raise exception 'Invalid numbering request'; end if;
 -- Transaction-scoped lock: concurrent requests and retries never reuse or change identities.
 perform pg_advisory_xact_lock(hashtextextended('legal-document-' || p_kind,0));
 select number into n from public.legal_document_numbers where kind=p_kind and entity_id=p_entity_id;
 if n is not null then
  if p_existing is not null and p_existing<>n then raise exception 'Existing number conflicts with persistent identity'; end if;
  return n;
 end if;
 if p_existing is not null then
  if p_existing<1 then raise exception 'Number must be positive'; end if;
  n:=p_existing;
 else
  select coalesce((select last_number from public.legal_number_counters where kind=p_kind),0)+1 into n;
 end if;
 insert into public.legal_document_numbers values(p_kind,p_entity_id,n);
 insert into public.legal_number_counters(kind,last_number) values(p_kind,n)
 on conflict(kind) do update set last_number=greatest(legal_number_counters.last_number,excluded.last_number);
 return n;
end $$;
revoke all on function public.reserve_legal_document_number(text,uuid,bigint) from public,anon,authenticated;
grant execute on function public.reserve_legal_document_number(text,uuid,bigint) to service_role;
