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
const migrations=['20261011010000_admin_security.sql','20261012010000_admin_password_simplify.sql','20261012020000_admin_security_safeupdate.sql','20261013010000_webhook_key_rotation.sql','20261013020000_webhook_checklist.sql','20261014010000_class_password.sql'];
for(const f of migrations)await db.exec(fs.readFileSync('supabase/migrations/'+f,'utf8'));
// Supabase rejects DELETE/UPDATE without WHERE on API connections (pg-safeupdate); PGlite does not,
// so check the current function definition statically. INSERT ... ON CONFLICT DO UPDATE is not affected.
const current=fs.readFileSync('supabase/migrations/'+migrations.at(-1),'utf8').replace(/--[^\n]*/g,'').replace(/\bdo\s+update\b/gi,'do upsert');
const unsafe=[...current.matchAll(/\b(delete\s+from|update)\s[^;]*;/gi)].map(m=>m[0]).filter(s=>!/\bwhere\b/i.test(s));
if(unsafe.length)throw new Error('DELETE/UPDATE without WHERE (blocked by Supabase safeupdate): '+unsafe.join(' | '));
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
// Class (teacher) password: owner sets it with an admin session; class sessions reach the class room only.
const cls=h('1'),cls2=h('0'),classPw=pw('6');
ok((await rpc('class-owner')).status,409); // not set yet
ok((await rpc('class-set',{session_hash:kiosk,password_hash:classPw})).status,401);
ok((await rpc('class-set',{session_hash:other,password_hash:classPw})).status,401);
ok((await rpc('class-set',{session_hash:token,password_hash:'bad'})).status,400);
ok((await rpc('class-set',{session_hash:token,password_hash:classPw})).ok,true);
ok((await rpc('profile',{session_hash:token})).class_password_set,true);
const co=await rpc('class-owner');ok([co.password_hash,co.class_version],[classPw,2]);
ok((await rpc('class-login',{verified:true,class_version:1,token_hash:cls})).status,409);
for(let i=0;i<5;i++)ok((await rpc('class-login',{verified:false,class_version:2,token_hash:cls})).status,401);
ok((await rpc('class-owner')).status,429);
ok((await rpc('owner')).must_change,false); // owner login is not locked by class failures
await db.exec("update public.hada_security_state set class_locked_until=now()-interval '1 minute' where id=1");
ok((await rpc('class-login',{verified:true,class_version:2,token_hash:'bad'})).status,400);
ok((await rpc('class-login',{verified:true,class_version:2,token_hash:cls})).ok,true);
ok((await rpc('authorize',{candidate:cls})).kind,'class');
ok((await raw(`select (expires_at>now()+interval '29 days') as long from public.hada_security_sessions where token_hash='${cls}'`))[0].long,true);
ok((await rpc('profile',{session_hash:cls})).status,401);
ok((await rpc('class-set',{session_hash:cls,password_hash:pw('7')})).status,401);
ok((await rpc('webhook-status',{session_hash:cls})).status,401);
// Changing the class password ends class sessions only.
ok((await rpc('class-login',{verified:true,class_version:2,token_hash:cls2})).ok,true);
ok((await rpc('class-set',{session_hash:token,password_hash:pw('7')})).ok,true);
ok((await rpc('authorize',{candidate:cls})).kind,'none');
ok((await rpc('authorize',{candidate:cls2})).kind,'none');
ok((await rpc('authorize',{candidate:token})).kind,'session');
ok((await rpc('authorize',{candidate:kiosk})).kind,'kiosk');
ok((await rpc('class-login',{verified:true,class_version:3,token_hash:cls})).ok,true);
// Session expiry fails closed.
await db.exec(`update public.hada_security_sessions set expires_at=now()-interval '1 second' where token_hash='${token}'`);
ok((await rpc('authorize',{candidate:token})).kind,'none');
ok((await rpc('profile',{session_hash:token})).status,401);
// Deploy-manager reset: back to the initial password on the next init, sessions revoked, keys kept.
ok((await rpc('reset')).ok,true);
ok((await rpc('authorize',{candidate:kiosk})).kind,'none');
ok((await rpc('owner')).status,409);
ok(await rpc('status'),{initialized:true,password_set:false});
ok((await rpc('authorize',{candidate:cls})).kind,'none'); // reset ends class sessions too
ok((await rpc('init',{...init,internal_key:h('a'),internal_hash:h('a'),webhook_hash:h('f')})).reset,true);
ok((await raw('select version,must_change,password_hash,internal_hash,webhook_hash from public.hada_security_state'))[0],{version:4,must_change:true,password_hash:initial,internal_hash:key2,webhook_hash:web});
ok(await vault(),key2);
ok((await rpc('authorize',{candidate:web})).kind,'webhook');
ok((await raw("select string_agg(event,',' order by id) as e from public.hada_security_audit"))[0].e,'initialized,password_and_internal_key_changed,class_password_set,class_password_set,reset_requested,reset_applied');
// Webhook key rotation: blocked while the initial password is active.
ok((await rpc('login',{verified:true,version:4,token_hash:token})).ok,true);
ok((await rpc('webhook-status',{session_hash:token})).status,409);
ok((await rpc('class-owner')).status,409); // class login waits until the initial password is changed
ok((await rpc('class-set',{session_hash:token,password_hash:pw('8')})).status,409);
ok((await rpc('change',{session_hash:token,expected_version:4,password_hash:changed,internal_key:h('5'),internal_hash:h('5')})).ok,true);
ok((await rpc('login',{verified:true,version:5,token_hash:token})).ok,true);
ok((await rpc('login',{verified:true,version:5,token_hash:kiosk,kind:'kiosk'})).ok,true);
const web2=h('6'),web3=h('4'),web4=h('8');
ok((await rpc('webhook-finish',{session_hash:token})).status,409); // nothing to finish
ok((await rpc('webhook-start',{session_hash:token,webhook_hash:web})).status,400); // same as current key
ok((await rpc('webhook-start',{session_hash:token,webhook_hash:'bad'})).status,400);
ok((await rpc('webhook-start',{session_hash:other,webhook_hash:web2})).status,401);
ok((await rpc('webhook-start',{session_hash:kiosk,webhook_hash:web2})).status,401); // kiosk session cannot rotate
ok((await rpc('webhook-start',{session_hash:token,webhook_hash:web2})).ok,true);
ok((await rpc('webhook-start',{session_hash:token,webhook_hash:web3})).status,409); // one rotation at a time
// Both keys work during the transition; calls are counted per function and key.
ok((await rpc('authorize',{candidate:web,route:'send-report'})).kind,'webhook');
ok((await rpc('authorize',{candidate:web,route:'send-report'})).kind,'webhook');
ok((await rpc('authorize',{candidate:web2,route:'cascade-delete'})).kind,'webhook');
ok((await rpc('authorize',{candidate:web,route:'Bad Route!'})).kind,'webhook'); // not recorded
ok((await rpc('authorize',{candidate:token})).kind,'session');
let st=await rpc('webhook-status',{session_hash:token});
ok(st.rotating,true);
ok(st.usage.map(u=>[u.route,u.key,u.calls]),[['cascade-delete','new',1],['send-report','old',2]]);
// Finishing with recent old-key calls needs explicit confirmation.
ok((await rpc('webhook-finish',{session_hash:token})).needs_confirm,true);
ok((await rpc('authorize',{candidate:web})).kind,'webhook');
ok((await rpc('webhook-finish',{session_hash:token,force:true})).ok,true);
ok((await rpc('authorize',{candidate:web,route:'send-report'})).kind,'none');
ok((await rpc('authorize',{candidate:web2})).kind,'webhook');
st=await rpc('webhook-status',{session_hash:token});
ok([st.rotating,st.changed_at!==null],[false,true]);
// Finish without old-key calls needs no confirmation; cancel restores the previous key.
ok((await rpc('webhook-start',{session_hash:token,webhook_hash:web3})).ok,true);
ok((await rpc('authorize',{candidate:web3,route:'send-report'})).kind,'webhook');
ok((await rpc('webhook-finish',{session_hash:token})).ok,true);
ok((await rpc('webhook-start',{session_hash:token,webhook_hash:web4})).ok,true);
ok((await rpc('webhook-cancel',{session_hash:token})).ok,true);
ok((await rpc('authorize',{candidate:web4})).kind,'none');
ok((await rpc('authorize',{candidate:web3})).kind,'webhook');
ok((await raw('select count(*)::int as n from public.hada_security_webhook_usage'))[0].n,0);
ok((await rpc('webhook-cancel',{session_hash:token})).status,409);
// Manual checklist marks exist only during a rotation and are cleared on cancel.
ok((await rpc('webhook-check',{session_hash:token,item:'reg-end',checked:true})).status,409);
ok((await rpc('webhook-start',{session_hash:token,webhook_hash:h('9')})).ok,true);
ok((await rpc('webhook-check',{session_hash:token,item:'Bad Item!',checked:true})).status,400);
ok((await rpc('webhook-check',{session_hash:other,item:'reg-end',checked:true})).status,401);
ok((await rpc('webhook-check',{session_hash:token,item:'reg-end',checked:true})).ok,true);
ok((await rpc('webhook-check',{session_hash:token,item:'reg-link',checked:true})).ok,true);
ok((await rpc('webhook-check',{session_hash:token,item:'reg-link',checked:false})).ok,true);
ok(Object.keys((await rpc('webhook-status',{session_hash:token})).checks),['reg-end']);
ok((await rpc('webhook-cancel',{session_hash:token})).ok,true);
ok((await rpc('webhook-status',{session_hash:token})).checks,{});
// Notion link cache: admin session only, only plain notion.so database/view URLs are stored.
const nurl=x=>'https://www.notion.so/'+x.repeat(32);
ok((await rpc('links-get',{session_hash:other})).status,401);
ok((await rpc('links-set',{session_hash:token,links:'x'})).status,400);
ok((await rpc('links-set',{session_hash:token,links:[{name:'등록(학원)',db:nurl('a'),view:nurl('a')+'?v='+'b'.repeat(32)},{name:'출석(학원)',db:'javascript:alert(1)'},{name:'수업(학원)',db:nurl('c'),view:'https://evil.example/'},{name:'학생(학원)',db:nurl('d')}]})).ok,true);
ok((await rpc('links-get',{session_hash:token})).links,{'등록(학원)':{db:nurl('a'),view:nurl('a')+'?v='+'b'.repeat(32)},'학생(학원)':{db:nurl('d'),view:null}});
// Password change and deploy-manager reset keep the webhook key.
ok((await rpc('change',{session_hash:token,expected_version:5,password_hash:pw('5'),internal_key:h('3'),internal_hash:h('3')})).ok,true);
ok((await rpc('authorize',{candidate:web3})).kind,'webhook');
ok((await rpc('reset')).ok,true);
ok((await rpc('authorize',{candidate:web3})).kind,'webhook');
ok((await raw("select string_agg(event,',' order by id) as e from public.hada_security_audit where event like 'webhook%'"))[0].e,'webhook_rotation_started,webhook_rotation_finished,webhook_rotation_started,webhook_rotation_finished,webhook_rotation_started,webhook_rotation_cancelled,webhook_rotation_started,webhook_rotation_cancelled');
// Public roles cannot read the credential tables or execute the service RPC.
for(const role of ['anon','authenticated']){
 await db.exec('set role '+role);
 for(const query of ['select * from public.hada_security_state','select * from public.hada_security_webhook_usage','select * from public.hada_security_webhook_checks','select * from public.hada_security_notion_links',"select public.hada_security_command('internal')"]){let denied=false;try{await db.query(query);}catch{denied=true;}ok(denied,true);}
 await db.exec('reset role');
}
await db.close();console.log(`PostgreSQL security checks passed: ${checks}`);
})().catch(e=>{console.error(e);process.exit(1)});
