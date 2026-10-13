// 수업방(v2.5.67): 선생님 공용 수업용 비밀번호로 로그인 → 강사 선택(이 기기에 기억) → 날짜별 수업 카드와
// 보강 대기실 → 수업(학생 목록 [출석|과제 검사], 학습기록) → 학생 공간 / 기록 카드 → 학생별 학습활동.
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
 cal:'<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
 out:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
 plus:'<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',check:'<polyline points="20 6 9 17 4 12"/>',
 refresh:'<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
 lock:'<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',square:'<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>',
 checked:'<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'};
const icon=(name,cls='')=>`<svg class="line ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name]||''}</svg>`;
const nlink=(id,label)=>id?`<a class="icon-btn nl" href="${notionUrl(id)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(label)} Notion에서 열기" title="Notion에서 열기">${icon('ext')}</a>`:'';
const KINDS=['학습','과제','평가'],STATUS={'🟢 출석':'출석','🔴 결석':'결석','🔵 보강':'보강'};
const pad=n=>String(n).padStart(2,'0');
function seoulDate(offset=0){const d=new Date(Date.now()+9*3600e3+offset*864e5);return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;}
function dateLabel(ymd){const [y,m,d]=ymd.split('-').map(Number);const w='일월화수목금토'[new Date(Date.UTC(y,m-1,d)).getUTCDay()];return `${m}/${d} (${w})`;}
function timeOf(iso){if(!iso)return '';const d=new Date(new Date(iso).getTime()+9*3600e3);return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;}
function shortDate(iso){if(!iso)return '';const d=new Date(new Date(iso).getTime()+(String(iso).includes('T')?9*3600e3:0));return `${d.getUTCMonth()+1}/${d.getUTCDate()}`;}

const state={session:store.get(SESSION_KEY),teacherId:store.get(TEACHER_KEY),teachers:[],date:seoulDate(),view:'home',day:null,
 sessionId:'',detail:null,tab:'students',seg:'att',recKind:'전체',hwRecord:'',edit:false,editOwner:'',saver:null,draft:{},recordId:'',acts:null,student:null,noteTab:'memo',books:null,picked:new Set(),
 calOpen:false,calMonth:'',calDays:new Set(),calKey:''};

