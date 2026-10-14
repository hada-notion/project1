'use strict';
// 공용 상단 메뉴 (docs/DESIGN.md "상단 메뉴"). 화면을 추가하면 이 목록 하나만 고친다.
// 페이지의 .top 안에 빈 #app-nav가 있으면 채운다. 관리 화면은 같은 탭에서 이동하고(공용 CSS의 화면 전환으로
// 상단 바는 그대로 둔 채 본문만 바뀌어 보인다), 기기에서 따로 띄워 두는 출결 키오스크와 수업 관리는 새 탭으로 연다.
// 아이콘은 Feather Icons(MIT) 원본 경로.
(() => {
const ICONS={
 settings:'<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"></path><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',
 legal:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line>',
 book:'<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>',
 school:'<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>',
 external:'<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line>',
 check:'<polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>',
 edit:'<path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>',
 award:'<circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline>',
 menu:'<line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line>',
 x:'<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
 more:'<circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle>',
};
// [주소, 메뉴 이름, 아이콘, 설명(마우스를 올리면 보임), 화면 준비 여부(false면 흐린 탭으로 자리만 보이고 누르면 잠깐 "준비 중")].
// 새 탭 메뉴는 넓은 화면에서 ↗와 이름, 태블릿 폭에서는 각자의 아이콘만 보인다. 휴대폰 폭(700px 이하)에서는 상단 바에 ☰만 두고 전부 사이드바로 옮긴다.
const PAGES=[
 ['admin_settings.html','관리자 설정','settings','관리자 비밀번호 변경과 Notion 웹훅 키 교체'],
 ['library.html','라이브러리','book','교재를 시리즈별로 보고, 찾아서 추가'],
 ['exam.html','시험 관리','award','학교·학년별 시험 범위와 일정 관리(준비 중)',false], // 화면을 만들면 false를 지운다
 ['school_search.html','학교 검색','school','나이스에서 학교를 찾아 Notion 학교 페이지와 연결'],
 ['legal_documents.html','법정 서류','legal','출석부·원부·영수증 서식을 기간별로 조회하고 출력'],
];
const EXTERNAL=[
 ['attendance_kiosk.html','키오스크','check','학원 입구 태블릿에서 전화번호로 등원·하원 체크(새 탭)','출결 키오스크(새 탭에서 열림)'],
 ['class_room.html','수업 관리','edit','선생님이 수업별 출석·과제·학습기록을 관리(새 탭)','수업 관리(새 탭에서 열림)'],
];
const PHONE=window.matchMedia('(max-width:700px)');
const icon=name=>`<svg class="line nav-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const here=()=>location.pathname.split('/').pop()||'index.html';
function el(tag,cls,attrs={}){const e=document.createElement(tag);if(cls)e.className=cls;for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);return e}
function link(href,label,iconName,title,cls){const a=el('a',cls,{href,title,'aria-label':label});a.innerHTML=icon(iconName);const t=el('span','nav-label');t.textContent=label;a.append(t);return a}
function iconBtn(cls,label,iconName){const b=el('button','ghost nav-icon-btn '+cls,{type:'button',title:label,'aria-label':label});b.innerHTML=icon(iconName);return b}
// 아직 없는 화면: 이동하지 않고, 누르면 이름 자리에 1.5초 동안 "준비 중"
function soon(a){a.removeAttribute('href');a.classList.add('nav-soon');a.setAttribute('role','link');a.setAttribute('aria-disabled','true');a.tabIndex=0;
 const flash=e=>{e.preventDefault();const t=a.querySelector('.nav-label');if(a.dataset.flash)return;a.dataset.flash='1';const old=t.textContent;t.textContent='준비 중';
  setTimeout(()=>{t.textContent=old;delete a.dataset.flash},1500)};
 a.addEventListener('click',flash);a.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')flash(e)});}
function render(){
 const box=document.getElementById('app-nav');if(!box||box.childElementCount)return;
 const nav=el('nav','nav-tabs',{'aria-label':'관리 화면'});
 for(const [href,name,iconName,desc,ready=true] of PAGES){const a=link(href,name,iconName,desc,'nav-tab');if(!ready)soon(a);if(href===here())a.setAttribute('aria-current','page');nav.append(a)}
 const ext=EXTERNAL.map(([href,name,own,desc,aria])=>{const a=link(href,name,'external',desc,'nav-ext');a.firstChild.classList.add('nav-out');a.insertAdjacentHTML('afterbegin',icon(own).replace('nav-icon','nav-icon nav-own'));a.target='_blank';a.rel='noopener';a.setAttribute('aria-label',aria);return a;});
 box.replaceChildren(nav,...ext);
 extras();
}
// 화면별 부가 버튼(.topright 안의 보안 설정 현황·로그아웃 등)은 넓은 화면에서 맨 오른쪽 ⋯ 메뉴, 휴대폰 폭에서는 ☰ 사이드바 아래에 둔다.
// 원래 버튼의 id·hidden·클릭 동작은 그대로 두고, 사이드바에는 같은 이름의 줄을 만들어 원래 버튼을 누른다.
function extras(){
 const right=document.querySelector('.top .topright');if(!right||right.querySelector('.nav-burger'))return;
 const items=[...right.querySelectorAll('button')];
 const wrap=el('div','nav-more'),btn=iconBtn('nav-more-btn','더 보기','more');
 btn.setAttribute('aria-haspopup','menu');btn.setAttribute('aria-expanded','false');btn.setAttribute('aria-controls','nav-menu');
 const menu=el('div','nav-menu',{id:'nav-menu',role:'menu'});menu.hidden=true;
 for(const b of items){b.classList.remove('ghost','secondary');b.classList.add('nav-menu-item');b.setAttribute('role','menuitem');menu.append(b)}
 const shown=()=>items.filter(b=>!b.hidden);
 const close=focus=>{if(menu.hidden)return;menu.hidden=true;btn.setAttribute('aria-expanded','false');if(focus)btn.focus()};
 btn.addEventListener('click',()=>{if(!menu.hidden)return close();menu.hidden=false;btn.setAttribute('aria-expanded','true');shown()[0]?.focus()});
 menu.addEventListener('click',e=>{if(e.target.closest('.nav-menu-item'))close()});
 menu.addEventListener('keydown',e=>{const list=shown(),i=list.indexOf(document.activeElement);
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();list[(i+(e.key==='ArrowDown'?1:list.length-1))%list.length]?.focus()}});
 document.addEventListener('keydown',e=>{if(e.key==='Escape')close(true)});
 document.addEventListener('click',e=>{if(!wrap.contains(e.target))close()});
 wrap.append(btn,menu);
 const drawer=sidebar(items);
 const sync=()=>{wrap.hidden=!shown().length;if(wrap.hidden)close();drawer.sync()};
 new MutationObserver(sync).observe(menu,{subtree:true,attributes:true,attributeFilter:['hidden']});
 right.replaceChildren(wrap,drawer.burger);document.body.append(drawer.dialog);sync();
}
// ☰ 사이드바(휴대폰 폭): 오른쪽에서 열리는 서랍. 수업 관리 ☰ 서랍과 같은 모양. 바깥·✕·Esc·뒤로가기로 닫힌다.
function sidebar(items){
 const burger=iconBtn('nav-burger','메뉴','menu');burger.setAttribute('aria-haspopup','dialog');burger.setAttribute('aria-controls','nav-drawer');
 const d=el('dialog','nav-drawer',{id:'nav-drawer','aria-labelledby':'nav-drawer-title'});
 const head=el('div','nav-dr-head'),h=el('h2','',{id:'nav-drawer-title'});h.textContent='메뉴';const x=iconBtn('nav-dr-x','닫기','x');head.append(h,x);
 const group=(label,rows)=>{const g=el('div','nav-dr-group'),t=el('p','nav-dr-label');t.textContent=label;g.append(t,...rows);return g};
 const pages=PAGES.map(([href,name,iconName,desc,ready=true])=>{
  if(!ready){const r=el('div','nav-dr-item nav-soon',{'aria-disabled':'true',title:desc});r.innerHTML=icon(iconName);const t=el('span');t.textContent=name;const s=el('small');s.textContent='준비 중';r.append(t,s);return r}
  const a=link(href,name,iconName,desc,'nav-dr-item');a.removeAttribute('aria-label');if(href===here())a.setAttribute('aria-current','page');
  a.addEventListener('click',e=>{if(href===here()){e.preventDefault();hide();return}e.preventDefault();hide(()=>location.assign(href))});return a});
 const ext=EXTERNAL.map(([href,name,own,desc,aria])=>{const a=link(href,name,own,desc,'nav-dr-item');a.setAttribute('aria-label',aria);a.target='_blank';a.rel='noopener';a.insertAdjacentHTML('beforeend',icon('external').replace('nav-icon','nav-icon nav-out'));a.addEventListener('click',()=>hide());return a});
 const acts=items.map(b=>{const r=el('button','nav-dr-item',{type:'button'});r.textContent=b.textContent;r.addEventListener('click',()=>hide(()=>b.click()));return [b,r]});
 const actGroup=el('div','nav-dr-group');actGroup.append(...acts.map(([,r])=>r));
 const inner=el('div','nav-dr-in');inner.append(head,group('관리 화면',pages),group('새 탭에서 열기',ext));if(acts.length)inner.append(actGroup);d.append(inner);
 // 뒤로가기로 닫히도록 열 때 기록을 하나 쌓는다. 닫을 때는 그 기록을 되돌리고(history.back), 다 닫힌 뒤 할 일(then)을 한다.
 let then=null;
 const open=()=>{if(d.open)return;d.showModal();history.pushState({hadaNavDrawer:1},'');x.focus()};
 const hide=fn=>{then=fn||null;if(!d.open){run();return}if(history.state&&history.state.hadaNavDrawer)history.back();else{d.close();run()}};
 const run=()=>{const f=then;then=null;if(f)f()};
 window.addEventListener('popstate',()=>{if(d.open){d.close();burger.focus()}run()});
 burger.addEventListener('click',open);x.addEventListener('click',()=>hide());
 d.addEventListener('cancel',e=>{e.preventDefault();hide()});
 d.addEventListener('click',e=>{if(e.target===d)hide()}); // 바깥(어두운 부분) 누르기. 안쪽은 .nav-dr-in이 서랍 전체를 채운다
 PHONE.addEventListener('change',()=>{if(!PHONE.matches&&d.open)hide()});
 return {burger,dialog:d,sync:()=>{for(const [b,r] of acts)r.hidden=b.hidden;actGroup.hidden=!acts.some(([b])=>!b.hidden)}};
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',render);else render();
})();
