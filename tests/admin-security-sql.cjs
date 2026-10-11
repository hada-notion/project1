// Isolated PostgreSQL engine. Vault is a transactional stub; no real credentials or network.
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const assert=require('node:assert/strict'),fs=require('fs');
(async()=>{
const db=new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role; create schema vault;
create table vault.secrets(id uuid primary key default gen_random_uuid(),name text,secret text);
create function vault.create_secret(value text,label text) returns uuid language plpgsql as $$ declare x uuid; begin insert into vault.secrets(name,secret) values(label,value) returning id into x;return x;end $$;
create function vault.update_secret(x uuid,value text) returns void language plpgsql as $$ begin update vault.secrets set secret=value where id=x;end $$;`);
await db.exec(fs.readFileSync('supabase/migrations/20261011010000_admin_security.sql','utf8'));
const h=x=>x.repeat(64),setup=h('a'),token=h('b'),web=h('c'),key1=h('d'),key2=h('e'),code=h('f');
const password='pbkdf2-sha256$600000$'+'1'.repeat(32)+'$'+'2'.repeat(64);
let checks=0;const ok=(a,b)=>{assert.deepEqual(a,b);checks++};
const rpc=async(action,data={})=>(await db.query('select public.hada_security_command($1,$2::jsonb) as result',[action,JSON.stringify(data)])).rows[0].result;
const raw=async(q)=>(await db.query(q)).rows;
ok((await rpc('status')).configured,false);
ok((await rpc('authorize',{candidate:web})).status,503);
await rpc('provision',{setup_hash:setup});
ok((await rpc('authorize',{candidate:web})).kind,'none');
ok((await rpc('setup-context',{setup_hash:token})).status,401);
ok((await rpc('setup-context',{setup_hash:setup})).version,0);
for(let i=0;i<2;i++)ok((await rpc('limit',{bucket:'x',max:2,seconds:60})).ok,true);
ok((await rpc('limit',{bucket:'x',max:2,seconds:60})).status,429);
const id='11111111-1111-4111-8111-111111111111';
await rpc('begin-otp',{id,purpose:'setup',email:'owner@example.test',context_hash:setup,version:0,code_hash:code});
ok((await rpc('begin-otp',{id:'22222222-2222-4222-8222-222222222222',purpose:'setup',email:'owner@example.test',context_hash:setup,version:0,code_hash:code})).status,429);
const complete={id,code_hash:code,purpose:'setup',context_hash:setup,password_hash:password,internal_key:key1,internal_hash:key1,webhook_hash:web,expected_version:0};
ok((await rpc('complete',{...complete,code_hash:token})).status,401);
ok((await raw('select attempts from public.hada_security_otp'))[0].attempts,1);
ok((await rpc('complete',complete)).ok,true);
ok((await rpc('authorize',{candidate:web})).kind,'webhook');
ok((await rpc('authorize',{candidate:key1})).kind,'internal');
ok((await rpc('provision',{setup_hash:setup})).status,409);
ok((await rpc('complete',complete)).status,401);
ok((await raw("select secret from vault.secrets where name='sync_queue_admin_key'"))[0].secret,key1);
ok((await rpc('setup-context',{setup_hash:setup})).status,401);
ok((await rpc('login',{verified:false,version:1,token_hash:token})).status,401);
for(let i=0;i<4;i++)await rpc('login',{verified:false,version:1,token_hash:token});
ok((await rpc('owner')).status,429);
await db.exec("update public.hada_security_state set locked_until=now()-interval '1 minute'");
ok((await rpc('login',{verified:true,version:1,token_hash:token})).ok,true);
ok((await rpc('authorize',{candidate:token})).kind,'session');
ok((await rpc('profile',{session_hash:token})).email,'owner@example.test');
ok((await rpc('begin-otp',{id:'33333333-3333-4333-8333-333333333333',purpose:'change',email:'attacker@example.test',context_hash:token,version:1,code_hash:code})).status,401);
const id2='44444444-4444-4444-8444-444444444444';
await rpc('begin-otp',{id:id2,purpose:'change',email:'owner@example.test',context_hash:token,version:1,code_hash:code});
const rotate={...complete,id:id2,purpose:'change',context_hash:token,internal_key:key2,internal_hash:key2,expected_version:1};
// Deliberate Vault failure must roll back EVERYTHING.
await db.exec("create or replace function vault.update_secret(x uuid,value text) returns void language plpgsql as $$ begin raise exception 'simulated Vault failure';end $$;");
let failed=false;try{await rpc('complete',rotate);}catch{failed=true;}ok(failed,true);
ok((await raw('select version from public.hada_security_state'))[0].version,1);
ok((await raw(`select consumed from public.hada_security_otp where id='${id2}'`))[0].consumed,false);
ok((await rpc('authorize',{candidate:token})).kind,'session');
await db.exec('create or replace function vault.update_secret(x uuid,value text) returns void language plpgsql as $$ begin update vault.secrets set secret=value where id=x;end $$;');
ok((await rpc('complete',rotate)).ok,true);
ok((await rpc('authorize',{candidate:web})).kind,'webhook');
ok((await rpc('authorize',{candidate:token})).kind,'none');
ok((await rpc('authorize',{candidate:key2})).kind,'internal');
ok((await rpc('authorize',{candidate:key1})).kind,'internal');
await db.exec("update public.hada_security_state set previous_until=now()-interval '1 second'");
ok((await rpc('authorize',{candidate:key1})).kind,'none');
ok((await raw('select count(*)::integer as n from public.hada_security_audit'))[0].n,2);
// Public roles cannot read the credential tables or execute the service RPC.
for(const role of ['anon','authenticated']){
 await db.exec('set role '+role);
 for(const query of ['select * from public.hada_security_state',"select public.hada_security_command('internal')"]){let denied=false;try{await db.query(query);}catch{denied=true;}ok(denied,true);}
 await db.exec('reset role');
}
// Five wrong OTP attempts permanently block this challenge.
await rpc('login',{verified:true,version:2,token_hash:token});
const id3='55555555-5555-4555-8555-555555555555';
await db.exec("update public.hada_security_otp set created_at=now()-interval '2 minutes'");
await rpc('begin-otp',{id:id3,purpose:'change',email:'owner@example.test',context_hash:token,version:2,code_hash:code});
const r3={...rotate,id:id3,expected_version:2};
for(let i=0;i<5;i++)ok((await rpc('complete',{...r3,code_hash:setup})).status,401);
ok((await rpc('complete',r3)).status,401);
// Session expiry and stale rotation versions fail closed.
await db.exec("update public.hada_security_sessions set expires_at=now()-interval '1 second'");
ok((await rpc('profile',{session_hash:token})).status,401);
ok((await rpc('authorize',{candidate:token})).kind,'none');
ok((await rpc('complete',{...r3,expected_version:1})).status,401);
// Fresh challenge that expires cannot change the password.
await rpc('login',{verified:true,version:2,token_hash:token});
await db.exec("update public.hada_security_otp set created_at=now()-interval '2 minutes'");
const id4='66666666-6666-4666-8666-666666666666';
await rpc('begin-otp',{id:id4,purpose:'change',email:'owner@example.test',context_hash:token,version:2,code_hash:code});
await db.exec("update public.hada_security_otp set expires_at=now()-interval '1 second'");
ok((await rpc('complete',{...r3,id:id4})).status,401);
ok((await raw('select version from public.hada_security_state'))[0].version,2);
await db.close();console.log(`PostgreSQL security checks passed: ${checks}`);
})().catch(e=>{console.error(e);process.exit(1)});
