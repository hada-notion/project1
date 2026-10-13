// 수업 관리(v2.5.67, v2.5.82에 이름 변경): 관리자 비밀번호로 로그인(12시간, 이 기기에 기억) → 강사 선택(이 기기에 기억) → 오늘 수업(v2.5.79, 서랍 v2.5.80: 상단 ≡ 왼쪽 클래스 목록·📅 오른쪽 날짜)
// → 수업(학생 목록 [출석|과제 검사], 학습기록, + 기록 만들기) → 학생 공간 / 기록 카드 → 학생별 학습활동. 보강 대기실은 ≡ 서랍에서 연다.
// 업무 데이터는 class-room 함수가 Notion에 읽고 쓴다. 체크·입력은 편집 모드에서 모아 [저장], 만들기·출제는 바로 실행.
'use strict';
const $=id=>document.getElementById(id);
const SESSION_KEY='hada_class_session_v1',TEACHER_KEY='hada_class_teacher_v1';
const CFG=(()=>{try{return HadaAdminAuth.config();}catch(e){return {error:e.message};}})();
const store={get:k=>{try{return localStorage.getItem(k)||'';}catch{return '';}},set:(k,v)=>{try{v?localStorage.setItem(k,v):localStorage.removeItem(k);}catch{}}};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const notionUrl=id=>'https://www.notion.so/'+String(id).replace(/-/g,'');
// Feather Icons(MIT) 원본 경로.
const P={back:'<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',ext:'<line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/>',
 users:'<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
 학습:'<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
 과제:'<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>',
 평가:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
 grid:'<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
 cal:'<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
 out:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
 plus:'<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',check:'<polyline points="20 6 9 17 4 12"/>',
 refresh:'<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
 lock:'<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',square:'<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>',
 checked:'<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
 menu:'<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
 x:'<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',memo:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>'};
const icon=(name,cls='')=>`<svg class="line ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name]||''}</svg>`;
const nlink=(id,label)=>id?`<a class="icon-btn nl" href="${notionUrl(id)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(label)} Notion에서 열기" title="Notion에서 열기">${icon('ext')}</a>`:'';
const KINDS=['학습','과제','평가'],STATUS={'🟢 출석':'출석','🔴 결석':'결석','🔵 보강':'보강'};
const pad=n=>String(n).padStart(2,'0');
function seoulDate(offset=0){const d=new Date(Date.now()+9*3600e3+offset*864e5);return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;}
function dateLabel(ymd){const [y,m,d]=ymd.split('-').map(Number);const w='일월화수목금토'[new Date(Date.UTC(y,m-1,d)).getUTCDay()];return `${m}/${d} (${w})`;}
function timeOf(iso){if(!iso)return '';const d=new Date(new Date(iso).getTime()+9*3600e3);return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;}
function shortDate(iso){if(!iso)return '';const d=new Date(new Date(iso).getTime()+(String(iso).includes('T')?9*3600e3:0));return `${d.getUTCMonth()+1}/${d.getUTCDate()}`;}

const state={session:store.get(SESSION_KEY),teacherId:store.get(TEACHER_KEY),teachers:[],date:seoulDate(),view:'empty',day:null,
 sessionId:'',detail:null,tab:'students',seg:'att',recKind:'전체',hwRecord:'',edit:false,editOwner:'',saver:null,draft:{},recordId:'',acts:null,student:null,noteTab:'memo',books:null,picked:new Set(),
 classWeek:[],cwMonth:'',cwFrom:'',cwTo:'',classes:null,form:null,bookCache:{}};

async function api(action,data={}){
 if(CFG.error)throw new Error(CFG.error);
 const res=await fetch(CFG.url+'/functions/v1/class-room',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':state.session,Authorization:'Bearer '+CFG.anonKey,apikey:CFG.anonKey},body:JSON.stringify({action,...data}),cache:'no-store'});
 const body=await res.json().catch(()=>({}));
 if(res.status===401){store.set(SESSION_KEY,'');state.session='';showLogin('로그인이 끝났어요. 관리자 비밀번호로 다시 로그인해 주세요.');throw new Error('silent');}
 if(!res.ok)throw new Error(body.error||'서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.');
 return body;
}
function toast(msg){const t=$('toast');t.textContent=msg;t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>t.hidden=true,2400);}
async function run(fn,btn){if(run.busy)return;run.busy=true;if(btn){btn.classList.add('loading');btn.setAttribute('aria-busy','true');}
 try{await fn();}catch(e){if(e.message!=='silent')toast(e.message);}finally{run.busy=false;if(btn){btn.classList.remove('loading');btn.removeAttribute('aria-busy');}}}
function bar(crumbs,{back,notion,right='',who=false}={}){
 $('bar').innerHTML='<div class="bar-in">'+(back?`<button class="icon-btn" id="bar-back" type="button" aria-label="뒤로">${icon('back')}</button>`:'')+
  (crumbs.length===1&&!back?`<h1>${esc(crumbs[0])}</h1>`:`<div class="crumbs">${crumbs.map((c,i)=>i===0&&who?`<button class="crumb-btn" id="who" type="button" aria-label="강사 바꾸기">${esc(c)} ▾</button>`:`<span>${esc(c)}</span>`).join('<span class="sep">›</span>')}</div>`)+right+(notion?nlink(notion,crumbs.at(-1)):'')+'</div>';
 if(back)$('bar-back').onclick=back;
}
// 하단 탭 [학생 목록 | + 기록 만들기 | 학습기록](v2.5.79): 수업 고르기는 상단 ≡로 옮겼다. 수업이 없는 화면에서는 학생 목록·학습기록을 누를 수 없고 +는 안내만 한다.
function setTabs(on){const tb=$('tabbar');tb.hidden=!on;$('app').classList.toggle('with-tabs',!!on);document.body.classList.toggle('tabs-on',!!on);if(!on)return;
 const cur=state.view==='session'?state.tab:'',off=state.detail?'':'disabled';
 tb.innerHTML=`<div class="tab-in three"><button type="button" data-tab="students" class="${cur==='students'?'on':''}" ${off}>${icon('users')}<span>학생 목록</span></button><button type="button" class="plus" id="tab-plus">${'<span class="plus-dot">'+icon('plus')+'</span>'}<span>기록 만들기</span></button><button type="button" data-tab="records" class="${cur==='records'?'on':''}" ${off}>${icon('학습')}<span>학습기록</span></button></div>`;
 $('tab-plus').onclick=()=>openCreateSheet();
 tb.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{if(b.dataset.tab===cur)return;if(!leaveEdit())return;state.tab=b.dataset.tab;state.view='session';render();});}
function leaveEdit(){if(state.edit&&Object.keys(state.draft).length&&!confirm('저장하지 않은 변경이 있어요. 버리고 나갈까요?'))return false;state.edit=false;state.draft={};updateSavebar();return true;}
function updateSavebar(){const sb=$('savebar'),n=Object.keys(state.draft).length;sb.hidden=!state.edit||!n;sb.classList.toggle('no-tabs',$('tabbar').hidden);$('save-count').textContent=`변경 ${n}건`;
 document.body.classList.toggle('save-on',!sb.hidden);}
window.addEventListener('beforeunload',e=>{if(state.edit&&Object.keys(state.draft).length){e.preventDefault();e.returnValue='';}});

// ---------- 로그인·강사 ----------
function showLogin(message=''){
 setTabs(false);state.view='login';bar(['수업 관리']);
 $('app').innerHTML=`<p class="page-title">${icon('lock')}수업 관리 로그인</p><p class="page-hint">관리자 비밀번호를 입력하세요. 이 기기에서 12시간 동안 다시 묻지 않아요.</p>
 <form id="login" class="card"><label for="pw">관리자 비밀번호</label><input type="password" id="pw" autocomplete="current-password" maxlength="128" required>
 <p class="error" id="login-err" ${message?'':'hidden'}>${esc(message)}</p><div class="actions"><button class="primary" type="submit">로그인</button></div></form>`;
 if(CFG.error){$('login-err').hidden=false;$('login-err').textContent=CFG.error;}
 $('login').onsubmit=async e=>{e.preventDefault();const btn=e.submitter,err=$('login-err');if(run.busy)return;run.busy=true;btn.classList.add('loading');err.hidden=true;
  try{const s=await HadaAdminAuth.login(CFG.url,$('pw').value);state.session=s;store.set(SESSION_KEY,s);run.busy=false;await run(start);}
  catch(x){err.hidden=false;err.textContent=x.message;}finally{run.busy=false;btn.classList.remove('loading');}};
}
async function loadTeachers(){if(!state.teachers.length)state.teachers=(await api('teachers')).teachers;}
function teacherName(id){return state.teachers.find(t=>t.id===id)?.name||'';}
function showTeachers(){
 setTabs(false);state.view='teachers';bar(['강사 선택'],{back:state.teacherId!==''?()=>{state.view=state.detail?'session':'empty';render();}:null});
 $('app').innerHTML=`<p class="page-title">${icon('users')}강사 선택</p><p class="page-hint">고른 강사의 수업만 보여 줘요. 이 기기에 기억하고, 위에서 언제든 바꿀 수 있어요.</p><div class="list">
 ${state.teachers.map(t=>`<button class="row" type="button" data-id="${esc(t.id)}"><span class="av">${esc(t.name.slice(0,1))}</span><span class="meta"><span class="t">${esc(t.name)}</span><span class="d">${esc(t.role)}</span></span>${state.teacherId===t.id?icon('check','check'):''}</button>`).join('')}
 <button class="row" type="button" data-id="all"><span class="av sq">전</span><span class="meta"><span class="t">전체 수업</span><span class="d">모든 강사의 수업</span></span>${state.teacherId==='all'?icon('check','check'):''}</button></div>
 <div class="actions"><button class="secondary wide" id="logout" type="button">${icon('out','inline-icon')} 이 기기에서 로그아웃</button></div>`;
 $('logout').onclick=()=>{if(!confirm('이 기기에서 로그아웃할까요? 다시 들어오려면 관리자 비밀번호가 필요해요.'))return;store.set(SESSION_KEY,'');store.set(TEACHER_KEY,'');state.session='';state.teacherId='';showLogin();};
 $('app').querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>run(async()=>{state.teacherId=b.dataset.id;state.detail=null;store.set(TEACHER_KEY,state.teacherId);await openToday();},b));
}

