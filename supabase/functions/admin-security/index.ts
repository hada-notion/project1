import { SecurityError,securityEnabled,securityRpc,sha256,randomToken,validatePassword,hashPassword,verifyPassword,nextRecommended,ensureInitialized,fixedWebhookKey,SECURITY_WEBHOOK_ROUTES } from '../_shared/adminSecurity.ts';
import { NOTION_API,NOTION_TOKEN,NOTION_VERSION } from '../_shared/constants.ts';
// While security is disabled the function only answers with a fixed 503 message and no secrets, so the
// browser must be able to read it for the legacy-login fallback even before ADMIN_ALLOWED_ORIGINS is set.
function cors(req:Request,enforceOrigin:boolean):Record<string,string> {
  const origin=req.headers.get('Origin')??'';
  const allowed=(Deno.env.get('ADMIN_ALLOWED_ORIGINS')??'').split(',').map(x=>x.trim()).filter(Boolean);
  if(enforceOrigin&&origin&&!allowed.includes(origin))throw new SecurityError(403,'허용되지 않은 관리 페이지입니다.');
  return {'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin',...(origin?{'Access-Control-Allow-Origin':origin}:{}),'Access-Control-Allow-Headers':'content-type, x-admin-key, authorization, apikey','Access-Control-Allow-Methods':'POST, OPTIONS'};
}
// Links for the webhook checklist: each academy's own "(학원)" databases, found through its Notion
// integration so no per-academy configuration is needed. Normalized title (no spaces, no trailing "DB")
// -> database URL; trashed sources are skipped and the most recently edited wins on duplicate titles.
export async function notionDatabaseLinks():Promise<Record<string,string>> {
  if(!NOTION_TOKEN)return {};
  const found=new Map<string,{url:string,edited:string}>();let cursor:string|undefined;
  for(let page=0;page<5;page++){
    const res=await fetch(`${NOTION_API}/search`,{method:'POST',headers:{Authorization:`Bearer ${NOTION_TOKEN}`,'Notion-Version':NOTION_VERSION,'Content-Type':'application/json'},
      body:JSON.stringify({filter:{property:'object',value:'data_source'},page_size:100,...(cursor?{start_cursor:cursor}:{})}),signal:AbortSignal.timeout(10000)});
    if(!res.ok){console.error('notion search failed',res.status);break;}
    const data=await res.json();
    for(const r of data.results??[]){
      if(r.in_trash||r.archived)continue;
      const title=(r.title??[]).map((t:any)=>t.plain_text??'').join('').replace(/\s+/g,'').replace(/DB$/i,'');
      const id=String(r.parent?.database_id??'').replace(/-/g,'');
      if(!title.includes('(학원)')||!/^[0-9a-f]{32}$/.test(id))continue;
      const prev=found.get(title);if(!prev||String(r.last_edited_time)>prev.edited)found.set(title,{url:`https://www.notion.so/${id}`,edited:String(r.last_edited_time)});
    }
    if(!data.has_more||!data.next_cursor)break;cursor=data.next_cursor;
  }
  return Object.fromEntries([...found].map(([k,v])=>[k,v.url]));
}
// The Views API needs a newer Notion-Version than the rest of the code base.
const VIEWS_VERSION='2026-03-11';
async function notionGet(path:string):Promise<any>{
  for(let attempt=0;attempt<3;attempt++){
    const res=await fetch(`${NOTION_API}${path}`,{headers:{Authorization:`Bearer ${NOTION_TOKEN}`,'Notion-Version':VIEWS_VERSION},signal:AbortSignal.timeout(10000)});
    if(res.status===429){await new Promise(r=>setTimeout(r,Math.min(5,Number(res.headers.get('Retry-After'))||1)*1000));continue;}
    if(!res.ok){console.error('notion views failed',res.status);return null;}
    return await res.json();
  }
  return null;
}
// URL of the database view named "웹훅등록" (the view that gathers the webhook buttons), or ''.
export async function webhookViewUrl(dbId:string):Promise<string>{
  let cursor='';
  for(let page=0;page<3;page++){
    const list=await notionGet(`/views?database_id=${dbId}&page_size=100${cursor?`&start_cursor=${encodeURIComponent(cursor)}`:''}`);
    if(!list)return '';
    for(const ref of list.results??[]){
      const id=String(ref.id??'').replace(/-/g,'');if(!/^[0-9a-f]{32}$/.test(id))continue;
      const view=await notionGet(`/views/${id}`);
      if(view&&String(view.name??'').replace(/\s+/g,'')==='웹훅등록')return `https://www.notion.so/${dbId}?v=${id}`;
    }
    if(!list.has_more||!list.next_cursor)break;cursor=list.next_cursor;
  }
  return '';
}
// Database and "웹훅등록" view links for the requested checklist DB names, three DBs at a time.
export async function buildNotionLinks(names:string[]):Promise<{name:string,db:string,view:string}[]>{
  const dbs=await notionDatabaseLinks();const wanted=names.filter(n=>dbs[n]);const out:{name:string,db:string,view:string}[]=[];let next=0;
  const worker=async()=>{while(next<wanted.length){const name=wanted[next++];const db=dbs[name];out.push({name,db,view:await webhookViewUrl(db.slice(-32))});}};
  await Promise.all([worker(),worker(),worker()]);
  return out;
}
export async function handleAdminSecurity(req:Request):Promise<Response> {
  let headers:Record<string,string>={'Content-Type':'application/json','Cache-Control':'no-store'};
  try {
    headers=cors(req,securityEnabled());if(req.method==='OPTIONS')return new Response('ok',{headers});
    if(req.method!=='POST')throw new SecurityError(405,'POST 요청만 지원합니다.');
    if(!securityEnabled())throw new SecurityError(503,'관리자 보안 기능의 최초 서버 설정이 필요합니다.');
    const raw=await req.text();if(raw.length>4096)throw new SecurityError(413,'요청이 너무 큽니다.');
    let b:any;try{b=JSON.parse(raw);}catch{throw new SecurityError(400,'요청 형식이 올바르지 않습니다.');}
    if(!b||typeof b!=='object'||Array.isArray(b))throw new SecurityError(400,'요청 형식이 올바르지 않습니다.');
    const result=(value:unknown)=>new Response(JSON.stringify(value),{headers});
    // Public status: never says whether the initial password is still active.
    if(b.action==='status'){await ensureInitialized();return result({ready:true,webhook_key_weak:fixedWebhookKey().length<32});}
    // Persistent global buckets; independent of spoofable browser IP headers.
    if(['login','change','class-set','webhook-start','webhook-cancel'].includes(b.action))await securityRpc('limit',{bucket:'security-'+b.action,max:60,seconds:3600});
    if(b.action==='webhook-links'&&b.refresh===true)await securityRpc('limit',{bucket:'security-webhook-links',max:10,seconds:3600});
    const session=req.headers.get('x-admin-key')??'';
    if(b.action==='login'&&b.scope==='class'){
      // Shared class (teacher) password: a 30-day session that may only call class-room (v2.5.65).
      await ensureInitialized();
      const info=await securityRpc('class-owner');
      const ok=await verifyPassword(b.password,info.password_hash??'');
      const token=randomToken();
      await securityRpc('class-login',{verified:ok,class_version:info.class_version,token_hash:await sha256(token)});
      return result({session:token});
    }
    if(b.action==='login'){
      await ensureInitialized();
      const info=await securityRpc('owner');
      const ok=await verifyPassword(b.password,info.password_hash??'');
      // The initial password may only open the settings page to change it.
      if(ok&&info.must_change&&b.scope!=='settings')throw new SecurityError(409,'초기 비밀번호 상태입니다. 관리자 설정 페이지에서 비밀번호를 먼저 변경해 주세요.');
      const token=randomToken();
      await securityRpc('login',{verified:ok,version:info.version,token_hash:await sha256(token),kind:b.scope==='kiosk'?'kiosk':'admin'});
      return result({session:token,must_change:!!info.must_change});
    }
    if(b.action==='logout'){if(session)await securityRpc('logout',{session_hash:await sha256(session)});return result({ok:true});}
    if(b.action==='profile'){
      const state=await securityRpc('profile',{session_hash:await sha256(session)});
      const next=nextRecommended(state.changed_at);
      return result({changed_at:state.changed_at,recommended_at:next,change_due:Date.now()>=Date.parse(next),must_change:!!state.must_change,
        class_password_set:!!state.class_password_set,class_changed_at:state.class_changed_at??null});
    }
    if(b.action==='change'){
      const ctx=await securityRpc('profile',{session_hash:await sha256(session)});
      if(!await verifyPassword(b.current_password,ctx.password_hash))throw new SecurityError(401,'현재 비밀번호가 올바르지 않습니다.');
      const password=validatePassword(b.new_password);
      if(password===b.current_password)throw new SecurityError(400,'현재 비밀번호와 다른 비밀번호를 입력해 주세요.');
      const internalKey=randomToken();
      const response=await securityRpc('change',{session_hash:await sha256(session),expected_version:ctx.version,password_hash:await hashPassword(password),internal_key:internalKey,internal_hash:await sha256(internalKey)});
      return result({ok:true,changed_at:response.changed_at,message:'변경 완료. 모든 기존 로그인 세션이 해제되었습니다.'});
    }
    if(b.action==='class-set'){
      // The owner confirms with the admin password; the class password must differ from it.
      const sessionHash=await sha256(session);
      const ctx=await securityRpc('profile',{session_hash:sessionHash});
      if(!await verifyPassword(b.current_password,ctx.password_hash))throw new SecurityError(401,'현재 비밀번호가 올바르지 않습니다.');
      const password=validatePassword(b.class_password);
      if(password===b.current_password)throw new SecurityError(400,'관리자 비밀번호와 다른 수업용 비밀번호를 정해 주세요.');
      const response=await securityRpc('class-set',{session_hash:sessionHash,password_hash:await hashPassword(password)});
      return result({ok:true,changed_at:response.changed_at,message:'수업용 비밀번호를 저장했어요. 선생님들은 새 비밀번호로 다시 로그인해야 해요.'});
    }
    // Webhook key rotation. The new key is returned once, on start, because the owner must paste it into
    // Notion; it is never stored in readable form and cannot be fetched again.
    if(b.action==='webhook-status'){
      const st=await securityRpc('webhook-status',{session_hash:await sha256(session)});
      const usage=(Array.isArray(st.usage)?st.usage:[]).filter((u:any)=>SECURITY_WEBHOOK_ROUTES.has(u.route));
      return result({rotating:!!st.rotating,started_at:st.started_at,changed_at:st.changed_at,weak:!st.changed_at&&fixedWebhookKey().length<32,usage,checks:st.checks??{}});
    }
    if(b.action==='webhook-links'){
      // Cached per academy; searching Notion (databases and their views) only on first use or refresh.
      const sessionHash=await sha256(session);
      await securityRpc('webhook-status',{session_hash:sessionHash}); // session check and must_change block
      let cached=await securityRpc('links-get',{session_hash:sessionHash});
      if(b.refresh===true||!Object.keys(cached.links??{}).length){
        const names=(Array.isArray(b.names)?b.names:[]).filter((n:unknown)=>typeof n==='string'&&n.length<=64).slice(0,60);
        await securityRpc('links-set',{session_hash:sessionHash,links:await buildNotionLinks(names)});
        cached=await securityRpc('links-get',{session_hash:sessionHash});
      }
      return result({links:cached.links??{},updated_at:cached.updated_at});
    }
    if(b.action==='webhook-check'){
      if(typeof b.item!=='string')throw new SecurityError(400,'항목 형식 오류');
      const response=await securityRpc('webhook-check',{session_hash:await sha256(session),item:b.item,checked:b.checked===true});
      return result({ok:true,checked_at:response.checked_at});
    }
    if(b.action==='webhook-start'||b.action==='webhook-cancel'){
      const sessionHash=await sha256(session);
      const ctx=await securityRpc('profile',{session_hash:sessionHash});
      if(!await verifyPassword(b.current_password,ctx.password_hash))throw new SecurityError(401,'현재 비밀번호가 올바르지 않습니다.');
      if(b.action==='webhook-cancel'){await securityRpc('webhook-cancel',{session_hash:sessionHash});return result({ok:true});}
      const key=randomToken(24);
      const response=await securityRpc('webhook-start',{session_hash:sessionHash,webhook_hash:await sha256(key)});
      return result({ok:true,key,started_at:response.started_at});
    }
    if(b.action==='webhook-finish'){
      const response=await securityRpc('webhook-finish',{session_hash:await sha256(session),force:b.force===true});
      if(response.needs_confirm)return new Response(JSON.stringify({error:'최근 7일 안에 이전 키로 호출된 버튼이 있습니다. 지금 완료하면 그 버튼은 동작하지 않습니다.',needs_confirm:true}),{status:409,headers});
      return result({ok:true,changed_at:response.changed_at});
    }
    throw new SecurityError(400,'지원하지 않는 작업입니다.');
  }catch(e){const status=e instanceof SecurityError?e.status:503;return new Response(JSON.stringify({error:e instanceof SecurityError?e.message:'처리하지 못했습니다. 서버 연결 상태를 확인해 주세요.'}),{status,headers});}
}
Deno.serve(handleAdminSecurity);
