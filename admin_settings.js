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
function forgetSession(){session='';mustChange=false;try{sessionStorage.removeItem(sessionKey);}catch{}keepNewKey('');clearPasswords();}
function loggedOutFacts(){text('owner-status','로그인 후 확인');text('last-change','로그인 후 표시');text('next-change','로그인 후 표시');text('webhook-fact','평소 유지 · 사고 시 별도 교체');}
async function request(action,values={},timeout=20000){
 const res=await fetch(base+'/functions/v1/admin-security',{method:'POST',headers:{'Content-Type':'application/json',...(session?{'x-admin-key':session}:{})},body:JSON.stringify({action,...values}),cache:'no-store',signal:AbortSignal.timeout(timeout)});
 const data=await res.json().catch(()=>({}));if(!res.ok){const e=new Error(data.error||'인증 서버 응답을 확인하지 못했습니다.');e.status=res.status;e.needsConfirm=!!data.needs_confirm;throw e;}return data;
}
// Webhook key rotation. The server keeps only the new key's hash. While the rotation is open, this browser tab keeps
// the key in sessionStorage so it can be copied again from the progress view (pasting URLs and keys in turn clears the
// clipboard). It is removed on finish, cancel, logout or when the tab closes, and never sent anywhere.
const NEW_KEY='hada_webhook_new_key_v1';
function keepNewKey(key){try{if(key)sessionStorage.setItem(NEW_KEY,key);else sessionStorage.removeItem(NEW_KEY);}catch{}}
function newKey(){try{return sessionStorage.getItem(NEW_KEY)||'';}catch{return '';}}
// Copies a value and confirms it where the owner is looking: a short toast at the bottom of the screen and a check
// mark on the pressed button for a moment (the notice line at the top is usually scrolled away).
const COPY_ICON='<svg class="line" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const CHECK_ICON='<svg class="line" viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';
let toastTimer=null;
function toast(message){const t=$('toast');t.textContent=message;t.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{t.hidden=true;},2000);}
async function copyText(value,message,button){
 try{await navigator.clipboard.writeText(value);}
 catch{const t=document.createElement('textarea');t.value=value;t.setAttribute('readonly','');t.className='sr-only';document.body.append(t);t.select();const ok=document.execCommand('copy');t.remove();if(!ok)throw new Error('복사하지 못했습니다. 값을 직접 선택해 복사해 주세요.');}
 toast(message);
 const icon=button&&button.querySelector('.copy-icon');
 if(icon){icon.innerHTML=CHECK_ICON;button.classList.add('copied');setTimeout(()=>{icon.innerHTML=COPY_ICON;button.classList.remove('copied');},1500);}
}
function copyButton(label,title,onClick){
 const b=el('button','ghost copy-btn');b.type='button';b.title=title;b.setAttribute('aria-label',title);
 const i=el('span','copy-icon');i.innerHTML=COPY_ICON;b.append(i,label);b.onclick=()=>onClick(b);return b;
}
let webhook={rotating:false,usage:[],checks:{}},unchecked=0;
// Every Notion button/automation that sends the webhook key, grouped by database (docs/버튼-웹훅-매핑.md).
// Each item: [id, name, kind, route, extra]. extra.path is appended to the webhook URL (sub-route or query) and
// extra.header is an additional Notion webhook header. adminSecurity_test.ts checks that the routes here are exactly
// SECURITY_WEBHOOK_ROUTES, so a new webhook function cannot be left out of the checklist.
const BUTTON='버튼',AUTO='자동화';
// extra.trigger: {when, check:[property, checked]} draws the automation trigger as Notion-like chips. extra.note is one
// short line for a button that differs from the usual (sub-route, extra header, unusual place).
// 삭제: the 삭제 button only ticks "삭제 체크"; the automation on that checkbox sends the webhook and the server works
// through the child pages one relay step at a time.
const DELETE={trigger:{check:['삭제 체크',true]},note:'삭제 버튼은 체크만 합니다. 키는 "삭제 체크" 자동화에 있습니다.'};
const CHECKLIST=[
 ['등록(학원)',[
  ['reg-link-regenerate','링크 재발급',BUTTON,route('toggle-report-link'),{header:['x-link-action','regenerate'],note:'추가 헤더가 하나 더 있습니다. 헤더 버튼으로 값을 복사합니다.'}],
  ['reg-link-disable','링크 비활성화',AUTO,route('toggle-report-link'),{header:['x-link-action','disable'],trigger:{check:['링크 비활성화',true]}}],
  ['reg-link-enable','링크 활성화',AUTO,route('toggle-report-link'),{header:['x-link-action','enable'],trigger:{check:['링크 비활성화',false]}}],
  ['reg-report-sync','학생 페이지 동기화',BUTTON,route('sync-report-cache')],
  ['reg-textbook','교재 생성',BUTTON,route('sync-registration-textbook'),{path:'/create-individual',note:'주소 끝의 /create-individual까지 넣습니다. 클래스의 교재 생성과 주소가 다릅니다.'}],
  ['reg-enroll','시간표 설정',BUTTON,route('sync-registration-enroll')],
  ['reg-session','수업 생성',BUTTON,route('sync-registration-class-session')],
  ['reg-end','종료 처리',BUTTON,route('sync-registration-end')]]],
 ['클래스(학원)',[
  ['class-tuition','월 수강료 생성',BUTTON,route('generate-tuition')],
  ['class-textbook-fee','교재비 생성',BUTTON,route('sync-textbook-distribution'),{path:'/from-class-carts',note:'주소 끝의 /from-class-carts까지 넣습니다.'}],
  ['class-textbook','교재 생성',BUTTON,route('sync-registration-textbook'),{path:'/create-class',note:'주소 끝의 /create-class까지 넣습니다. 등록의 교재 생성과 주소가 다릅니다.'}],
  ['class-report-sync','학생 페이지 동기화',BUTTON,route('sync-class-report-cache')],
  ['class-report','보고서 생성',BUTTON,route('generate-report')]]],
 ['시간표(학원)',[['timetable-classes','수업추가',BUTTON,route('generate-classes')]]],
 ['메뉴(학원)',[['menu-bulk-classes','다음주 수업 일괄 생성',BUTTON,route('generate-classes'),{path:'?mode=bulk',note:'주소 끝의 ?mode=bulk까지 넣습니다.'}]],{
  text:'메뉴 DB의 어떤 페이지(예: 수업 HOME)를 열어도 제목 아래 속성 줄에 "다음주 수업 일괄 생성" 버튼이 있습니다. 속성 이름을 클릭하고 "자동화 편집"을 눌러 웹훅 보내기의 값 칸을 바꿉니다. 메뉴 DB에는 "웹훅 등록" 보기가 없어도 됩니다.',
  image:'assets/admin-settings/menu-bulk-button.png',alt:'메뉴 페이지 상단 속성 줄의 다음주 수업 일괄 생성 버튼'}],
 ['수업(학원)',[
  ['session-record','학습기록 생성',BUTTON,route('create-learning-record')],
  ['session-attendance','출석 조정',BUTTON,route('fix-attendance')],
  ['session-reports','보고서 일괄 전송',BUTTON,route('send-class-daily-reports')],
  ['session-delete','삭제',AUTO,route('cascade-delete'),DELETE]]],
 ['출석(학원)',[
  ['attendance-record','학습기록 생성',BUTTON,route('create-learning-record')],
  ['attendance-report','보고서 전송',BUTTON,route('send-daily-report')],
  ['attendance-delete','삭제',AUTO,route('cascade-delete'),DELETE]]],
 ['학습기록(학원)',[
  ['record-assignment','학습활동 생성',BUTTON,route('create-assignment')],
  ['record-delete','삭제',AUTO,route('cascade-delete'),DELETE]]],
 ['학습활동(학원)',[['assignment-delete','삭제',AUTO,route('cascade-delete'),DELETE]]],
 ['보고서(학원)',[['report-send','보고서 전송',BUTTON,route('send-report')]]],
 ['알림톡 발송함(학원)',[['outbox-send','일괄 전송',BUTTON,route('send-selected-notifications')]]],
 ['수강료(학원)',[['tuition-notice','수강료 안내 발송',BUTTON,route('send-tuition-notice')]]],
 ['교재비(학원)',[
  ['cart-notice','안내문 전송',BUTTON,route('send-textbook-notice')],
  ['cart-progress-book','진도교재 담기',BUTTON,route('sync-textbook-distribution'),{path:'/from-cart',note:'주소 끝의 /from-cart까지 넣습니다.'}],
  ['cart-delete','삭제',AUTO,route('cascade-delete'),DELETE]]],
 ['교재배부(학원)',[['distribution-delete','삭제',AUTO,route('cascade-delete'),DELETE]]],
 ['교재결제(학원)',[['payment-delete','삭제',AUTO,route('cascade-delete'),DELETE]]],
 ['학생(학원)',[
  ['student-inquiry-auto','상담 신청 접수안내',AUTO,route('send-inquiry-receipt'),{trigger:{when:'페이지 추가',check:['개인정보 동의',true]}}],
  ['student-inquiry','접수안내 직접 발송',BUTTON,route('send-inquiry-receipt'),{note:'관리자가 직접 입력한 학생에게 보낼 때 누릅니다.'}]]],
 ['시험정보(학원)',[['exam-scope','응시학생 등록',BUTTON,route('sync-exam-scope')]]],
 ['학교(학원)',[['school-calendar','학사일정 가져오기',BUTTON,route('sync-school-calendar')]]],
 ['대시보드(학원)',[['dashboard-link','날짜 변경 연결',AUTO,route('sync-dashboard-link'),{trigger:{when:'날짜 속성 편집'}}],
  ['dashboard-link-new','새 대시보드 연결',AUTO,route('sync-dashboard-link'),{trigger:{when:'페이지 추가'}}]]],
 ['정규교재(학원)',[['book-report-sync','교재 수정 반영',AUTO,route('sync-report-cache'),{trigger:{when:'속성 편집'}}],
  ['book-report-sync-new','새 교재 반영',AUTO,route('sync-report-cache'),{trigger:{when:'페이지 추가'}}]]],
 ['일정(학원)',[['schedule-report-sync','일정 수정 반영',AUTO,route('sync-report-cache'),{trigger:{when:'속성 편집'}}],
  ['schedule-report-sync-new','새 일정 반영',AUTO,route('sync-report-cache'),{trigger:{when:'페이지 추가'}}]]],
];
// Webhook routes with no Notion button or automation, so they are not checklist items:
// sync-attendance (GitHub Actions manual run; its GitHub Secret is noted below the checklist).
const OUTSIDE_NOTION=[route('sync-attendance')];
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
function link(url,label,title,cls='link-chip'){const a=el('a',cls,label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.title=title;return a;}
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
 if(v.old&&checkedAt&&v.old.last_at>checkedAt)return ['bad',`체크 후에도 이 함수로 이전 키 호출 (${shortDate(v.old.last_at)})`];
 if(v.old)return ['bad',`이 함수로 이전 키 호출 있음 (${shortDate(v.old.last_at)} · ${v.old.calls}회)`];
 if(v.new)return ['good',`새 키 호출 확인 (${shortDate(v.new.last_at)})`];
 return ['none',''];
}
// What each button/automation does, in one or two plain sentences (shown behind the item's ? button).
const DESC={
 'reg-link-regenerate':'학부모 리포트 링크를 새 주소로 바꿉니다. 이전 링크는 더 이상 열리지 않습니다.',
 'reg-link-disable':'"링크 비활성화"를 체크하면 학부모 리포트 링크가 열리지 않게 막습니다.',
 'reg-link-enable':'"링크 비활성화" 체크를 풀면 막았던 학부모 리포트 링크가 다시 열립니다.',
 'reg-report-sync':'이 학생의 학부모 리포트(출석·학습기록·교재·일정)를 최신 내용으로 다시 만듭니다. 학부모에게 보내지는 않습니다.',
 'reg-textbook':'이 학생의 진도교재를 만듭니다. 그룹 진도 교재는 클래스의 반별교재에 연결하고, 개별 진도 교재는 이 학생용으로 만듭니다.',
 'reg-enroll':'등록일이 비어 있으면 오늘로 채우고, 종료일이 있으면 지워 다시 수강 중으로 돌립니다. 시간표가 비어 있으면 클래스의 그룹 수업 시간표를 연결합니다(개별 수업은 직접 연결).',
 'reg-session':'이미 만들어진 수업 중 등록 기간·시간표에 맞는 수업에 이 학생을 연결하고 빠진 출석을 만듭니다. 새 수업 일정을 만드는 버튼은 아니며, 다시 눌러도 중복되지 않습니다.',
 'reg-end':'종료일 기준으로 그 뒤의 출석을 지우고, 수업·시간표 연결을 풀고, 쓰지 않는 교재를 정리합니다. 되돌리는 기능은 없습니다.',
 'class-tuition':'클래스의 "수강료 생성 대상"에 연결한 발송함의 달을 기준으로, 그 달에 수강 중인 학생마다 수강료 건을 만듭니다. 이미 있으면 건너뜁니다.',
 'class-textbook-fee':'이 반에서 아직 교재비 페이지가 없는 학생마다 교재비 페이지를 만듭니다. 교재를 담지는 않으며, 교재는 각 교재비의 "진도교재 담기"로 담습니다.',
 'class-textbook':'이 클래스의 수강 중인 학생마다 진도교재를 차례로 만들거나 맞춥니다.',
 'class-report-sync':'이 클래스 학생 중 리포트 링크가 있는 학생의 학부모 리포트를 최신 내용으로 다시 만듭니다. 학부모에게 보내지는 않습니다.',
 'class-report':'클래스의 "보고서 생성 대상"에 연결한 발송함의 구분(주간/월간)과 기간으로, 그 기간에 수강 중인 학생마다 보고서를 만들고 출석·학습기록·학습활동을 연결합니다. 이미 있으면 건너뜁니다.',
 'timetable-classes':'이 시간표의 다음 수업 1회를 만들고, 이 시간표에 연결된 학생의 출석을 함께 만듭니다.',
 'menu-bulk-classes':'모든 시간표의 수업을 아직 만들어지지 않은 주의 일요일까지 만들고 출석을 함께 만듭니다. 시간표를 하나씩 차례로 처리하며, 다시 눌러도 중복되지 않습니다.',
 'session-record':'이 수업에 출석한 학생들의 학습기록을 만듭니다.',
 'session-attendance':'이 수업 날짜에 수강 중인 학생 기준으로 출석을 맞춥니다. 빠진 출석은 연결하거나 만들고, 수강 기간이 아니거나 중복된 출석은 삭제 체크합니다.',
 'session-reports':'이 수업에 출석한 학생들에게 일일 보고서를 한 명씩 차례로 보냅니다.',
 'attendance-record':'이 출석의 학습기록을 만듭니다. 수업 없이 온 보강 출석이면 보강으로 표시합니다.',
 'attendance-report':'이 학생의 일일 보고서를 학부모에게 보냅니다. 보내기 전에 리포트를 최신 내용으로 맞춥니다.',
 'record-assignment':'이 학습기록의 대상 학생마다 학습활동(과제)을 만듭니다.',
 'report-send':'이 보고서(주간 또는 월간)를 학부모에게 알림톡으로 보냅니다.',
 'outbox-send':'이 발송함의 구분(주간·월간 보고서 또는 수강료)에 맞는 건 중 "일괄전송 선택"이 체크된 건을 이름순으로 10건씩 차례로 보냅니다. 건수가 많아도 다시 누르지 않고 기다립니다.',
 'tuition-notice':'이 수강료 안내를 학부모에게 알림톡으로 보냅니다.',
 'cart-notice':'이 학생의 미납 교재 안내문을 학부모에게 알림톡으로 보냅니다.',
 'cart-progress-book':'이 학생의 진도교재 중 "진행 중"인 교재만 모아 교재배부를 한 번에 만듭니다. "다음 교재"는 제외합니다.',
 'student-inquiry-auto':'상담 신청서로 학생이 추가되고 개인정보 동의가 체크돼 있으면, 선택한 우선 연락 대상에게 접수안내를 자동으로 보냅니다.',
 'student-inquiry':'관리자가 직접 입력한 학생에게 같은 접수안내를 보냅니다. 개인정보 동의를 확인한 뒤 누릅니다.',
 'exam-scope':'시험과 같은 학년(학교를 지정했으면 같은 학교)이면서 등록 중인 학생 중 아직 성적 행이 없는 학생의 성적 행을 만듭니다. 이미 입력한 점수는 그대로 둡니다.',
 'school-calendar':'이 학교의 올해 학사일정을 나이스(NEIS)에서 가져와 일정에 넣습니다.',
 'dashboard-link':'대시보드 날짜가 바뀌면 그날의 수업·출석·일정을 이 대시보드에 다시 연결합니다.',
 'dashboard-link-new':'새 대시보드가 만들어지면 그날의 수업·출석·일정을 이 대시보드에 연결합니다.',
 'book-report-sync':'교재 정보(북커버 등)가 바뀌면 그 교재를 쓰는 학생들의 학부모 리포트를 다시 만듭니다.',
 'book-report-sync-new':'새 교재가 추가될 때도 같은 반영을 실행합니다. 그 교재를 쓰는 학생이 있으면 리포트에 반영됩니다.',
 'schedule-report-sync':'일정이 바뀌면 관련 학생(학생·클래스·학교·학년)의 학부모 리포트를 다시 만듭니다.',
 'schedule-report-sync-new':'새 일정이 추가되면 관련 학생(학생·클래스·학교·학년)의 학부모 리포트를 다시 만듭니다.',
};
// 삭제 is the same in every DB: the page and its child records are removed; shared records are only unlinked.
const itemDesc=id=>DESC[id]||(id.endsWith('-delete')?'이 페이지와 하위 기록을 삭제합니다. 여러 곳에서 쓰는 공용 기록은 연결만 풉니다. 하위 페이지는 이어달리기로 차례로 처리됩니다.':'');
// Notion-like checkbox glyphs for trigger chips (checked / unchecked).
const BOX_ON='<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="currentColor"/><path d="M4.5 8.2l2.3 2.3 4.7-5" fill="none" class="tick" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const BOX_OFF='<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
// The trigger line ("트리거 [＋ 페이지 추가] 조건 [☑ 개인정보 동의] 체크됨") and the one-line note for unusual buttons.
function describe(extra){
 const out=[];const t=extra.trigger;
 if(t){
  const row=el('div','trigger');row.append(el('span','trigger-label','트리거'));
  // Event chips carry Notion's own trigger glyphs: ＋ for 페이지 추가, a pencil corner for 속성 편집.
  if(t.when)for(const w of t.when.split(' · ')){const c=el('span','trig');c.append(el('span','trig-glyph',w==='페이지 추가'?'＋':'∠'),w);row.append(c);}
  if(t.check){
   const [prop,on]=t.check;if(t.when)row.append(el('span','trigger-label','조건'));
   // The state sits inside the chip so "체크됨" never ends up alone on a line.
   const chip=el('span','trig box'+(on?' on':''));const i=el('span','box-icon');i.innerHTML=on?BOX_ON:BOX_OFF;
   chip.append(i,prop,el('span','trigger-state',on?'체크됨':'체크 해제됨'));row.append(chip);
  }
  out.push(row);
 }
 if(extra.note)out.push(el('div','note',extra.note));
 return out;
}
function renderChecklist(){
 const box=$('db-cards');box.replaceChildren();let done=0,total=0,oldRoutes=new Set();
 for(const u of webhook.usage)if(u.key==='old')oldRoutes.add(u.route);
 // Cards sit in rows: each row starts at the same height, biggest DB first so cards in one row are of similar
 // length (등록 → 클래스 → 수업 → …). Column count follows the screen width in CSS (.cards).
 for(const [db,items,help] of [...CHECKLIST].sort((a,b)=>b[1].length-a[1].length)){
  const card=el('section','dbcard');
  const head=el('div','dbhead');const title=el('h4','',db.replace('(학원)',''));
  const count=items.filter(([id])=>webhook.checks[id]).length;done+=count;total+=items.length;
  const badge=el('span','dbcount'+(count===items.length?' complete':''),`${count} / ${items.length}`);
  head.append(title,badge);
  const l=links&&links[dbKey(db)];const nav=el('div','dblinks');
  // The 웹훅등록 view is the link people use most, so it is the filled chip; the DB link is the outlined one.
  const hasView=l&&safeView(l.view);
  if(hasView)nav.append(link(l.view,'웹훅 등록 ↗',db+' DB의 "웹훅 등록" 보기 열기','link-chip main'));
  if(l&&safeDb(l.db))nav.append(link(l.db,'DB 열기 ↗',db+' DB 열기',hasView?'link-chip':'link-chip main'));
  if(!nav.childNodes.length)nav.append(el('span','muted','Notion에서 이 DB를 찾지 못했습니다'));
  head.append(nav);
  card.append(head);
  const list=el('ul','items');
  for(const [id,name,kind,routeName,extra={}] of items){
   const checkedAt=webhook.checks[id],[tone,msg]=hint(routeName,checkedAt);
   const li=el('li','item'+(checkedAt?' done':'')+(tone==='bad'?' alert':''));
   const label=el('label','check');const box2=document.createElement('input');box2.type='checkbox';box2.checked=!!checkedAt;box2.dataset.item=id;
   box2.onchange=()=>task(async()=>{await request('webhook-check',{item:id,checked:box2.checked});await loadWebhook();renderChecklist();});
   // The kind badge sits right after the name so the type is read with it and the item needs one row less.
   const badge2=el('span','kind '+(kind===AUTO?'auto':'button'));badge2.innerHTML=ICONS[kind];badge2.append(kind);
   const nameEl=el('span','name',name);nameEl.append(badge2);label.append(box2,nameEl);
   // Every item shows the same first line; what it does, its trigger and any note sit behind the item's ? button.
   const q=el('button','help-btn item-help','?');q.type='button';q.title='설명 보기';q.setAttribute('aria-label',name+' 설명 보기');
   q.onclick=e=>{e.preventDefault();e.stopPropagation();showHelp(name+' · '+kind,{nodes:[el('p','help-desc',itemDesc(id)),...describe(extra)],text:help&&help.text,image:help&&help.image,alt:help&&help.alt});};
   label.append(q);
   const meta=el('div','meta');
   // No call yet is the normal state, so only an actual call record is shown.
   meta.append(el('code','',routeName+(extra.path||'')));if(msg)meta.append(el('span','hint '+tone,msg));
   // Webhook URL (and extra header) for this button, built from this academy's Supabase address.
   const copies=el('div','copies');const url=base+'/functions/v1/'+routeName+(extra.path||'');
   copies.append(copyButton('웹훅','웹훅 URL 복사: '+url,b=>copyText(url,'웹훅 URL을 복사했습니다',b).catch(e=>error(e.message))));
   if(extra.header){const [hn,hv]=extra.header;copies.append(copyButton('헤더',`추가 헤더 값 복사: ${hn}: ${hv}`,b=>copyText(hv,`추가 헤더 값(${hn}: ${hv})을 복사했습니다`,b).catch(e=>error(e.message))));}
   li.append(label,meta,copies);list.append(li);
  }
  card.append(list);box.append(card);
 }
 unchecked=total-done;
 text('usage-summary',`완료 ${done} / ${total}`+(oldRoutes.size?` · 이전 키 호출이 남은 함수 ${oldRoutes.size}개`:''));
 $('progress-bar').style.width=total?`${Math.round(done*100/total)}%`:'0%';
 text('links-updated',linksUpdated?`링크 기준: ${date(linksUpdated)}`:'');
}
// One help dialog for both a card's "찾는 위치" (text + image) and an item's trigger / note (extra nodes).
function showHelp(title,help){
 text('help-title',title);text('help-text',help.text||'');
 const img=$('help-image');img.hidden=!help.image;if(help.image){img.src=help.image;img.alt=help.alt||'';}else img.removeAttribute('src');
 $('help-extra').replaceChildren(...(help.nodes||[]));$('help-dialog').showModal();
}
function renderKeyBar(){
 const icon=$('key-bar-copy').querySelector('.copy-icon');if(!icon.innerHTML)icon.innerHTML=COPY_ICON;
 const key=newKey();$('key-bar-copy').hidden=!key;$('key-bar-show').hidden=!key;$('key-bar').classList.toggle('missing',!key);
 if(!key)$('key-bar').dataset.shown='';
 $('key-bar-value').textContent=key?($('key-bar').dataset.shown==='1'?key:key.slice(0,4)+'•'.repeat(12)+key.slice(-4)):'이 탭에는 새 키가 없습니다. 교체를 시작한 탭에서만 다시 복사할 수 있어요. 키를 잃었다면 아래 "교체 취소" 후 새 웹훅 키를 다시 만들면 여기서 복사할 수 있습니다.';
 $('key-bar-show').textContent=$('key-bar').dataset.shown==='1'?'가리기':'보기';
}
async function showProgress(){
 await loadLinks();
 renderKeyBar();
 text('webhook-started',`${date(webhook.started_at)}부터 이전 키와 새 키가 모두 동작하고 있습니다.`);
 panel('webhook-progress','웹훅 키 교체 진행 중','DB별로 버튼·자동화의 키를 새 키로 바꾸고 체크합니다. 모두 끝나면 교체를 완료합니다.');
 renderChecklist(); // after the panel is visible so the column count uses the real width
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
$('close-facts').onclick=()=>$('facts-dialog').close();
$('close-help').onclick=()=>$('help-dialog').close();
$('open-webhook').onclick=e=>task(openWebhook,e.currentTarget,webhook.rotating&&!links?'불러오는 중… (처음엔 Notion 링크를 찾느라 최대 1분)':'불러오는 중…');
$('webhook-back').onclick=()=>task(profile);
$('progress-back').onclick=()=>task(profile);
$('webhook-form').onsubmit=e=>{e.preventDefault();task(async()=>{
 const data=await request('webhook-start',{current_password:$('webhook-password').value});clearPasswords();
 $('new-webhook-key').value=data.key;keepNewKey(data.key);panel('webhook-key','새 웹훅 키가 만들어졌습니다','지금부터 이전 키와 새 키가 모두 동작합니다. 아래 키를 복사해 주세요.');$('new-webhook-key').select();});};
$('copy-webhook-key').onclick=async()=>{const field=$('new-webhook-key');try{await navigator.clipboard.writeText(field.value);notice('새 웹훅 키를 복사했습니다. 모든 버튼·자동화에 같은 키를 붙여 넣습니다.');}catch{field.select();notice('자동 복사가 막혔습니다. 선택된 키를 Ctrl+C로 복사해 주세요.');}};
$('webhook-key-done').onclick=e=>{task(async()=>{$('new-webhook-key').value='';await loadWebhook();await showProgress();},e.currentTarget,'체크리스트 불러오는 중… (처음엔 최대 1분)');};
$('webhook-refresh').onclick=e=>task(async()=>{await loadWebhook();await showProgress();},e.currentTarget);
$('links-refresh').onclick=e=>task(async()=>{await loadLinks(true);renderChecklist();notice('Notion 링크를 다시 찾았습니다.');},e.currentTarget,'Notion에서 찾는 중… (최대 1분)');
$('webhook-finish').onclick=()=>task(async()=>{
 if(!confirm((unchecked?`아직 체크하지 않은 항목이 ${unchecked}개 있습니다. 그 버튼·자동화의 키도 바꿨는지 확인해 주세요.\n`:'')+'교체를 완료하면 이전 키가 삭제되어, 이전 키로 오는 Notion 호출은 모두 거부됩니다. 완료할까요?'))return;
 let done;try{done=await request('webhook-finish');}catch(e){if(!e.needsConfirm)throw e;if(!confirm(e.message+' 그래도 완료할까요?'))return;done=await request('webhook-finish',{force:true});}
 keepNewKey('');await profile();notice(`웹훅 키 교체를 완료했습니다(${date(done.changed_at)}). 이전 키를 삭제했습니다.`);});
$('webhook-cancel').onclick=()=>task(async()=>{
 if(!$('cancel-password').value)throw new Error('교체를 취소하려면 현재 관리자 비밀번호를 입력해 주세요.');
 if(!confirm('새 키를 버리고 이전 키로 되돌립니다. 이미 새 키로 바꾼 버튼은 다시 이전 키로 돌려야 합니다. 취소할까요?'))return;
 await request('webhook-cancel',{current_password:$('cancel-password').value});clearPasswords();keepNewKey('');await profile();notice('웹훅 키 교체를 취소했습니다. 이전 키만 동작합니다.');});
$('key-bar-copy').onclick=e=>copyText(newKey(),'새 웹훅 키를 복사했습니다',e.currentTarget).catch(err=>error(err.message));
$('key-bar-show').onclick=()=>{const bar=$('key-bar');bar.dataset.shown=bar.dataset.shown==='1'?'':'1';renderKeyBar();};
// Re-pack the checklist when the window width changes the column count.
initialize();
})();