// ---------- 수업 고르기·날짜 ----------
// v2.5.79 구조: 상단 [≡ 수업 선택 | 클래스 이모지·이름 / 날짜·시간 | 📅 날짜 이동], 본문은 그 반 그날 수업, 하단 [학생 목록 | + 기록 만들기 | 학습기록].
// 처음 열면 오늘 수업 중 지금 진행 중인 수업 → 다음 수업 → 마지막 수업 순으로 열고, 오늘 수업이 없으면 안내만 보인다.
const teacherArg=()=>state.teacherId&&state.teacherId!=='all'?{teacherId:state.teacherId}:{};
const fetchDay=date=>api('day',{date,...teacherArg()});
async function loadDay(){state.day=await fetchDay(state.date);}
// 날짜는 서울 날짜 문자열(YYYY-MM-DD)로 계산한다. 주는 월요일부터(리포트 캘린더와 같음).
function addDays(ymd,n){const [y,m,d]=ymd.split('-').map(Number);const t=new Date(Date.UTC(y,m-1,d+n));return `${t.getUTCFullYear()}-${pad(t.getUTCMonth()+1)}-${pad(t.getUTCDate())}`;}
function dowMon(ymd){const [y,m,d]=ymd.split('-').map(Number);return (new Date(Date.UTC(y,m-1,d)).getUTCDay()+6)%7;}
const weekStart=ymd=>addDays(ymd,-dowMon(ymd));
function longDate(ymd){const [y,m,d]=ymd.split('-').map(Number);return `${y}년 ${m}월 ${d}일 (${'일월화수목금토'[new Date(Date.UTC(y,m-1,d)).getUTCDay()]})`;}
const ymdOf=iso=>{if(!iso)return '';if(!String(iso).includes('T'))return String(iso).slice(0,10);const d=new Date(new Date(iso).getTime()+9*3600e3);return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;};
const md=x=>`${+x.slice(5,7)}/${+x.slice(8)}`;
function shiftMonth(ym,n){const [y,m]=ym.split('-').map(Number);const t=new Date(Date.UTC(y,m-1+n,1));return `${t.getUTCFullYear()}-${pad(t.getUTCMonth()+1)}`;}
const monthDays=ym=>{const [y,m]=ym.split('-').map(Number);return new Date(Date.UTC(y,m,0)).getUTCDate();};
// 반마다 색 이모지(리포트 student_report_part1.js와 같은 규칙): Notion 클래스 이모지가 비었을 때만 쓴다.
const CLASS_COLOR_EMOJIS=['🟣','🔵','🟢','🟠','🔴','🟡','🟤','⚪'];
function pickClassColorEmoji(seed){let h=0;for(const ch of String(seed||''))h=(h*31+ch.charCodeAt(0))>>>0;return CLASS_COLOR_EMOJIS[h%CLASS_COLOR_EMOJIS.length];}
const emojiOf=s=>s.classEmoji||pickClassColorEmoji(s.className||s.name);
const CHEVRON_DOWN='<svg class="line" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
const CHEVRON_UP='<svg class="line" viewBox="0 0 24 24" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>';
const CAL_DOW=['월','화','수','목','금','토','일'].map((l,i)=>`<div class="cal-dow${i===5?' sat':i===6?' sun':''}">${l}</div>`).join('');
const navBtn=(attr,label,ch)=>`<button class="cal-nav-btn" type="button" ${attr} aria-label="${label}"><span>${ch}</span></button>`;
const todayBtn=id=>`<button class="cal-today-btn" type="button" id="${id}"><span>오늘</span></button>`;
// 날짜 칸: 수업 있는 날은 칸을 칠하고(has), 지금 날짜는 진하게(picked), 오늘은 빨간 테두리. 수업 없는 날은 흐리게·누를 수 없음.
function dayCell(ymd,has,picked,attr){const c=['cal-day',has?'has':'off'];if(ymd===seoulDate())c.push('today');if(picked)c.push('picked');
 return `<button type="button" class="${c.join(' ')}" ${has?attr:'disabled tabindex="-1"'} aria-label="${esc(dateLabel(ymd))}${has?' 수업 있음':''}" aria-pressed="${!!picked}"><span>${Number(ymd.slice(8))}</span></button>`;}
function nowSessionId(sessions){const now=Date.now(),list=sessions.slice().sort((a,b)=>String(a.start).localeCompare(String(b.start)));
 const live=list.find(s=>Date.parse(s.start)<=now&&now<Date.parse(s.end||s.start)+60e3);if(live)return live.id;
 const next=list.find(s=>Date.parse(s.start)>now);return (next||list.at(-1))?.id||'';}
// 오늘 수업 열기(처음 들어올 때·강사를 바꿀 때)
async function openToday(){
 state.date=seoulDate();state.day=await fetchDay(state.date);
 const id=nowSessionId(state.day.sessions||[]);
 if(id)return openSessionNow(id);
 state.detail=null;state.sessionId='';state.view='empty';render();
}
function topBar(){
 const s=state.detail?.session,cal=!!(s&&s.classIds?.length);
 const title=s?`<b><span class="tb-emo">${s.makeup?'':esc(emojiOf(s))}</span>${esc(s.makeup?s.name:(s.className||s.name))}${s.makeup?' <span class="pill s-보강">보강</span>':''}</b><small>${esc(dateLabel(state.date))} ${esc(s.time||'')}</small>`
  :`<b>${state.date===seoulDate()?'오늘 수업 없음':'수업 없음'}</b><small>${esc(dateLabel(state.date))}</small>`;
 $('bar').innerHTML=`<div class="bar-in tb-in"><button class="icon-btn" id="tb-menu" type="button" aria-label="클래스 선택">${icon('menu')}</button><div class="tb-title">${title}</div><button class="icon-btn" id="tb-cal" type="button" aria-label="날짜 이동" ${cal?'':'disabled'}>${icon('cal')}</button></div>`;
 $('tb-menu').onclick=()=>{if(leaveEdit())openClassDrawer();};
 $('tb-cal').onclick=()=>{if(leaveEdit())openDateDrawer();};
}
// ---------- 서랍(v2.5.80): ≡ 왼쪽 = 강사의 클래스 목록, 📅 오른쪽 = 이 반 날짜 ----------
// 서랍은 dialog 하나를 왼쪽·오른쪽으로 바꿔 쓴다. 바깥(어두운 곳)을 누르거나 ✕로 닫는다.
function drawer(side,title,body){const d=$('drawer');d.className=`drawer ${side}`;
 d.innerHTML=`<div class="dr-in"><div class="dr-head"><h2>${title}</h2><button class="icon-btn" type="button" id="dr-x" aria-label="닫기">${icon('x')}</button></div>${body}</div>`;
 $('dr-x').onclick=()=>d.close();if(!d.open)d.showModal();return d;}
