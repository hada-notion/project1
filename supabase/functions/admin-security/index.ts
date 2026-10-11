import { SecurityError,securityEnabled,securityRpc,sha256,randomToken,randomCode,otpHash,sendCode,mailReady,normalizeEmail,validatePassword,hashPassword,verifyPassword,maskedEmail,nextRecommended } from '../_shared/adminSecurity.ts';
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
    if(b.action==='status'){const state=await securityRpc('status');return result({configured:state.configured,mail_ready:mailReady()});}
    // Persistent global + address buckets; independent of spoofable browser IP headers.
    if(['login','setup-send','change-send','setup-complete','change-complete'].includes(b.action))
      await securityRpc('limit',{bucket:'security-'+b.action,max:b.action.endsWith('send')?10:60,seconds:3600});
    const session=req.headers.get('x-admin-key')??'';
    if(b.action==='login'){
      const info=await securityRpc('owner');
      const ok=await verifyPassword(b.password,info.password_hash??'');
      const token=randomToken();
      await securityRpc('login',{verified:ok,version:info.version,token_hash:await sha256(token)});
      return result({session:token});
    }
    if(b.action==='logout'){if(session)await securityRpc('logout',{session_hash:await sha256(session)});return result({ok:true});}
    if(b.action==='profile'){
      const state=await securityRpc('profile',{session_hash:await sha256(session)});
      const next=nextRecommended(state.changed_at);
      return result({email:maskedEmail(state.email),changed_at:state.changed_at,recommended_at:next,change_due:Date.now()>=Date.parse(next)});
    }
    const setup=b.action==='setup-send'||b.action==='setup-complete';
    const change=b.action==='change-send'||b.action==='change-complete';
    if(!setup&&!change)throw new SecurityError(400,'지원하지 않는 작업입니다.');
    const token=typeof b.setup_token==='string'?b.setup_token:'';
    if(setup&&(!/^[0-9a-f]{64}$/.test(token)))throw new SecurityError(401,'유효한 일회용 설정 링크가 필요합니다.');
    const context=setup?await securityRpc('setup-context',{setup_hash:await sha256(token)}):await securityRpc('profile',{session_hash:await sha256(session)});
    if(b.action.endsWith('send')){
      if(!mailReady())throw new SecurityError(503,'인증메일 발송 서비스 연결이 필요합니다.');
      if(change){if(!await verifyPassword(b.password,context.password_hash))throw new SecurityError(401,'현재 비밀번호가 올바르지 않습니다.');}
      const email=setup?normalizeEmail(b.email):context.email;
      const id=crypto.randomUUID(),code=randomCode();
      await securityRpc('begin-otp',{id,purpose:setup?'setup':'change',email,context_hash:await sha256(setup?token:session),version:context.version,code_hash:await otpHash(id,code)});
      try{await sendCode(email,code,id);}catch(e){await securityRpc('cancel-otp',{id});throw e;}
      return result({challenge_id:id,email:maskedEmail(email),expires_in:600});
    }
    if(typeof b.challenge_id!=='string'||!/^[0-9a-f-]{36}$/.test(b.challenge_id)||typeof b.code!=='string'||!/^\d{6}$/.test(b.code))throw new SecurityError(400,'6자리 인증번호를 입력해 주세요.');
    const password=validatePassword(b.new_password),passwordHash=await hashPassword(password);
    const fixed=Deno.env.get('WEBHOOK_SECRET')||Deno.env.get('ADMIN_SECRET')||'';
    if(setup&&fixed.length<32)throw new SecurityError(503,'32자 이상의 학원 전용 웹훅 키를 먼저 설정해 주세요.');
    const internalKey=randomToken();
    const response=await securityRpc('complete',{id:b.challenge_id,code_hash:await otpHash(b.challenge_id,b.code),purpose:setup?'setup':'change',context_hash:await sha256(setup?token:session),password_hash:passwordHash,internal_key:internalKey,internal_hash:await sha256(internalKey),webhook_hash:setup?await sha256(fixed):null,expected_version:context.version});
    return result({ok:true,changed_at:response.changed_at,message:'설정 완료. 모든 기존 로그인 세션이 해제되었습니다.'});
  }catch(e){const status=e instanceof SecurityError?e.status:503;return new Response(JSON.stringify({error:e instanceof SecurityError?e.message:'처리하지 못했습니다. 서버 연결 상태를 확인해 주세요.'}),{status,headers});}
}
Deno.serve(handleAdminSecurity);
