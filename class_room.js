// 수업 관리(v2.5.67, v2.5.82에 이름 변경): 관리자 비밀번호로 로그인(12시간, 이 기기에 기억) → 강사 선택(이 기기에 기억).
// v2.5.87부터 학부모 리포트와 같은 구조: 첫 화면(강사 이름·담당 클래스 카드·보강 대기실, 아래로 주간 시간표) · ☰ 사이드바(강사 정보·강사 바꾸기·로그아웃)
// → 반 상세(하단 탭 홈·교재·캘린더·학습기록·학생) → 기록 카드 → 학생별 학습활동, 교재 상세(v2.5.89).
// v2.5.93: 출석 체크·과제 점검은 캘린더에서 날짜를 눌러 접은 아래 탭으로, 학생 탭은 명부(학교·학년·연락처·학생 보고서 새 탭). 학생 공간은 없앴다.
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
 home:'<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
 book:'<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
 sun:'<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
 x:'<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',memo:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>'};
const icon=(name,cls='')=>`<svg class="line ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name]||''}</svg>`;
const nlink=(id,label)=>id?`<a class="icon-btn nl" href="${notionUrl(id)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(label)} Notion에서 열기" title="Notion에서 열기">${icon('ext')}</a>`:'';
const KINDS=['학습','과제','평가'],STATUS={'🟢 출석':'출석','🔴 결석':'결석','🔵 보강':'보강'};
const pad=n=>String(n).padStart(2,'0');
function seoulDate(offset=0){const d=new Date(Date.now()+9*3600e3+offset*864e5);return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;}
function dateLabel(ymd){const [y,m,d]=ymd.split('-').map(Number);const w='일월화수목금토'[new Date(Date.UTC(y,m-1,d)).getUTCDay()];return `${m}/${d} (${w})`;}
function timeOf(iso){if(!iso)return '';const d=new Date(new Date(iso).getTime()+9*3600e3);return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;}
function shortDate(iso){if(!iso)return '';const d=new Date(new Date(iso).getTime()+(String(iso).includes('T')?9*3600e3:0));return `${d.getUTCMonth()+1}/${d.getUTCDate()}`;}

const state={session:store.get(SESSION_KEY),teacherId:store.get(TEACHER_KEY),teachers:[],date:seoulDate(),view:'main',day:null,
 sessionId:'',detail:null,tab:'home',bookSeg:'진행 중',bookItem:null,classRecs:null,calOpen:false,calMode:'att',rosterCache:{},statsCache:{},seg:'att',recKind:'전체',hwRecord:'',edit:false,editOwner:'',saver:null,draft:{},recordId:'',acts:null,books:null,picked:new Set(),
 classWeek:[],cwMonth:'',cwFrom:'',cwTo:'',classes:null,form:null,bookCache:{},bookByRegs:{},cwStale:false,bodyCache:{}};

// ⟳ 새로고침(v2.5.116): 서버가 수업 관리 복사본을 읽을 때 Notion에서 직접 고친 것을 먼저 맞춘다(Notion을 읽을 때는 바로 끝남). 실패해도 그냥 다시 읽는다.
async function syncCopy(){await api('sync-copy').catch(()=>{});}
async function api(action,data={}){
 if(CFG.error)throw new Error(CFG.error);
 const t0=performance.now();
 const res=await fetch(CFG.url+'/functions/v1/class-room',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':state.session,Authorization:'Bearer '+CFG.anonKey,apikey:CFG.anonKey},body:JSON.stringify({action,...data}),cache:'no-store'});
 const body=await res.json().catch(()=>({}));
 if(res.status===401){store.set(SESSION_KEY,'');state.session='';showLogin('로그인이 끝났어요. 관리자 비밀번호로 다시 로그인해 주세요.');throw new Error('silent');}
 if(!res.ok)throw new Error(body.error||'서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.');
 if(TIMING)logTiming(action,Math.round(performance.now()-t0),body._timing,body._source);
 return body;
}
// 속도 측정(v2.5.108, 0단계): 주소에 ?timing=1이면 최근 동작 12개의 [동작 · 왕복 ms · 서버 ms · Notion 호출 수]를 오른쪽 아래에 보인다. 평소에는 아무것도 하지 않는다.
const TIMING=new URLSearchParams(location.search).get('timing')==='1';
function logTiming(action,ms,t,src){(logTiming.rows=logTiming.rows||[]).unshift({action:src==='copy'?action+' [복사본]':action,ms,server:t?.ms,notion:t?.notion,retries:t?.retries});logTiming.rows.length=Math.min(logTiming.rows.length,12);
 let el=$('timing');if(!el){el=document.createElement('pre');el.id='timing';el.className='timing';document.body.appendChild(el);}
 el.textContent='동작 · 왕복 · 서버 · Notion\n'+logTiming.rows.map(r=>`${r.action} · ${r.ms}ms · ${r.server??'–'}ms · ${r.notion??'–'}회${r.retries?` (재시도 ${r.retries})`:''}`).join('\n');
 console.info('[timing]',action,ms+'ms',t);}
function toast(msg){const t=$('toast');t.textContent=msg;t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>t.hidden=true,2400);}
async function run(fn,btn){if(run.busy)return;run.busy=true;if(btn){btn.classList.add('loading');btn.setAttribute('aria-busy','true');}
 try{await fn();}catch(e){if(e.message!=='silent')toast(e.message);}finally{run.busy=false;if(btn){btn.classList.remove('loading');btn.removeAttribute('aria-busy');}}}
function bar(crumbs,{back,notion,right='',who=false}={}){
 $('bar').hidden=false;document.body.classList.remove('snap-on');
 $('bar').innerHTML='<div class="bar-in">'+(back?`<button class="icon-btn" id="bar-back" type="button" aria-label="뒤로">${icon('back')}</button>`:'')+
  (crumbs.length===1&&!back?`<h1>${esc(crumbs[0])}</h1>`:`<div class="crumbs">${crumbs.map((c,i)=>c&&c.go?`<button class="crumb-link" type="button" data-ci="${i}">${esc(c.label)}</button>`:`<span>${esc(c?.label??c)}</span>`).join('<span class="sep">›</span>')}</div>`)+right+(notion?nlink(notion,crumbs.at(-1)?.label??crumbs.at(-1)):'')+'</div>';
 if(back)$('bar-back').onclick=back;
 $('bar').querySelectorAll('[data-ci]').forEach(b=>b.onclick=()=>crumbs[Number(b.dataset.ci)].go());
}
// 하단 탭(v2.5.87): 리포트 등록 상세처럼 [홈 | 교재 | 캘린더 | 학습기록 | 학생]. 탭은 앱처럼 쌓지 않는다(뒤로가기 규칙은 아래 "뒤로가기").
const TABS=[['home','home','홈'],['books','book','교재'],['calendar','cal','캘린더'],['records','학습','학습기록'],['students','users','학생']];
const TAB_NAME=Object.fromEntries(TABS.map(([k,,l])=>[k,l]));
function setTabs(on){const tb=$('tabbar');tb.hidden=!on;$('app').classList.toggle('with-tabs',!!on);document.body.classList.toggle('tabs-on',!!on);if(!on)return;
 const cur=state.view==='session'?state.tab:state.view==='book'?'books':'';
 tb.innerHTML=`<div class="tab-in">${TABS.map(([k,ic,l])=>`<button type="button" data-tab="${k}" class="${cur===k?'on':''}" ${cur===k?'aria-current="page"':''}>${icon(ic)}<span>${l}</span></button>`).join('')}</div>`;
 tb.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>goTab(b.dataset.tab));}
// 탭 옮기기: 홈 → 다른 탭은 한 칸 쌓고, 다른 탭끼리는 바꿔 쓰고, 홈으로는 뒤로가기와 같게(쌓인 홈이 없으면 바꿔 쓰기).
// 기록 카드·교재 상세에서 누르면 쌓인 같은 반 화면이 그 탭이면 뒤로가기, 아니면 한 칸 쌓는다.
// open=true: 캘린더를 보고 있는 수업 날짜로 접은 채 연다(홈의 등원·과제 제출 칸, v2.5.93).
function goTab(tab,open=false){
 if(state.view==='session'&&tab===state.tab)return;
 const top=nav.stack.at(-1),back=top&&top.view==='session'&&top.tab===tab&&sameClass(top);
 if(back&&(state.view!=='session'||tab==='home'))return navBack();
 if(!leaveEdit())return;
 if(state.view==='session'&&(state.tab!=='home'||tab==='home'))nav.replace=true;
 if(tab==='calendar'&&(state.tab!=='calendar'||state.view!=='session')){state.cwMonth=state.date.slice(0,7);state.calOpen=open;}
 state.tab=tab;state.view='session';render();}
// 홈 → 캘린더 접힌 날의 [출석 체크]·[과제 점검]
function jumpCheck(seg){state.seg=seg;goTab('calendar',true);}
function leaveEdit(){if(state.edit&&Object.keys(state.draft).length&&!confirm('저장하지 않은 변경이 있어요. 버리고 나갈까요?'))return false;state.edit=false;state.draft={};updateSavebar();return true;}
function updateSavebar(){const sb=$('savebar'),n=Object.keys(state.draft).length;sb.hidden=!state.edit||!n;sb.classList.toggle('no-tabs',$('tabbar').hidden);$('save-count').textContent=`변경 ${n}건`;
 document.body.classList.toggle('save-on',!sb.hidden);}
window.addEventListener('beforeunload',e=>{if(state.edit&&Object.keys(state.draft).length){e.preventDefault();e.returnValue='';}});

// ---------- 로그인·강사 ----------
function showLogin(message=''){
 setTabs(false);setHero('');state.view='login';bar(['수업 관리']);
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
function teacherList(){return `<div class="list">${state.teachers.map(t=>`<button class="row" type="button" data-id="${esc(t.id)}"><span class="av">${esc(t.name.slice(0,1))}</span><span class="meta"><span class="t">${esc(t.name)}</span><span class="d">${esc(t.role)}</span></span>${state.teacherId===t.id?icon('check','check'):''}</button>`).join('')}
 <button class="row" type="button" data-id="all"><span class="av sq">전</span><span class="meta"><span class="t">전체 수업</span><span class="d">모든 강사의 수업</span></span>${state.teacherId==='all'?icon('check','check'):''}</button></div>`;}
function logout(then){if(!confirm('이 기기에서 로그아웃할까요? 다시 들어오려면 관리자 비밀번호가 필요해요.'))return;store.set(SESSION_KEY,'');store.set(TEACHER_KEY,'');state.session='';state.teacherId='';state.classes=null;
 closeLayers(()=>{nav.stack=[];showLogin();});}
function pickTeacher(id){state.teacherId=id;state.detail=null;state.classes=null;store.set(TEACHER_KEY,id);}
function showTeachers(){
 setTabs(false);setHero('');state.view='teachers';bar(['강사 선택']);
 $('app').innerHTML=`<p class="page-title">${icon('users')}강사 선택</p><p class="page-hint">고른 강사의 수업만 보여 줘요. 이 기기에 기억하고, 첫 화면 ☰ 메뉴에서 언제든 바꿀 수 있어요.</p>${teacherList()}
 <div class="actions"><button class="secondary wide" id="logout" type="button">${icon('out','inline-icon')} 이 기기에서 로그아웃</button></div>`;
 $('logout').onclick=()=>logout();
 $('app').querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>run(async()=>{pickTeacher(b.dataset.id);await loadMain(true);nav.replace=true;state.view='main';render();},b));
 navTrack();
}