$('drawer').addEventListener('click',e=>{if(e.target===$('drawer'))$('drawer').close();});
// ≡ 클래스 목록: [이모지] [클래스명] [오늘 수업시간]. 오늘 수업이 있는 반을 시간순으로 위에, 나머지는 이름순(시간 칸에 "수업 없음").
// 반을 누르면 오늘 수업(진행 중 → 다음 → 마지막) → 없으면 다음 수업 → 없으면 가장 최근 수업을 연다. 날짜는 📅에서 고른다.
const classesKey=()=>state.teacherId+'|'+seoulDate();
async function openClassDrawer(){
 if(state.classes?.key===classesKey()){drawClassDrawer();api('classes',{date:seoulDate(),...teacherArg()}).then(r=>{state.classes={key:classesKey(),list:r.classes};if($('drawer').open&&$('drawer').classList.contains('left'))drawClassDrawer();}).catch(()=>{});return;}
 await run(async()=>{state.classes={key:classesKey(),list:(await api('classes',{date:seoulDate(),...teacherArg()})).classes};drawClassDrawer();});
}
function drawClassDrawer(){
 const who=state.teacherId==='all'?'전체 수업':teacherName(state.teacherId),cur=state.detail?.session?.classIds?.[0]||'';
 const list=(state.classes?.list||[]).slice().sort((a,b)=>(!a.today.length-!b.today.length)||String(a.today[0]?.start||'').localeCompare(String(b.today[0]?.start||''))||a.name.localeCompare(b.name,'ko'));
 const waiting=state.day?.makeupWaiting||[];
 const d=drawer('left',esc(state.teacherId==='all'?'전체 클래스':`${who} 선생님 클래스`),
 `<div class="list">${list.length?list.map(c=>`<button class="row srow ${c.classId===cur?'cur':''}" type="button" data-class="${esc(c.classId)}"><span class="emo">${esc(c.emoji||pickClassColorEmoji(c.name))}</span><span class="meta"><span class="t">${esc(c.name)}</span></span><span class="time ${c.today.length?'':'none'}">${esc(c.today[0]?.time||'수업 없음')}</span></button>`).join(''):'<p class="empty">앞뒤 4주 안에 수업이 있는 클래스가 없어요.</p>'}</div>
 <div class="list wait"><button class="row srow" type="button" id="open-wait"><span class="emo ico">${icon('users')}</span><span class="meta"><span class="t">보강 대기실</span></span><span class="cnt-pill">${waiting.length}명</span><span class="time chev">›</span></button></div>
 <div class="dr-foot"><button class="secondary wide" type="button" id="dr-who">강사 바꾸기 · ${esc(who)}</button></div>`);
 d.querySelectorAll('[data-class]').forEach(b=>b.onclick=()=>{const c=list.find(x=>x.classId===b.dataset.class),id=nowSessionId(c.today)||c.next?.id||c.last?.id;if(!id)return;
  if(id===state.sessionId){d.close();return;}run(async()=>{await openSessionNow(id);d.close();},b);});
 $('open-wait').onclick=()=>{d.close();state.view='waiting';state.picked=new Set();render();};
 $('dr-who').onclick=()=>{d.close();showTeachers();};
}
// 📅 이 반 날짜: 월 캘린더(수업 있는 날 칠함, 보고 있는 날 진하게, 오늘 빨간 테두리) + [‹ 직전] [다음 ›]. 날짜를 누르면 그 수업으로 가고 닫힌다(보던 탭 유지).
function openDateDrawer(){state.cwMonth=state.date.slice(0,7);drawDateDrawer();}
function drawDateDrawer(){
 const s=state.detail.session,list=state.classWeek||[],byDate=new Map(list.map(x=>[x.date,x])),ym=state.cwMonth,[y,m]=ym.split('-').map(Number),first=`${ym}-01`;
 const cell=dd=>{const x=byDate.get(dd);return dayCell(dd,!!x,x&&x.id===state.sessionId,x?`data-cs="${esc(x.id)}"`:'');};
 const i=list.findIndex(x=>x.id===state.sessionId),prev=list[i-1],next=list[i+1];
 const d=drawer('right',`<span class="tb-emo">${esc(emojiOf(s))}</span>${esc(s.className||s.name)} 날짜`,
 `<div class="attendance-calendar flat"><div class="cal-month-nav">${navBtn('data-cwm="-1"','이전 달','‹')}<div class="cal-month-title">${y}년 ${m}월</div><div class="cal-nav-right">${todayBtn('cw-today')}${navBtn('data-cwm="1"','다음 달','›')}</div></div>
 <div class="cal-grid">${CAL_DOW}${Array.from({length:dowMon(first)},()=>'<div class="cal-day empty"></div>').join('')}${Array.from({length:monthDays(ym)},(_,k)=>cell(`${ym}-${pad(k+1)}`)).join('')}</div></div>
 <div class="jump"><button class="secondary" type="button" ${prev?`data-cs="${esc(prev.id)}"`:'disabled'}>‹ 직전${prev?' '+md(prev.date):''}</button><button class="secondary" type="button" ${next?`data-cs="${esc(next.id)}"`:'disabled'}>다음${next?' '+md(next.date):''} ›</button></div>`);
 d.querySelectorAll('[data-cs]').forEach(b=>b.onclick=()=>{const id=b.dataset.cs;if(id===state.sessionId){d.close();return;}run(async()=>{await openSessionNow(id,true);d.close();},b);});
 $('cw-today').onclick=e=>{const x=list.find(z=>z.date===seoulDate());if(x){if(x.id===state.sessionId)d.close();else run(async()=>{await openSessionNow(x.id,true);d.close();},e.currentTarget);return;}
  run(async()=>{state.cwMonth=seoulDate().slice(0,7);await ensureClassMonth(state.cwMonth);drawDateDrawer();},e.currentTarget);};
 d.querySelectorAll('[data-cwm]').forEach(b=>b.onclick=()=>run(async()=>{state.cwMonth=shiftMonth(state.cwMonth,Number(b.dataset.cwm));await ensureClassMonth(state.cwMonth);drawDateDrawer();},b));
}
// 다른 달을 보면 그 달까지 이 반 수업을 더 읽어 합친다.
async function ensureClassMonth(ym){const list=state.classWeek||[],from=`${ym}-01`,to=`${ym}-${pad(monthDays(ym))}`;
 if(list.length&&state.cwFrom<=from&&to<=state.cwTo)return;
 const more=(await api('class-sessions',{sessionId:state.sessionId,around:`${ym}-15`})).sessions||[];
 const map=new Map(list.map(x=>[x.id,x]));more.forEach(x=>map.set(x.id,x));state.classWeek=[...map.values()].sort((a,b)=>a.date.localeCompare(b.date));
 state.cwFrom=state.cwFrom&&state.cwFrom<addDays(`${ym}-15`,-63)?state.cwFrom:addDays(`${ym}-15`,-63);state.cwTo=state.cwTo&&state.cwTo>addDays(`${ym}-15`,35)?state.cwTo:addDays(`${ym}-15`,35);}
