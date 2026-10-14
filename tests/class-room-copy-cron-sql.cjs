// 수업 관리 복사본 예약 실행 마이그레이션(v2.5.114) 검사. PGlite에 pg_cron·pg_net·Vault 대신 기록만 하는 가짜를 두고
// 예약 등록, 처음 채우기 순서와 스스로 지우기, incremental 대기를 확인한다. 실제 DB·네트워크·비밀값 없음.
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const assert=require('node:assert/strict'),fs=require('fs');
(async()=>{
const db=new PGlite();
await db.exec(`create role anon; create role authenticated;
create schema cron; create table cron.job(jobid serial primary key, jobname text unique, schedule text, command text);
create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job(jobname,schedule,command) values(n,s,c) on conflict(jobname) do update set schedule=excluded.schedule, command=excluded.command returning jobid::bigint $$;
create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname=n returning true $$;
create schema net; create table net.calls(id serial, url text, headers jsonb, body jsonb, timeout int);
create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int) returns bigint language sql as $$ insert into net.calls(url,headers,body,timeout) values(url,headers,body,timeout_milliseconds) returning id::bigint $$;
create schema vault; create table vault.decrypted_secrets(name text, decrypted_secret text); insert into vault.decrypted_secrets values('sync_queue_admin_key','test-only-key');
create table public.sync_cursors(source text primary key, last_synced_at timestamptz not null);`);
const sql=fs.readFileSync('supabase/migrations/20261014060000_class_room_copy_cron.sql','utf8');
await db.exec(sql);await db.exec(sql); // 다시 적용해도 예약이 겹치지 않는다
const jobs=async()=>(await db.query('select jobname,schedule from cron.job order by jobname')).rows.map(r=>r.jobname+' '+r.schedule);
assert.deepEqual(await jobs(),['class-room-copy-first-fill */3 * * * *','class-room-copy-incremental */5 * * * *','class-room-copy-reconcile-activities 15 18 * * *','class-room-copy-reconcile-attendance 5 18 * * *','class-room-copy-reconcile-records 10 18 * * *','class-room-copy-reconcile-sessions 0 18 * * *']);
const run=async n=>{const c=(await db.query('select command from cron.job where jobname=$1',[n])).rows[0].command;return (await db.query(c)).rows[0];};
const last=async()=>(await db.query('select url,headers,body,timeout from net.calls order by id desc limit 1')).rows[0];
// incremental은 처음 채우기 전에는 기다린다
assert.equal(Object.values(await run('class-room-copy-incremental'))[0],'waiting');
assert.equal((await db.query('select count(*)::int n from net.calls')).rows[0].n,0);
// 처음 채우기: 커서 없는 첫 표부터
for(const t of ['cr_sessions','cr_attendance','cr_records','cr_activities']){
 assert.equal(Object.values(await run('class-room-copy-first-fill'))[0],t);
 const c=await last();assert.equal(c.url,'https://twczhsxybkcvjkdfdxvs.supabase.co/functions/v1/sync-class-room-copy');
 assert.deepEqual(c.body,{mode:'reconcile',table:t});assert.equal(c.headers['x-admin-key'],'test-only-key');assert.equal(c.timeout,150000);
 assert.equal(Object.values(await run('class-room-copy-first-fill'))[0],t,'same table again until its cursor exists');
 await db.query('insert into public.sync_cursors values($1, now())',[t]);
}
assert.equal(Object.values(await run('class-room-copy-first-fill'))[0],'done');
assert(!(await jobs()).some(j=>j.startsWith('class-room-copy-first-fill')),'first fill unschedules itself');
assert.equal(Object.values(await run('class-room-copy-incremental'))[0],'called');assert.deepEqual((await last()).body,{mode:'incremental'});
await run('class-room-copy-reconcile-records');assert.deepEqual((await last()).body,{mode:'reconcile',table:'cr_records'});
const grants=(await db.query("select count(*)::int n from information_schema.routine_privileges where routine_name like 'class_room_copy%' and grantee in ('anon','authenticated','PUBLIC')")).rows[0].n;
assert.equal(grants,0,'helper functions not callable by anon/authenticated');
console.log('Class room copy cron migration passed: 6 jobs, re-apply safe, first fill in table order then unschedules, incremental waits for cursors, Vault key header');
})().catch(e=>{console.error(e);process.exit(1)});
