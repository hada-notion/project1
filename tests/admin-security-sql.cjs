// Isolated PostgreSQL engine. Vault is a transactional stub; no real credentials or network.
// Applies both admin security migrations in order, as the real database does.
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const assert=require('node:assert/strict'),fs=require('fs');
(async()=>{
const db=new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role; create schema vault;
create table vault.secrets(id uuid primary key default gen_random_uuid(),name text,secret text);
create function vault.create_secret(value text,label text) returns uuid language plpgsql as $$ declare x uuid; begin insert into vault.secrets(name,secret) values(label,value) returning id into x;return x;end $$;
create function vault.update_secret(x uuid,value text) returns void language plpgsql as $$ begin update vault.secrets set secret=value where id=x;end $$;`);
for(const f of ['20261011010000_admin_security.sql','20261012010000_admin_password_simplify.sql'])await db.exec(fs.readFileSync('supabase/migrations/'+f,'utf8'));
const h=x=>x.repeat(64),web=h('c'),key1=h('d'),key2=h('e'),token=h('b'),kiosk=h('9'),other=h('7');
const pw=d=>'pbkdf2-sha256$600000$'+'1'.repeat(32)+'$'+d.repeat(64);
const initial=pw('2'),changed=pw('3');
let checks=0;const ok=(a,b)=>{assert.deepEqual(a,b);checks++};
const rpc=async(action,data={})=>(await db.query('select public.hada_security_command($1,$2::jsonb) as result',[action,JSON.stringify(data)])).rows[0].result;
const raw=async(q)=>(await db.query(q)).rows;
const vault=async()=>(await raw("select secret from vault.secrets where name='sync_queue_admin_key'"))[0]?.secret;
// Before init: nothing is authorized and no owner exists.
ok(await rpc('status'),{initialized:false,password_set:false});
ok((await rpc('authorize',{candidate:web})).kind,'uninitialized');
ok((await rpc('owner')).status,503);
ok((await raw("select to_regclass('public.hada_security_otp') as t"))[0].t,null);
// Init: initial password, internal key in Vault, webhook hash, must_change.
const init={password_hash:initial,internal_key:key1,internal_hash:key1,webhook_hash:web};
ok((await rpc('init',{...init,password_hash:'0000'})).status,400);
ok((await rpc('init',init)).initialized,true);
ok(await rpc('status'),{initialized:true,password_set:true});
ok(await vault(),key1);
ok((await rpc('authorize',{candidate:web})).kind,'webhook');
ok((await rpc('authorize',{candidate:key1})).kind,'internal');
ok((await rpc('init',{...init,internal_key:key2,internal_hash:key2})).ok,true); // idempotent
ok(await vault(),key1);
ok((await rpc('owner')).must_change,true);
// Lockout after five wrong passwords.
ok((await rpc('login',{verified:false,version:1,token_hash:token})).status,401);
for(let i=0;i<4;i++)await rpc('login',{verified:false,version:1,token_hash:token});
ok((await rpc('owner')).status,429);
await db.exec("update public.hada_security_state set locked_until=now()-interval '1 minute'");
// While the initial password is active, a session cannot reach business routes.
ok((await rpc('login',{verified:true,version:1,token_hash:token})).ok,true);
ok((await rpc('authorize',{candidate:token})).kind,'none');
ok((await rpc('profile',{session_hash:token})).must_change,true);
const change={session_hash:token,expected_version:1,password_hash:changed,internal_key:key2,internal_hash:key2};
ok((await rpc('change',{...change,expected_version:0})).status,409);
ok((await rpc('change',{...change,password_hash:'bad'})).status,400);
ok((await rpc('change',{...change,session_hash:other})).status,401);
// Vault failure rolls back the whole change.
await db.exec("create or replace function vault.update_secret(x uuid,value text) returns void language plpgsql as $$ begin raise exception 'simulated Vault failure';end $$;");
let failed=false;try{await rpc('change',change);}catch{failed=true;}ok(failed,true);
ok((await raw('select version,must_change from public.hada_security_state'))[0],{version:1,must_change:true});
await db.exec('create or replace function vault.update_secret(x uuid,value text) returns void language plpgsql as $$ begin update vault.secrets set secret=value where id=x;end $$;');
ok((await rpc('change',change)).ok,true);
ok((await raw('select version,must_change,password_hash from public.hada_security_state'))[0],{version:2,must_change:false,password_hash:changed});
ok(await vault(),key2);
ok((await rpc('authorize',{candidate:token})).kind,'none'); // all sessions revoked
ok((await rpc('authorize',{candidate:key2})).kind,'internal');
ok((await rpc('authorize',{candidate:key1})).kind,'internal'); // previous key grace period
await db.exec("update public.hada_security_state set previous_until=now()-interval '1 second'");
ok((await rpc('authorize',{candidate:key1})).kind,'none');
ok((await rpc('authorize',{candidate:web})).kind,'webhook'); // webhook key never changes with the password
// Normal and kiosk sessions after the change.
ok((await rpc('login',{verified:true,version:2,token_hash:token})).ok,true);
ok((await rpc('authorize',{candidate:token})).kind,'session');
ok((await rpc('login',{verified:true,version:2,token_hash:kiosk,kind:'root'})).status,400);
ok((await rpc('login',{verified:true,version:2,token_hash:kiosk,kind:'kiosk'})).ok,true);
ok((await rpc('authorize',{candidate:kiosk})).kind,'kiosk');
ok((await raw(`select (expires_at>now()+interval '29 days') as long from public.hada_security_sessions where token_hash='${kiosk}'`))[0].long,true);
ok((await raw(`select (expires_at<now()+interval '13 hours') as short from public.hada_security_sessions where token_hash='${token}'`))[0].short,true);
ok((await rpc('profile',{session_hash:kiosk})).status,401);
ok((await rpc('change',{...change,session_hash:kiosk,expected_version:2})).status,401);
// Session expiry fails closed.
await db.exec(`update public.hada_security_sessions set expires_at=now()-interval '1 second' where token_hash='${token}'`);
ok((await rpc('authorize',{candidate:token})).kind,'none');
ok((await rpc('profile',{session_hash:token})).status,401);
// Deploy-manager reset: back to the initial password on the next init, sessions revoked, keys kept.
ok((await rpc('reset')).ok,true);
ok((await rpc('authorize',{candidate:kiosk})).kind,'none');
ok((await rpc('owner')).status,409);
ok(await rpc('status'),{initialized:true,password_set:false});
ok((await rpc('init',{...init,internal_key:h('a'),internal_hash:h('a'),webhook_hash:h('f')})).reset,true);
ok((await raw('select version,must_change,password_hash,internal_hash,webhook_hash from public.hada_security_state'))[0],{version:4,must_change:true,password_hash:initial,internal_hash:key2,webhook_hash:web});
ok(await vault(),key2);
ok((await rpc('authorize',{candidate:web})).kind,'webhook');
ok((await raw("select string_agg(event,',' order by id) as e from public.hada_security_audit"))[0].e,'initialized,password_and_internal_key_changed,reset_requested,reset_applied');
// Public roles cannot read the credential tables or execute the service RPC.
for(const role of ['anon','authenticated']){
 await db.exec('set role '+role);
 for(const query of ['select * from public.hada_security_state',"select public.hada_security_command('internal')"]){let denied=false;try{await db.query(query);}catch{denied=true;}ok(denied,true);}
 await db.exec('reset role');
}
await db.close();console.log(`PostgreSQL security checks passed: ${checks}`);
})().catch(e=>{console.error(e);process.exit(1)});