function renderEmpty(){
 topBar();setTabs(true);
 $('app').innerHTML=`<div class="list"><p class="empty tall">${state.date===seoulDate()?'오늘은':esc(dateLabel(state.date))+'에는'} ${state.teacherId==='all'?'':esc(teacherName(state.teacherId))+' 선생님 '}수업이 없어요.<br>왼쪽 위 ≡ 에서 클래스를 고를 수 있어요.</p></div>`;
}
// + 기록 만들기 창(v2.5.80): 클래스(보고 있는 날짜의 내 수업) → 교재(리포트 교재 카드처럼 표지·진도) → 구분 → 주제 → 범위 → 내용. 만든 뒤 바로 기록 화면으로 간다.
async function openCreateSheet(){
 if(!leaveEdit())return;
 const sessions=(state.day?.sessions||[]).slice();if(state.detail&&!sessions.some(s=>s.id===state.sessionId))sessions.push(state.detail.session);sessions.sort((a,b)=>String(a.start).localeCompare(String(b.start)));
 if(!sessions.length){toast(`${state.date===seoulDate()?'오늘':dateLabel(state.date)} 수업이 없어요. Notion에서 수업 페이지를 먼저 만들어 주세요.`);return;}
 if(state.date!==seoulDate()&&!confirm(`오늘 수업이 아닙니다. ${dateLabel(state.date)} 수업으로 기록을 만들까요?`))return;
 state.form={kind:state.form?.kind||'학습',sessionId:sessions.some(s=>s.id===state.sessionId)?state.sessionId:sessions[0].id,sessions,book:null,topic:'',range:'',content:''};
 await run(async()=>{await booksFor(state.form.sessionId);});drawCreate();if(!$('sheet').open)$('sheet').showModal();
}
async function booksFor(id){state.bookCache=state.bookCache||{};if(!state.bookCache[id])state.bookCache[id]=await api('books',{sessionId:id});return state.bookCache[id];}
// 교재 카드 묶음: 반 교재 / 개별 교재 묶음("n명 모두"·학생 한 명) / 학생별 교재. 진행 중인 교재만(없으면 전체).
// 묶음 카드의 진도는 평균, 최근 범위는 "첫 학생 범위 외 n명". 기록 카드에서 바꿀 때(single)는 교재 하나만 고르므로 묶음 카드를 빼고, 지금 교재(include)는 진행 중이 아니어도 보인다.
function bookChoices(data,{single=false,include=''}={}){
 const {books,registrations}=data,regName=id=>(registrations.find(r=>r.id===id)?.name||'').split(' ')[0],names=b=>b.ownerIds.map(regName).join(', ');
 let shown=books.filter(b=>!b.status||b.status==='진행 중'||b.id===include);if(!shown.length)shown=books;
 const group=shown.filter(b=>b.mode==='그룹 진도'),ind=shown.filter(b=>b.mode!=='그룹 진도'),tpl={};
 ind.forEach(b=>{if(b.templateId)(tpl[b.templateId]=tpl[b.templateId]||[]).push(b);});
 const loose=ind.filter(b=>!b.templateId||tpl[b.templateId].length<2),base=n=>n.replace(/\(.*\)$/,'').trim();
 const card=(b,sub)=>({value:b.id,title:base(b.name)||b.name,sub,cover:b.cover,progress:b.progress,recent:b.recent});
 const out=[];
 if(group.length)out.push({label:'반 교재',items:group.map(b=>card(b,`반 교재 · ${b.ownerIds.length}명${b.pages?` · ${b.pages}쪽`:''}`))});
 Object.values(tpl).filter(l=>l.length>1).forEach(list=>{const p=list.map(b=>b.progress).filter(x=>x!==null),first=list.find(b=>b.recent);
  out.push({label:`${base(list[0].name)} · 개별 ${list.length}명`,items:[...(single?[]:[{value:list.map(b=>b.id).join(','),title:base(list[0].name),sub:`개별 · ${list.length}명 모두 · 학생마다 기록`,cover:list[0].cover,
   progress:p.length?Math.round(p.reduce((a,x)=>a+x,0)/p.length):null,recent:first?`${names(first)} ${first.recent}${list.length>1?` 외 ${list.length-1}명`:''}`:''}]),...list.map(b=>card(b,`개별 · ${names(b)}`))]});});
 if(loose.length)out.push({label:'학생별 교재',items:loose.map(b=>card(b,`학생별 · ${names(b)}`))});
 return out;
}
const BOOK_ICON='<svg class="line" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
// 교재 카드 한 장(리포트 .book-row 모양). 표지 주소는 Notion 파일이라 만료될 수 있어, 그림이 안 열리면 책 아이콘으로 바뀐다.
function bookRow(it,{attr='',on=false,chev=false}={}){
 return `<button class="book-row ${on?'on':''}" type="button" ${attr}><span class="br-cover">${BOOK_ICON}${it.cover?`<img src="${esc(it.cover)}" alt="" loading="lazy">`:''}</span><span class="br-body"><span class="br-title">${esc(it.title)}</span><span class="br-sub">${esc(it.sub)}</span>
 ${it.progress!==null&&it.progress!==undefined?`<span class="progress-line"><span class="track"><span class="fill" style="width:${Math.max(0,Math.min(100,it.progress))}%"></span></span><b>${it.progress}%</b></span>`:''}${it.recent?`<span class="br-recent">${icon('학습')}<span>최근 ${esc(it.recent)}</span></span>`:''}</span>${on?`<span class="br-check">${icon('check')}</span>`:''}${chev?'<span class="br-chev" aria-hidden="true">›</span>':''}</button>`;}
const emptyBookRow=(attr,title,sub,ic=BOOK_ICON)=>`<button class="book-row empty" type="button" ${attr}><span class="br-cover">${ic}</span><span class="br-body"><span class="br-title">${title}</span><span class="br-sub">${sub}</span></span><span class="br-chev" aria-hidden="true">›</span></button>`;
const bindCovers=root=>root.querySelectorAll('.br-cover img').forEach(i=>{i.onerror=()=>i.remove();});
function sessionLabel(s,list){const name=s.makeup?s.name:(s.className||s.name),dup=list.filter(x=>(x.makeup?x.name:(x.className||x.name))===name).length>1;return (s.makeup?'':emojiOf(s)+' ')+name+(dup?' · '+s.time:'');}
function drawCreate(){
 const f=state.form,choices=bookChoices(state.bookCache[f.sessionId]),picked=choices.flatMap(g=>g.items).find(x=>x.value===f.book);
 $('sheet').innerHTML=`<div class="dialog-head"><h2>기록 만들기</h2><button class="ghost" type="button" id="sh-x">닫기</button></div>
 <form id="cf" class="form"><label for="cf-s">클래스 <span class="muted">${esc(dateLabel(state.date))} 수업</span></label><select id="cf-s">${f.sessions.map(s=>`<option value="${esc(s.id)}" ${s.id===f.sessionId?'selected':''}>${esc(sessionLabel(s,f.sessions))}</option>`).join('')}</select>
 <label>교재 <span class="muted">이 반 학생들의 교재</span></label>${picked?bookRow(picked,{attr:'id="cf-b" aria-label="교재 바꾸기"',chev:true}):f.book===''?emptyBookRow('id="cf-b"','교재 없이 기록','주제로 기록해요 · 눌러서 바꾸기',icon('plus')):emptyBookRow('id="cf-b"','교재 비어 있음','눌러서 이 반 학생들의 교재 고르기')}
 <label>구분</label><div class="center-tabs left kind-tabs"><div class="tabs" role="tablist">${KINDS.map(k=>`<button type="button" role="tab" aria-selected="${k===f.kind}" class="${k===f.kind?'active':''}" data-ck="${k}"><span>${icon(k,'kind-ic')}${k}</span></button>`).join('')}</div></div>
 <label for="cf-t">주제 <span class="muted">${f.book===''?'(필수)':'(선택)'}</span></label><input id="cf-t" maxlength="200" placeholder="교재 없는 기록은 리포트에 주제가 보여요" value="${esc(f.topic)}">
 <label for="cf-r">범위</label><input id="cf-r" maxlength="200" placeholder="예: p.31-35" value="${esc(f.range)}">
 <label for="cf-c">내용</label><textarea id="cf-c" maxlength="2000">${esc(f.content)}</textarea>
 <p class="error" id="cf-err" hidden></p><div class="actions"><button class="primary" type="submit">기록 만들기</button></div></form>`;
 const sh=$('sheet'),q=s=>sh.querySelector(s),keep=()=>{f.topic=q('#cf-t').value;f.range=q('#cf-r').value;f.content=q('#cf-c').value;};
 $('sh-x').onclick=()=>sh.close();bindCovers(sh);bulletize(q('#cf-c'));
 sh.querySelectorAll('[data-ck]').forEach(b=>b.onclick=()=>{f.kind=b.dataset.ck;sh.querySelectorAll('[data-ck]').forEach(x=>{const on=x===b;x.classList.toggle('active',on);x.setAttribute('aria-selected',on);});});
 q('#cf-s').onchange=e=>run(async()=>{keep();f.sessionId=e.target.value;f.book=null;await booksFor(f.sessionId);drawCreate();});
 q('#cf-b').onclick=()=>{keep();drawBookPicker(bookChoices(state.bookCache[f.sessionId]),f.book,v=>{f.book=v;drawCreate();},drawCreate,'교재 없이 기록','주제로 기록해요(주제 필수)');};
 q('#cf').onsubmit=e=>{e.preventDefault();keep();const topic=f.topic.trim(),err=q('#cf-err');err.hidden=true;
  if(f.book===null){err.hidden=false;err.textContent='교재를 골라 주세요. 교재 없이 만들려면 교재 고르기에서 "교재 없이 기록"을 골라요.';return;}
  if(!f.book&&!topic){err.hidden=false;err.textContent='교재 없이 만들 때는 주제를 적어 주세요.';q('#cf-t').focus();return;}
  run(async()=>{const r=await api('create-records',{sessionId:f.sessionId,kind:f.kind,...(f.book?{bookIds:f.book.split(',')}:{}),...(topic?{topic}:{}),range:f.range,content:f.content});
   sh.close();if(f.sessionId!==state.sessionId)await openSessionNow(f.sessionId);else await reloadSession();
   const made=r.records.filter(x=>x.created).length;toast(made?`기록 ${made}개를 만들었어요.`:'이미 있는 기록이에요. 기록 화면에서 고쳐 주세요.');
   if(r.records.length===1)await openRecordNow(r.records[0].id);else{state.view='session';state.tab='records';render();}},e.submitter);};
}
// 교재 고르기(기록 만들기·기록 카드 공용): 창 안을 카드 목록으로 바꿔 보여 주고, 고르면 onPick(값), 돌아가기는 onBack.
function drawBookPicker(choices,cur,onPick,onBack,noneTitle,noneSub){
 $('sheet').innerHTML=`<div class="dialog-head"><h2>교재 고르기</h2><button class="ghost" type="button" id="bk-back">돌아가기</button></div>
 ${choices.map(g=>`<p class="group-label">${esc(g.label)}</p><div class="br-list">${g.items.map(it=>bookRow(it,{attr:`data-book="${esc(it.value)}"`,on:it.value===cur})).join('')}</div>`).join('')}
 ${choices.length?'':'<div class="list"><p class="empty">이 반 학생들에게 연결된 진행 중 교재가 없어요.</p></div>'}
 <p class="group-label">교재 없이</p><div class="br-list">${emptyBookRow('data-book=""',noneTitle,noneSub,icon('plus'))}</div>`;
 const sh=$('sheet');bindCovers(sh);sh.scrollTop=0;if(!sh.open)sh.showModal();
 $('bk-back').onclick=onBack;
 sh.querySelectorAll('[data-book]').forEach(b=>b.onclick=()=>onPick(b.dataset.book));
}

