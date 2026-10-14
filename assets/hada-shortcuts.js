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
};
// [주소, 메뉴 이름, 아이콘, 설명(마우스를 올리면 보임), 휴대폰 폭(700px 이하)에서 보이는 짧은 이름]. 새 탭 메뉴는 넓은 화면에서 ↗와 이름, 폰 폭에서는 각자의 아이콘만 보인다.
const PAGES=[
 ['admin_settings.html','관리자 설정','settings','관리자 비밀번호 변경과 Notion 웹훅 키 교체','설정'],
 ['legal_documents.html','법정 서류','legal','출석부·원부·영수증 서식을 기간별로 조회하고 출력','서류'],
 ['school_search.html','학교 검색','school','나이스에서 학교를 찾아 Notion 학교 페이지와 연결','학교'],
 ['library.html','라이브러리','book','교재를 시리즈별로 보고, 찾아서 추가','라이브러리'],
];
const EXTERNAL=[
 ['attendance_kiosk.html','키오스크','check','학원 입구 태블릿에서 전화번호로 등원·하원 체크(새 탭)','출결 키오스크(새 탭에서 열림)'],
 ['class_room.html','수업 관리','edit','선생님이 수업별 출석·과제·학습기록을 관리(새 탭)','수업 관리(새 탭에서 열림)'],
];
const icon=name=>`<svg class="line nav-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
function link(href,label,iconName,title,cls){const a=document.createElement('a');a.href=href;a.className=cls;a.title=title;a.innerHTML=icon(iconName);const t=document.createElement('span');t.className='nav-label';t.textContent=label;a.append(t);a.setAttribute('aria-label',label);return a}
function render(){
 const box=document.getElementById('app-nav');if(!box||box.childElementCount)return;
 const here=location.pathname.split('/').pop()||'index.html';
 const nav=document.createElement('nav');nav.className='nav-tabs';nav.setAttribute('aria-label','관리 화면');
 for(const [href,name,iconName,desc,short] of PAGES){const a=link(href,name,iconName,desc,'nav-tab');const s=document.createElement('span');s.className='nav-short';s.textContent=short;s.setAttribute('aria-hidden','true');a.append(s);if(href===here)a.setAttribute('aria-current','page');nav.append(a)}
 const ext=EXTERNAL.map(([href,name,own,desc,aria])=>{const a=link(href,name,'external',desc,'nav-ext');a.firstChild.classList.add('nav-out');a.insertAdjacentHTML('afterbegin',icon(own).replace('nav-icon','nav-icon nav-own'));a.target='_blank';a.rel='noopener';a.setAttribute('aria-label',aria);return a;});
 box.replaceChildren(nav,...ext);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',render);else render();
})();