// ---------- 수업 고르기·날짜 ----------
const teacherArg=()=>state.teacherId&&state.teacherId!=='all'?{teacherId:state.teacherId}:{};
const fetchDay=date=>api('day',{date,...teacherArg()});
async function loadDay(){state.day={...await fetchDay(state.date),date:state.date};}
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
// ---------- 첫 화면(v2.5.87) ----------
// 학부모 리포트 첫 화면처럼 [강사 이름 / 담당 클래스 카드 / 보강 대기실]을 한가운데 두고, 아래로 넘기면 이번 주 시간표.
// 클래스 카드: 오늘 수업이 있는 반을 시간순으로 위에(배지 "오늘 17:00"), 나머지는 다음 수업 순(배지 "수 19:00", 이번 주가 아니면 날짜).
// 카드를 누르면 그 반의 오늘 수업(진행 중 → 다음 → 마지막) → 없으면 다음 수업 → 없으면 가장 최근 수업을 반 상세 홈으로 연다.
const classesKey=()=>state.teacherId+'|'+seoulDate();
async function loadMain(force=false){
 if(!force&&state.classes?.key===classesKey()&&state.day?.date===seoulDate())return;
 const today=seoulDate(),[c,day]=await Promise.all([api('classes',{date:today,...teacherArg()}),fetchDay(today)]);
 state.classes={key:classesKey(),list:c.classes};state.date=today;state.day={...day,date:today};
}
async function showMain(force=false){await loadMain(force);state.view='main';render();}
const startOf=t=>String(t||'').split('–')[0];
const dowOf=ymd=>'일월화수목금토'[new Date(ymd+'T00:00:00Z').getUTCDay()];
// 수업 날짜 짧게: 오늘 → "오늘", 이번 주 → 요일, 그 밖 → 월/일
const whenLabel=(ymd,time)=>`${ymd===seoulDate()?'오늘':ymd>=weekStart(seoulDate())&&ymd<addDays(weekStart(seoulDate()),7)?dowOf(ymd):md(ymd)} ${startOf(time)}`.trim();
function classBadge(c){
 if(c.today.length)return `<span class="cb-badge on">오늘 ${esc(startOf(c.today[0].time))}</span>`;
 if(c.next)return `<span class="cb-badge">${esc(whenLabel(c.next.date,c.next.time))}</span>`;
 return '<span class="cb-badge none">수업 없음</span>';}
// 정렬 기준은 서울 날짜·시각 글자("2026-10-14 17:00", v2.5.88). Notion 수업일시 원문은 수업마다 시간대 표기(+09:00·Z)가 달라 그대로 비교하면 순서가 섞인다.
const classKey=c=>c.today.length?`${seoulDate()} ${startOf(c.today[0].time)}`:c.next?`${c.next.date} ${startOf(c.next.time)}`:'';
function sortedClasses(){return (state.classes?.list||[]).slice().sort((a,b)=>(!a.today.length-!b.today.length)||(!a.next-!b.next)
 ||classKey(a).localeCompare(classKey(b))||a.name.localeCompare(b.name,'ko'));}
const whoName=()=>state.teacherId==='all'?'전체 수업':teacherName(state.teacherId);
const whoRole=()=>state.teacherId==='all'?'모든 강사':(state.teachers.find(t=>t.id===state.teacherId)?.role||'강사');
// 주간 시간표(리포트 통합 시간표 모양): 월~일 7칸, 칸마다 수업 시작 시각·반. 오늘 칸은 진하게. 수업을 누르면 그 수업으로.
// 통합 시간표(v2.5.90, 리포트 student_report_part2.js buildWeekGridHtml와 같은 모양): 월~일 7칸, 칸마다 [시작 시각 / 반 이름].
// 반 색은 리포트 8색(🟣🔵🟢🟠🔴🟡🟤⚪ 순서). 반 카드의 이모지가 이 8색 동그라미면 그 색, 아니면 리포트와 같은 규칙(반 이름 해시)으로 고른다.
// 그래서 첫 화면 카드의 동그라미와 시간표 칸 색이 같고, 같은 반은 늘 같은 색이다. 오늘 요일은 빨간 글자. 수업을 누르면 그 수업으로.
const classColor=c=>{const i=CLASS_COLOR_EMOJIS.indexOf(c.emoji||pickClassColorEmoji(c.name));return (i<0?CLASS_COLOR_EMOJIS.indexOf(pickClassColorEmoji(c.name)):i)+1;};
function weekGrid(list){const mon=weekStart(seoulDate());
 return `<div class="wk-card"><div class="wk-grid">${Array.from({length:7},(_,i)=>{const d=addDays(mon,i),slots=list.flatMap(c=>(c.week||[]).filter(x=>x.date===d).map(x=>({c,x}))).sort((a,b)=>a.x.time.localeCompare(b.x.time));
  return `<div class="wk-col ${d===seoulDate()?'today':''}"><div class="wk-day">${'월화수목금토일'[i]}</div>${slots.map(({c,x})=>`<button class="wk-slot c${classColor(c)}" type="button" data-open="${esc(x.id)}" aria-label="${esc(dateLabel(d))} ${esc(x.time)} ${esc(c.name)}"><b>${esc(startOf(x.time))}</b><span>${esc(c.name)}</span></button>`).join('')}</div>`;}).join('')}</div></div>`;}
function renderMain(){
 setTabs(false);setHero('');$('bar').hidden=true;
 if(!state.classes){$('app').innerHTML='<p class="empty">불러오는 중…</p>';run(()=>showMain(true));return;}
 const list=sortedClasses(),w=state.day?.makeupWaiting||[],mon=weekStart(seoulDate());
 // 클래스가 많을 때(v2.5.91): 정렬 순서(오늘 수업 시간순 → 다음 수업순)대로 위 4개만 보이고, 나머지는 "다른 클래스 n개 ⌄" 한 줄로 접는다.
 // 4개면 일반 폰(카카오톡 인앱 포함) 한 화면에 첫 화면이 다 들어온다. 5개까지는 1개만 접는 게 어색해 모두 보인다.
 // 누르면 전부 펼치고 다시 누르면 접는다(기억하지 않음). 접힌 반 중 오늘 수업이 있으면 "오늘 n개 포함"을 붙인다.
 const MAIN_SHOW=4,fold=list.length>MAIN_SHOW+1,shown=fold?list.slice(0,MAIN_SHOW):list,others=fold?list.slice(MAIN_SHOW):[],othersToday=others.filter(c=>c.today.length).length;
 const card=c=>`<button class="class-card" type="button" data-class="${esc(c.classId)}"><span class="emo">${esc(c.emoji||pickClassColorEmoji(c.name))}</span><span class="cc-name">${esc(c.name)}</span>${classBadge(c)}</button>`;
 // 리포트 첫 화면처럼 화면 높이 두 칸을 위아래로 넘긴다(scroll-snap): ① 강사·클래스 ② 통합 시간표.
 document.body.classList.add('snap-on');
 $('app').innerHTML=`<div class="scroll-container" id="snap"><section class="snap-section intro"><div class="intro-tools"><button class="icon-btn" id="m-refresh" type="button" aria-label="새로고침">${icon('refresh')}</button><button class="icon-btn" id="m-menu" type="button" aria-label="메뉴">${icon('menu')}</button></div>
 <div class="intro-in"><p class="intro-greeting">수업 관리</p><h1 class="intro-name">${esc(whoName())}</h1><p class="intro-sub">${esc(whoRole())} · 담당 클래스 ${list.length}개</p>
 <div class="class-group">${shown.map(card).join('')||'<p class="empty">앞뒤 4주 안에 수업이 있는 클래스가 없어요.</p>'}
 ${others.length?`<button class="more-card" type="button" id="more-cls" aria-expanded="false" aria-controls="cls-more"><span>다른 클래스 ${others.length}개${othersToday?` · 오늘 ${othersToday}개 포함`:''}</span>${CHEVRON_DOWN}</button><div class="class-more" id="cls-more" hidden>${others.map(card).join('')}</div>`:''}</div>
 <button class="wait-card" type="button" id="open-wait">${icon('users')}<span>보강 대기실</span><span class="cnt-pill">${w.length}명</span></button></div>
 <button class="swipe-hint" type="button" id="to-week">통합 시간표 보기<span class="chevron"><svg class="line" viewBox="0 0 24 24" aria-hidden="true"><polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/></svg></span></button></section>
 <section class="snap-section timetable-section" id="week"><button class="up-hint" type="button" id="to-intro"><span class="chevron"><svg class="line" viewBox="0 0 24 24" aria-hidden="true"><polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/></svg></span>이전으로</button>
 <h2 class="tt-title"><span class="tt-icon"><svg class="line" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/></svg></span>통합 시간표</h2><p class="tt-hint">담당 반들의 이번 주(${esc(md(mon))} ~ ${esc(md(addDays(mon,6)))}) 수업을 요일별로 합쳐서 보여줘요</p>${weekGrid(list)}</section></div>`;
 $('m-refresh').onclick=e=>run(async()=>{await syncCopy();await showMain(true);},e.currentTarget);
 $('m-menu').onclick=openMenu;
 const more=$('more-cls');if(more)more.onclick=()=>{const box=$('cls-more'),open=box.hidden;box.hidden=!open;more.setAttribute('aria-expanded',open);more.classList.toggle('open',open);};
 $('to-week').onclick=()=>$('week').scrollIntoView({behavior:'smooth'});
 $('to-intro').onclick=()=>$('snap').scrollTo({top:0,behavior:'smooth'});
 $('open-wait').onclick=()=>{state.view='waiting';state.picked=new Set();render();};
 $('app').querySelectorAll('[data-class]').forEach(b=>b.onclick=()=>{const c=list.find(x=>x.classId===b.dataset.class),id=nowSessionId(c.today)||c.next?.id||c.last?.id;if(id)openSession(id,b);});
 $('app').querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openSession(b.dataset.open,b));
}
// ☰ 사이드바(v2.5.87): 오른쪽 서랍. 강사 정보(이름·역할·담당 클래스·학생 수·이번 주 수업) / 강사 바꾸기(서랍 안에서 고름) / 보강 대기실 / 로그아웃.
// 서랍은 dialog 하나를 바꿔 쓴다. 바깥(어두운 곳)·✕·뒤로가기로 닫는다.
function drawer(side,title,body){const d=$('drawer');d.className=`drawer ${side}`;
 d.innerHTML=`<div class="dr-in"><div class="dr-head"><h2>${title}</h2><button class="icon-btn" type="button" id="dr-x" aria-label="닫기">${icon('x')}</button></div>${body}</div>`;
 $('dr-x').onclick=navBack;showLayer(d);d.scrollTop=0;return d;}
$('drawer').addEventListener('click',e=>{if(e.target===$('drawer'))navBack();});
const stat=(v,l,cls='')=>`<div class="home-stat ${cls}"><b>${esc(v)}</b><small>${esc(l)}</small></div>`;
// 누르는 요약 칸(v2.5.93): 홈의 등원·과제 제출 → 캘린더 접힌 날의 출석 체크·과제 점검
const statBtn=(jump,v,l,cls='')=>`<button class="home-stat go ${cls}" type="button" data-jump="${jump}" aria-label="${esc(l)} ${esc(v)} · ${jump==='att'?'학생 목록':'학습 기록'}으로 가기"><b>${esc(v)}</b><small>${esc(l)} ›</small></button>`;
function openMenu(){
 const list=state.classes?.list||[],students=list.reduce((a,c)=>a+(c.students||0),0),week=list.reduce((a,c)=>a+(c.week?.length||0),0);
 drawer('right','메뉴',`<div class="who-card"><span class="av">${esc(whoName().slice(0,1))}</span><span class="meta"><b>${esc(whoName())}</b><small>${esc(whoRole())}</small></span></div>
 <div class="home-stats">${stat(list.length+'개','담당 클래스')}${stat(students+'명','학생(반별 합)')}${stat(week+'회','이번 주 수업')}</div>
 <div class="list menu-list"><button class="row srow" type="button" id="mn-who"><span class="emo ico">${icon('users')}</span><span class="meta"><span class="t">강사 바꾸기</span></span><span class="time chev">›</span></button>
 <button class="row srow" type="button" id="mn-wait"><span class="emo ico">${icon('grid')}</span><span class="meta"><span class="t">보강 대기실</span></span><span class="cnt-pill">${(state.day?.makeupWaiting||[]).length}명</span><span class="time chev">›</span></button></div>
 <div class="dr-foot"><button class="secondary wide" type="button" id="mn-out">${icon('out','inline-icon')} 이 기기에서 로그아웃</button></div>`);
 $('mn-who').onclick=drawTeacherMenu;
 $('mn-wait').onclick=()=>closeLayers(()=>{state.view='waiting';state.picked=new Set();render();});
 $('mn-out').onclick=()=>logout();
}
// 강사 바꾸기: 서랍 안을 강사 목록으로 바꾼다. 고르면 서랍을 닫고 첫 화면을 그 강사로 다시 그린다.
function drawTeacherMenu(){
 const d=drawer('right','강사 바꾸기',`<p class="page-hint">고른 강사의 수업만 보여 줘요. 이 기기에 기억해요.</p>${teacherList()}`);
 d.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>run(async()=>{pickTeacher(b.dataset.id);await loadMain(true);closeLayers(()=>{state.view='main';render();});},b));
}
// 다른 달을 보면 그 달까지 이 반 수업을 더 읽어 합친다.
async function ensureClassMonth(ym){const list=state.classWeek||[],from=`${ym}-01`,to=`${ym}-${pad(monthDays(ym))}`;
 if(list.length&&state.cwFrom<=from&&to<=state.cwTo)return;
 const more=(await api('class-sessions',{sessionId:state.sessionId,around:`${ym}-15`})).sessions||[];
 const map=new Map(list.map(x=>[x.id,x]));more.forEach(x=>map.set(x.id,x));state.classWeek=[...map.values()].sort((a,b)=>a.date.localeCompare(b.date));
 state.cwFrom=state.cwFrom&&state.cwFrom<addDays(`${ym}-15`,-63)?state.cwFrom:addDays(`${ym}-15`,-63);state.cwTo=state.cwTo&&state.cwTo>addDays(`${ym}-15`,35)?state.cwTo:addDays(`${ym}-15`,35);}