// ---------- 보강 대기실 ----------
function renderWaiting(){
 setTabs(false);const w=state.day?.makeupWaiting||[],made=(state.day?.sessions||[]).filter(s=>s.makeup);
 bar([longDate(state.date),'보강 대기실'],{back:()=>run(async()=>{if(state.sessionId)await openSessionNow(state.sessionId,true);else await openToday();})});
 $('app').innerHTML=`<p class="page-title">${icon('users')}보강 대기실</p><p class="page-hint">학생을 골라 보강 수업을 만들어요. 1명이면 1:1, 여러 명이면 그룹 보강이에요.</p>
 ${w.length?`<div class="list">${w.map(x=>`<button class="row" type="button" data-pick="${esc(x.attendanceId)}"><span class="pick">${icon(state.picked.has(x.attendanceId)?'checked':'square','check')}</span><span class="meta"><span class="t">${esc(x.name)}</span><span class="d">${esc(x.className)}${x.start?' · '+timeOf(x.start):''}</span></span>${nlink(x.attendanceId,x.name+' 출석')}</button>`).join('')}</div>
 <div class="actions"><button class="primary" id="make" type="button" ${state.picked.size?'':'disabled'}>보강 수업 만들기${state.picked.size?' · '+state.picked.size+'명':''}</button></div>`:'<div class="list"><p class="empty">배정할 보강 학생이 없어요.</p></div>'}
 ${made.length?`<h2 class="sec-title">${icon('check')}만든 보강 수업</h2><div class="list">${made.map(s=>`<div class="row"><span class="meta"><span class="t">${esc(s.name)}</span><span class="d">${esc(s.time)} · 학생 ${s.students}명 · 기록 ${s.records}</span></span><button class="ghost" type="button" data-open="${esc(s.id)}">열기</button>${s.records?'':`<button class="ghost" type="button" data-del="${esc(s.id)}">수업 삭제</button>`}${nlink(s.id,s.name)}</div>`).join('')}</div>`:''}`;
 $('app').querySelectorAll('[data-pick]').forEach(b=>b.onclick=e=>{if(e.target.closest('a'))return;const id=b.dataset.pick;state.picked.has(id)?state.picked.delete(id):state.picked.add(id);renderWaiting();});
 $('app').querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openSession(b.dataset.open,b));
 $('app').querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{if(!confirm('이 보강 수업을 지울까요? 학생들은 보강 대기실로 돌아가요.'))return;run(async()=>{await api('delete-makeup-session',{sessionId:b.dataset.del});await loadDay();toast('보강 수업을 지웠어요.');renderWaiting();},b);});
 if($('make'))$('make').onclick=openMakeupSheet;
}
function openMakeupSheet(){
 const now=new Date(Date.now()+9*3600e3),hh=pad(now.getUTCHours()),mm=pad(Math.ceil(now.getUTCMinutes()/10)*10%60);
 const tid=state.teacherId&&state.teacherId!=='all'?state.teacherId:'';
 $('sheet').innerHTML=`<div class="dialog-head"><h2>보강 수업 만들기</h2><button class="ghost" type="button" id="sh-x">닫기</button></div>
 <form id="mk" class="form"><label for="mk-t">담당강사</label><select id="mk-t" required><option value="">강사 고르기</option>${state.teachers.map(t=>`<option value="${esc(t.id)}" ${t.id===tid?'selected':''}>${esc(t.name)}</option>`).join('')}</select>
 <label for="mk-s">시작</label><input type="time" id="mk-s" value="${hh}:${mm}" required><label for="mk-e">끝 (선택)</label><input type="time" id="mk-e">
 <p class="target">학생 ${state.picked.size}명 · 시간표·클래스 없는 보강 수업으로 만들어요.</p><div class="actions"><button class="primary" type="submit">만들기</button></div></form>`;
 $('sheet').showModal();$('sh-x').onclick=()=>$('sheet').close();
 $('mk').onsubmit=e=>{e.preventDefault();const iso=t=>t?new Date(`${state.date}T${t}:00+09:00`).toISOString():undefined;
  run(async()=>{const r=await api('create-makeup-session',{attendanceIds:[...state.picked],teacherId:$('mk-t').value,start:iso($('mk-s').value),end:iso($('mk-e').value)});$('sheet').close();state.picked=new Set();await loadDay();toast('보강 수업을 만들었어요.');await openSessionNow(r.sessionId);},e.submitter);};
}

// ---------- 수업 ----------
// 리포트처럼 모든 폭에서 640 한 줄. 하단 탭으로 학생 목록 / 학습기록을 오가고, 학생 공간·기록 카드는 새 화면.
// 칸 머리는 제목 / 안내 / 가운데 탭 3줄.
async function openSession(id,btn){await run(()=>openSessionNow(id),btn);}
// keep=true: 📅 날짜 이동으로 같은 반의 다른 수업으로 옮길 때 보던 탭·출석/과제 검사 전환을 그대로 둔다.
// 수업 날짜(서울)를 보고 있는 날짜로 삼고, 그날 내 수업 목록(state.day)을 함께 맞춘다(+ 기록 만들기의 클래스 목록).
async function openSessionNow(id,keep=false){
 const [detail,week]=await Promise.all([api('session',{sessionId:id}),api('class-sessions',{sessionId:id}).catch(()=>({sessions:[]}))]);
 const date=ymdOf(detail.session.start)||state.date;
 if(date!==state.date||!state.day)state.day=await fetchDay(date).catch(()=>({sessions:[],makeupWaiting:[]}));
 state.date=date;state.sessionId=id;state.detail=detail;state.classWeek=week.sessions||[];state.cwFrom=addDays(date,-63);state.cwTo=addDays(date,35);state.view='session';state.books=null;
 if(!keep){state.tab='students';state.seg='att';state.recKind='전체';}
 state.edit=false;state.draft={};state.hwRecord=state.detail.homeworkDue[0]?.recordId||'';render();}
async function reloadSession(){state.detail=await api('session',{sessionId:state.sessionId});}
function paneHead(title,hint,tabs='',acts=''){
 return `<div class="ph title-row">${title}</div><p class="page-hint ph">${hint}</p>`+(tabs||acts?`<div class="ph tab-row"><span></span>${tabs?`<div class="center-tabs"><div class="tabs" role="tablist">${tabs}</div></div>`:'<span></span>'}<span class="acts">${acts}</span></div>`:'');
}
// 내용 칸 글머리(v2.5.81): 줄 맨 앞에서 "- " 또는 "* "를 치면 Notion처럼 "  • "(앞 두 칸 띄움)로 바뀐다.
// 글머리 줄에서 Tab은 한 단계 들여쓰기("      ◦ " → "          ▪ ", 4칸씩), Shift+Tab은 내어쓰기. Enter는 다음 줄에 같은 단계 글머리를 잇고,
// 빈 글머리 줄에서 Enter와 글머리 바로 뒤 Backspace는 한 단계 내어쓰고 첫 단계면 글머리를 지운다.
// 저장은 글자 그대로라 리포트·Notion에도 점으로 보인다. 한글 조합 중에는 건드리지 않는다. 글머리가 아닌 줄의 Tab은 원래대로(다음 칸으로 이동).
const BULLETS=['  • ','      ◦ ','          ▪ '];
function bulletize(ta,onChange){
 const lineStart=()=>ta.value.lastIndexOf('\n',ta.selectionStart-1)+1;
 const set=(v,pos)=>{ta.value=v;ta.setSelectionRange(pos,pos);if(onChange)onChange();};
 ta.addEventListener('input',e=>{if(e.isComposing||ta.selectionStart!==ta.selectionEnd)return;const p=ta.selectionStart,s=lineStart(),head=ta.value.slice(s,p);
  if(head==='- '||head==='* ')set(ta.value.slice(0,s)+BULLETS[0]+ta.value.slice(p),s+BULLETS[0].length);});
 ta.addEventListener('keydown',e=>{if(e.isComposing||e.keyCode===229||ta.selectionStart!==ta.selectionEnd)return;
  const v=ta.value,p=ta.selectionStart,s=lineStart(),lvl=BULLETS.findIndex(b=>v.startsWith(b,s));if(lvl<0)return;const b=BULLETS[lvl];if(p<s+b.length)return;
  const to=n=>{const nb=n<0?'':BULLETS[n];set(v.slice(0,s)+nb+v.slice(s+b.length),p-b.length+nb.length);};
  if(e.key==='Tab'){e.preventDefault();if(e.shiftKey)to(lvl-1);else if(lvl<BULLETS.length-1)to(lvl+1);}
  else if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();const end=v.indexOf('\n',p),lineEnd=end<0?v.length:end;
   if(v.slice(s,lineEnd)===b)to(lvl-1);else set(v.slice(0,p)+'\n'+b+v.slice(p),p+1+b.length);}
  else if(e.key==='Backspace'&&p===s+b.length){e.preventDefault();to(lvl-1);}});
}
const tabBtn=(on,attr,label)=>`<button type="button" role="tab" aria-selected="${on}" class="${on?'active':''}" ${attr}><span>${esc(label)}</span></button>`;
const editing=owner=>state.edit&&state.editOwner===owner;
function editButton(owner){return `<button class="act" type="button" data-edit="${owner}"><span>${editing(owner)?'취소':'편집'}</span></button>`;}
// 편집은 한 번에 한 칸만. 다른 칸의 [편집]을 누르면 지금 편집을 정리(변경이 있으면 확인)하고 넘어간다.
function bindEdit(root){root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{const owner=b.dataset.edit;
 if(editing(owner)){state.edit=false;state.draft={};}else{if(!leaveEdit())return;state.edit=true;state.editOwner=owner;state.draft={};}
 state.saver=null;updateSavebar();render();});}
