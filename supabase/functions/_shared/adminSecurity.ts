// Server-only owner authentication. Never return internal or webhook keys to a browser.
export const SECURITY_WEBHOOK_ROUTES = new Set([
  'cascade-delete','create-assignment','create-learning-record','fix-attendance',
  'generate-classes','generate-report','generate-tuition','mark-report-source-dirty',
  'send-report','send-daily-report','send-class-daily-reports','send-tuition-notice',
  'send-textbook-notice','send-selected-notifications','send-inquiry-receipt',
  'sync-attendance','sync-class-report-cache','sync-dashboard-link','sync-exam-scope',
  'sync-registration-class-session','sync-registration-end','sync-registration-enroll',
  'sync-registration-textbook','sync-registration-timetable','sync-report-cache',
  'sync-school-calendar','sync-student-report','sync-textbook-distribution',
]);
export const SECURITY_BROWSER_ROUTES = new Set([
  'list-students','kiosk-checkin','get-legal-document-data','school-api',
  'sync-school-calendar','sync-school-schedules','sync-student-report','toggle-report-link',
]);
export function securityEnabled(): boolean { return Deno.env.get('ADMIN_SECURITY_ENABLED') === 'true'; }
export class SecurityError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function securityRpc(action: string, data: Record<string, unknown> = {}): Promise<any> {
  const base = Deno.env.get('SB_URL'), key = Deno.env.get('SB_SERVICE_ROLE_KEY');
  if (!base || !key) throw new SecurityError(503, '관리자 인증 서버 설정이 필요합니다.');
  const res = await fetch(`${base.replace(/\/$/,'')}/rest/v1/rpc/hada_security_command`, {
    method: 'POST', headers: { 'Content-Type':'application/json', apikey:key, Authorization:`Bearer ${key}` },
    body: JSON.stringify({p_action:action,p_data:data}), signal:AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new SecurityError(503, '관리자 인증 저장소에 연결하지 못했습니다.');
  const result = await res.json();
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new SecurityError(503, '관리자 인증 응답 형식이 올바르지 않습니다.');
  if (result.error) throw new SecurityError(result.status ?? 400, result.error);
  return result;
}
export function randomToken(bytes = 32): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)),x=>x.toString(16).padStart(2,'0')).join('');
}
export async function sha256(value:string):Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
}
export function equalSecret(a:string,b:string):boolean {
  const aa=new TextEncoder().encode(a),bb=new TextEncoder().encode(b);let diff=aa.length^bb.length;
  for(let i=0;i<Math.max(aa.length,bb.length);i++)diff|=(aa[i]??0)^(bb[i]??0);
  return diff===0;
}
export function normalizeEmail(raw:unknown):string {
  if(typeof raw!=='string')throw new SecurityError(400,'이메일을 입력해 주세요.');
  const value=raw.trim().toLowerCase();
  if(value.length>254||! /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value))throw new SecurityError(400,'올바른 이메일 주소를 입력해 주세요.');
  return value;
}
export function validatePassword(raw:unknown):string {
  if(typeof raw!=='string'||raw.length<12||raw.length>128||raw.trim()!==raw)throw new SecurityError(400,'비밀번호는 앞뒤 공백 없이 12~128자로 입력해 주세요.');
  return raw;
}
export async function hashPassword(password:string,salt=randomToken(16)):Promise<string> {
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:600000,hash:'SHA-256'},key,256);
  const digest=Array.from(new Uint8Array(bits),x=>x.toString(16).padStart(2,'0')).join('');
  return `pbkdf2-sha256$600000$${salt}$${digest}`;
}
export async function verifyPassword(password:unknown,encoded:string):Promise<boolean> {
  if(typeof password!=='string'||password.length>128)return false;
  if(!/^pbkdf2-sha256\$600000\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(encoded))return false;
  return equalSecret(await hashPassword(password,encoded.split('$')[2]),encoded);
}
export function routeName(req:Request):string { return new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? ''; }
export async function authorizeKey(req:Request,provided:unknown,legacy:string):Promise<boolean> {
  if(typeof provided!=='string'||!provided||provided.length>1024)return false;
  if(!securityEnabled())return !!legacy && equalSecret(provided,legacy);
  const result=await securityRpc('authorize',{candidate:await sha256(provided)});
  const route=routeName(req);
  if(result.kind==='internal')return true;
  if(result.kind==='session')return SECURITY_BROWSER_ROUTES.has(route);
  if(result.kind==='webhook')return SECURITY_WEBHOOK_ROUTES.has(route);
  return false;
}
export async function currentInternalKey():Promise<string> {
  const state=await securityRpc('internal');
  if(!state.internal_key)throw new SecurityError(503,'소유자 최초 설정을 완료해 주세요.');
  return state.internal_key;
}
export function mailReady():boolean { return !!Deno.env.get('ADMIN_MAIL_API_KEY') && !!Deno.env.get('ADMIN_MAIL_FROM'); }
export async function sendCode(email:string,code:string,id:string):Promise<void> {
  if(!mailReady())throw new SecurityError(503,'인증메일 발송 서비스 연결이 필요합니다.');
  const res=await fetch('https://api.resend.com/emails',{
    method:'POST',headers:{Authorization:`Bearer ${Deno.env.get('ADMIN_MAIL_API_KEY')}`,'Content-Type':'application/json','Idempotency-Key':id},
    body:JSON.stringify({from:Deno.env.get('ADMIN_MAIL_FROM'),to:[email],subject:'하다 학원관리 관리자 인증번호',text:`관리자 인증번호: ${code}\n\n10분 안에 입력해 주세요. 본인이 요청하지 않았다면 무시하세요. 인증번호를 타인에게 전달하지 마세요.`}),signal:AbortSignal.timeout(15000),
  });
  if(!res.ok)throw new SecurityError(503,'인증메일 발송에 실패했습니다. 잠시 후 다시 요청해 주세요.');
}
export function randomCode():string {
  // Rejection sampling avoids modulo bias.
  let n:number;do{n=crypto.getRandomValues(new Uint32Array(1))[0];}while(n>=4294000000);
  return String(n%1000000).padStart(6,'0');
}
export async function otpHash(id:string,code:string):Promise<string> {
  const key=Deno.env.get('SB_SERVICE_ROLE_KEY');if(!key)throw new SecurityError(503,'서버 설정이 필요합니다.');
  const hmac=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',hmac,new TextEncoder().encode(`${id}:${code}`))),x=>x.toString(16).padStart(2,'0')).join('');
}
export function maskedEmail(email:string):string { const [local,host]=email.split('@');return `${local.slice(0,2)}***@${host}`; }
export function nextRecommended(iso:string):string {
  const value=new Date(iso);const day=value.getUTCDate();value.setUTCDate(1);value.setUTCMonth(value.getUTCMonth()+3);
  const last=new Date(Date.UTC(value.getUTCFullYear(),value.getUTCMonth()+1,0)).getUTCDate();value.setUTCDate(Math.min(day,last));return value.toISOString();
}
