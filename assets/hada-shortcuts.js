'use strict';
// 공용 바로가기 목록 (docs/DESIGN.md "바로가기"). 화면을 추가하면 이 목록 하나만 고친다.
// 페이지에 #open-links 버튼과 #links-dialog(.link-list, #close-links)가 있으면 지금 화면을 뺀 목록을 채운다.
(() => {
const ICONS={
 settings:'<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"></path><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',
 kiosk:'<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>',
 legal:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="13" y2="17"></line>',
 school:'<circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>',
};
const PAGES=[
 ['admin_settings.html','관리자 설정','settings','관리자 비밀번호 변경과 Notion 웹훅 키 교체를 합니다.'],
 ['attendance_kiosk.html','출결 키오스크','kiosk','학원 입구 태블릿에서 전화번호로 등원·하원을 체크합니다.'],
 ['legal_documents.html','법정 서류 출력','legal','출석부·원부·영수증 서식을 기간별로 조회하고 출력합니다.'],
 ['school_search.html','학교 검색·연결','school','나이스에서 학교를 찾아 연결합니다. Notion 학교 페이지의 "학교 검색" 링크로 열면 그 학교가 자동 선택됩니다.'],
];
function render(){
 const dialog=document.getElementById('links-dialog'),list=dialog&&dialog.querySelector('.link-list');if(!list)return;
 const here=location.pathname.split('/').pop()||'index.html';list.replaceChildren();
 for(const [href,name,icon,desc] of PAGES){
  if(href===here)continue;
  const li=document.createElement('li'),a=document.createElement('a');a.className='link-card';a.href=href;a.target='_blank';a.rel='noopener';
  const ic=document.createElement('span');ic.className='link-icon';ic.innerHTML=`<svg class="line" viewBox="0 0 24 24" aria-hidden="true">${ICONS[icon]}</svg>`;
  const tx=document.createElement('span');tx.className='link-text';const st=document.createElement('strong');st.textContent=name+' ↗';const sp=document.createElement('span');sp.textContent=desc;tx.append(st,sp);
  a.append(ic,tx);li.append(a);list.append(li);
 }
 const open=document.getElementById('open-links'),close=document.getElementById('close-links');
 if(open)open.addEventListener('click',()=>dialog.showModal());
 if(close)close.addEventListener('click',()=>dialog.close());
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',render);else render();
})();