function sessionBar(){const s=state.detail.session,v=state.view;
 if(v==='session')return topBar();
 const extra=v==='student'?[state.student.name]:[state.acts.record.kind||'기록'];
 bar([s.className||s.name,...extra],{back:()=>{if(!leaveEdit())return;if(v==='record')state.tab='records';state.view='session';render();},
  notion:v==='student'?state.student.attendanceId:state.acts.record.id});}
function renderSession(){
 sessionBar();const v=state.view,el=$('app');state.saver=null;setTabs(true);
 (v==='student'?paneStudent:v==='record'?paneRecord:state.tab==='records'?paneRecords:paneStudents)(el);
}
function paneStudents(el){
 const d=state.detail,att=state.seg==='att',ed=editing('students');
 const n=s=>d.students.filter(x=>(state.draft[x.attendanceId]?.status??x.status)===s).length;
 const hw=d.homeworkDue,cur=hw.find(h=>h.recordId===state.hwRecord)||hw[0],sub=i=>state.draft[i.activityId]?.submitted??i.submitted;
 const nameOf=i=>d.students.find(s=>s.attendanceId===i.attendanceId)?.name||'학생';
 const hint=att?`출석 <b>${n('🟢 출석')}</b> · 결석 <b>${n('🔴 결석')}</b> · 보강 <b>${n('🔵 보강')}</b> · 웹 출석은 알림톡을 보내지 않아요`
  :cur?`제출 <b>${cur.items.filter(sub).length}</b> · 미제출 <b>${cur.items.filter(i=>!sub(i)).length}</b> · 오늘이 마감인 과제예요`:'오늘이 마감인 과제를 제출·미제출로 체크해요';
 const acts=att?(d.students.length?editButton('students'):''):cur?editButton('students')+nlink(cur.recordId,cur.title):'';
 let body='';
 if(att){
  // 한 줄(v2.5.80): [이름] [출석 상태] [등원] [하원] [메모]. 이름을 누르면 학생 공간, 메모를 누르면 메모 창(바로 저장). 편집 중에는 [이름] [출석|결석|보강]만.
  const rows=d.students.map(s=>{const st=state.draft[s.attendanceId]?.status??s.status,ch=state.draft[s.attendanceId];
   return `<div class="row s1 ${ch?'changed':''} ${st==='🔴 결석'&&!ed?'dim':''}">${ed?`<span class="nm">${esc(s.name)}</span>
   <span class="seg">${Object.entries(STATUS).map(([v,l])=>`<button type="button" class="v-${l} ${st===v?'on':''}" data-att="${esc(s.attendanceId)}" data-v="${v}">${l}</button>`).join('')}</span>`
   :`<button class="nm" type="button" data-student="${esc(s.attendanceId)}" aria-label="${esc(s.name)} 학생 공간">${esc(s.name)}</button><span class="c"><span class="pill s-${STATUS[st]||''}">${STATUS[st]||'미입력'}</span></span>
   <span class="c tm">${s.arrivedAt?timeOf(s.arrivedAt):'–'}</span><span class="c tm">${s.leftAt?timeOf(s.leftAt):'–'}</span>
   <button class="c memo-btn ${s.memo?'has':''}" type="button" data-memo="${esc(s.attendanceId)}" aria-label="${esc(s.name)} 메모${s.memo?' 있음':''}">${icon('memo')}</button>`}</div>`;}).join('');
  body=d.students.length?`<div class="list stu ${ed?'editing':''}"><div class="srow-h" aria-hidden="true"><span>이름</span><span class="c">출석</span>${ed?'':'<span class="c">등원</span><span class="c">하원</span><span class="c">메모</span>'}</div>${rows}</div>`
   :'<div class="list"><p class="empty">이 수업에 연결된 학생이 없어요.</p></div>';
 }else if(!cur)body='<div class="list"><p class="empty">오늘이 마감인 과제가 없어요.</p></div>';
 else{
  const pick=hw.length>=4?`<select id="hw-pick">${hw.map(h=>`<option value="${esc(h.recordId)}" ${h.recordId===cur.recordId?'selected':''}>${esc(h.title)}</option>`).join('')}</select>`:hw.length>1?`<div class="chips">${hw.map(h=>`<button class="chip ${h.recordId===cur.recordId?'on':''}" type="button" data-hw="${esc(h.recordId)}">${esc(h.range||h.title)} ${h.items.filter(sub).length}/${h.items.length}</button>`).join('')}</div>`:'';
  body=`${pick||ed?`<div class="toolrow pick-row"><div class="grow">${pick}</div>${ed?'<button class="act" type="button" id="all-done"><span>전원 제출</span></button>':''}</div>`:''}
  <div class="list">${cur.items.map(i=>{const v=sub(i),ch=state.draft[i.activityId];return `<div class="row ${ch?'changed':''}"><span class="meta"><span class="t">${esc(nameOf(i))}</span></span>
  ${ed?`<span class="seg"><button type="button" class="v-제출 ${v?'on':''}" data-hwact="${esc(i.activityId)}" data-v="1">제출</button><button type="button" class="v-미제출 ${v?'':'on'}" data-hwact="${esc(i.activityId)}" data-v="0">미제출</button></span>`:`<span class="pill ${v?'done':'miss'}">${v?'제출':'미제출'}</span>`}${nlink(i.activityId,nameOf(i)+' 학습활동')}</div>`;}).join('')}</div>`;
 }
 el.innerHTML=paneHead(`<p class="page-title">${icon('users')}학생 목록</p>${nlink(d.session.id,'수업')}`,hint,tabBtn(att,'data-seg="att"','출석')+tabBtn(!att,'data-seg="hw"','과제 검사'),acts)+`<div class="pbody">${body}</div>`;
 el.querySelectorAll('[data-seg]').forEach(b=>b.onclick=()=>{if(!leaveEdit())return;state.seg=b.dataset.seg;render();});
 el.querySelectorAll('[data-hw]').forEach(b=>b.onclick=()=>{if(!leaveEdit())return;state.hwRecord=b.dataset.hw;render();});
 const hp=el.querySelector('#hw-pick');if(hp)hp.onchange=e=>{if(!leaveEdit()){e.target.value=state.hwRecord;return;}state.hwRecord=e.target.value;render();};
 bindEdit(el);
 el.querySelectorAll('[data-att]').forEach(b=>b.onclick=()=>{const id=b.dataset.att,orig=d.students.find(s=>s.attendanceId===id).status;if(b.dataset.v===orig)delete state.draft[id];else state.draft[id]={status:b.dataset.v};render();});
 el.querySelectorAll('[data-hwact]').forEach(b=>b.onclick=()=>{const id=b.dataset.hwact,v=b.dataset.v==='1',orig=hw.flatMap(h=>h.items).find(i=>i.activityId===id).submitted;if(v===orig)delete state.draft[id];else state.draft[id]={submitted:v};render();});
 const ad=el.querySelector('#all-done');if(ad)ad.onclick=()=>{cur.items.forEach(i=>{if(i.submitted)delete state.draft[i.activityId];else state.draft[i.activityId]={submitted:true};});render();};
 el.querySelectorAll('[data-student]').forEach(b=>b.onclick=()=>openStudent(b.dataset.student,b));
 el.querySelectorAll('[data-memo]').forEach(b=>b.onclick=()=>openMemo(b.dataset.memo));
 if(ed)state.saver=async()=>{const entries=Object.entries(state.draft);
  if(att)await api('save-attendance',{items:entries.map(([attendanceId,v])=>({attendanceId,...v}))});
  else await api('save-activities',{items:entries.map(([activityId,v])=>({activityId,...v}))});
  state.edit=false;state.draft={};updateSavebar();await reloadSession();toast(`저장했어요 · ${entries.length}건`);render();};
}

