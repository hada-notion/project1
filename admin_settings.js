'use strict';
(() => {
const $=id=>document.getElementById(id);
const forms=['login-form','setup-form','change-form','verify-form','dashboard'];
let base='',session='',setupToken='',challenge='',purpose='setup',busy=false;
const sessionKey='hada_owner_session_v1';
try{session=sessionStorage.getItem(sessionKey)||'';sessionStorage.removeItem('hada_admin_owner_email_draft_v1');}catch{}
const fragment=new URLSearchParams(location.hash.slice(1));
setupToken=fragment.get('setup')||'';
if(location.hash)history.replaceState(null,'',location.pathname+location.search);
function text(id,value){$(id).textContent=value;}
function notice(message){text('connection-status',message);}
function friendly(e){return e instanceof TypeError||e.name==='TimeoutError'||e.name==='AbortError'?'인증 서버에 연결하지 못했습니다. 연결 설정과 네트워크를 확인해 주세요.':(e.message||'처리하지 못했습니다.');}
function error(message){text('form-error',message);$('form-error').hidden=!message;}
function panel(id,title,description){forms.forEach(x=>$(x).hidden=x!==id);text('panel-title',title);text('panel-description',description);error('');$('retry').hidden=true;}
function clearPasswords(){document.querySelectorAll('input[type=password]').forEach(x=>x.value='');$('verification-code').value='';}
function forgetSession(){session='';try{sessionStorage.removeItem(sessionKey);}catch{}clearPasswords();}
async function request(action,values={}){
 const res=await fetch(base+'/functions/v1/admin-security',{method:'POST',headers:{'Content-Type':'application/json',...(session?{'x-admin-key':session}:{})},body:JSON.stringify({action,...values}),cache:'no-store',signal:AbortSignal.timeout(20000)});
 const data=await res.json().catch(()=>({}));if(!res.ok){const e=new Error(data.error||'인증 서버 응답을 확인하지 못했습니다.');e.status=res.status;throw e;}return data;
}
async function task(fn){if(busy)return;busy=true;error('');const buttons=[...document.querySelectorAll('button')];buttons.forEach(x=>x.disabled=true);try{await fn();}catch(e){error(friendly(e));}finally{busy=false;buttons.forEach(x=>x.disabled=false);}}
function date(iso){return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(iso));}
async function profile(){const info=await request('profile');text('owner-status',info.email);text('last-change',date(info.changed_at));text('next-change',date(info.recommended_at));text('due-status',info.change_due?'마지막 변경 후 3개월이 지났습니다. 보안을 위해 비밀번호를 변경해 주세요.':'현재 권장 변경 기간 내에 있습니다. 유출이 의심되면 즉시 변경해 주세요.');panel('dashboard','관리자 보안 설정','웹훅 헤더를 수정하지 않고 관리용 비밀번호를 변경할 수 있어요.');notice('관리자 인증 서버에 연결되었습니다.');}
async function initialize(){
 try{
  if(!base){const res=await fetch('admin_config.json',{cache:'no-store'});if(!res.ok)throw new Error('학원별 공개 연결 설정 파일이 필요합니다.');const config=await res.json();const url=new URL(config.supabaseUrl);if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co')||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error('Supabase 연결 주소 설정을 확인해 주세요.');base=url.origin;}
  const state=await request('status');
  text('owner-status',state.configured?'등록 완료 · 로그인 후 확인':'아직 미등록');
  notice(state.mail_ready?'관리자 인증 서버에 연결되었습니다.':'서버 연결 완료. 인증메일 발송 서비스 설정이 필요합니다.');
  if(state.configured){setupToken='';if(session){try{await profile();return;}catch{forgetSession();}}panel('login-form','관리자 로그인','등록한 관리용 비밀번호로 로그인해 주세요.');}
  else if(setupToken){forgetSession();panel('setup-form','소유자 이메일 등록','이메일 인증 후 관리용 비밀번호를 설정합니다. 최초 설정 링크는 한 번만 사용할 수 있어요.');}
  else{forgetSession();panel('','최초 설정 링크가 필요해요','배포 담당자에게 전달받은 학원 전용 일회용 설정 링크로 접속해 주세요. 일반 공개 주소만으로는 소유자를 등록할 수 없습니다.');}
 }catch(e){panel('','인증 서버 연결 준비가 필요해요','기존 출결·웹훅 설정은 변경하지 않았습니다. 최초 서버 연결 설정이 완료되면 이 화면에서 등록할 수 있어요.');text('owner-status','서버 연결 후 확인');notice(friendly(e));$('retry').hidden=false;}
}
$('login-form').onsubmit=e=>{e.preventDefault();task(async()=>{const data=await request('login',{password:$('login-password').value});session=data.session;try{sessionStorage.setItem(sessionKey,session);}catch{}clearPasswords();await profile();});};
$('setup-form').onsubmit=e=>{e.preventDefault();task(async()=>{const data=await request('setup-send',{setup_token:setupToken,email:$('owner-email').value});purpose='setup';challenge=data.challenge_id;panel('verify-form','이메일 인증과 비밀번호 설정',`${data.email}로 인증번호를 발송했습니다. 10분 안에 입력해 주세요.`);$('verification-code').focus();});};
$('start-change').onclick=()=>{clearPasswords();panel('change-form','비밀번호 변경 인증','현재 비밀번호를 확인한 뒤 등록된 이메일로 인증번호를 보냅니다.');$('current-password').focus();};
$('change-form').onsubmit=e=>{e.preventDefault();task(async()=>{const data=await request('change-send',{password:$('current-password').value});clearPasswords();purpose='change';challenge=data.challenge_id;panel('verify-form','새 비밀번호 설정',`${data.email}로 인증번호를 발송했습니다. 10분 안에 입력해 주세요.`);$('verification-code').focus();});};
$('verify-form').onsubmit=e=>{e.preventDefault();task(async()=>{if($('new-password').value!==$('confirm-password').value)throw new Error('새 비밀번호와 확인 값이 일치하지 않습니다.');await request(purpose==='setup'?'setup-complete':'change-complete',{setup_token:purpose==='setup'?setupToken:undefined,challenge_id:challenge,code:$('verification-code').value,new_password:$('new-password').value});setupToken='';challenge='';forgetSession();text('owner-status','등록 완료 · 로그인 후 확인');text('last-change','로그인 후 표시');text('next-change','로그인 후 표시');panel('login-form','설정이 완료되었습니다','비밀번호와 내부 인증키가 함께 갱신되었습니다. 새 비밀번호로 로그인해 주세요.');notice('설정 완료. 기존 로그인은 모두 해제되었고 웹훅 헤더는 유지됩니다.');});};
$('restart-verification').onclick=()=>{clearPasswords();panel(purpose==='setup'?'setup-form':'change-form','인증번호 다시 요청','이전 발송 후 60초가 지나면 새 인증번호를 요청할 수 있습니다. 새 요청 시 이전 번호는 사용할 수 없습니다.');};
$('logout').onclick=()=>task(async()=>{try{await request('logout');}finally{forgetSession();panel('login-form','로그아웃했습니다','관리용 비밀번호로 다시 로그인할 수 있어요.');text('owner-status','등록 완료 · 로그인 후 확인');text('last-change','로그인 후 표시');text('next-change','로그인 후 표시');}});
$('retry').onclick=()=>task(initialize);
window.addEventListener('hashchange',()=>{const token=new URLSearchParams(location.hash.slice(1)).get('setup');if(token){setupToken=token;history.replaceState(null,'',location.pathname+location.search);task(initialize);}});
initialize();
})();
