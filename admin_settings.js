'use strict';
(() => {
const $=id=>document.getElementById(id);
const forms=['login-form','change-form','dashboard'];
let base='',session='',mustChange=false,busy=false;
const sessionKey='hada_owner_session_v1';
try{session=sessionStorage.getItem(sessionKey)||'';sessionStorage.removeItem('hada_admin_owner_email_draft_v1');}catch{}
function text(id,value){$(id).textContent=value;}
function notice(message){text('connection-status',message);}
function friendly(e){return e instanceof TypeError||e.name==='TimeoutError'||e.name==='AbortError'?'인증 서버에 연결하지 못했습니다. 연결 설정과 네트워크를 확인해 주세요.':(e.message||'처리하지 못했습니다.');}
function error(message){text('form-error',message);$('form-error').hidden=!message;}
function panel(id,title,description){forms.forEach(x=>$(x).hidden=x!==id);text('panel-title',title);text('panel-description',description);error('');$('retry').hidden=true;}
function clearPasswords(){document.querySelectorAll('input[type=password]').forEach(x=>x.value='');}
function forgetSession(){session='';mustChange=false;try{sessionStorage.removeItem(sessionKey);}catch{}clearPasswords();}
function loggedOutFacts(){text('owner-status','로그인 후 확인');text('last-change','로그인 후 표시');text('next-change','로그인 후 표시');}
async function request(action,values={}){
 const res=await fetch(base+'/functions/v1/admin-security',{method:'POST',headers:{'Content-Type':'application/json',...(session?{'x-admin-key':session}:{})},body:JSON.stringify({action,...values}),cache:'no-store',signal:AbortSignal.timeout(20000)});
 const data=await res.json().catch(()=>({}));if(!res.ok){const e=new Error(data.error||'인증 서버 응답을 확인하지 못했습니다.');e.status=res.status;throw e;}return data;
}
async function task(fn){if(busy)return;busy=true;error('');const buttons=[...document.querySelectorAll('button')];buttons.forEach(x=>x.disabled=true);try{await fn();}catch(e){error(friendly(e));}finally{busy=false;buttons.forEach(x=>x.disabled=false);}}
function date(iso){return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(iso));}
function showChange(initial){clearPasswords();$('cancel-change').hidden=initial;panel('change-form',initial?'초기 비밀번호를 변경해 주세요':'비밀번호 변경',initial?'초기 비밀번호 0000은 이 화면에서만 사용할 수 있어요. 새 비밀번호로 바꾸면 키오스크와 관리자 서류 화면을 사용할 수 있습니다.':'현재 비밀번호를 확인한 뒤 새 비밀번호로 바꿉니다.');$('current-password').focus();}
async function profile(){
 const info=await request('profile');mustChange=info.must_change;
 text('last-change',date(info.changed_at));text('next-change',mustChange?'변경 후 3개월 기준':date(info.recommended_at));
 notice('관리자 인증 서버에 연결되었습니다.');
 if(mustChange){text('owner-status','초기 비밀번호 사용 중');showChange(true);return;}
 text('owner-status','변경 완료');
 text('due-status',info.change_due?'마지막 변경 후 3개월이 지났습니다. 보안을 위해 비밀번호를 변경해 주세요.':'현재 권장 변경 기간 내에 있습니다. 유출이 의심되면 즉시 변경해 주세요.');
 panel('dashboard','관리자 보안 설정','Notion 웹훅 키를 수정하지 않고 관리자 비밀번호를 변경할 수 있어요.');
}
async function initialize(){
 try{
  if(!base){const res=await fetch('admin_config.json',{cache:'no-store'});if(!res.ok)throw new Error('학원별 공개 연결 설정 파일이 필요합니다.');const config=await res.json();const url=new URL(config.supabaseUrl);if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co')||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error('Supabase 연결 주소 설정을 확인해 주세요.');base=url.origin;}
  await request('status');
  notice('관리자 인증 서버에 연결되었습니다.');
  if(session){try{await profile();return;}catch{forgetSession();}}
  loggedOutFacts();panel('login-form','관리자 로그인','관리자 비밀번호로 로그인해 주세요.');
 }catch(e){panel('','인증 서버 연결 준비가 필요해요','기존 출결·웹훅 설정은 변경하지 않았습니다. 관리자 보안 기능이 활성화되면 이 화면에서 비밀번호를 관리할 수 있어요.');text('owner-status','서버 연결 후 확인');notice(friendly(e));$('retry').hidden=false;}
}
$('login-form').onsubmit=e=>{e.preventDefault();task(async()=>{const data=await request('login',{password:$('login-password').value,scope:'settings'});session=data.session;try{sessionStorage.setItem(sessionKey,session);}catch{}clearPasswords();await profile();});};
$('start-change').onclick=()=>showChange(false);
$('cancel-change').onclick=()=>task(profile);
$('change-form').onsubmit=e=>{e.preventDefault();task(async()=>{if($('new-password').value!==$('confirm-password').value)throw new Error('새 비밀번호와 확인 값이 일치하지 않습니다.');await request('change',{current_password:$('current-password').value,new_password:$('new-password').value});forgetSession();loggedOutFacts();panel('login-form','비밀번호를 변경했습니다','내부 인증키도 함께 갱신되었습니다. 새 비밀번호로 다시 로그인해 주세요.');notice('변경 완료. 기존 로그인은 모두 해제되었고 Notion 웹훅 키는 유지됩니다.');});};
$('logout').onclick=()=>task(async()=>{try{await request('logout');}finally{forgetSession();loggedOutFacts();panel('login-form','로그아웃했습니다','관리자 비밀번호로 다시 로그인할 수 있어요.');}});
$('retry').onclick=()=>task(initialize);
initialize();
})();