// 메모 창(v2.5.80): 메모를 바로 보고 고쳐 [저장]하면 바로 저장한다(편집 모드 없이). 빠른 입력은 메모 끝에 붙인다.
const QUICK_MEMO=['교재 두고 옴','과제 안 해 옴','집중 좋음','조퇴'];
function openMemo(id){
 const s=state.detail.students.find(x=>x.attendanceId===id),c=state.detail.session,sh=$('sheet');
 sh.innerHTML=`<div class="dialog-head"><h2>${esc(s.name)} 메모</h2><button class="ghost" type="button" id="sh-x">닫기</button></div>
 <p class="page-hint">${esc(dateLabel(state.date))} ${esc(c.className||c.name)}${s.arrivedAt?' · 등원 '+timeOf(s.arrivedAt):''}${s.leftAt?' · 하원 '+timeOf(s.leftAt):''}</p>
 <form id="mf" class="form"><textarea id="mf-t" maxlength="2000" aria-label="${esc(s.name)} 메모">${esc(s.memo)}</textarea>
 <div class="chips quick">${QUICK_MEMO.map(q=>`<button class="chip" type="button" data-q="${esc(q)}">+ ${esc(q)}</button>`).join('')}</div>
 <div class="actions"><button class="primary" type="submit">저장</button></div></form>`;
 sh.showModal();$('sh-x').onclick=()=>sh.close();const t=$('mf-t');
 sh.querySelectorAll('[data-q]').forEach(b=>b.onclick=()=>{const v=t.value.trim();t.value=v?`${v}, ${b.dataset.q}`:b.dataset.q;t.focus();});
 $('mf').onsubmit=e=>{e.preventDefault();const v=t.value;if(v===(s.memo||'')){sh.close();return;}
  run(async()=>{await api('save-attendance',{items:[{attendanceId:id,memo:v}]});sh.close();await reloadSession();toast('메모를 저장했어요.');render();},e.submitter);};
}

// ---------- 학생 공간 ----------
// 위: 과제·평가(보기만), 아래: 메모·선생님 한마디(편집). 넓은 화면은 위를 [과제|평가] 탭으로, 휴대폰은 차례로 쌓는다.
async function openStudent(attendanceId,btn){if(!leaveEdit())return;await run(async()=>{const s=state.detail.students.find(x=>x.attendanceId===attendanceId);state.student={...s,data:s.registrationId?await api('student',{registrationId:s.registrationId}):{homework:[],tests:[],memos:[]}};state.view='student';state.noteTab='memo';state.edit=false;state.draft={};render();},btn);}
function paneStudent(el){
 const s=state.student,d=s.data,ed=editing('student'),key=state.noteTab||'memo',val=state.draft[key]??s[key]??'';
 const tests=d.tests.slice().reverse(),last=d.tests[0],done=d.homework.filter(h=>h.submitted).length;
 const hint=[d.homework.length?`과제 제출 <b>${done}/${d.homework.length}</b>`:'',last?`최근 평가 <b>${Math.round((last.correct||0)/last.total*100)}점</b>`:''].filter(Boolean).join(' · ')||'최근 과제와 평가가 없어요';
 const reg=nlink(s.registrationId,s.name+' 등록');
 const title=`<p class="page-title">${icon('users')}${esc(s.name)} <span class="pill s-${STATUS[s.status]||''}">${STATUS[s.status]||'미입력'}${s.arrivedAt?' '+timeOf(s.arrivedAt):''}</span><span class="grow"></span>${reg}</p>`;
 const hwHtml=`<div class="list">${d.homework.map(h=>`<div class="row"><span class="meta"><span class="t">${esc(h.range||h.title)}</span><span class="d">${h.due?'마감 '+shortDate(h.due):''}</span></span><span class="pill ${h.submitted?'done':'miss'}">${h.submitted?'제출':'미제출'}</span>${nlink(h.id,h.title)}</div>`).join('')||'<p class="empty">최근 과제가 없어요.</p>'}</div>`;
 const testHtml=`<div class="list">${tests.length?`<div class="bars">${tests.map(t=>{const p=Math.round((t.correct||0)/t.total*100);return `<div><b>${p}</b><i style="height:${Math.max(6,p)}%"></i><span>${esc((t.range||t.title).slice(0,8))}</span></div>`;}).join('')}</div>`:'<p class="empty">점수가 있는 평가가 없어요.</p>'}</div>`;
 const past=key==='memo'?d.memos.filter(m=>m.attendanceId!==s.attendanceId).slice(0,4).map(m=>`<p class="help"><b>${shortDate(m.date)}</b> ${esc(m.memo)}</p>`).join(''):'';
 const note=`<div class="tab-row note-row"><span></span><div class="center-tabs"><div class="tabs" role="tablist">${tabBtn(key==='memo','data-note="memo"','메모')}${tabBtn(key==='comment','data-note="comment"','선생님 한마디')}</div></div><span class="acts">${editButton('student')}</span></div>
 ${ed?`<div class="form"><textarea data-key="${key}" aria-label="${key==='memo'?'메모':'선생님 한마디'}">${esc(val)}</textarea></div>`:`<div class="card">${val?esc(val):`<span class="muted">${key==='memo'?'오늘 메모가 없어요.':'오늘 한마디가 없어요.'}</span>`}${past}</div>`}
 <p class="note-hint">${key==='memo'?'메모는 학부모에게 안 보여요.':'선생님 한마디는 다음 리포트 새로고침 때 학부모 화면에 반영돼요.'}</p>`;
 el.innerHTML=paneHead(title,hint)+`<div class="pbody"><h2 class="sec-title">${icon('과제')}과제 현황</h2>${hwHtml}<h2 class="sec-title">${icon('평가')}평가 결과</h2>${testHtml}<h2 class="sec-title">${icon('lock')}메모 · 한마디</h2>${note}</div>`;
 el.querySelectorAll('[data-note]').forEach(b=>b.onclick=()=>{state.noteTab=b.dataset.note;render();});
 bindEdit(el);
 el.querySelectorAll('textarea[data-key]').forEach(t=>t.oninput=()=>{const k=t.dataset.key;if(t.value===(s[k]??''))delete state.draft[k];else state.draft[k]=t.value;updateSavebar();});
 if(ed)state.saver=async()=>{await api('save-attendance',{items:[{attendanceId:s.attendanceId,...state.draft}]});Object.assign(s,state.draft);state.edit=false;state.draft={};updateSavebar();await reloadSession();toast('저장했어요.');render();};
}

