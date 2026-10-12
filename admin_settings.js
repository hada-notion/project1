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
function panel(id,title,description){forms.forEach(x=>$(x).hidden=x!==id);text('panel-title',title);text('panel-description',description);error('');$('retry').hidden=true;$('main-card').classList.toggle('centered',!!id&&!['dashboard','webhook-progress'].includes(id));}
function clearPasswords(){document.querySelectorAll('input[type=password]').forEach(x=>x.value='');$('new-webhook-key').value='';}
function forgetSession(){session='';mustChange=false;try{sessionStorage.removeItem(sessionKey);}catch{}clearPasswords();}
function loggedOutFacts(){text('owner-status','로그인 후 확인');text('last-change','로그인 후 표시');text('next-change','로그인 후 표시');text('webhook-fact','평소 유지 · 사고 시 별도 교체');}
async function request(action,values={},timeout=20000){
 const res=await fetch(base+'/functions/v1/admin-security',{method:'POST',headers:{'Content-Type':'application/json',...(session?{'x-admin-key':session}:{})},body:JSON.stringify({action,...values}),cache:'no-store',signal:AbortSignal.timeout(timeout)});
 const data=await res.json().catch(()=>({}));if(!res.ok){const e=new Error(data.error||'인증 서버 응답을 확인하지 못했습니다.');e.status=res.status;e.needsConfirm=!!data.needs_confirm;throw e;}return data;
}
// Webhook key rotation. The new key exists only in the readonly field until the owner leaves that view.
let webhook={rotating:false,usage:[],checks:{}},unchecked=0;
// Every Notion button/automation that sends the webhook key, grouped by database (docs/버튼-웹훅-매핑.md).
// Each item: [id, name, kind, route]. adminSecurity_test.ts checks that the routes here are exactly
// SECURITY_WEBHOOK_ROUTES, so a new webhook function cannot be left out of the checklist.
const BUTTON='버튼',AUTO='자동화';
const CHECKLIST=[
 ['등록(학원)',[
  ['reg-link-regenerate','링크 재발급',BUTTON,route('toggle-report-link')],
  ['reg-link-disable','링크 비활성화 (체크됨일 때)',AUTO,route('toggle-report-link')],
  ['reg-link-enable','링크 활성화 (체크 해제됨일 때)',AUTO,route('toggle-report-link')],
  ['reg-report-sync','학생 페이지 동기화',BUTTON,route('sync-report-cache')],
  ['reg-textbook','교재 생성',BUTTON,route('sync-registration-textbook')],
  ['reg-enroll','시간표 설정',BUTTON,route('sync-registration-enroll')],
  ['reg-session','수업 생성',BUTTON,route('sync-registration-class-session')],
  ['reg-end','종료 처리',BUTTON,route('sync-registration-end')],
  ['reg-timetable','클래스 연결 (속성 편집 자동화)',AUTO,route('sync-registration-timetable')]]],
 ['클래스(학원)',[
  ['class-tuition','월 수강료 생성',BUTTON,route('generate-tuition')],
  ['class-textbook-fee','교재비 생성',BUTTON,route('sync-textbook-distribution')],
  ['class-textbook','교재 생성',BUTTON,route('sync-registration-textbook')],
  ['class-report-sync','학생 페이지 동기화',BUTTON,route('sync-class-report-cache')],
  ['class-report','보고서 생성',BUTTON,route('generate-report')]]],
 ['시간표(학원)',[['timetable-classes','수업추가',BUTTON,route('generate-classes')]]],
 ['메뉴(학원)',[['menu-bulk-classes','다음주 수업 일괄 생성',BUTTON,route('generate-classes')]],{
  text:'메뉴 DB의 어떤 페이지(예: 수업 HOME)를 열어도 제목 아래 속성 줄에 "다음주 수업 일괄 생성" 버튼이 있습니다. 속성 이름을 클릭하고 "자동화 편집"을 눌러 웹훅 보내기의 값 칸을 바꿉니다. 메뉴 DB에는 웹훅등록 보기가 없어도 됩니다.',
  image:'assets/admin-settings/menu-bulk-button.png',alt:'메뉴 페이지 상단 속성 줄의 다음주 수업 일괄 생성 버튼'}],
 ['수업(학원)',[
  ['session-record','학습기록 생성',BUTTON,route('create-learning-record')],
  ['session-attendance','출석 조정',BUTTON,route('fix-attendance')],
  ['session-reports','보고서 일괄 전송',BUTTON,route('send-class-daily-reports')],
  ['session-delete','삭제',BUTTON,route('cascade-delete')]]],
 ['출석(학원)',[
  ['attendance-record','학습기록 생성',BUTTON,route('create-learning-record')],
  ['attendance-report','보고서 전송',BUTTON,route('send-daily-report')],
  ['attendance-delete','삭제',BUTTON,route('cascade-delete')]]],
 ['학습기록(학원)',[
  ['record-assignment','학습활동 생성',BUTTON,route('create-assignment')],
  ['record-delete','삭제',BUTTON,route('cascade-delete')]]],
 ['학습활동(학원)',[['assignment-delete','삭제',BUTTON,route('cascade-delete')]]],
 ['보고서(학원)',[['report-send','보고서 전송',BUTTON,route('send-report')]]],
 ['알림톡 발송함(학원)',[['outbox-send','일괄 전송',BUTTON,route('send-selected-notifications')]]],
 ['수강료(학원)',[['tuition-notice','수강료 안내 발송',BUTTON,route('send-tuition-notice')]]],
 ['교재비(학원)',[
  ['cart-notice','안내문 전송',BUTTON,route('send-textbook-notice')],
  ['cart-progress-book','진도교재 담기',BUTTON,route('sync-textbook-distribution')],
  ['cart-delete','삭제',BUTTON,route('cascade-delete')]]],
 ['교재배부(학원)',[['distribution-delete','삭제',BUTTON,route('cascade-delete')]]],
 ['교재결제(학원)',[['payment-delete','삭제',BUTTON,route('cascade-delete')]]],
 ['학생(학원)',[
  ['student-inquiry-auto','페이지 추가 (상담 폼, 개인정보 동의 조건)',AUTO,route('send-inquiry-receipt')],
  ['student-inquiry','접수안내 발송',BUTTON,route('send-inquiry-receipt')]]],
 ['시험정보(학원)',[['exam-scope','응시학생 등록',BUTTON,route('sync-exam-scope')]]],
 ['학교(학원)',[['school-calendar','학사일정 가져오기',BUTTON,route('sync-school-calendar')]]],
 ['대시보드(학원)',[['dashboard-link','레코드 생성/편집 (하위 항목 연결)',AUTO,route('sync-dashboard-link')]]],
 ['정규교재(학원)',[['book-report-sync','레코드 편집 (북커버 등)',AUTO,route('sync-report-cache')]]],
 ['일정(학원)',[['schedule-report-sync','레코드 편집',AUTO,route('sync-report-cache')]]],
];
// Webhook routes with no Notion button or automation, so they are not checklist items:
// mark-report-source-dirty (the template records the date with a native Notion automation),
// sync-attendance (GitHub Actions manual run; its GitHub Secret is noted below the checklist),
// sync-student-report (no caller in the template).
const OUTSIDE_NOTION=[route('mark-report-source-dirty'),route('sync-attendance'),route('sync-student-report')];
function route(name){return name;}
// Notion database / "웹훅등록" view links (normalized DB title -> {db, view}), cached on the server.
let links=null,linksUpdated=null;
const dbKey=name=>name.replace(/\s+/g,'');
async function loadLinks(refresh=false){
 if(links&&!refresh)return;
 if(refresh)notice('Notion에서 DB와 웹훅등록 보기를 찾고 있습니다. 1분 정도 걸릴 수 있어요.');
 try{const data=await request('webhook-links',{names:CHECKLIST.filter(([db])=>db).map(([db])=>dbKey(db)),refresh},90000);links=data.links||{};linksUpdated=data.updated_at;}
 catch(e){links=links||{};if(refresh)throw e;}
}
const safeDb=url=>/^https:\/\/www\.notion\.so\/[0-9a-f]{32}$/.test(url||'');
const safeView=url=>/^https:\/\/www\.notion\.so\/[0-9a-f]{32}\?v=[0-9a-f]{32}$/.test(url||'');
const ICONS={[BUTTON]:'<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="3" width="11" height="7.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8.3 7.6l6 2.4-2.5 1-1 2.5z" fill="currentColor"/></svg>',[AUTO]:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.6 1 3 9.2h4.2L6.3 15l6.7-8.3H8.7z" fill="currentColor"/></svg>'};
function el(tag,cls,content){const x=document.createElement(tag);if(cls)x.className=cls;if(content!==undefined)x.textContent=content;return x;}
function link(url,label,title){const a=el('a','',label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.title=title;return a;}
async function loadWebhook(){
 webhook=await request('webhook-status');webhook.checks=webhook.checks||{};
 text('webhook-fact',webhook.rotating?`교체 진행 중 (${date(webhook.started_at)} 시작)`:webhook.changed_at?`마지막 교체 ${date(webhook.changed_at)}`:'평소 유지 · 사고 시 별도 교체');
 text('webhook-summary',webhook.rotating?'웹훅 키 교체가 진행 중입니다. 체크리스트를 마친 뒤 교체를 완료해 주세요.':webhook.weak?'현재 웹훅 키가 짧습니다(32자 미만). 추측하기 쉬우니 웹훅 키 교체를 권장합니다.':'Notion 웹훅 키는 평소 그대로 둡니다. 유출이 의심될 때만 교체하세요.');
 $('webhook-summary').classList.toggle('warn',!webhook.rotating&&!!webhook.weak);
 text('open-webhook',webhook.rotating?'웹훅 키 교체 현황':'웹훅 키 교체');
}
// Automatic hint from the server's per-function call counts. Several buttons can share one function, so
// this only supports the manual check: it cannot tell which button made the call.
function hint(routeName,checkedAt){
 const v={};for(const u of webhook.usage)if(u.route===routeName)v[u.key]=u;
 if(v.old&&checkedAt&&v.old.last_at>checkedAt)return ['bad',`체크 후에도 이 함수로 옛 키 호출 (${shortDate(v.old.last_at)})`];
 if(v.old)return ['bad',`이 함수로 옛 키 호출 있음 (${shortDate(v.old.last_at)} · ${v.old.calls}회)`];
 if(v.new)return ['good',`새 키 호출 확인 (${shortDate(v.new.last_at)})`];
 return ['none','교체 후 호출 기록 없음'];
}
function renderChecklist(){
 const box=$('db-cards');box.replaceChildren();let done=0,total=0,oldRoutes=new Set();
 for(const u of webhook.usage)if(u.key==='old')oldRoutes.add(u.route);
 for(const [db,items,help] of CHECKLIST){
  const card=el('section','dbcard');
  const head=el('div','dbhead');const title=el('h4','',db.replace('(학원)',''));
  const count=items.filter(([id])=>webhook.checks[id]).length;done+=count;total+=items.length;
  const badge=el('span','dbcount'+(count===items.length?' complete':''),`${count} / ${items.length}`);
  head.append(title,badge);
  const l=links&&links[dbKey(db)];const nav=el('div','dblinks');
  if(l&&safeView(l.view))nav.append(link(l.view,'웹훅등록 보기 열기 ↗',db+' DB의 웹훅등록 보기'));
  if(l&&safeDb(l.db))nav.append(link(l.db,safeView(l.view)?'DB ↗':'DB 열기 ↗',db+' DB'));
  if(!nav.childNodes.length)nav.append(el('span','muted','Notion에서 이 DB를 찾지 못했습니다'));
  if(help){const q=el('button','help-btn','?');q.type='button';q.title='찾는 위치 보기';q.setAttribute('aria-label',db.replace('(학원)','')+' 버튼 찾는 위치 보기');q.onclick=()=>showHelp(db,help);nav.append(q);}
  head.append(nav);
  card.append(head);
  const list=el('ul','items');
  for(const [id,name,kind,routeName] of items){
   const checkedAt=webhook.checks[id],[tone,msg]=hint(routeName,checkedAt);
   const li=el('li','item'+(checkedAt?' done':'')+(tone==='bad'?' alert':''));
   const label=el('label','check');const box2=document.createElement('input');box2.type='checkbox';box2.checked=!!checkedAt;box2.dataset.item=id;
   box2.onchange=()=>task(async()=>{await request('webhook-check',{item:id,checked:box2.checked});await loadWebhook();renderChecklist();});
   label.append(box2,el('span','name',name));
   const meta=el('div','meta'),badge2=el('span','kind '+(kind===AUTO?'auto':'button'));badge2.innerHTML=ICONS[kind];badge2.append(kind);
   meta.append(badge2,el('code','',routeName),el('span','hint '+tone,msg));
   li.append(label,meta);list.append(li);
  }
  card.append(list);box.append(card);
 }
 unchecked=total-done;
 text('usage-summary',`완료 ${done} / ${total}`+(oldRoutes.size?` · 옛 키 호출이 남은 함수 ${oldRoutes.size}개`:''));
 $('progress-bar').style.width=total?`${Math.round(done*100/total)}%`:'0%';
 text('links-updated',linksUpdated?`링크 기준: ${date(linksUpdated)}`:'');
}
function showHelp(db,help){
 text('help-title',db.replace('(학원)','')+' · 찾는 위치');text('help-text',help.text);
 const img=$('help-image');img.src=help.image;img.alt=help.alt;$('help-dialog').showModal();
}
async function showProgress(){
 await loadLinks();
 text('webhook-started',`${date(webhook.started_at)}부터 옛 키와 새 키가 모두 동작하고 있습니다.`);
 renderChecklist();
 panel('webhook-progress','웹훅 키 교체 진행 중','DB별로 버튼·자동화의 키를 새 키로 바꾸고 체크합니다. 모두 끝나면 교체를 완료합니다.');
}
async function openWebhook(){await loadWebhook();if(webhook.rotating){await showProgress();return;}clearPasswords();panel('webhook-form','웹훅 키 교체','유출이 의심될 때 Notion 버튼·자동화를 멈추지 않고 새 키로 옮깁니다.');$('webhook-password').focus();}
// Runs one server action at a time. The clicked button shows a spinner and a waiting label meanwhile.
async function task(fn,button,label='불러오는 중…'){
 if(busy)return;busy=true;error('');const buttons=[...document.querySelectorAll('button,input[type=checkbox]')];buttons.forEach(x=>x.disabled=true);
 const original=button&&button.textContent;if(button){button.classList.add('loading');button.textContent=label;button.setAttribute('aria-busy','true');}
 try{await fn();}catch(e){error(friendly(e));}finally{busy=false;buttons.forEach(x=>x.disabled=false);if(button){button.classList.remove('loading');button.removeAttribute('aria-busy');if(button.textContent===label)button.textContent=original;}}
}
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
$('login-form').onsubmit=e=>{e.preventDefault();task(async()=>{const data=await request('login',{password:$('login-password').value,scope:'settings'});session=data.session;try{sessionStorage.setItem(sessionKey,session);}catch{}clearPasswords();await profile();},e.submitter,'로그인 중…');};
$('start-change').onclick=()=>showChange(false);
$('cancel-change').onclick=()=>task(profile);
$('change-form').onsubmit=e=>{e.preventDefault();task(async()=>{if($('new-password').value!==$('confirm-password').value)throw new Error('새 비밀번호와 확인 값이 일치하지 않습니다.');await request('change',{current_password:$('current-password').value,new_password:$('new-password').value});forgetSession();loggedOutFacts();panel('login-form','비밀번호를 변경했습니다','내부 인증키도 함께 갱신되었습니다. 새 비밀번호로 다시 로그인해 주세요.');notice('변경 완료. 기존 로그인은 모두 해제되었고 Notion 웹훅 키는 유지됩니다.');});};
$('logout').onclick=()=>task(async()=>{try{await request('logout');}finally{forgetSession();loggedOutFacts();panel('login-form','로그아웃했습니다','관리자 비밀번호로 다시 로그인할 수 있어요.');}});
$('retry').onclick=()=>task(initialize);
$('open-facts').onclick=()=>$('facts-dialog').showModal();
$('open-links').onclick=()=>$('links-dialog').showModal();
$('close-links').onclick=()=>$('links-dialog').close();
$('close-facts').onclick=()=>$('facts-dialog').close();
$('close-help').onclick=()=>$('help-dialog').close();
$('open-webhook').onclick=e=>task(openWebhook,e.currentTarget,webhook.rotating&&!links?'불러오는 중… (처음엔 Notion 링크를 찾느라 최대 1분)':'불러오는 중…');
$('webhook-back').onclick=()=>task(profile);
$('progress-back').onclick=()=>task(profile);
$('webhook-form').onsubmit=e=>{e.preventDefault();task(async()=>{
 const data=await request('webhook-start',{current_password:$('webhook-password').value});clearPasswords();
 $('new-webhook-key').value=data.key;panel('webhook-key','새 웹훅 키가 만들어졌습니다','지금부터 옛 키와 새 키가 모두 동작합니다. 아래 키를 복사해 주세요.');$('new-webhook-key').select();});};
$('copy-webhook-key').onclick=async()=>{const field=$('new-webhook-key');try{await navigator.clipboard.writeText(field.value);notice('새 웹훅 키를 복사했습니다. 모든 버튼·자동화에 같은 키를 붙여 넣습니다.');}catch{field.select();notice('자동 복사가 막혔습니다. 선택된 키를 Ctrl+C로 복사해 주세요.');}};
$('webhook-key-done').onclick=e=>{if(!confirm('이 화면을 벗어나면 새 웹훅 키를 다시 볼 수 없습니다. 복사했나요?'))return;task(async()=>{$('new-webhook-key').value='';await loadWebhook();await showProgress();},e.currentTarget,'체크리스트 불러오는 중… (처음엔 최대 1분)');};
$('webhook-refresh').onclick=e=>task(async()=>{await loadWebhook();await showProgress();},e.currentTarget);
$('links-refresh').onclick=e=>task(async()=>{await loadLinks(true);renderChecklist();notice('Notion 링크를 다시 찾았습니다.');},e.currentTarget,'Notion에서 찾는 중… (최대 1분)');
$('webhook-finish').onclick=()=>task(async()=>{
 if(!confirm((unchecked?`아직 체크하지 않은 항목이 ${unchecked}개 있습니다. 그 버튼·자동화의 키도 바꿨는지 확인해 주세요.\n`:'')+'교체를 완료하면 옛 키로 오는 Notion 호출은 모두 거부됩니다. 완료할까요?'))return;
 let done;try{done=await request('webhook-finish');}catch(e){if(!e.needsConfirm)throw e;if(!confirm(e.message+' 그래도 완료할까요?'))return;done=await request('webhook-finish',{force:true});}
 await profile();notice(`웹훅 키 교체를 완료했습니다(${date(done.changed_at)}). 옛 키는 더 이상 동작하지 않습니다.`);});
$('webhook-cancel').onclick=()=>task(async()=>{
 if(!$('cancel-password').value)throw new Error('교체를 취소하려면 현재 관리자 비밀번호를 입력해 주세요.');
 if(!confirm('새 키를 버리고 옛 키로 되돌립니다. 이미 새 키로 바꾼 버튼은 다시 옛 키로 돌려야 합니다. 취소할까요?'))return;
 await request('webhook-cancel',{current_password:$('cancel-password').value});clearPasswords();await profile();notice('웹훅 키 교체를 취소했습니다. 옛 키만 동작합니다.');});
initialize();
})();