// 기록 만들기 창(v2.5.80, v2.5.87부터 학습기록 탭의 + 버튼·교재 탭의 교재 카드에서 연다): 클래스(보고 있는 날짜의 내 수업) → 교재(리포트 교재 카드처럼 표지·진도) → 구분 → 주제 → 범위 → 내용. 만든 뒤 바로 기록 화면으로 간다.
async function openCreateSheet(book=null){
 if(!leaveEdit())return;
 if(state.day?.date!==state.date)await ensureDay(state.date);
 const sessions=(state.day?.sessions||[]).slice();if(state.detail&&!sessions.some(s=>s.id===state.sessionId))sessions.push(state.detail.session);sessions.sort((a,b)=>String(a.start).localeCompare(String(b.start)));
 if(!sessions.length){toast(`${state.date===seoulDate()?'오늘':dateLabel(state.date)} 수업이 없어요. Notion에서 수업 페이지를 먼저 만들어 주세요.`);return;}
 if(state.date!==seoulDate()&&!confirm(`오늘 수업이 아닙니다. ${dateLabel(state.date)} 수업으로 기록을 만들까요?`))return;
 state.form={kind:state.form?.kind||'학습',sessionId:sessions.some(s=>s.id===state.sessionId)?state.sessionId:sessions[0].id,sessions,book,topic:'',range:'',content:''};
 await run(async()=>{await booksFor(state.form.sessionId);});drawCreate();showLayer($('sheet'));
}
// 교재(v2.5.109 속도): 수업별 결과(bookCache)에 더해 같은 학생 구성의 결과(bookByRegs)를 다시 쓴다 — 같은 반 다른 수업으로 가도 교재를 다시 읽지 않는다.
// 같은 수업 교재를 동시에 두 번 요청하지 않게 진행 중인 요청을 기다린다. 새로고침(⟳)하면 둘 다 비운다.
const regsKey=d=>[...new Set((d?.students||[]).map(s=>s.registrationId).filter(Boolean))].sort().join(',');
async function booksFor(id){state.bookCache=state.bookCache||{};if(state.bookCache[id])return state.bookCache[id];
 booksFor.pending=booksFor.pending||{};if(!booksFor.pending[id])booksFor.pending[id]=api('books',{sessionId:id}).finally(()=>{delete booksFor.pending[id];});
 state.bookCache[id]=await booksFor.pending[id];return state.bookCache[id];}
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
// feed=true(v2.5.102): 교재 탭·교재 상세는 학부모 리포트 교재 카드와 같은 결(테두리 없는 그림자 카드, 표지가 없거나 안 열리면 갈색 바탕에 교재명, 화살표 없음).
// 기록 만들기·기록 카드의 교재 고르기는 고른 표시가 필요해 테두리 카드 그대로.
function bookRow(it,{attr='',on=false,chev=false,feed=false}={}){
 return `<button class="book-row ${on?'on':''} ${feed?'feed':''}" type="button" ${attr}><span class="br-cover">${feed?`<span class="br-fallback">${esc(it.title)}</span>`:BOOK_ICON}${it.cover?`<img src="${esc(it.cover)}" alt="" loading="lazy">`:''}</span><span class="br-body"><span class="br-title">${esc(it.title)}</span><span class="br-sub">${esc(it.sub)}</span>
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
 $('sh-x').onclick=navBack;bindCovers(sh);bulletize(q('#cf-c'));
 sh.querySelectorAll('[data-ck]').forEach(b=>b.onclick=()=>{f.kind=b.dataset.ck;sh.querySelectorAll('[data-ck]').forEach(x=>{const on=x===b;x.classList.toggle('active',on);x.setAttribute('aria-selected',on);});});
 q('#cf-s').onchange=e=>run(async()=>{keep();f.sessionId=e.target.value;f.book=null;await booksFor(f.sessionId);drawCreate();});
 q('#cf-b').onclick=()=>{keep();pushLayer(drawCreate);drawBookPicker(bookChoices(state.bookCache[f.sessionId]),f.book,v=>{f.book=v;navBack();},navBack,'교재 없이 기록','주제로 기록해요(주제 필수)');};
 q('#cf').onsubmit=e=>{e.preventDefault();keep();const topic=f.topic.trim(),err=q('#cf-err');err.hidden=true;
  if(f.book===null){err.hidden=false;err.textContent='교재를 골라 주세요. 교재 없이 만들려면 교재 고르기에서 "교재 없이 기록"을 골라요.';return;}
  if(!f.book&&!topic){err.hidden=false;err.textContent='교재 없이 만들 때는 주제를 적어 주세요.';q('#cf-t').focus();return;}
  run(async()=>{const r=await api('create-records',{sessionId:f.sessionId,kind:f.kind,...(f.book?{bookIds:f.book.split(',')}:{}),...(topic?{topic}:{}),range:f.range,content:f.content});
   if(f.sessionId!==state.sessionId)await openSessionNow(f.sessionId);else await reloadSession();
   const made=r.records.filter(x=>x.created).length;toast(made?`기록 ${made}개를 만들었어요.`:'이미 있는 기록이에요. 기록 화면에서 고쳐 주세요.');
   if(r.records.length===1)await openRecordNow(r.records[0].id);else{state.view='session';state.tab='records';render();}closeLayers();},e.submitter);};
}
// 교재 고르기(기록 만들기·기록 카드 공용): 창 안을 카드 목록으로 바꿔 보여 주고, 고르면 onPick(값), 돌아가기는 onBack.
function drawBookPicker(choices,cur,onPick,onBack,noneTitle,noneSub){
 $('sheet').innerHTML=`<div class="dialog-head"><h2>교재 고르기</h2><button class="ghost" type="button" id="bk-back">돌아가기</button></div>
 ${choices.map(g=>`<p class="group-label">${esc(g.label)}</p><div class="br-list">${g.items.map(it=>bookRow(it,{attr:`data-book="${esc(it.value)}"`,on:it.value===cur})).join('')}</div>`).join('')}
 ${choices.length?'':'<div class="list"><p class="empty">이 반 학생들에게 연결된 진행 중 교재가 없어요.</p></div>'}
 <p class="group-label">교재 없이</p><div class="br-list">${emptyBookRow('data-book=""',noneTitle,noneSub,icon('plus'))}</div>`;
 const sh=$('sheet');bindCovers(sh);sh.scrollTop=0;
 $('bk-back').onclick=onBack;
 sh.querySelectorAll('[data-book]').forEach(b=>b.onclick=()=>onPick(b.dataset.book));
}

// ---------- 보강 대기실 ----------
function renderWaiting(){
 setTabs(false);const w=state.day?.makeupWaiting||[],made=(state.day?.sessions||[]).filter(s=>s.makeup);
 bar([longDate(state.date),'보강 대기실'],{back:()=>nav.stack.length?navBack():run(()=>showMain())});
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
 showLayer($('sheet'));$('sh-x').onclick=navBack;
 $('mk').onsubmit=e=>{e.preventDefault();const iso=t=>t?new Date(`${state.date}T${t}:00+09:00`).toISOString():undefined;
  run(async()=>{const r=await api('create-makeup-session',{attendanceIds:[...state.picked],teacherId:$('mk-t').value,start:iso($('mk-s').value),end:iso($('mk-e').value)});state.picked=new Set();await loadDay();toast('보강 수업을 만들었어요.');await openSessionNow(r.sessionId);closeLayers();},e.submitter);};
}

// ---------- 수업 ----------
// 리포트처럼 모든 폭에서 640 한 줄. 하단 탭으로 학생 목록 / 학습기록을 오가고, 학생 공간·기록 카드는 새 화면.
// 칸 머리는 제목 / 안내 / 가운데 탭 3줄.
async function openSession(id,btn){await run(()=>openSessionNow(id),btn);}
// keep=true: 같은 반의 다른 수업으로 옮길 때(홈 ‹ ›, 캘린더 날짜, 새로고침) 보던 탭·출석/과제 검사 전환을 그대로 둔다. tab은 처음 열 때의 탭.
// 수업 날짜(서울)를 보고 있는 날짜로 삼고, 그날 내 수업 목록(state.day)을 함께 맞춘다(+ 기록 만들기의 클래스 목록).
// 수업 열기(속도 v2.5.109): 같은 반의 받아 둔 수업 목록(classWeek)에 있는 수업이면 같은 반 수업 목록을 다시 읽지 않는다(저장·새로고침 뒤에는 다시 읽음).
// 다른 반을 처음 열 때는 교재를 수업 상세와 동시에 요청한다.
async function openSessionNow(id,keep=false,tab='home',open=false){
 const sameClass=!state.cwStale&&(state.classWeek||[]).some(x=>x.id===id);
 const booksP=sameClass?null:booksFor(id).catch(()=>null);
 const [detail,week]=await Promise.all([api('session',{sessionId:id}),sameClass?null:api('class-sessions',{sessionId:id}).catch(()=>({sessions:[]}))]);
 const date=ymdOf(detail.session.start)||state.date;
 state.date=date;state.sessionId=id;state.detail=detail;state.view='session';state.books=null;ensureDay(date);
 if(week){state.classWeek=week.sessions||[];state.cwFrom=addDays(date,-63);state.cwTo=addDays(date,35);state.cwStale=false;}
 const rk=regsKey(detail);if(rk){if(state.bookCache[id])state.bookByRegs[rk]=state.bookCache[id];else if(state.bookByRegs[rk])state.bookCache[id]=state.bookByRegs[rk];}
 if(booksP&&rk)booksP.then(b=>{if(b)state.bookByRegs[rk]=b;});
 if(!keep){state.tab=tab;state.seg='att';state.recKind='전체';state.calOpen=open;}
 if(!keep||state.tab!=='calendar')state.cwMonth=date.slice(0,7);
 state.edit=false;state.draft={};state.hwRecord=state.detail.homeworkDue[0]?.recordId||'';render();}
// 그날 수업 목록(day, v2.5.110 속도): 반 상세에서는 [+ 기록 만들기]의 클래스 고르기에만 쓰므로 수업을 열 때 기다리지 않고 뒤에서 읽는다.
// 기록 만들기를 눌렀을 때 아직 다 안 읽혔으면 그때만 기다린다. 같은 날짜를 동시에 두 번 읽지 않는다.
function ensureDay(date){if(state.day?.date===date)return Promise.resolve();if(ensureDay.p?.date===date)return ensureDay.p.p;
 const p=fetchDay(date).then(d=>({...d,date})).catch(()=>({sessions:[],makeupWaiting:[],date})).then(d=>{if(state.date===date)state.day=d;});
 ensureDay.p={date,p};return p;}
function switchSession(id,btn){if(id===state.sessionId||!leaveEdit())return;run(async()=>{nav.replace=true;try{await openSessionNow(id,true);}finally{nav.replace=false;}},btn);}
async function reloadSession(){state.detail=await api('session',{sessionId:state.sessionId});state.classRecs=null;state.cwStale=true;}
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
// 반 상세 머리(v2.5.87): 리포트 등록 상세처럼 베이지 바 [← | 강사 › 반 › 탭 | 새로고침], 홈 탭에서는 바 아래에 반 이름 큰 머리.
const className=s=>s.makeup?s.name:(s.className||s.name);
function setHero(html){const h=$('hero');h.innerHTML=html;h.hidden=!html;}
// 수업 요일·시각: 이 반의 앞뒤 2주 수업 요일(월부터)과 보고 있는 수업 시각. 예) "화·목 17:00"
function classPattern(){const list=state.classWeek||[],d=state.date,near=list.filter(x=>x.date>=addDays(d,-14)&&x.date<=addDays(d,14));
 const days=[...new Set(near.map(x=>dowMon(x.date)))].sort().map(i=>'월화수목금토일'[i]).join('·');return [days,startOf(state.detail.session.time)].filter(Boolean).join(' ');}
function heroHtml(){const s=state.detail.session,tname=teacherName(s.teacherIds?.[0])||(state.teacherId==='all'?'':teacherName(state.teacherId));
 return `<div class="hero-in"><p class="hero-title">${s.makeup?'':`<span class="emo">${esc(emojiOf(s))}</span>`}<span class="nm">${esc(className(s))}</span>${s.makeup?' <span class="pill s-보강">보강</span>':''}${nlink(s.id,'수업')}</p>
 <p class="hero-sub">${[tname?tname+' 선생님':'',s.makeup?dateLabel(state.date)+' '+(s.time||''):classPattern()].filter(Boolean).map(esc).join(' · ')}</p></div>`;}
function classBar(){const s=state.detail.session;
 bar([crumbToMain(),state.tab==='home'?className(s):crumbToTab('home',className(s)),TAB_NAME[state.tab]||''],{back:()=>{if(nav.stack.length)return navBack();if(!leaveEdit())return;if(state.tab!=='home'){state.tab='home';nav.replace=true;render();}else run(()=>showMain());},
  right:`<button class="icon-btn" id="bar-refresh" type="button" aria-label="새로고침">${icon('refresh')}</button>`});
 $('bar-refresh').onclick=e=>{if(!leaveEdit())return;state.classRecs=null;state.cwStale=true;state.bookCache={};state.bookByRegs={};state.bodyCache={};delete state.rosterCache[state.sessionId];delete state.statsCache[state.sessionId];run(async()=>{await syncCopy();await openSessionNow(state.sessionId,true);},e.currentTarget);};}
// 경로 글자 누르기(v2.5.98, 학부모 리포트 경로처럼): 강사 이름 → 첫 화면, 반 이름 → 그 반 홈, "교재" → 교재 탭. 마지막 글자(지금 화면)는 누르지 않는다.
// 그 화면이 방문 기록에 있으면 뒤로가기를 여러 번 한 것처럼 돌아가고(기록이 꼬이지 않게), 없으면 그 화면을 바로 연다.
function backTo(match,fallback){if(!leaveEdit())return;let i=nav.stack.length-1;while(i>=0&&!match(nav.stack[i]))i--;
 if(i<0)return fallback();nav.chain=nav.stack.length-1-i;navBack();}
const crumbToMain=()=>({label:whoName(),go:()=>backTo(s=>s.view==='main',()=>run(()=>showMain()))});
const crumbToTab=(tab,label)=>({label,go:()=>backTo(s=>s.view==='session'&&s.tab===tab&&sameClass(s),()=>{state.tab=tab;state.view='session';if(tab==='calendar')state.calOpen=false;nav.replace=true;render();})});
function sessionBar(){const s=state.detail.session,v=state.view;
 if(v==='session')return classBar();
 const extra=v==='book'?[crumbToTab('books','교재'),state.bookItem.title]:[state.acts.record.kind||'기록'];
 bar([crumbToTab('home',className(s)),...extra],{back:()=>{if(nav.stack.length)return navBack();if(!leaveEdit())return;if(v==='record')state.tab='records';if(v==='book')state.tab='books';state.view='session';render();},
  notion:v==='book'?state.bookItem.value.split(',')[0]:state.acts.record.id});}
function renderSession(){
 sessionBar();const v=state.view,el=$('app');state.saver=null;setTabs(true);setHero(v==='session'&&state.tab==='home'?heroHtml():'');
 (v==='record'?paneRecord:v==='book'?paneBook:{home:paneHome,books:paneBooks,calendar:paneCalendar,records:paneRecords,students:paneRoster}[state.tab]||paneHome)(el);
}
// 홈 탭(v2.5.87): 보고 있는 수업(‹ › 같은 반 이전·다음 수업) / 그날 요약(등원·과제 제출·다음 수업) / 그날 마감 과제 / 이 수업 학습기록.
function paneHome(el){
 const d=state.detail,s=d.session,list=state.classWeek||[],i=list.findIndex(x=>x.id===state.sessionId),prev=i>0?list[i-1]:null,next=i>=0?list[i+1]||null:null;
 const today=state.date===seoulDate(),arrived=d.students.filter(x=>x.arrivedAt||x.status==='🟢 출석').length;
 const items=d.homeworkDue.flatMap(h=>h.items),sub=items.filter(x=>x.submitted).length;
 el.innerHTML=`<div class="card now-card"><span class="meta"><small>보고 있는 수업</small><b>${today?'오늘 ':''}${esc(dateLabel(state.date))} ${esc(s.time||'')}</b></span>
 <span class="now-nav">${navBtn(prev?`data-go="${esc(prev.id)}"`:'disabled','이전 수업','‹')}${navBtn(next?`data-go="${esc(next.id)}"`:'disabled','다음 수업','›')}</span></div>
 <h2 class="sec-title">${icon('sun')}${today?'오늘 ':''}${esc(longDate(state.date).replace(/^\d+년 /,''))}</h2>
 <div class="card"><div class="home-stats">${statBtn('att',`${arrived}/${d.students.length}`,'등원',d.students.length&&arrived===d.students.length?'good':'')}${statBtn('rec',items.length?`${sub}/${items.length}`:'–','과제 제출',items.length?(sub===items.length?'good':'bad'):'')}${stat(next?whenLabel(next.date,next.time):'–','다음 수업')}</div></div>
 <h2 class="sec-title">${icon('과제')}${today?'오늘':'이날'} 마감 과제 <span class="cnt">${d.homeworkDue.length}</span></h2>
 ${d.homeworkDue.length?`<div class="list">${d.homeworkDue.map(h=>{const n=h.items.filter(x=>x.submitted).length;return `<button class="row" type="button" data-hwgo="${esc(h.recordId)}"><span class="kind-icon k-과제">${icon('과제')}</span><span class="meta"><span class="t">${esc(h.range||h.title)}</span><span class="d">${esc(h.title)}</span></span><span class="pill ${pillTone(n,h.items.length)}">제출 ${n}/${h.items.length}</span></button>`;}).join('')}</div>`:`<div class="list"><p class="empty">${today?'오늘':'이날'}이 마감인 과제가 없어요.</p></div>`}
 <h2 class="sec-title">${icon('book')}교재 진도</h2>${homeBooks()}
 <h2 class="sec-title">${icon('학습')}이 수업 학습기록 <span class="cnt">${d.records.length}</span></h2>
 ${d.records.map(recCard).join('')||'<div class="list"><p class="empty">아직 기록이 없어요. 학습기록 탭의 + 로 만들어요.</p></div>'}`;
 el.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>switchSession(b.dataset.go,b));
 bindBookOpen(el);
 el.querySelectorAll('[data-hwgo]').forEach(b=>b.onclick=()=>openRecord(b.dataset.hwgo,b));
 el.querySelectorAll('[data-jump]').forEach(b=>b.onclick=()=>jumpCheck(b.dataset.jump));
 el.querySelectorAll('[data-rec]').forEach(b=>b.onclick=()=>openRecord(b.dataset.rec,b));
}
// 교재·반 기록은 화면을 먼저 그리고 없으면 읽어 와서, 같은 화면이 그대로면 다시 그린다(편집 중이면 그대로 둔다).
function whenLoaded(p){const key=screenKey();p.then(()=>{if(screenKey()===key&&!state.edit)render();}).catch(e=>{if(e.message!=='silent')toast(e.message);});}
function ensureBooks(){const id=state.sessionId;if(state.bookCache?.[id])return state.bookCache[id];if(ensureBooks.busy!==id){ensureBooks.busy=id;whenLoaded(booksFor(id).finally(()=>{ensureBooks.busy=null;}));}return null;}
// 반 학습기록(v2.5.89): 같은 반 앞뒤 수업의 기록(class-records). 반이 바뀌거나 기록을 만들고 고치면 다시 읽는다.
const recKey=()=>state.detail?.session?.classIds?.[0]||state.sessionId;
function ensureClassRecords(){const k=recKey();if(state.classRecs?.key===k)return state.classRecs.list;
 if(ensureClassRecords.busy!==k){ensureClassRecords.busy=k;const id=state.sessionId;whenLoaded(api('class-records',{sessionId:id}).then(r=>{if(recKey()===k)state.classRecs={key:k,list:r.records};}).finally(()=>{ensureClassRecords.busy=null;}));}return null;}
// 교재 진행상태 구분(v2.5.89): 진행 중(비어 있음 포함) · 완료 · 다음(다음 교재). 미사용은 보이지 않는다.
const BOOK_SEGS=['진행 중','완료','다음'];
const bookSegOf=b=>!b.status||b.status==='진행 중'?'진행 중':b.status==='완료'?'완료':b.status==='다음 교재'?'다음':'';
const booksIn=(data,seg)=>({...data,books:data.books.filter(b=>bookSegOf(b)===seg).map(b=>({...b,status:''}))});
// 교재 탭(v2.5.87, 구분·상세 v2.5.89): 이 수업 학생들의 교재를 리포트 교재 카드로. [진행 중 | 완료 | 다음], 카드를 누르면 교재 상세.
function paneBooks(el){
 const data=ensureBooks();
 if(!data){el.innerHTML=paneHead(`<p class="page-title">${icon('book')}교재</p>`,'교재를 불러오는 중…');return;}
 if(!BOOK_SEGS.includes(state.bookSeg))state.bookSeg='진행 중';
 const seg=state.bookSeg,cnt=x=>data.books.filter(b=>bookSegOf(b)===x).length,src=booksIn(data,seg),groups=src.books.length?bookChoices(src):[];
 const shown=groups.flatMap(g=>g.items);
 el.innerHTML=paneHead(`<p class="page-title">${icon('book')}교재</p>`,'진행상황별로 교재를 볼 수 있어요',BOOK_SEGS.map(x=>tabBtn(seg===x,`data-bs="${x}"`,`${x==='진행 중'?'진행중':x} ${cnt(x)}`)).join(''))+
 `<div class="pbody">${groups.map(g=>`${groups.length>1?`<p class="group-label">${esc(g.label)}</p>`:''}<div class="br-list feed">${g.items.map(it=>bookRow(it,{attr:`data-bkv="${esc(it.value)}"`,feed:true})).join('')}</div>`).join('')||`<div class="list"><p class="empty">${seg==='진행 중'?'진행 중인 교재가 없어요.':seg==='완료'?'완료한 교재가 없어요.':'다음 교재가 없어요.'}</p></div>`}</div>`;
 bindCovers(el);
 el.querySelectorAll('[data-bs]').forEach(b=>b.onclick=()=>{state.bookSeg=b.dataset.bs;render();});
 bindBookOpen(el,shown);
}
// 홈 "교재 진도": 진행 중 교재를 한 카드에 [교재명 / 진도 막대]. 개별 교재 묶음은 "n명 모두" 한 줄(진도 평균).
function homeBooks(){const data=ensureBooks();if(!data)return '<div class="list"><p class="empty">교재를 불러오는 중…</p></div>';
 const items=bookChoices(booksIn(data,'진행 중')).flatMap(g=>g.items[0].value.includes(',')?[g.items[0]]:g.items);
 if(!items.length)return '<div class="list"><p class="empty">진행 중인 교재가 없어요.</p></div>';
 homeBooks.items=items;
 return `<div class="list bp-list">${items.map(it=>`<button class="bp-row" type="button" data-bkv="${esc(it.value)}"><span class="bp-t">${esc(it.title)}<small>${esc(it.sub)}</small></span>${it.progress!==null&&it.progress!==undefined?`<span class="progress-line"><span class="track"><span class="fill" style="width:${Math.max(0,Math.min(100,it.progress))}%"></span></span><b>${it.progress}%</b></span>`:''}</button>`).join('')}</div>`;}
function bindBookOpen(el,items=homeBooks.items||[]){el.querySelectorAll('[data-bkv]').forEach(b=>b.onclick=()=>{const it=items.find(x=>x.value===b.dataset.bkv);if(!it||!leaveEdit())return;state.bookItem=it;state.view='book';render();});}
// 교재 상세(v2.5.89, 리포트 교재 상세처럼): 교재 카드 / [이 교재로 기록 만들기](진행 중 교재만) / 학생별 진도 / 이 교재 학습기록(반 기록 중 이 교재, 날짜별).
function paneBook(el){
 const it=state.bookItem,ids=it.value.split(','),data=ensureBooks(),books=data?data.books.filter(b=>ids.includes(b.id)):[];
 const regName=id=>(data?.registrations.find(r=>r.id===id)?.name||'').split(' ')[0]||'학생';
 const live=books.length&&books.every(b=>bookSegOf(b)==='진행 중'),each=ids.length>1||books[0]?.mode!=='그룹 진도';
 const owners=books.flatMap(b=>b.ownerIds.map(o=>({o,b})));
 const list=ensureClassRecords(),recs=list?list.filter(r=>ids.includes(r.bookId)):null;
 el.innerHTML=`<div class="br-list feed">${bookRow(it,{feed:true}).replace('<button class="book-row ','<div class="book-row static ').replace(/<\/button>$/,'</div>')}</div>
 ${live?`<div class="actions"><button class="primary wide" type="button" id="bk-new">${icon('plus','inline-icon')} 이 교재로 기록 만들기</button></div>`:`<p class="page-hint bk-note">${books.length?'진행 중인 교재만 기록을 만들 수 있어요.':''}</p>`}
 <h2 class="sec-title">${icon('users')}학생 <span class="cnt">${owners.length}명</span></h2>
 <div class="list">${owners.map(({o,b})=>`<div class="row"><span class="meta"><span class="t">${esc(regName(o))}</span><span class="d">${esc(b.recent?'최근 '+b.recent:'최근 기록 없음')}</span></span>${each&&b.progress!==null&&b.progress!==undefined?`<span class="pct">${b.progress}%</span>`:''}</div>`).join('')||'<p class="empty">교재 정보를 불러오는 중…</p>'}</div>
 <h2 class="sec-title">${icon('학습')}이 교재 학습기록 <span class="cnt">${recs?recs.length:''}</span></h2>
 ${recs?recTimeline(recs,'이 반 앞뒤 수업에 이 교재 기록이 없어요.'):'<div class="list"><p class="empty">기록을 불러오는 중…</p></div>'}`;
 bindCovers(el);
 const nb=el.querySelector('#bk-new');if(nb)nb.onclick=()=>openCreateSheet(it.value);
 el.querySelectorAll('[data-rec]').forEach(b=>b.onclick=()=>openRecord(b.dataset.rec,b));
}
// 캘린더 탭(v2.5.87, 접기 v2.5.93, 현황 v2.5.103 — 학부모 리포트 캘린더처럼): 위에 [출석 현황 | 과제 현황], 처음엔 이 반 수업 한 달.
// 칸 색(두 현황 같은 기준): 비율 100% 초록 · 50% 이상 노랑 · 50% 미만 빨강. 출석 = 출석(또는 등원 찍음) ÷ 그 수업 학생 수(일부만 입력해도 전체 기준),
// 과제 = 그날 마감 과제 제출 ÷ 그날 마감 과제 수. 지난 수업에 출석을 하나도 안 넣었으면 빗금, 오늘 아직 안 넣었거나 앞으로 수업·그날 마감 과제가 없는 날은 테두리.
// 달 보기 위 막대 카드(리포트와 같은 B안: 첫 줄 "n월 수업 지난/전체회", 둘째 줄 막대 한 줄)와 칩 4개 — 누르면 그 상태의 가장 최근 날짜(남은 수업·마감 전은 가장 가까운 날)로 접혀 열린다.
// 날짜를 누르면 그 수업으로 가며 그 주 한 줄로 접히고 아래에 [⌄ 월 전체 보기] · [학생 목록 | 학습 기록]. 접힌 주에서 다른 날을 누르면 수업만 바꾼다(칸을 쌓지 않음, 고른 탭 유지).
// 뒤로가기·[월 전체 보기]는 월 보기로. 반이 없는 보강 수업은 달력 없이 바로 그날 목록을 보인다.
const rateTone=(n,t)=>n>=t?'ok':n*2>=t?'mid':'bad';
function calState(x,mode=state.calMode){const t=seoulDate();if(x.date>t)return 'plan';
 if(mode==='hw')return x.hwTotal?rateTone(x.hwDone||0,x.hwTotal):'open';
 if(!x.total)return 'open';if(x.missing>=x.total)return x.date===t?'open':'miss';return rateTone(x.present||0,x.total);}
const CAL_MODES=[['att','출석 현황'],['hw','과제 현황']];
const CAL_TABS=[['att','학생 목록'],['rec','학습 기록']];
const CAL_CHIPS={att:[['ok','전원 출석'],['mid','50% 이상'],['bad','50% 미만'],['plan','남은 수업']],hw:[['ok','모두 제출'],['mid','50% 이상'],['bad','50% 미만'],['plan','마감 전']]};
const CAL_LEGEND={att:['전원 출석','50% 이상 출석','50% 미만 출석'],hw:['모두 제출','50% 이상 제출','50% 미만 제출']};
function calSummary(ms,mode,m){
 const st=ms.map(x=>calState(x,mode)),cnt=k=>k==='plan'&&mode==='hw'?ms.filter((x,i)=>st[i]==='plan'&&x.hwTotal).length:st.filter(s=>s===k).length;
 const past=ms.filter(x=>x.date<=seoulDate()),hwAll=ms.filter(x=>x.date<=seoulDate()).reduce((a,x)=>[a[0]+(x.hwDone||0),a[1]+(x.hwTotal||0)],[0,0]);
 const head=mode==='hw'?`<span class="lbl">${m}월 과제</span><b>${hwAll[0]} / ${hwAll[1]} 제출</b>`:`<span class="lbl">${m}월 수업</span><b>${past.length} / ${ms.length}회</b>`;
 return `<div class="card cal-sum"><div class="sum-bar">${head}<span class="cells">${st.map(s=>`<i class="${s}"></i>`).join('')||'<i></i>'}</span></div>
 <div class="sum-chips">${CAL_CHIPS[mode].map(([k,l])=>{const n=cnt(k);return `<button class="sum-chip ${k}" type="button" data-chip="${k}" ${n?'':'disabled'} aria-label="${esc(l)} ${n}회${n?' · 그날로 가기':''}"><b>${n}</b><small>${esc(l)}</small></button>`;}).join('')}</div></div>`;}
function paneCalendar(el){
 const d=state.detail,list=state.classWeek||[],byDate=new Map(list.map(x=>[x.date,x])),open=state.calOpen||!list.length,mode=state.calMode==='hw'?'hw':'att';
 const ym=open?state.date.slice(0,7):(state.cwMonth||state.date.slice(0,7)),[y,m]=ym.split('-').map(Number),first=`${ym}-01`;
 const cell=dd=>{const x=byDate.get(dd);if(!x)return dayCell(dd,false,false,'');const c=['cal-day','has',calState(x,mode)];if(dd===seoulDate())c.push('today');if(x.id===state.sessionId)c.push('picked');
  const what=mode==='hw'?(x.hwTotal?` 과제 제출 ${x.hwDone||0}/${x.hwTotal}`:''):(x.total?` 출석 ${x.present}/${x.total}`:'');
  return `<button type="button" class="${c.join(' ')}" data-cs="${esc(x.id)}" aria-label="${esc(dateLabel(dd))} 수업${what}" aria-pressed="${x.id===state.sessionId}"><span>${Number(dd.slice(8))}</span></button>`;};
 const mon=weekStart(state.date),days=open?Array.from({length:7},(_,i)=>cell(addDays(mon,i))).join('')
  :Array.from({length:dowMon(first)},()=>'<div class="cal-day empty"></div>').join('')+Array.from({length:monthDays(ym)},(_,k)=>cell(`${ym}-${pad(k+1)}`)).join('');
 const navRow=open?`<div class="cal-month-nav"><span></span><div class="cal-month-title">${y}년 ${m}월</div><span></span></div>`
  :`<div class="cal-month-nav">${navBtn('data-cwm="-1"','이전 달','‹')}<div class="cal-month-title">${y}년 ${m}월</div><div class="cal-nav-right">${todayBtn('cw-today')}${navBtn('data-cwm="1"','다음 달','›')}</div></div>`;
 const ms=list.filter(x=>x.date.startsWith(ym));
 el.innerHTML=paneHead(`<p class="page-title">${icon('cal')}캘린더</p>`,!list.length?'반이 없는 보강 수업이라 달력 없이 이 수업만 봐요':open?'같은 주의 다른 날을 누르면 그 수업으로 바뀌어요':'날짜를 누르면 그 주로 접히고 학생 목록·학습 기록을 봐요',
  list.length?CAL_MODES.map(([k,l])=>tabBtn(mode===k,`data-cm="${k}"`,l)).join(''):'')+
 `<div class="pbody">${list.length&&!open?calSummary(ms,mode,m):''}${list.length?`<div class="attendance-calendar">${navRow}<div class="cal-grid">${CAL_DOW}${days}</div>
 ${open?`<button class="cal-collapse-btn" type="button" id="cal-month">${CHEVRON_DOWN}<span>월 전체 보기</span></button>`:`<div class="cal-legend">${CAL_LEGEND[mode].map((l,i)=>`<span><i class="${['ok','mid','bad'][i]}"></i>${l}</span>`).join('')}</div>`}</div>`:''}
 ${open?'<div id="cal-sub"></div>':''}</div>`;
 const openDay=(id,b)=>{if(!leaveEdit())return;state.calOpen=true;if(id===state.sessionId)return render();run(()=>openSessionNow(id,true),b);};
 el.querySelectorAll('[data-cs]').forEach(b=>b.onclick=()=>open?switchSession(b.dataset.cs,b):openDay(b.dataset.cs,b));
 el.querySelectorAll('[data-cm]').forEach(b=>b.onclick=()=>{if(b.dataset.cm===mode)return;state.calMode=b.dataset.cm;render();});
 // 칩: 지난 상태는 가장 최근 날, 남은 수업·마감 전은 가장 가까운 날
 el.querySelectorAll('[data-chip]').forEach(b=>b.onclick=()=>{const k=b.dataset.chip,hit=ms.filter(x=>calState(x,mode)===k&&(k!=='plan'||mode!=='hw'||x.hwTotal));
  const x=k==='plan'?hit[0]:hit.at(-1);if(x)openDay(x.id,b);});
 el.querySelectorAll('[data-cwm]').forEach(b=>b.onclick=()=>run(async()=>{state.cwMonth=shiftMonth(ym,Number(b.dataset.cwm));await ensureClassMonth(state.cwMonth);render();},b));
 const ct=el.querySelector('#cw-today');if(ct)ct.onclick=e=>{run(async()=>{state.cwMonth=seoulDate().slice(0,7);await ensureClassMonth(state.cwMonth);render();},e.currentTarget);};
 const cm=el.querySelector('#cal-month');if(cm)cm.onclick=()=>{if(!leaveEdit())return;const top=nav.stack.at(-1);state.cwMonth=state.date.slice(0,7);
  if(top&&top.view==='session'&&top.tab==='calendar'&&!top.calOpen&&sameClass(top))return navBack();state.calOpen=false;nav.replace=true;render();};
 if(open)paneCheck($('cal-sub'));
}
// 접힌 날 아래 [학생 목록 | 학습 기록](v2.5.93, v2.5.103에 과제 점검 탭을 없앰). 탭 줄 아래 한 줄에 집계와 [편집]·↗.
// 학습 기록 = 맨 위에 그날이 마감인 과제(앞 수업에서 낸 과제 포함, 카드를 누르면 그 기록 화면에서 제출·미제출을 고친다) → 이 수업에 만든 기록 → [이 수업에 기록 만들기].
function paneCheck(el){
 const d=state.detail,seg=CAL_TABS.some(([k])=>k===state.seg)?state.seg:'att',att=seg==='att',ed=att&&editing('students');
 const n=s=>d.students.filter(x=>(state.draft[x.attendanceId]?.status??x.status)===s).length;
 let hint='',acts='',body='';
 if(!att){
  const all=ensureClassRecords()||[],today=state.date===seoulDate();
  const due=d.homeworkDue.map(h=>all.find(r=>r.id===h.recordId)||{id:h.recordId,kind:'과제',title:h.title,range:h.range,homework:{submitted:h.items.filter(i=>i.submitted).length,total:h.items.length,due:state.date}});
  const dueIds=new Set(due.map(r=>r.id)),mine=d.records.filter(r=>!dueIds.has(r.id));
  hint=`마감 과제 <b>${due.length}</b> · 이 수업 기록 <b>${mine.length}</b> · 과제를 누르면 제출 체크`;
  body=`${due.length?`<p class="group-label rec-date">${today?'지난 과제 · 오늘 마감':`${esc(withDow(state.date))} 마감 과제`}</p>${due.map(recCard).join('')}`:''}
  <p class="group-label rec-date">이 수업 기록</p>${mine.map(recCard).join('')||'<div class="list"><p class="empty">이 수업에 만든 기록이 없어요.</p></div>'}
  <div class="actions"><button class="primary" type="button" id="cal-new-rec">${icon('plus','inline-icon')} 이 수업에 기록 만들기</button></div>`;
 }else{
  hint=`출석 <b>${n('🟢 출석')}</b> · 결석 <b>${n('🔴 결석')}</b> · 보강 <b>${n('🔵 보강')}</b> · 웹 출석은 알림톡을 보내지 않아요`;acts=d.students.length?editButton('students'):'';
  // 한 줄(v2.5.80): [이름] [출석 상태] [등원] [하원] [메모]. 메모 칸은 메모·선생님 한마디 창(바로 저장). 편집 중에는 [이름] [출석|결석|보강]만.
  const rows=d.students.map(s=>{const st=state.draft[s.attendanceId]?.status??s.status,ch=state.draft[s.attendanceId];
   return `<div class="row s1 ${ch?'changed':''} ${st==='🔴 결석'&&!ed?'dim':''}"><span class="nm">${esc(s.name)}</span>${ed?`<span class="seg">${Object.entries(STATUS).map(([v,l])=>`<button type="button" class="v-${l} ${st===v?'on':''}" data-att="${esc(s.attendanceId)}" data-v="${v}">${l}</button>`).join('')}</span>`
   :`<span class="c"><span class="pill s-${STATUS[st]||''}">${STATUS[st]||'미입력'}</span></span><span class="c tm">${s.arrivedAt?timeOf(s.arrivedAt):'–'}</span><span class="c tm">${s.leftAt?timeOf(s.leftAt):'–'}</span>
   <button class="c memo-btn ${s.memo||s.comment?'has':''}" type="button" data-memo="${esc(s.attendanceId)}" aria-label="${esc(s.name)} 메모·선생님 한마디${s.memo||s.comment?' 있음':''}">${icon('memo')}</button>`}</div>`;}).join('');
  body=d.students.length?`<div class="list stu ${ed?'editing':''}"><div class="srow-h" aria-hidden="true"><span>이름</span><span class="c">출석</span>${ed?'':'<span class="c">등원</span><span class="c">하원</span><span class="c">메모</span>'}</div>${rows}</div>`
   :'<div class="list"><p class="empty">이 수업에 연결된 학생이 없어요.</p></div>';
 }
 el.innerHTML=`<div class="center-tabs check-tabs"><div class="tabs" role="tablist">${CAL_TABS.map(([k,l])=>tabBtn(seg===k,`data-seg="${k}"`,l)).join('')}</div></div>
 <div class="toolrow check-row"><p class="sum">${hint}</p>${acts}</div>${body}`;
 el.querySelectorAll('[data-seg]').forEach(b=>b.onclick=()=>{if(b.dataset.seg===seg||!leaveEdit())return;state.seg=b.dataset.seg;render();});
 bindEdit(el);
 el.querySelectorAll('[data-att]').forEach(b=>b.onclick=()=>{const id=b.dataset.att,orig=d.students.find(s=>s.attendanceId===id).status;if(b.dataset.v===orig)delete state.draft[id];else state.draft[id]={status:b.dataset.v};render();});
 el.querySelectorAll('[data-memo]').forEach(b=>b.onclick=()=>openMemo(b.dataset.memo));
 el.querySelectorAll('[data-rec]').forEach(b=>b.onclick=()=>openRecord(b.dataset.rec,b));
 const nr=el.querySelector('#cal-new-rec');if(nr)nr.onclick=()=>openCreateSheet();
 if(ed)state.saver=async()=>{const entries=Object.entries(state.draft);
  await api('save-attendance',{items:entries.map(([attendanceId,v])=>({attendanceId,...v}))});
  state.edit=false;state.draft={};updateSavebar();await reloadSession();toast(`저장했어요 · ${entries.length}건`);render();};
}

// 메모 창(v2.5.80, 선생님 한마디 v2.5.93): [메모 | 선생님 한마디]를 바꿔 보며 고치고 [저장]하면 바뀐 칸만 바로 저장한다(편집 모드 없이).
// 빠른 입력은 메모에만, 끝에 ", "로 붙인다. 메모는 학부모에게 안 보이고, 선생님 한마디는 다음 리포트 새로고침 때 학부모 화면에 반영된다(학생 공간에서 옮김).
const QUICK_MEMO=['교재 두고 옴','과제 안 해 옴','집중 좋음','조퇴'];
function openMemo(id,key='memo'){
 const s=state.detail.students.find(x=>x.attendanceId===id),c=state.detail.session,sh=$('sheet'),val={memo:s.memo||'',comment:s.comment||''};let cur=key;
 const draw=()=>{sh.innerHTML=`<div class="dialog-head"><h2>${esc(s.name)} ${cur==='memo'?'메모':'선생님 한마디'}</h2><button class="ghost" type="button" id="sh-x">닫기</button></div>
 <p class="page-hint">${esc(dateLabel(state.date))} ${esc(c.className||c.name)}${s.arrivedAt?' · 등원 '+timeOf(s.arrivedAt):''}${s.leftAt?' · 하원 '+timeOf(s.leftAt):''}</p>
 <div class="center-tabs left note-tabs"><div class="tabs" role="tablist">${tabBtn(cur==='memo','data-note="memo"','메모')}${tabBtn(cur==='comment','data-note="comment"','선생님 한마디')}</div></div>
 <form id="mf" class="form"><textarea id="mf-t" maxlength="2000" aria-label="${esc(s.name)} ${cur==='memo'?'메모':'선생님 한마디'}">${esc(val[cur])}</textarea>
 ${cur==='memo'?`<div class="chips quick">${QUICK_MEMO.map(q=>`<button class="chip" type="button" data-q="${esc(q)}">+ ${esc(q)}</button>`).join('')}</div>`:''}
 <p class="note-hint">${cur==='memo'?'메모는 학부모에게 안 보여요.':'선생님 한마디는 다음 리포트 새로고침 때 학부모 화면에 반영돼요.'}</p>
 <div class="actions"><button class="primary" type="submit">저장</button></div></form>`;
  const t=$('mf-t');$('sh-x').onclick=navBack;
  sh.querySelectorAll('[data-note]').forEach(b=>b.onclick=()=>{val[cur]=t.value;cur=b.dataset.note;draw();});
  sh.querySelectorAll('[data-q]').forEach(b=>b.onclick=()=>{const v=t.value.trim();t.value=v?`${v}, ${b.dataset.q}`:b.dataset.q;t.focus();});
  $('mf').onsubmit=e=>{e.preventDefault();val[cur]=t.value;const items={};if(val.memo!==(s.memo||''))items.memo=val.memo;if(val.comment!==(s.comment||''))items.comment=val.comment;
   if(!Object.keys(items).length){navBack();return;}
   run(async()=>{await api('save-attendance',{items:[{attendanceId:id,...items}]});await reloadSession();toast('저장했어요.');render();closeLayers();},e.submitter);};};
 draw();showLayer(sh);
}

// ---------- 학생 탭(v2.5.93, 반 요약 v2.5.94) ----------
// 위: 반 요약 카드(보고 있는 수업 달 출석률·과제이행률·최근 평가 평균, 그리고 리포트 "최근 평가 추이"와 같은 꺾은선 그래프, v2.5.96). 아래: 반 학생 명부
// [이름 학교 · 학년 … ↗ 학생 보고서(새 탭, 이름과 같은 줄)] / [출석 n% · 평가 n점](낮으면 빨강: 출석 80% 미만, 점수 60점 미만) /
// 연락처(누르면 전화)·보고서 상태는 기록 카드와 같은 ⌄ 펼치기 안에(v2.5.96).
// 학생 탭을 열 때만 읽는다(roster, class-stats). 보고서 링크가 꺼져 있거나 토큰이 없으면 ↗ 대신 안내 글자.
function ensureStats(){const id=state.sessionId;if(state.statsCache[id])return state.statsCache[id];
 if(ensureStats.busy!==id){ensureStats.busy=id;whenLoaded(api('class-stats',{sessionId:id}).then(r=>{state.statsCache[id]=r;}).finally(()=>{ensureStats.busy=null;}));}return null;}
// 비율·점수 4구간(docs/DESIGN.md 1부 3장): 0 = 90 이상, 1 = 70 이상, 2 = 50 이상, 3 = 50 미만
const scoreBand=v=>v>=90?0:v>=70?1:v>=50?2:3;
const monthName=ym=>Number(ym.slice(5))+'월';
function classSummary(st){
 if(!st)return '<div class="card cls-sum"><p class="empty">반 요약을 불러오는 중…</p></div>';
 const pct=r=>r===null||r===undefined?'–':r+'%',t=st.tests,avg=t.length?Math.round(t.reduce((n,x)=>n+x.avg,0)/t.length*10)/10:null;
 const tone=v=>v===null||v===undefined?'':['good','fair','low','bad'][scoreBand(v)];
 return `<div class="card cls-sum"><div class="home-stats">${stat(pct(st.month.rate),`${monthName(st.month.ym)} 출석률`,tone(st.month.rate))}${stat(pct(st.homework.rate),`${monthName(st.homework.ym)} 과제이행률`,tone(st.homework.rate))}${stat(avg===null?'–':avg.toFixed(1)+'점','최근 평가 평균',tone(avg))}</div>
 <p class="group-label">최근 평가 추이 · 반 평균</p>${trendChart(t)}</div>`;}
// 최근 평가 추이(v2.5.96): 학부모 리포트 buildTestTrendChartHtml과 같은 그림(400×200, 0~100 눈금 20 간격, 선·점, 점 위 "n.n점", 아래 "MM.DD"). 색은 토큰(CSS .trend).
function trendChart(points){
 if(!points.length)return '<p class="empty">점수가 있는 평가가 아직 없어요.</p>';
 const W=400,H=200,PX=30,PT=20,PB=34,step=points.length>1?(W-PX*2)/(points.length-1):0,x=i=>PX+i*step+(points.length>1?0:(W-PX*2)/2),y=v=>PT+(H-PT-PB)-(v/100)*(H-PT-PB);
 const grid=[0,20,40,60,80,100].map(v=>`<line class="tg" x1="${PX}" y1="${y(v)}" x2="${W-PX}" y2="${y(v)}"/><text class="tt" x="2" y="${y(v)+4}" font-size="9">${v}</text>`).join('');
 const line=points.length>1?`<polyline class="tl" points="${points.map((p,i)=>`${x(i)},${y(p.avg)}`).join(' ')}"/>`:'';
 const dots=points.map((p,i)=>`<circle class="td" cx="${x(i)}" cy="${y(p.avg)}" r="4"/><text class="tv" x="${x(i)}" y="${y(p.avg)-10}" font-size="11" text-anchor="middle">${p.avg.toFixed(1)}점</text><text class="tx" x="${x(i)}" y="${H-10}" font-size="10" text-anchor="middle">${esc(p.date.slice(5).replace('-','.'))}</text>`).join('');
 return `<div class="trend" role="img" aria-label="최근 평가 반 평균 ${points.map(p=>`${md(p.date)} ${p.avg}점`).join(', ')}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${grid}${line}${dots}</svg></div>`;}
function ensureRoster(){const id=state.sessionId;if(state.rosterCache[id])return state.rosterCache[id];
 if(ensureRoster.busy!==id){ensureRoster.busy=id;whenLoaded(api('roster',{sessionId:id}).then(r=>{state.rosterCache[id]=r.students;}).finally(()=>{ensureRoster.busy=null;}));}return null;}
const telHref=p=>'tel:'+String(p).replace(/[^0-9+]/g,'');
function paneRoster(el){
 const list=ensureRoster(),st=ensureStats(),head=h=>paneHead(`<p class="page-title">${icon('users')}학생</p>${nlink(state.detail.session.id,'수업')}`,h);
 if(!list){el.innerHTML=head('학생 정보를 불러오는 중…')+`<div class="pbody">${classSummary(st)}</div>`;return;}
 const per=s=>st?.students?.[s.registrationId],pill=(txt,v)=>`<span class="pill b-${['good','fair','low','poor'][scoreBand(v)]}">${txt}</span>`;
 const tel=(label,p)=>p?`<a class="tel" href="${esc(telHref(p))}" aria-label="${label} ${esc(p)} 전화 걸기">${label} ${esc(p)}</a>`:'';
 el.innerHTML=head(`학생 <b>${list.length}</b>명 · 출석률은 ${st?monthName(st.month.ym):'이번 달'}, 점수는 최근 평가 · ↗ 학생 보고서(새 탭) · 펼치면 연락처`)+`<div class="pbody">${classSummary(st)}${list.length?`<div class="list roster">${list.map(s=>{const x=per(s),
  a=x&&x.rate!==null&&x.rate!==undefined?pill(`출석 ${x.rate}%`,x.rate):'',b=x&&x.score!==null&&x.score!==undefined?pill(`평가 ${x.score}점`,x.score):'';
  return `<div class="r1 log-card"><div class="log-head r-body"><div class="r-top"><span class="r-name">${esc(s.name)}${s.school||s.grade?`<small>${esc([s.school,s.grade].filter(Boolean).join(' · '))}</small>`:''}</span>
  ${s.reportToken?`<a class="icon-btn rep" href="student_report.html?token=${encodeURIComponent(s.reportToken)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(s.name)} 학생 보고서 새 탭에서 열기" title="학생 보고서">${icon('ext')}</a>`:''}</div>
  ${a||b?`<div class="r-stats">${a}${b}</div>`:''}
  <button class="log-chev" type="button" data-chev="연락처" aria-expanded="false" aria-label="${esc(s.name)} 연락처 펼치기"><span>${CHEVRON_DOWN}</span></button></div>
  <div class="log-extra r-extra" hidden><div class="phones">${tel('학생',s.studentPhone)}${tel('우선',s.parentPhone)}${s.studentPhone||s.parentPhone?'':'<span class="no-tel">연락처 없음</span>'}</div>
  ${s.reportToken?'':`<p class="no-rep">${s.reportOff?'학생 보고서 링크가 꺼져 있어요.':'학생 보고서 링크가 없어요.'}</p>`}</div></div>`;}).join('')}</div>`:'<div class="list"><p class="empty">이 수업에 연결된 학생이 없어요.</p></div>'}</div>`;
}

// ---------- 학습기록 ----------
// 기록 카드 한 장(학습기록 탭·홈·캘린더·교재 상세 공용). v2.5.95부터 학부모 리포트 학습기록 카드(student_report_part2.js 학습기록 탭, renderLogMetaRows)와 같은 규칙:
// [분류 아이콘 칸(아이콘 + 구분 글자)] [교재 · 범위](교재 없으면 주제) [알약: 과제 "제출 n/전체", 평가 "평균 n점", 보강],
// 아래 줄은 펼치지 않아도 보인다: 단원("• 1-1. …", 단원 번호마다 한 줄) → 내용(선생님이 적은 글, 줄마다 앞뒤 공백 정리) → 과제는 "• 마감: 날짜"(출제일은 묶음 날짜라 뺌, v2.5.98).
// 펼치기(⌄)는 Notion 페이지 본문(글·목록·사진·파일·표)이 있을 때만이고, 펼치면 본문만 연한 베이지 칸에 보인다. 카드를 누르면 기록 화면.
// 반 전체 제출 알약 색(DESIGN.md 1부 3장): 모두 제출 초록 · 50% 이상 노랑 · 50% 미만 빨강
const pillTone=(n,t)=>n>=t?'done':n*2>=t?'mid':'miss';
const withDow=ymd=>ymd?`${ymd} (${'일월화수목금토'[new Date(ymd+'T00:00:00Z').getUTCDay()]})`:'';
function recCard(r){
 const subject=r.subject||'',title=[subject,r.range].filter(Boolean).join(' · ')||r.topic||r.title;
 const units=(r.unit||'').split(/(?=\d+-\d+\.)/).map(x=>x.trim()).filter(Boolean);
 const note=(r.content||'').split('\n').map(l=>l.trim()).join('\n').trim();
 // 기록 카드는 늘 날짜·수업으로 묶인 곳에 보이므로(학습기록 탭·홈·캘린더·교재 상세) 출제일은 묶음 날짜와 겹쳐 빼고 마감만(v2.5.98)
 const extras=r.kind==='과제'&&r.homework?.due?[`마감: ${withDow(r.homework.due)}`]:[];
 const hw=r.homework,sc=r.score;
 const pill=hw?`<span class="pill ${pillTone(hw.submitted,hw.total)}">제출 ${hw.submitted}/${hw.total}</span>`:sc?`<span class="pill b-${["good","fair","low","poor"][scoreBand(sc.avg)]}">평균 ${sc.avg}점</span>`:'';
 const body=bodyHtml(r.body),meta=units.map(u=>`<span class="log-context">• ${esc(u)}</span>`).join('')+(note?`<span class="log-note">${esc(note)}</span>`:'')+extras.map(x=>`<span class="log-context">• ${esc(x)}</span>`).join('');
 // 펼치기(v2.5.111): 본문을 미리 읽지 않으므로 늘 둔다. 펼칠 때 record-body로 그 기록 본문만 읽는다(이미 받은 본문이 있으면 그대로).
 if(body)state.bodyCache[r.id]=r.body;
 return `<div class="rec log-card has-extra"><div class="log-head"><button class="log-main" type="button" data-rec="${esc(r.id)}"><span class="log-top"><span class="log-icon k-${esc(r.kind||'학습')}">${icon(r.kind||'학습')}<small>${esc(r.kind||'학습')}</small></span><span class="log-title">${esc(title)}</span>${pill}${r.makeup?'<span class="pill s-보강">보강</span>':''}</span>
 ${meta?`<span class="log-meta">${meta}</span>`:''}</button>
 <button class="log-chev" type="button" data-chev data-body="${esc(r.id)}" aria-expanded="false" aria-label="본문 펼치기"><span>${CHEVRON_DOWN}</span></button></div>
 <div class="log-extra" hidden>${body}</div></div>`;}
// Notion 페이지 본문(feedBody.ts가 내려주는 블록 목록) → HTML. 글은 굵게·기울임·코드·링크만 살리고, 사진·동영상·파일은 새 탭으로 연다.
function spansHtml(b){const sp=Array.isArray(b.spans)&&b.spans.length?b.spans:[{text:b.text||''}];
 return sp.map(s=>{let h=esc(s.text??'');if(s.code)h=`<code>${h}</code>`;if(s.bold)h=`<b>${h}</b>`;if(s.italic)h=`<i>${h}</i>`;if(s.strikethrough)h=`<s>${h}</s>`;
  if(s.href&&/^https?:\/\//.test(s.href))h=`<a href="${esc(s.href)}" target="_blank" rel="noopener noreferrer">${h}</a>`;return h;}).join('');}
function bodyHtml(body){if(!Array.isArray(body)||!body.length)return '';const out=[];let list='';const close=()=>{if(list){out.push(`</${list}>`);list='';}};
 for(const b of body){if(!b)continue;
  if(b.type==='text'){const st=String(b.style||'paragraph'),t=spansHtml(b);
   if(st==='bulleted_list_item'||st==='numbered_list_item'||st==='to_do'){const tag=st==='numbered_list_item'?'ol':'ul';if(list!==tag){close();out.push(`<${tag} class="lb-list">`);list=tag;}out.push(`<li>${st==='to_do'?(b.checked?'☑ ':'☐ '):''}${t}</li>`);continue;}
   close();out.push(st.startsWith('heading')?`<p class="lb-h">${t}</p>`:st==='quote'||st==='callout'?`<p class="lb-q">${b.icon?esc(b.icon)+' ':''}${t}</p>`:st==='code'?`<pre class="lb-code">${esc(b.text||'')}</pre>`:`<p>${t}</p>`);continue;}
  close();const url=/^https?:\/\//.test(String(b.url||''))?String(b.url):'';
  if(b.type==='image'&&url)out.push(`<a class="lb-img" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(url)}" alt="${esc(b.caption||'')}" loading="lazy"></a>${b.caption?`<p class="lb-cap">${esc(b.caption)}</p>`:''}`);
  else if((b.type==='video'||b.type==='pdf'||b.type==='file')&&url)out.push(`<p><a class="lb-file" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(b.name||b.caption||(b.type==='video'?'동영상':'첨부 파일'))}</a></p>`);
  else if(b.type==='divider')out.push('<hr class="lb-hr">');
  else if(b.type==='table'&&Array.isArray(b.rows))out.push(`<table class="lb-table">${b.rows.map(row=>`<tr>${(row||[]).map(c=>`<td>${spansHtml({spans:c})}</td>`).join('')}</tr>`).join('')}</table>`);}
 close();return out.join('');}
// 내용 펼치기·접기(모든 화면 공용, 화면을 다시 그리지 않는다)
$('app').addEventListener('click',e=>{const b=e.target.closest('[data-chev]');if(!b)return;const x=b.closest('.log-card').querySelector('.log-extra'),open=x.hidden;x.hidden=!open;b.setAttribute('aria-expanded',open);const what=b.dataset.chev||'본문';b.setAttribute('aria-label',open?`${what} 접기`:`${what} 펼치기`);
 if(open&&b.dataset.body&&!x.dataset.loaded)fillBody(b.dataset.body,x);});
// 기록 본문 펼치기(v2.5.111): 처음 펼칠 때 그 기록 본문만 읽고, 받은 본문은 ⟳ 새로고침 전까지 다시 쓴다.
async function fillBody(id,x){const show=list=>{x.dataset.loaded='1';x.innerHTML=bodyHtml(list)||'<p class="empty body-empty">본문이 없어요.</p>';};
 if(state.bodyCache[id])return show(state.bodyCache[id]);
 x.innerHTML='<p class="empty body-empty">본문을 불러오는 중…</p>';
 try{const r=await api('record-body',{recordId:id});state.bodyCache[id]=r.body||[];show(state.bodyCache[id]);}
 catch(err){x.innerHTML='<p class="empty body-empty">본문을 불러오지 못했어요. 다시 펼쳐 주세요.</p>';if(err.message!=='silent')toast(err.message);}}
// 기록을 날짜별로(v2.5.103 타임라인): 오늘이 맨 위("날짜 · 오늘", 오늘 카드는 테두리) → 지난 날짜 최근부터 → 앞으로 날짜는 가까운 날부터 맨 아래.
// 보고 있는 수업 날짜는 글자색으로 표시한다.
function recTimeline(recs,empty){const t=seoulDate(),all=[...new Set(recs.map(r=>r.date||''))];
 const dates=[...all.filter(d=>d===t),...all.filter(d=>d<t).sort().reverse(),...all.filter(d=>d>t).sort()];
 return dates.map(d=>{const day=recs.filter(r=>(r.date||'')===d),cur=day.some(r=>r.sessionId===state.sessionId);
  return `<div class="rec-day ${d===t?'today':''}"><p class="group-label rec-date ${cur?'cur':''}">${esc(d?withDow(d):'날짜 없음')}${d===t?' · 오늘':''}</p>${day.map(recCard).join('')}</div>`;}).join('')||`<div class="list"><p class="empty">${esc(empty)}</p></div>`;}
// 학습기록 탭(v2.5.89): 이 반 앞뒤 수업(9주 전 ~ 5주 뒤)의 기록을 날짜별로. [전체 · 학습 · 과제 · 평가], + 기록 만들기는 보고 있는 수업에.
function paneRecords(el){
 const all=ensureClassRecords(),k=state.recKind||'전체',fab=`<button class="fab" type="button" id="new-rec">${icon('plus')}<span>기록 만들기</span></button>`;
 const head=(hint)=>paneHead(`<p class="page-title">${icon('학습')}학습기록</p>${nlink(state.detail.session.id,'수업')}`,hint,['전체',...KINDS].map(x=>tabBtn(x===k,`data-rk="${x}"`,x)).join(''));
 if(!all)el.innerHTML=head('이 반 기록을 불러오는 중…')+fab;
 else{const recs=k==='전체'?all:all.filter(r=>r.kind===k);
  el.innerHTML=head('이 반 최근 기록 · '+KINDS.map(x=>`${x} <b>${all.filter(r=>r.kind===x).length}</b>`).join(' · '))+`<div class="pbody">${recTimeline(recs,k==='전체'?'아직 기록이 없어요.':`${k} 기록이 없어요.`)}</div>`+fab;}
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
  ${checking?(ed?`<span class="seg"><button type="button" class="v-제출 ${sub?'on':''}" data-sub="${esc(a.id)}" data-v="1">제출</button><button type="button" class="v-미제출 ${sub?'':'on'}" data-sub="${esc(a.id)}" data-v="0">미제출</button></span>`:`<span class="pill ${sub?'sub':'miss'}">${sub?'제출':'미제출'}</span>`):''}
  ${scoring?(ed?`<span class="score"><input inputmode="numeric" data-cor="${esc(a.id)}" value="${cor??''}" aria-label="${esc(a.name)} 맞힌 문항"> / <input inputmode="numeric" data-tot="${esc(a.id)}" value="${tot??''}" aria-label="${esc(a.name)} 전체 문항"></span>`:`<span class="pill k-평가">${cor??'–'} / ${tot??'–'}</span>`):''}${nlink(a.id,a.name+' 학습활동')}</div>`;}).join('')}</div>`
 :`<div class="list"><p class="empty">아직 학습활동이 없어요.</p></div>`}
 ${acts.length?'':`<div class="actions"><button class="primary" type="button" id="make-acts" ${r.activityStatus==='🔄 작업중'?'disabled':''}>${esc(ACT_LABEL[r.kind]||'학습활동 만들기')} · ${r.registrationIds.length}명</button></div>${r.activityStatus==='🔄 작업중'?'<p class="help">만드는 중이에요. 잠시 뒤 새로고침해 주세요.</p>':''}`}</div>`;
 const q=s=>el.querySelector(s);bindCovers(el);
 [['#rec-topic','topic'],['#rec-range','range'],['#rec-content','content']].forEach(([s,k])=>q(s).oninput=e=>{re[k]=e.target.value;});
 bulletize(q('#rec-content'),()=>{re.content=q('#rec-content').value;});
 q('#rec-book').onclick=()=>{drawBookPicker(bookChoices(state.books,{single:true,include:re.book}),re.book,val=>{re.book=val;closeLayers(render);},navBack,'교재 없음','교재 없이 주제로 기록해요');showLayer($('sheet'));};
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

// ---------- 뒤로가기(v2.5.85) ----------
// 브라우저·휴대폰 뒤로가기가 페이지를 벗어나지 않고 직전 동작으로 돌아가게 방문 기록(History API)에 동작을 하나씩 남긴다.
// 창·서랍(layer)은 열 때 한 칸, 화면(보기·수업·기록·학생 공간)이 바뀔 때 한 칸. 뒤로가기는 열린 창부터 닫고, 없으면 이전 화면으로.
// 하단 탭은 앱(안드로이드·인스타그램)처럼 쌓지 않는다(v2.5.87): 홈 → 다른 탭만 한 칸이고, 다른 탭에서 뒤로가기나 [홈]은 홈으로,
// 홈에서 뒤로가기는 첫 화면으로. 같은 반 안에서 수업을 바꾸면(홈 ‹ ›, 캘린더 날짜) 칸을 쌓지 않고, 다른 탭에서 홈으로 돌아가도 고른 수업을 그대로 본다.
// 창을 닫는 동작(✕·바깥·Esc·저장 뒤 닫기)도 모두 방문 기록을 거쳐(history.back) 기록과 화면이 어긋나지 않게 한다. 처음 화면에서는 원래대로 나간다.
// 방문 기록마다 순번(idx)을 붙여 뒤로가기와 앞으로 가기를 구분한다. 앞으로 가기는 되돌릴 화면이 없으므로 바로 한 칸 뒤로 돌려 무시한다.
const nav={stack:[],layers:[],after:null,count:0,last:null,restoring:false,idx:0,skip:false,replace:false,chain:0};
const chainNext=()=>{if(nav.chain>0){nav.chain--;setTimeout(navBack,0);}};
history.replaceState({cr:'base',idx:0},'');
const navPush=kind=>history.pushState({cr:kind,idx:++nav.idx},'');
const NAV_FIELDS=['calOpen','bookItem','view','tab','sessionId','recordId','seg','recKind','calMode','detail','classWeek','cwFrom','cwTo','date','day','acts','recEdit','books','hwRecord','picked'];
const screenKey=()=>!['session','record','book'].includes(state.view)?state.view:[state.view,state.tab,state.sessionId,state.view==='record'?state.recordId:'',state.view==='book'?state.bookItem?.value:'',state.view==='session'&&state.tab==='calendar'&&state.calOpen?'open':''].join('|');
function takeSnap(){const o={key:screenKey()};for(const k of NAV_FIELDS)o[k]=state[k];return o;}
function navTrack(){
 if(state.view==='login'){nav.last=null;return;}
 const cur=takeSnap();
 if(nav.restoring||!nav.last){nav.last=cur;return;}
 // 탭끼리·같은 반 수업끼리 옮길 때: 되돌아갈 칸 없이 지금 칸을 바꿔 쓰기만 한다.
 if(nav.replace){nav.replace=false;nav.last=cur;history.replaceState({cr:'screen',idx:nav.idx},'');return;}
 if(cur.key!==nav.last.key){
  // 같은 수업 안에서 옮겼으면 앞 화면도 방금 읽은 수업 자료로 되돌린다(새로 만든 기록이 목록에 보이게).
  const prev=nav.last.sessionId===state.sessionId?{...nav.last,detail:state.detail,day:state.day,classWeek:state.classWeek,books:state.books}:nav.last;
  nav.stack.push(prev);
  // 창 안에서 화면이 바뀌었으면(서랍에서 반·날짜를 고름, 기록을 만들고 기록 화면으로 감) 창을 닫고 창의 기록 칸을 새 화면 칸으로 바꿔 쓴다.
  // 창 안의 창(교재 고르기)에서는 화면을 바꾸지 않으므로 열린 창은 하나다.
  if(nav.layers.length){nav.layers=[];for(const d of [$('sheet'),$('drawer')])if(d.open)d.close();history.replaceState({cr:'screen',idx:nav.idx},'');}
  else navPush('screen');
 }
 nav.last=cur;
}
function pushLayer(close){nav.layers.push(close);navPush('layer');}
function showLayer(dlg){if(!dlg.open){dlg.showModal();pushLayer(()=>dlg.close());}}
// 열린 창을 모두 닫고(방문 기록도 그만큼 되돌린 뒤) then을 한다. 열린 창이 없으면 바로 한다.
function closeLayers(then){const n=nav.layers.length;if(!n){if(then)then();return;}nav.after=then||null;nav.count=n;history.go(-n);}
const navBack=()=>history.back();
// 같은 반의 화면인가(보강 수업처럼 반이 없으면 같은 수업인가)
function sameClass(p){const a=p.detail?.session?.classIds?.[0],b=state.detail?.session?.classIds?.[0];return a?a===b:p.sessionId===state.sessionId;}
window.addEventListener('popstate',e=>{
 const idx=e.state?.idx??0;
 if(nav.skip){nav.skip=false;nav.idx=idx;return;}
 if(idx>nav.idx){nav.skip=true;history.back();return;}
 nav.idx=idx;
 if(nav.layers.length){const n=Math.max(1,nav.count);nav.count=0;for(let i=0;i<n&&nav.layers.length;i++)nav.layers.pop()();const then=nav.after;nav.after=null;if(then)then();return;}
 const prev=nav.stack.pop();if(!prev){nav.chain=0;return;}
 if(!leaveEdit()){nav.stack.push(prev);navPush('screen');return;}
 // 반 상세의 다른 탭 → 홈: 보고 있는 수업(‹ ›·캘린더로 고른 수업)은 그대로 두고 탭만 되돌린다.
 if(state.view==='session'&&prev.view==='session'&&sameClass(prev)){nav.restoring=true;state.tab=prev.tab;state.calOpen=prev.calOpen;if(prev.calOpen===false)state.cwMonth=state.date.slice(0,7);render();nav.restoring=false;nav.last=takeSnap();chainNext();return;}
 nav.restoring=true;for(const k of NAV_FIELDS)state[k]=prev[k];render();nav.restoring=false;nav.last=takeSnap();chainNext();
 if(state.view==='session'&&state.sessionId)reloadSession().then(()=>{if(state.view==='session'&&!state.edit)render();}).catch(()=>{});
});
[$('sheet'),$('drawer')].forEach(d=>d.addEventListener('cancel',e=>{e.preventDefault();navBack();}));

// ---------- 시작 ----------
function render(){
 if(!state.session)return showLogin();
 if(!state.teacherId)return showTeachers();
 ({main:renderMain,waiting:renderWaiting,session:renderSession,record:renderSession,book:renderSession,teachers:showTeachers}[state.view]||renderMain)();
 updateSavebar();navTrack();
}
async function start(){
 // Notion 수업 페이지 링크로 열면(?session=…) 그 수업 날짜로 접힌 캘린더의 출석 체크를 바로 연다(v2.5.93). 아니면 첫 화면.
 await loadTeachers();
 const want=new URLSearchParams(location.search).get('session');
 if(!state.teacherId)return render();
 if(want){await openSessionNow(want,false,'calendar',true);return;}
 await showMain();
}
// 저장 막대는 편집 중인 칸이 정한 저장 동작(state.saver)을 부른다.
$('save-ok').onclick=e=>{if(state.saver)run(state.saver,e.currentTarget);};
$('save-cancel').onclick=()=>{state.edit=false;state.draft={};updateSavebar();render();};
if(!state.session)showLogin();else run(start);
