// 수업 관리 복사본 마이그레이션(v2.5.112) 검사. 격리된 PostgreSQL(PGlite)에 적용해 표·RLS·권한·검색을 확인한다. 실제 DB·네트워크 없음.
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const assert=require('node:assert/strict'),fs=require('fs');
(async()=>{
const db=new PGlite();
await db.exec('create role anon; create role authenticated;');
const sql=fs.readFileSync('supabase/migrations/20261014050000_class_room_copy.sql','utf8');
await db.exec(sql);await db.exec(sql); // 다시 적용해도 오류 없음(if not exists)
const tables=(await db.query("select table_name from information_schema.tables where table_schema='public' and table_name like 'cr\\_%' order by 1")).rows.map(r=>r.table_name);
assert.deepEqual(tables,['cr_activities','cr_attendance','cr_records','cr_sessions']);
const rls=(await db.query("select relname from pg_class where relname like 'cr\\_%' and relkind='r' and relrowsecurity order by 1")).rows.map(r=>r.relname);
assert.deepEqual(rls,tables,'RLS on every copy table');
const grants=(await db.query("select count(*)::int n from information_schema.role_table_grants where table_name like 'cr\\_%' and grantee in ('anon','authenticated')")).rows[0].n;
assert.equal(grants,0,'no anon/authenticated access');
// 수업 관리가 할 검색: 같은 반 기간 수업, 수업들의 기록·출석, 그날 마감 학습활동
await db.exec(`insert into cr_sessions(id,starts_at,class_ids,notion_edited_at) values('s1','2026-10-14T08:00:00Z','{c1}',now()),('s2','2026-11-30T08:00:00Z','{c1}',now()),('s3','2026-10-14T08:00:00Z','{c2}',now());
insert into cr_records(id,session_ids,notion_edited_at) values('r1','{s1,s9}',now()),('r2','{s3}',now());
insert into cr_attendance(id,session_ids,notion_edited_at) values('a1','{s1}',now());
insert into cr_activities(id,record_id,due_on,notion_edited_at) values('k1','r1','2026-10-14',now()),('k2','r1',null,now());`);
assert.deepEqual((await db.query("select id from cr_sessions where class_ids @> '{c1}' and starts_at >= '2026-10-01' and starts_at < '2026-11-01'")).rows.map(r=>r.id),['s1']);
assert.deepEqual((await db.query("select id from cr_records where session_ids && '{s1,s2}'")).rows.map(r=>r.id),['r1']);
assert.deepEqual((await db.query("select id from cr_attendance where session_ids && '{s1}'")).rows.map(r=>r.id),['a1']);
assert.deepEqual((await db.query("select id from cr_activities where due_on='2026-10-14'")).rows.map(r=>r.id),['k1']);
await assert.rejects(db.exec("insert into cr_sessions(id) values('x')"),/notion_edited_at/,'notion_edited_at required');
console.log('Class room copy migration passed: 4 tables, RLS on, no anon/authenticated grants, re-apply safe, class/date/array searches');
})().catch(e=>{console.error(e);process.exit(1)});