// ---------- 학습기록 ----------
function paneRecords(el){
 const all=state.detail.records,k=state.recKind||'전체',recs=k==='전체'?all:all.filter(r=>r.kind===k);
 const hint=KINDS.map(x=>`${x} <b>${all.filter(r=>r.kind===x).length}</b>`).join(' · ');
 el.innerHTML=paneHead(`<p class="page-title">${icon('학습')}학습기록</p>${nlink(state.detail.session.id,'수업')}`,hint,['전체',...KINDS].map(x=>tabBtn(x===k,`data-rk="${x}"`,x)).join(''))+
 `<div class="pbody">${recs.map(r=>`<div class="rec"><button class="rec-head" type="button" data-rec="${esc(r.id)}"><span class="kind-icon k-${esc(r.kind)}" title="${esc(r.kind)}">${icon(r.kind||'학습')}</span><span class="t">${esc(r.title)}</span>${r.makeup?'<span class="pill s-보강">보강</span>':''}</button>
  <div class="rec-body">${esc([r.range,r.topic&&!r.title.includes(r.topic)?r.topic:''].filter(Boolean).join(' · ')||'내용을 적어 주세요')} · 학생 ${r.registrationIds.length}명${r.activities?` · 학습활동 ${r.activities}건`:''}</div></div>`).join('')||`<div class="list"><p class="empty">${k==='전체'?'아직 기록이 없어요.':`${k} 기록이 없어요.`}</p></div>`}
 <div class="actions"><button class="primary" type="button" id="new-rec">${icon('plus','inline-icon')}기록 만들기</button></div></div>`;
 el.querySelectorAll('[data-rk]').forEach(b=>b.onclick=()=>{state.recKind=b.dataset.rk;render();});
 el.querySelectorAll('[data-rec]').forEach(b=>b.onclick=()=>openRecord(b.dataset.rec,b));
 el.querySelector('#new-rec').onclick=()=>openCreateSheet();
}
async function openRecord(id,btn){if(!leaveEdit())return;await run(()=>openRecordNow(id),btn);}
async function openRecordNow(id){{state.recordId=id;state.acts=await api('activities',{recordId:id});state.books=await booksFor(state.sessionId);recEditFrom(state.acts.record);state.view='record';state.edit=false;state.draft={};render();}}
// 기록 카드 입력 칸의 지금 값(교재·주제·범위·내용). 교재를 고르는 동안에도 적던 글자를 잃지 않게 따로 둔다.
const recEditFrom=r=>{state.recEdit={book:r.bookId||'',topic:r.topic||'',range:r.range||'',content:r.content||''};};
const ACT_LABEL={학습:'학생별 기록 만들기',과제:'과제 출제',평가:'평가 만들기'};
function paneRecord(el){
 const {record:r,activities:acts}=state.acts,ed=editing('record');
 const re=state.recEdit,v=k=>re[k]??'';
 // 이 수업 학생들의 교재 목록에 없는 교재가 연결돼 있으면(학생이 바뀐 경우 등) 이름 없이 그 사실만 보여 준다.
 const item=bookChoices(state.books,{single:true,include:re.book}).flatMap(g=>g.items).find(x=>x.value===re.book)||(re.book?{value:re.book,title:'연결된 교재',sub:'이 수업 학생들의 교재 목록에 없어요 · 눌러서 바꾸기',cover:'',progress:null,recent:''}:null);
 const scoring=r.kind==='평가',checking=r.kind==='과제';
 el.innerHTML=paneHead(`<p class="page-title"><span class="kind-icon k-${esc(r.kind)}" title="${esc(r.kind)}">${icon(r.kind||'학습')}</span>${esc(r.title)}</p>`,`학생 <b>${r.registrationIds.length}명</b>에게 연결된 기록이에요${r.makeup?' · 보강 기록이라 진도율에서 빠져요':''}`,'',acts.length&&(scoring||checking)?editButton('record'):'')+`<div class="pbody">
 <form class="card form" id="rec-form"><label>교재 <span class="muted">이 수업 학생들의 교재</span></label>
 ${item?bookRow(item,{attr:'id="rec-book" aria-label="교재 바꾸기"',chev:true}):emptyBookRow('id="rec-book"','교재 없음','눌러서 교재 고르기')}
 <label for="rec-topic">주제 ${item?'<span class="muted">(선택)</span>':''}</label><input id="rec-topic" maxlength="200" value="${esc(v('topic'))}" placeholder="교재 없는 기록은 리포트에 주제가 보여요">
 <label for="rec-range">범위</label><input id="rec-range" maxlength="200" value="${esc(v('range'))}" placeholder="예: p.31-35">
 <label for="rec-content">내용</label><textarea id="rec-content">${esc(v('content'))}</textarea>
 <div class="actions"><button class="secondary" type="submit" id="rec-save">기록 저장</button></div></form>
 <h2 class="sec-title">${icon(r.kind||'학습')}학습활동 <span class="cnt">${acts.length}명</span></h2>
 ${acts.length?`<div class="list">${acts.map(a=>{const ch=state.draft['a:'+a.id];const sub=ch?.submitted??a.submitted,cor=ch?.correct??a.correct,tot=ch?.total??a.total;
  return `<div class="row ${ch?'changed':''}"><span class="av">${esc(a.name.slice(0,1))}</span><span class="meta"><span class="t">${esc(a.name)}</span>${scoring&&tot?`<span class="d">${Math.round((cor||0)/tot*100)}점</span>`:''}</span>
  ${checking?(ed?`<span class="seg"><button type="button" class="v-제출 ${sub?'on':''}" data-sub="${esc(a.id)}" data-v="1">제출</button><button type="button" class="v-미제출 ${sub?'':'on'}" data-sub="${esc(a.id)}" data-v="0">미제출</button></span>`:`<span class="pill ${sub?'done':'miss'}">${sub?'제출':'미제출'}</span>`):''}
  ${scoring?(ed?`<span class="score"><input inputmode="numeric" data-cor="${esc(a.id)}" value="${cor??''}" aria-label="${esc(a.name)} 맞힌 문항"> / <input inputmode="numeric" data-tot="${esc(a.id)}" value="${tot??''}" aria-label="${esc(a.name)} 전체 문항"></span>`:`<span class="pill k-평가">${cor??'–'} / ${tot??'–'}</span>`):''}${nlink(a.id,a.name+' 학습활동')}</div>`;}).join('')}</div>`
 :`<div class="list"><p class="empty">아직 학습활동이 없어요.</p></div>`}
 ${acts.length?'':`<div class="actions"><button class="primary" type="button" id="make-acts" ${r.activityStatus==='🔄 작업중'?'disabled':''}>${esc(ACT_LABEL[r.kind]||'학습활동 만들기')} · ${r.registrationIds.length}명</button></div>${r.activityStatus==='🔄 작업중'?'<p class="help">만드는 중이에요. 잠시 뒤 새로고침해 주세요.</p>':''}`}</div>`;
 const q=s=>el.querySelector(s);bindCovers(el);
 [['#rec-topic','topic'],['#rec-range','range'],['#rec-content','content']].forEach(([s,k])=>q(s).oninput=e=>{re[k]=e.target.value;});
 bulletize(q('#rec-content'),()=>{re.content=q('#rec-content').value;});
 q('#rec-book').onclick=()=>drawBookPicker(bookChoices(state.books,{single:true,include:re.book}),re.book,val=>{re.book=val;$('sheet').close();render();},()=>$('sheet').close(),'교재 없음','교재 없이 주제로 기록해요');
 q('#rec-form').onsubmit=e=>{e.preventDefault();const body={recordId:r.id,topic:re.topic,range:re.range,content:re.content};if((re.book||null)!==r.bookId)body.bookId=re.book||null;
  run(async()=>{await api('update-record',body);state.acts=await api('activities',{recordId:r.id});recEditFrom(state.acts.record);await reloadSession();toast('기록을 저장했어요.');render();},e.submitter);};
 if(q('#make-acts'))q('#make-acts').onclick=e=>run(async()=>{const res=await api('create-activities',{recordId:r.id});toast(res.status==='already_processing'?'이미 만드는 중이에요.':`학습활동을 만들고 있어요 · ${res.students}명`);setTimeout(()=>run(async()=>{const fresh=await api('activities',{recordId:r.id});if(state.view==='record'&&state.recordId===r.id){state.acts=fresh;render();}}),4000);},e.currentTarget);
 bindEdit(el);
 const setDraft=(id,patch)=>{const a=acts.find(x=>x.id===id),cur={...(state.draft['a:'+id]||{}),...patch};const same=Object.entries(cur).every(([k,val])=>a[k]===val);if(same)delete state.draft['a:'+id];else state.draft['a:'+id]=cur;updateSavebar();};
 el.querySelectorAll('[data-sub]').forEach(b=>b.onclick=()=>{setDraft(b.dataset.sub,{submitted:b.dataset.v==='1'});render();});
 const num=v=>v.trim()===''?null:Number(v);
 el.querySelectorAll('[data-cor]').forEach(i=>i.onchange=()=>setDraft(i.dataset.cor,{correct:num(i.value)}));
 el.querySelectorAll('[data-tot]').forEach(i=>i.onchange=()=>{setDraft(i.dataset.tot,{total:num(i.value)});el.querySelectorAll('[data-tot]').forEach(o=>{if(!o.value){o.value=i.value;setDraft(o.dataset.tot,{total:num(i.value)});}});});
 if(ed)state.saver=async()=>{const items=Object.entries(state.draft).filter(([k])=>k.startsWith('a:')).map(([k,v])=>({activityId:k.slice(2),...v}));
  await api('save-activities',{items});state.edit=false;state.draft={};updateSavebar();state.acts=await api('activities',{recordId:r.id});toast(`저장했어요 · ${items.length}명`);render();};
}

// ---------- 시작 ----------
function render(){
 if(!state.session)return showLogin();
 if(!state.teacherId)return showTeachers();
 ({empty:renderEmpty,waiting:renderWaiting,session:renderSession,student:renderSession,record:renderSession,teachers:showTeachers}[state.view]||renderEmpty)();
 updateSavebar();
}
async function start(){
 // Notion 수업 페이지 링크로 열면(?session=…) 그 수업을 바로 연다.
 await loadTeachers();
 const want=new URLSearchParams(location.search).get('session');
 if(!state.teacherId)return render();
 if(want){await openSessionNow(want);return;}
 await openToday();
}
// 저장 막대는 편집 중인 칸이 정한 저장 동작(state.saver)을 부른다.
$('save-ok').onclick=e=>{if(state.saver)run(state.saver,e.currentTarget);};
$('save-cancel').onclick=()=>{state.edit=false;state.draft={};updateSavebar();render();};
if(!state.session)showLogin();else run(start);
