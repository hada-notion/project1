import { SecurityError,securityEnabled,securityRpc,sha256,randomToken,validatePassword,hashPassword,verifyPassword,nextRecommended,ensureInitialized,fixedWebhookKey } from '../_shared/adminSecurity.ts';
// While security is disabled the function only answers with a fixed 503 message and no secrets, so the
// browser must be able to read it for the legacy-login fallback even before ADMIN_ALLOWED_ORIGINS is set.
function cors(req:Request,enforceOrigin:boolean):Record<string,string> {
  const origin=req.headers.get('Origin')??'';
  const allowed=(Deno.env.get('ADMIN_ALLOWED_ORIGINS')??'').split(',').map(x=>x.trim()).filter(Boolean);
  if(enforceOrigin&&origin&&!allowed.includes(origin))throw new SecurityError(403,'허용되지 않은 관리 페이지입니다.');
  return {'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin',...(origin?{'Access-Control-Allow-Origin':origin}:{}),'Access-Control-Allow-Headers':'content-type, x-admin-key, authorization, apikey','Access-Control-Allow-Methods':'POST, OPTIONS'};
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
    if(b.action==='login'||b.action==='change')await securityRpc('limit',{bucket:'security-'+b.action,max:60,seconds:3600});
    const session=req.headers.get('x-admin-key')??'';
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
      return result({changed_at:state.changed_at,recommended_at:next,change_due:Date.now()>=Date.parse(next),must_change:!!state.must_change});
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
    throw new SecurityError(400,'지원하지 않는 작업입니다.');
  }catch(e){const status=e instanceof SecurityError?e.status:503;return new Response(JSON.stringify({error:e instanceof SecurityError?e.message:'처리하지 못했습니다. 서버 연결 상태를 확인해 주세요.'}),{status,headers});}
}
Deno.serve(handleAdminSecurity);