async function api(action,data={}){
 if(CFG.error)throw new Error(CFG.error);
 const res=await fetch(CFG.url+'/functions/v1/class-room',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':state.session,Authorization:'Bearer '+CFG.anonKey,apikey:CFG.anonKey},body:JSON.stringify({action,...data}),cache:'no-store'});
 const body=await res.json().catch(()=>({}));
 if(res.status===401){store.set(SESSION_KEY,'');state.session='';showLogin('로그인이 끝났어요. 수업용 비밀번호로 다시 로그인해 주세요.');throw new Error('silent');}
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
// 하단 탭 [수업 목록 | 학생 목록 | 학습기록](v2.5.78): 같은 시간 두 수업을 오갈 때 상단 ←를 누르지 않고 아래에서 바로 움직인다.
// 수업 목록에서도 하단 탭을 두어 [학생 목록]·[학습기록]이 방금 보던 수업으로 돌아간다. 화면은 저장된 내용으로 먼저 그리고 뒤에서 새로 읽는다.
function setTabs(on){const tb=$('tabbar');tb.hidden=!on;$('app').classList.toggle('with-tabs',!!on);document.body.classList.toggle('tabs-on',!!on);if(!on)return;
 const cur=state.view==='home'?'home':state.tab;
 tb.innerHTML=`<div class="tab-in"><button type="button" data-tab="home" class="${cur==='home'?'on':''}">${icon('cal')}<span>수업 목록</span></button><button type="button" data-tab="students" class="${cur==='students'?'on':''}">${icon('users')}<span>학생 목록</span></button><button type="button" data-tab="records" class="${cur==='records'?'on':''}">${icon('학습')}<span>학습기록</span></button></div>`;
 tb.querySelectorAll('button').forEach(b=>b.onclick=()=>{if(b.dataset.tab===cur&&state.view!=='student'&&state.view!=='record')return;if(!leaveEdit())return;
  if(b.dataset.tab==='home'){state.view='home';render();loadDay().then(()=>{if(state.view==='home')render();}).catch(()=>{});return;}
  const back=state.view==='home';state.tab=b.dataset.tab;state.view='session';render();
  if(back)reloadSession().then(()=>{if(state.view==='session'&&!state.edit)render();}).catch(()=>{});});}
function leaveEdit(){if(state.edit&&Object.keys(state.draft).length&&!confirm('저장하지 않은 변경이 있어요. 버리고 나갈까요?'))return false;state.edit=false;state.draft={};updateSavebar();return true;}
function updateSavebar(){const sb=$('savebar'),n=Object.keys(state.draft).length;sb.hidden=!state.edit||!n;sb.classList.toggle('no-tabs',$('tabbar').hidden);$('save-count').textContent=`변경 ${n}건`;
 document.body.classList.toggle('save-on',!sb.hidden);}
window.addEventListener('beforeunload',e=>{if(state.edit&&Object.keys(state.draft).length){e.preventDefault();e.returnValue='';}});

// ---------- 로그인·강사 ----------
function showLogin(message=''){
 setTabs(false);state.view='login';bar(['수업']);
 $('app').innerHTML=`<p class="page-title">${icon('lock')}수업용 로그인</p><p class="page-hint">원장님께 받은 수업용 비밀번호를 입력하세요. 이 기기에서 30일 동안 다시 묻지 않아요.</p>
 <form id="login" class="card"><label for="pw">수업용 비밀번호</label><input type="password" id="pw" autocomplete="current-password" maxlength="128" required>
 <p class="help">수업용 로그인으로는 수업방만 쓸 수 있어요. 관리자 설정·법정 서류·키오스크 설정은 열리지 않아요.</p>
 <p class="error" id="login-err" ${message?'':'hidden'}>${esc(message)}</p><div class="actions"><button class="primary" type="submit">로그인</button></div></form>`;
 if(CFG.error){$('login-err').hidden=false;$('login-err').textContent=CFG.error;}
 $('login').onsubmit=async e=>{e.preventDefault();const btn=e.submitter,err=$('login-err');if(run.busy)return;run.busy=true;btn.classList.add('loading');err.hidden=true;
  try{const s=await HadaAdminAuth.login(CFG.url,$('pw').value,'class');state.session=s;store.set(SESSION_KEY,s);run.busy=false;await run(start);}
  catch(x){err.hidden=false;err.textContent=x.message;}finally{run.busy=false;btn.classList.remove('loading');}};
}
async function loadTeachers(){if(!state.teachers.length)state.teachers=(await api('teachers')).teachers;}
function teacherName(id){return state.teachers.find(t=>t.id===id)?.name||'';}
function showTeachers(){
 setTabs(false);state.view='teachers';bar(['강사 선택'],{back:state.teacherId!==''?()=>{state.view='home';render();}:null});
 $('app').innerHTML=`<p class="page-title">${icon('users')}강사 선택</p><p class="page-hint">고른 강사의 수업만 보여 줘요. 이 기기에 기억하고, 위에서 언제든 바꿀 수 있어요.</p><div class="list">
 ${state.teachers.map(t=>`<button class="row" type="button" data-id="${esc(t.id)}"><span class="av">${esc(t.name.slice(0,1))}</span><span class="meta"><span class="t">${esc(t.name)}</span><span class="d">${esc(t.role)}</span></span>${state.teacherId===t.id?icon('check','check'):''}</button>`).join('')}
 <button class="row" type="button" data-id="all"><span class="av sq">전</span><span class="meta"><span class="t">전체 수업</span><span class="d">모든 강사의 수업</span></span>${state.teacherId==='all'?icon('check','check'):''}</button></div>
 <div class="actions"><button class="secondary wide" id="logout" type="button">${icon('out','inline-icon')} 이 기기에서 로그아웃</button></div>`;
 $('logout').onclick=()=>{if(!confirm('이 기기에서 로그아웃할까요? 다시 들어오려면 수업용 비밀번호가 필요해요.'))return;store.set(SESSION_KEY,'');store.set(TEACHER_KEY,'');state.session='';state.teacherId='';showLogin();};
 $('app').querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>run(async()=>{state.teacherId=b.dataset.id;state.detail=null;store.set(TEACHER_KEY,state.teacherId);await loadDay();state.view='home';render();},b));
}

// ---------- 오늘 수업 ----------
const teacherArg=()=>state.teacherId&&state.teacherId!=='all'?{teacherId:state.teacherId}:{};
async function loadDay(){const [day]=await Promise.all([api('day',{date:state.date,...teacherArg()}),loadCalDays()]);state.day=day;}
// 날짜는 서울 날짜 문자열(YYYY-MM-DD)로 계산한다. 주는 월요일부터(리포트 캘린더와 같음).
function addDays(ymd,n){const [y,m,d]=ymd.split('-').map(Number);const t=new Date(Date.UTC(y,m-1,d+n));return `${t.getUTCFullYear()}-${pad(t.getUTCMonth()+1)}-${pad(t.getUTCDate())}`;}
function dowMon(ymd){const [y,m,d]=ymd.split('-').map(Number);return (new Date(Date.UTC(y,m-1,d)).getUTCDay()+6)%7;}
const weekStart=ymd=>addDays(ymd,-dowMon(ymd));
function longDate(ymd){const [y,m,d]=ymd.split('-').map(Number);return `${y}년 ${m}월 ${d}일 (${'일월화수목금토'[new Date(Date.UTC(y,m-1,d)).getUTCDay()]})`;}
function calRange(){
 if(state.calOpen){const [y,m]=state.calMonth.split('-').map(Number);return [`${state.calMonth}-01`,`${state.calMonth}-${pad(new Date(Date.UTC(y,m,0)).getUTCDate())}`];}
 const w=weekStart(state.date);return [w,addDays(w,6)];
}
// 달력에 수업 있는 날 표시: 보이는 주(또는 달)의 수업 날짜를 한 번에 읽는다.
async function loadCalDays(force=false){const [from,to]=calRange(),key=from+to+state.teacherId;if(!force&&state.calKey===key)return;
 state.calDays=new Set((await api('days',{from,to,...teacherArg()})).dates);state.calKey=key;}
// 반마다 색 이모지(리포트 student_report_part1.js와 같은 규칙): Notion 클래스 이모지가 비었을 때만 쓴다.
const CLASS_COLOR_EMOJIS=['🟣','🔵','🟢','🟠','🔴','🟡','🟤','⚪'];
function pickClassColorEmoji(seed){let h=0;for(const ch of String(seed||''))h=(h*31+ch.charCodeAt(0))>>>0;return CLASS_COLOR_EMOJIS[h%CLASS_COLOR_EMOJIS.length];}
const CHEVRON_DOWN='<svg class="line" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
const CAL_DOW=['월','화','수','목','금','토','일'].map((l,i)=>`<div class="cal-dow${i===5?' sat':i===6?' sun':''}">${l}</div>`).join('');
function calCell(ymd){const has=state.calDays.has(ymd),c=['cal-day',has?'plan':'empty-day'];if(ymd===seoulDate())c.push('today');if(ymd===state.date)c.push('picked');
 return `<button type="button" class="${c.join(' ')}" data-day="${ymd}" aria-label="${esc(dateLabel(ymd))}${has?' 수업 있음':''}" aria-pressed="${ymd===state.date}"><span>${Number(ymd.slice(8))}</span></button>`;}
const navBtn=(attr,label,ch)=>`<button class="cal-nav-btn" type="button" ${attr} aria-label="${label}"><span>${ch}</span></button>`;
// 리포트 캘린더(student_report_part2.js buildRegCalendarHtml)와 같은 구조: 날짜를 고른 주 한 줄 + "월 전체 보기", 월 전체는 [오늘]과 함께.
function calendarHtml(){
 if(!state.calOpen){const w=weekStart(state.date),e=addDays(w,6),md=x=>`${+x.slice(5,7)}/${+x.slice(8)}`;
  return `<div class="attendance-calendar day-mode"><div class="cal-month-nav">${navBtn('data-week="-7"','이전 주','‹')}<div class="cal-month-title">${md(w)} ~ ${md(e)}</div><div class="cal-nav-right">${navBtn('data-week="7"','다음 주','›')}</div></div>
  <div class="cal-grid">${CAL_DOW}${Array.from({length:7},(_,i)=>calCell(addDays(w,i))).join('')}</div><button type="button" class="cal-collapse-btn" id="cal-open">${CHEVRON_DOWN}월 전체 보기</button></div>`;}
 const [y,m]=state.calMonth.split('-').map(Number),first=`${state.calMonth}-01`,n=new Date(Date.UTC(y,m,0)).getUTCDate();
 const cells=Array.from({length:dowMon(first)},()=>'<div class="cal-day empty"></div>').join('')+Array.from({length:n},(_,i)=>calCell(`${state.calMonth}-${pad(i+1)}`)).join('');
 return `<div class="attendance-calendar"><div class="cal-month-nav">${navBtn('data-month="-1"','이전 달','‹')}<div class="cal-month-title">${y}년 ${m}월</div><div class="cal-nav-right"><button class="cal-today-btn" type="button" id="cal-today"><span>오늘</span></button>${navBtn('data-month="1"','다음 달','›')}</div></div>
 <div class="cal-grid">${CAL_DOW}${cells}</div></div>`;
}
function shiftMonth(ym,n){const [y,m]=ym.split('-').map(Number);const t=new Date(Date.UTC(y,m-1+n,1));return `${t.getUTCFullYear()}-${pad(t.getUTCMonth()+1)}`;}
// 수업 한 줄: [클래스 이모지] [클래스명] [등원 n/전체] [수업 시간]
function sessionRow(s){const name=s.makeup?s.name:(s.className||s.name),emoji=s.classEmoji||pickClassColorEmoji(s.className||s.name);
 const tone=!s.students||!s.arrived?'':s.arrived>=s.students?'ok':'part';
 return `<button class="row srow" type="button" data-session="${esc(s.id)}"><span class="emo">${s.makeup?'<span class="pill s-보강">보강</span>':esc(emoji)}</span><span class="meta"><span class="t">${esc(name)}</span></span><span class="cnt-pill ${tone}" aria-label="등원 ${s.arrived}명, 전체 ${s.students}명">${s.arrived}/${s.students}</span><span class="time">${esc(s.time)}</span></button>`;}
function renderHome(){
 setTabs(!!state.detail);const who=state.teacherId==='all'?'전체 수업':teacherName(state.teacherId);
 bar([who,'수업'],{who:true,right:`<button class="icon-btn" id="refresh" type="button" aria-label="새로고침">${icon('refresh')}</button>`,notion:state.teacherId&&state.teacherId!=='all'?state.teacherId:''});
 $('who').onclick=showTeachers;
 $('refresh').onclick=e=>run(async()=>{state.calKey='';await loadDay();renderHome();},e.currentTarget);
 const d=state.day,sessions=d?d.sessions:[],waiting=d?d.makeupWaiting:[];
 $('app').innerHTML=`<p class="page-title">${icon('cal')}수업</p><p class="page-hint">날짜를 누르면 그날 수업을 볼 수 있어요</p>
 ${calendarHtml()}
 <div class="cal-day-head"><b>${esc(longDate(state.date))}</b><span class="pill">수업 ${sessions.length}</span></div>
 <div class="list">${sessions.length?sessions.map(sessionRow).join(''):`<p class="empty">이 날 ${state.teacherId==='all'?'':'이 강사의 '}수업이 없어요.</p>`}</div>
 <div class="list wait"><button class="row srow" type="button" id="open-wait"><span class="emo ico">${icon('users')}</span><span class="meta"><span class="t">보강 대기실</span></span><span class="cnt-pill">${waiting.length}명</span><span class="time chev">›</span></button></div>`;
 const pick=ymd=>run(async()=>{state.date=ymd;state.calOpen=false;await loadDay();renderHome();});
 $('app').querySelectorAll('[data-day]').forEach(b=>b.onclick=()=>pick(b.dataset.day));
 $('app').querySelectorAll('[data-week]').forEach(b=>b.onclick=()=>pick(addDays(state.date,Number(b.dataset.week))));
 $('app').querySelectorAll('[data-month]').forEach(b=>b.onclick=()=>run(async()=>{state.calMonth=shiftMonth(state.calMonth,Number(b.dataset.month));await loadCalDays();renderHome();}));
 if($('cal-open'))$('cal-open').onclick=()=>run(async()=>{state.calOpen=true;state.calMonth=state.date.slice(0,7);await loadCalDays();renderHome();});
 if($('cal-today'))$('cal-today').onclick=()=>pick(seoulDate());
 $('app').querySelectorAll('[data-session]').forEach(b=>b.onclick=()=>openSession(b.dataset.session,b));
 $('open-wait').onclick=()=>{state.view='waiting';state.picked=new Set();render();};
}

// ---------- 보강 대기실 ----------
function renderWaiting(){
 setTabs(false);const w=state.day?.makeupWaiting||[],made=(state.day?.sessions||[]).filter(s=>s.makeup);
 bar(['수업','보강 대기실'],{back:()=>{state.view='home';render();}});
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
async function openSessionNow(id){{state.sessionId=id;state.detail=await api('session',{sessionId:id});state.view='session';state.tab='students';state.seg='att';state.recKind='전체';state.edit=false;state.draft={};state.hwRecord=state.detail.homeworkDue[0]?.recordId||'';render();}}
async function reloadSession(){state.detail=await api('session',{sessionId:state.sessionId});}
function paneHead(title,hint,tabs='',acts=''){
 return `<div class="ph">${title}</div><p class="page-hint ph">${hint}</p>`+(tabs||acts?`<div class="ph tab-row"><span></span>${tabs?`<div class="center-tabs"><div class="tabs" role="tablist">${tabs}</div></div>`:'<span></span>'}<span class="acts">${acts}</span></div>`:'');
}
const tabBtn=(on,attr,label)=>`<button type="button" role="tab" aria-selected="${on}" class="${on?'active':''}" ${attr}><span>${esc(label)}</span></button>`;
const editing=owner=>state.edit&&state.editOwner===owner;
function editButton(owner){return `<button class="act" type="button" data-edit="${owner}"><span>${editing(owner)?'취소':'편집'}</span></button>`;}
// 편집은 한 번에 한 칸만. 다른 칸의 [편집]을 누르면 지금 편집을 정리(변경이 있으면 확인)하고 넘어간다.
function bindEdit(root){root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{const owner=b.dataset.edit;
 if(editing(owner)){state.edit=false;state.draft={};}else{if(!leaveEdit())return;state.edit=true;state.editOwner=owner;state.draft={};}
 state.saver=null;updateSavebar();render();});}
function sessionBar(){const s=state.detail.session,v=state.view;
 const extra=v==='student'?[state.student.name]:v==='record'?[state.acts.record.kind||'기록']:[];
 const who=state.teacherId==='all'?'전체 수업':teacherName(state.teacherId);
 bar([who,s.className||s.name,...extra],{back:()=>{if(!leaveEdit())return;if(extra.length){if(v==='record')state.tab='records';state.view='session';render();}else{state.view='home';run(async()=>{await loadDay();render();});}},
  notion:v==='student'?state.student.attendanceId:v==='record'?state.acts.record.id:s.id});}
function renderSession(){
 sessionBar();const v=state.view;state.saver=null;setTabs(true);
 (v==='student'?paneStudent:v==='record'?paneRecord:state.tab==='records'?paneRecords:paneStudents)($('app'));
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
  body=`<div class="list">${d.students.map(s=>{const st=state.draft[s.attendanceId]?.status??s.status,ch=state.draft[s.attendanceId];
   return `<div class="row ${ch?'changed':''} ${st==='🔴 결석'&&!ed?'dim':''}">${ed?'':`<button class="icon-btn" type="button" data-student="${esc(s.attendanceId)}" aria-label="${esc(s.name)} 학생 공간">`}<span class="av">${esc(s.name.slice(0,1))}</span>${ed?'':'</button>'}
   <span class="meta"><span class="t">${esc(s.name)}</span><span class="d">${s.arrivedAt?'등원 '+timeOf(s.arrivedAt):''}${s.memo?(s.arrivedAt?' · ':'')+esc(s.memo):''}${!s.arrivedAt&&!s.memo?(STATUS[st]?'':'미입력'):''}</span></span>
   ${ed?`<span class="seg">${Object.entries(STATUS).map(([v,l])=>`<button type="button" class="v-${l} ${st===v?'on':''}" data-att="${esc(s.attendanceId)}" data-v="${v}">${l}</button>`).join('')}</span>`:`<span class="pill s-${STATUS[st]||''}">${STATUS[st]||'미입력'}</span>`}</div>`;}).join('')||'<p class="empty">이 수업에 연결된 학생이 없어요.</p>'}</div>`;
 }else if(!cur)body='<div class="list"><p class="empty">오늘이 마감인 과제가 없어요.</p></div>';
 else{
  const pick=hw.length>=4?`<select id="hw-pick">${hw.map(h=>`<option value="${esc(h.recordId)}" ${h.recordId===cur.recordId?'selected':''}>${esc(h.title)}</option>`).join('')}</select>`:hw.length>1?`<div class="chips">${hw.map(h=>`<button class="chip ${h.recordId===cur.recordId?'on':''}" type="button" data-hw="${esc(h.recordId)}">${esc(h.range||h.title)} ${h.items.filter(sub).length}/${h.items.length}</button>`).join('')}</div>`:'';
  body=`${pick||ed?`<div class="toolrow pick-row"><div class="grow">${pick}</div>${ed?'<button class="act" type="button" id="all-done"><span>전원 제출</span></button>':''}</div>`:''}
  <div class="list">${cur.items.map(i=>{const v=sub(i),ch=state.draft[i.activityId];return `<div class="row ${ch?'changed':''}"><span class="av">${esc(nameOf(i).slice(0,1))}</span><span class="meta"><span class="t">${esc(nameOf(i))}</span></span>
  ${ed?`<span class="seg"><button type="button" class="v-제출 ${v?'on':''}" data-hwact="${esc(i.activityId)}" data-v="1">제출</button><button type="button" class="v-미제출 ${v?'':'on'}" data-hwact="${esc(i.activityId)}" data-v="0">미제출</button></span>`:`<span class="pill ${v?'done':'miss'}">${v?'제출':'미제출'}</span>`}${nlink(i.activityId,nameOf(i)+' 학습활동')}</div>`;}).join('')}</div>`;
 }
 el.innerHTML=paneHead(`<p class="page-title">${icon('users')}학생 목록</p>`,hint,tabBtn(att,'data-seg="att"','출석')+tabBtn(!att,'data-seg="hw"','과제 검사'),acts)+`<div class="pbody">${body}</div>`;
 el.querySelectorAll('[data-seg]').forEach(b=>b.onclick=()=>{if(!leaveEdit())return;state.seg=b.dataset.seg;render();});
 el.querySelectorAll('[data-hw]').forEach(b=>b.onclick=()=>{if(!leaveEdit())return;state.hwRecord=b.dataset.hw;render();});
 const hp=el.querySelector('#hw-pick');if(hp)hp.onchange=e=>{if(!leaveEdit()){e.target.value=state.hwRecord;return;}state.hwRecord=e.target.value;render();};
 bindEdit(el);
 el.querySelectorAll('[data-att]').forEach(b=>b.onclick=()=>{const id=b.dataset.att,orig=d.students.find(s=>s.attendanceId===id).status;if(b.dataset.v===orig)delete state.draft[id];else state.draft[id]={status:b.dataset.v};render();});
 el.querySelectorAll('[data-hwact]').forEach(b=>b.onclick=()=>{const id=b.dataset.hwact,v=b.dataset.v==='1',orig=hw.flatMap(h=>h.items).find(i=>i.activityId===id).submitted;if(v===orig)delete state.draft[id];else state.draft[id]={submitted:v};render();});
 const ad=el.querySelector('#all-done');if(ad)ad.onclick=()=>{cur.items.forEach(i=>{if(i.submitted)delete state.draft[i.activityId];else state.draft[i.activityId]={submitted:true};});render();};
 el.querySelectorAll('[data-student]').forEach(b=>b.onclick=()=>openStudent(b.dataset.student,b));
 if(ed)state.saver=async()=>{const entries=Object.entries(state.draft);
  if(att)await api('save-attendance',{items:entries.map(([attendanceId,v])=>({attendanceId,...v}))});
  else await api('save-activities',{items:entries.map(([activityId,v])=>({activityId,...v}))});
  state.edit=false;state.draft={};updateSavebar();await reloadSession();toast(`저장했어요 · ${entries.length}건`);render();};
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
 el.innerHTML=paneHead(`<p class="page-title">${icon('학습')}학습기록</p>`,hint,['전체',...KINDS].map(x=>tabBtn(x===k,`data-rk="${x}"`,x)).join(''))+
 `<div class="pbody">${recs.map(r=>`<div class="rec"><button class="rec-head" type="button" data-rec="${esc(r.id)}"><span class="kind-icon k-${esc(r.kind)}" title="${esc(r.kind)}">${icon(r.kind||'학습')}</span><span class="t">${esc(r.title)}</span>${r.makeup?'<span class="pill s-보강">보강</span>':''}</button>
  <div class="rec-body">${esc([r.range,r.topic&&!r.title.includes(r.topic)?r.topic:''].filter(Boolean).join(' · ')||'내용을 적어 주세요')} · 학생 ${r.registrationIds.length}명${r.activities?` · 학습활동 ${r.activities}건`:''}</div></div>`).join('')||`<div class="list"><p class="empty">${k==='전체'?'아직 기록이 없어요.':`${k} 기록이 없어요.`}</p></div>`}
 <div class="actions"><button class="primary" type="button" id="new-rec">${icon('plus','inline-icon')}기록 만들기</button></div></div>`;
 el.querySelectorAll('[data-rk]').forEach(b=>b.onclick=()=>{state.recKind=b.dataset.rk;render();});
 el.querySelectorAll('[data-rec]').forEach(b=>b.onclick=()=>openRecord(b.dataset.rec,b));
 el.querySelector('#new-rec').onclick=openKindSheet;
}
function openKindSheet(){
 $('sheet').innerHTML=`<div class="dialog-head"><h2>어떤 기록을 만들까요?</h2><button class="ghost" type="button" id="sh-x">닫기</button></div><div class="choose">
 ${[['학습','오늘 수업에서 배운 내용'],['과제','다음 수업까지 해 올 것 · 마감 자동'],['평가','시험·테스트 · 학생별 점수']].map(([k,d])=>`<button type="button" data-kind="${k}"><span class="pill k-${k}">${icon(k)}</span><span><b>${k}</b><small>${d}</small></span></button>`).join('')}</div>`;
 $('sheet').showModal();$('sh-x').onclick=()=>$('sheet').close();
 $('sheet').querySelectorAll('[data-kind]').forEach(b=>b.onclick=()=>run(async()=>{if(!state.books)state.books=await api('books',{sessionId:state.sessionId});openBookSheet(b.dataset.kind);},b));
}
// 교재 고르기: 반 교재(그룹 진도) / 템플릿 묶음(같은 교재, 학생별 진도: 일괄 또는 학생 한 명) / 학생별 교재 / 교재 없이(주제).
function openBookSheet(kind,filter='진행 중'){
 const {books,registrations}=state.books,regName=id=>(registrations.find(r=>r.id===id)?.name||'').split(' ')[0];
 const shown=books.filter(b=>filter==='전체'||b.status===filter||(!b.status&&filter==='진행 중'));
 const group=shown.filter(b=>b.mode==='그룹 진도'),ind=shown.filter(b=>b.mode!=='그룹 진도');
 const tpl={};ind.forEach(b=>{if(b.templateId)(tpl[b.templateId]=tpl[b.templateId]||[]).push(b);});
 const loose=ind.filter(b=>!b.templateId||tpl[b.templateId].length<2);
 const nameOfTpl=list=>list[0].name.replace(/\(.*\)$/,'');
 $('sheet').innerHTML=`<div class="dialog-head"><h2><span class="pill k-${kind}">${kind}</span> 교재 고르기</h2><button class="ghost" type="button" id="sh-x">닫기</button></div>
 <div class="chips">${['진행 중','다음 교재','완료','미사용','전체'].map(f=>`<button class="chip ${f===filter?'on':''}" type="button" data-f="${f}">${f}</button>`).join('')}</div>
 ${group.length?`<p class="group-label">반 교재</p><div class="list">${group.map(b=>`<button class="row" type="button" data-books="${esc(b.id)}"><span class="meta"><span class="t">${esc(b.name)}</span><span class="d">반 학생 ${b.ownerIds.length}명 함께</span></span>${icon('plus','check')}</button>`).join('')}</div>`:''}
 ${Object.values(tpl).filter(l=>l.length>1).map(list=>`<p class="group-label">${esc(nameOfTpl(list))} · 개별 ${list.length}명</p><div class="list"><button class="row" type="button" data-books="${esc(list.map(b=>b.id).join(','))}"><span class="meta"><span class="t">${list.length}명 모두 만들기</span><span class="d">학생마다 자기 교재로 기록이 하나씩 생겨요</span></span>${icon('plus','check')}</button>
  ${list.map(b=>`<button class="row" type="button" data-books="${esc(b.id)}"><span class="meta"><span class="t">${esc(b.ownerIds.map(regName).join(', '))}</span><span class="d">${esc(b.name)}</span></span>${icon('plus','check')}</button>`).join('')}</div>`).join('')}
 ${loose.length?`<p class="group-label">학생별 교재</p><div class="list">${loose.map(b=>`<button class="row" type="button" data-books="${esc(b.id)}"><span class="meta"><span class="t">${esc(b.name)}</span><span class="d">${esc(b.ownerIds.map(regName).join(', '))}</span></span>${icon('plus','check')}</button>`).join('')}</div>`:''}
 ${!shown.length?'<p class="empty">이 상태의 교재가 없어요.</p>':''}
 <p class="group-label">교재 없이</p><form id="nobook" class="form"><label for="topic">주제</label><input id="topic" maxlength="200" placeholder="예: 실험 정리, 단원 정리 특강"><div class="actions"><button class="secondary wide" type="submit">교재 없이 반 전체 기록 만들기</button></div></form>`;
 if(!$('sheet').open)$('sheet').showModal();$('sh-x').onclick=()=>$('sheet').close();
 $('sheet').querySelectorAll('[data-f]').forEach(b=>b.onclick=()=>openBookSheet(kind,b.dataset.f));
 const create=(data,btn)=>run(async()=>{const r=await api('create-records',{sessionId:state.sessionId,kind,...data});$('sheet').close();await reloadSession();const made=r.records.filter(x=>x.created).length;toast(made?`기록 ${made}개를 만들었어요.`:'이미 있는 기록이에요.');if(r.records.length===1)await openRecordNow(r.records[0].id);else{state.view='session';state.tab='records';render();}},btn);
 $('sheet').querySelectorAll('[data-books]').forEach(b=>b.onclick=()=>create({bookIds:b.dataset.books.split(',')},b));
 $('nobook').onsubmit=e=>{e.preventDefault();create({topic:$('topic').value.trim()},e.submitter);};
}
async function openRecord(id,btn){if(!leaveEdit())return;await run(()=>openRecordNow(id),btn);}
async function openRecordNow(id){{state.recordId=id;state.acts=await api('activities',{recordId:id});if(!state.books)state.books=await api('books',{sessionId:state.sessionId});state.view='record';state.edit=false;state.draft={};render();}}
const ACT_LABEL={학습:'학생별 기록 만들기',과제:'과제 출제',평가:'평가 만들기'};
function paneRecord(el){
 const {record:r,activities:acts}=state.acts,ed=editing('record');
 const book=state.books.books.find(b=>b.id===r.bookId),v=k=>state.draft[k]??r[k]??'';
 const scoring=r.kind==='평가',checking=r.kind==='과제';
 el.innerHTML=paneHead(`<p class="page-title"><span class="kind-icon k-${esc(r.kind)}" title="${esc(r.kind)}">${icon(r.kind||'학습')}</span>${esc(r.title)}</p>`,`학생 <b>${r.registrationIds.length}명</b>에게 연결된 기록이에요${r.makeup?' · 보강 기록이라 진도율에서 빠져요':''}`,'',acts.length&&(scoring||checking)?editButton('record'):'')+`<div class="pbody">
 <form class="card form" id="rec-form"><label>교재 <span class="muted">이 수업 학생들의 교재만 보여요</span></label>
 <select id="rec-book"><option value="">교재 없음</option>${state.books.books.map(b=>`<option value="${esc(b.id)}" ${b.id===r.bookId?'selected':''}>${esc(b.name)}</option>`).join('')}</select>
 <label for="rec-topic">주제 ${book?'<span class="muted">(선택)</span>':''}</label><input id="rec-topic" maxlength="200" value="${esc(v('topic'))}" placeholder="교재 없는 기록은 리포트에 주제가 보여요">
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
 const q=s=>el.querySelector(s);
 q('#rec-form').onsubmit=e=>{e.preventDefault();const body={recordId:r.id,topic:q('#rec-topic').value,range:q('#rec-range').value,content:q('#rec-content').value};if((q('#rec-book').value||null)!==r.bookId)body.bookId=q('#rec-book').value||null;
  run(async()=>{await api('update-record',body);state.acts=await api('activities',{recordId:r.id});await reloadSession();toast('기록을 저장했어요.');render();},e.submitter);};
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
 ({home:renderHome,waiting:renderWaiting,session:renderSession,student:renderSession,record:renderSession,teachers:showTeachers}[state.view]||renderHome)();
 updateSavebar();
}
async function start(){
 // Notion 수업 페이지 링크로 열면(?session=…) 그 수업을 바로 연다.
 await loadTeachers();
 const want=new URLSearchParams(location.search).get('session');
 if(state.teacherId){await loadDay();}
 if(want&&state.teacherId){await openSessionNow(want);return;}
 state.view='home';render();
}
// 저장 막대는 편집 중인 칸이 정한 저장 동작(state.saver)을 부른다.
$('save-ok').onclick=e=>{if(state.saver)run(state.saver,e.currentTarget);};
$('save-cancel').onclick=()=>{state.edit=false;state.draft={};updateSavebar();render();};
if(!state.session)showLogin();else run(start);
