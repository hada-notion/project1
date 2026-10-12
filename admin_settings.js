'use strict';
(() => {
const $=id=>document.getElementById(id);
const forms=['login-form','change-form','dashboard','webhook-form','webhook-key','webhook-progress'];
let base='',session='',mustChange=false,busy=false;
const sessionKey='hada_owner_session_v1';
try{session=sessionStorage.getItem(sessionKey)||'';sessionStorage.removeItem('hada_admin_owner_email_draft_v1');}catch{}
function text(id,value){$(id).textContent=value;}
function notice(message){text('connection-status',message);}
function friendly(e){return e instanceof TypeError||e.name==='TimeoutError'||e.name==='AbortError'?'인증 서버에 연결하지 못했습니다. 연결 설정과 네트워크를 확인해 주세요.':(e.message||'처리하지 못했습니다.');}
function error(message){text('form-error',message);$('form-error').hidden=!message;}
function panel(id,title,description){forms.forEach(x=>$(x).hidden=x!==id);text('panel-title',title);text('panel-description',description);error('');$('retry').hidden=true;}
function clearPasswords(){document.querySelectorAll('input[type=password]').forEach(x=>x.value='');$('new-webhook-key').value='';}
function forgetSession(){session='';mustChange=false;try{sessionStorage.removeItem(sessionKey);}catch{}clearPasswords();}
function loggedOutFacts(){text('owner-status','로그인 후 확인');text('last-change','로그인 후 표시');text('next-change','로그인 후 표시');text('webhook-fact','평소 유지 · 사고 시 별도 교체');}
async function request(action,values={}){
 const res=await fetch(base+'/functions/v1/admin-security',{method:'POST',headers:{'Content-Type':'application/json',...(session?{'x-admin-key':session}:{})},body:JSON.stringify({action,...values}),cache:'no-store',signal:AbortSignal.timeout(20000)});
 const data=await res.json().catch(()=>({}));if(!res.ok){const e=new Error(data.error||'인증 서버 응답을 확인하지 못했습니다.');e.status=res.status;e.needsConfirm=!!data.needs_confirm;throw e;}return data;
}
// Webhook key rotation. The new key exists only in the readonly field until the owner leaves that view.
let webhook={rotating:false,usage:[]};
async function loadWebhook(){
 webhook=await request('webhook-status');
 text('webhook-fact',webhook.rotating?`교체 진행 중 (${date(webhook.started_at)} 시작)`:webhook.changed_at?`마지막 교체 ${date(webhook.changed_at)}`:'평소 유지 · 사고 시 별도 교체');
 text('webhook-summary',webhook.rotating?'웹훅 키 교체가 진행 중입니다. 옛 키를 쓰는 버튼이 남았는지 확인한 뒤 교체를 완료해 주세요.':webhook.weak?'현재 웹훅 키가 짧습니다(32자 미만). 시간 여유가 있을 때 교체를 권장합니다.':'Notion 웹훅 키는 평소 그대로 둡니다. 유출이 의심될 때만 교체하세요.');
 text('open-webhook',webhook.rotating?'웹훅 키 교체 현황':'웹훅 키 교체');
}
function showProgress(){
 text('webhook-started',`${date(webhook.started_at)}부터 옛 키와 새 키가 모두 동작하고 있습니다.`);
 const rows=$('usage-rows');rows.replaceChildren();const byRoute=new Map();
 for(const u of webhook.usage){if(!byRoute.has(u.route))byRoute.set(u.route,{});byRoute.get(u.route)[u.key]=u;}
 // Functions still called with the old key first.
 const routes=[...byRoute.keys()].sort((a,b)=>(byRoute.get(b).old?1:0)-(byRoute.get(a).old?1:0)||a.localeCompare(b));
 for(const route of routes){const tr=document.createElement('tr');const v=byRoute.get(route);
  for(const [value,cls] of [[route,''],[v.old?`${shortDate(v.old.last_at)} · ${v.old.calls}회`:'—',v.old?'old':''],[v.new?`${shortDate(v.new.last_at)} · ${v.new.calls}회`:'—','']]){const td=document.createElement('td');td.textContent=value;if(cls)td.className=cls;tr.append(td);}
  rows.append(tr);}
 $('usage-empty').hidden=routes.length>0;
 panel('webhook-progress','웹훅 키 교체 진행 중','Notion 버튼·자동화를 새 키로 바꾸고, 옛 키 호출이 사라지면 완료합니다.');
}
async function openWebhook(){await loadWebhook();if(webhook.rotating){showProgress();return;}clearPasswords();panel('webhook-form','웹훅 키 교체','유출이 의심될 때 Notion 버튼·자동화를 멈추지 않고 새 키로 옮깁니다.');$('webhook-password').focus();}
async function task(fn){if(busy)return;busy=true;error('');const buttons=[...document.querySelectorAll('button')];buttons.forEach(x=>x.disabled=true);try{await fn();}catch(e){error(friendly(e));}finally{busy=false;buttons.forEach(x=>x.disabled=false);}}
function shortDate(iso){return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(iso));}
function date(iso){return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(iso));}
function showChange(initial){clearPasswords();$('cancel-change').hidden=initial;panel('change-form',initial?'초기 비밀번호를 변경해 주세요':'비밀번호 변경',initial?'초기 비밀번호 0000은 이 화면에서만 사용할 수 있어요. 새 비밀번호로 바꾸면 키오스크와 관리자 서류 화면을 사용할 수 있습니다.':'현재 비밀번호를 확인한 뒤 새 비밀번호로 바꿉니다.');$('current-password').focus();}
async function profile(){
 const info=await request('profile');mustChange=info.must_change;
 text('last-change',date(info.changed_at));text('next-change',mustChange?'변경 후 3개월 기준':date(info.recommended_at));
 notice('관리자 인증 서버에 연결되었습니다.');
 if(mustChange){text('owner-status','초기 비밀번호 사용 중');showChange(true);return;}
 text('owner-status','변경 완료');
 try{await loadWebhook();}catch{text('webhook-summary','웹훅 키 상태를 확인하지 못했습니다. 잠시 후 다시 로그인해 주세요.');}
 text('due-status',info.change_due?'마지막 변경 후 3개월이 지났습니다. 보안을 위해 비밀번호를 변경해 주세요.':'현재 권장 변경 기간 내에 있습니다. 유출이 의심되면 즉시 변경해 주세요.');
 panel('dashboard','관리자 보안 설정','관리자 비밀번호는 Notion 웹훅 키와 따로 바꿀 수 있어요.');
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
$('open-webhook').onclick=()=>task(openWebhook);
$('webhook-back').onclick=()=>task(profile);
$('progress-back').onclick=()=>task(profile);
$('webhook-form').onsubmit=e=>{e.preventDefault();task(async()=>{
 const data=await request('webhook-start',{current_password:$('webhook-password').value});clearPasswords();
 $('new-webhook-key').value=data.key;panel('webhook-key','새 웹훅 키가 만들어졌습니다','지금부터 옛 키와 새 키가 모두 동작합니다. 아래 키를 복사해 주세요.');$('new-webhook-key').select();});};
$('copy-webhook-key').onclick=async()=>{const field=$('new-webhook-key');try{await navigator.clipboard.writeText(field.value);notice('새 웹훅 키를 복사했습니다. 붙여 넣은 뒤 클립보드를 비워 두세요.');}catch{field.select();notice('자동 복사가 막혔습니다. 선택된 키를 Ctrl+C로 복사해 주세요.');}};
$('webhook-key-done').onclick=()=>{if(!confirm('이 화면을 벗어나면 새 웹훅 키를 다시 볼 수 없습니다. 복사했나요?'))return;task(async()=>{$('new-webhook-key').value='';await loadWebhook();showProgress();});};
$('webhook-refresh').onclick=()=>task(async()=>{await loadWebhook();showProgress();});
$('webhook-finish').onclick=()=>task(async()=>{
 if(!confirm('교체를 완료하면 옛 키로 오는 Notion 호출은 모두 거부됩니다. 완료할까요?'))return;
 let done;try{done=await request('webhook-finish');}catch(e){if(!e.needsConfirm)throw e;if(!confirm(e.message+' 그래도 완료할까요?'))return;done=await request('webhook-finish',{force:true});}
 await profile();notice(`웹훅 키 교체를 완료했습니다(${date(done.changed_at)}). 옛 키는 더 이상 동작하지 않습니다.`);});
$('webhook-cancel').onclick=()=>task(async()=>{
 if(!$('cancel-password').value)throw new Error('교체를 취소하려면 현재 관리자 비밀번호를 입력해 주세요.');
 if(!confirm('새 키를 버리고 옛 키로 되돌립니다. 이미 새 키로 바꾼 버튼은 다시 옛 키로 돌려야 합니다. 취소할까요?'))return;
 await request('webhook-cancel',{current_password:$('cancel-password').value});clearPasswords();await profile();notice('웹훅 키 교체를 취소했습니다. 옛 키만 동작합니다.');});
initialize();
})();
