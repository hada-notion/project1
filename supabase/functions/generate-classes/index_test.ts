// End-to-end handler test with every network boundary mocked; never writes real Notion/Supabase.
import { reconcileDeadline } from "../_shared/assignmentDeadline.ts"
function assert(v: unknown,msg="assertion failed"){if(!v)throw new Error(msg)}
for(const [name,value] of Object.entries({ADMIN_SECRET:"test-only",SB_URL:"https://mock.supabase",SB_SERVICE_ROLE_KEY:"test-only",NOTION_TOKEN:"mock",DATA_SOURCE_TIMETABLE_ID:"timetables",DATA_SOURCE_CLASS_SESSION_ID:"sessions",DATA_SOURCE_CLASS_ID:"classes",DATA_SOURCE_ATTENDANCE_ID:"attendance",DATA_SOURCE_REGISTRATION_ID:"registrations",DATA_SOURCE_SCHEDULE_EVENT_ID:"events",DATA_SOURCE_STUDY_ACTIVITY_ID:"activities"}))Deno.env.set(name,value)
let handler: (r:Request)=>Promise<Response>
const serve=Deno.serve;(Deno as any).serve=(h:any)=>{handler=h;return {}}
await import("./index.ts");const { processFixAttendanceQueueItem } = await import("../_shared/fixAttendanceTarget.ts");(Deno as any).serve=serve
const rel=(id?:string)=>({relation:id?[{id}]:[]})
const txt=(s:string)=>({rich_text:[{plain_text:s,text:{content:s}}]})
function mock(){
 const tasks:Promise<unknown>[]=[]; const pages:any={menu:{id:"menu",properties:{"상태":{select:{name:"⚪ 대기"}}}},class:{id:"class",properties:{"클래스명":{title:[{plain_text:"Mock Class"}]},"담당강사":rel("teacher")}}}
 const timetables=[{id:"fri",day:"금",date:"2026-10-09"},{id:"wed",day:"수",date:"2026-10-07"},{id:"mon",day:"월",date:"2026-10-05"}].map(t=>{const p={id:t.id,properties:{"클래스":rel("class"),"요일":{select:{name:t.day}},"등원시간(HH:mm)":txt("20:00"),"하원시간(HH:mm)":txt("21:00"),"상태":{select:{name:"⚪ 대기"}}}};pages[t.id]=p;pages["old-"+t.id]={id:"old-"+t.id,db:"sessions",properties:{"시간표":rel(t.id),"수업일시":{date:{start:t.date+"T20:00:00+09:00"}},"학습기록":rel("record")}};return p})
 pages.record={id:"record",properties:{"구분":{select:{name:"과제"}},"등록":{relation:[{id:"a"},{id:"b"}]}}}
 for(const id of ["a","b"]){pages["source-"+id]={id:"source-"+id,db:"attendance",properties:{"등록":rel(id),"수업일시":{date:{start:"2026-10-09T20:00:00+09:00"}},"수업":rel("old-fri")}};pages["task-"+id]={id:"task-"+id,db:"activities",properties:{"등록":rel(id),"출석":rel("source-"+id),"학습기록":rel("record"),"과제상태":{select:{name:"🔴 미제출"}},"과제 마감":rel(),"자동 마감 기준":rel()}}}
 const created:any[]=[],calls:any[]=[]
 const result=(results:any[])=>new Response(JSON.stringify({results,has_more:false}),{status:200})
 const fetch=async(input:any,init:any={})=>{
  const url=String(input),body=init.body?JSON.parse(init.body):{};calls.push({url,body})
  if(url.includes("/functions/v1/generate-classes"))return await handler(new Request(url,{...init}))
  if(url.startsWith("https://mock.supabase"))return new Response("{}",{status:202})
  const db=url.match(/\/data_sources\/([^/]+)\/query/)?.[1]
  if(db){
   if(db==="timetables")return result(timetables)
   if(db==="sessions"){const tid=body.filter.relation.contains;return result(Object.values(pages).filter((p:any)=>p.db==="sessions"&&p.properties["시간표"].relation[0].id===tid).sort((a:any,b:any)=>b.properties["수업일시"].date.start.localeCompare(a.properties["수업일시"].date.start)).slice(0,1))}
   if(db==="events")return result([])
   if(db==="registrations")return result(["a","b"].map(id=>({id,properties:{}})))
   if(db==="activities"){const f0=body.filter.and[0];const regs=f0.or?f0.or.map((x:any)=>x.relation.contains):[f0.relation.contains];return result(regs.map((r:string)=>pages["task-"+r]).filter(Boolean))}
   if(db==="attendance")return result([])
   throw new Error("unknown mock database "+db)
  }
  const id=url.match(/\/pages\/([^/?]+)/)?.[1]
  if(id){assert(pages[id],"missing page "+id);if(init.method==="PATCH")Object.assign(pages[id].properties,body.properties);return new Response(JSON.stringify(pages[id]))}
  if(url.endsWith("/pages")&&init.method==="POST"){const page={id:"new-"+created.length,db:body.parent.data_source_id,properties:body.properties};pages[page.id]=page;created.push(page);return new Response(JSON.stringify(page))}
  throw new Error("unmocked request "+url)
 }
 return {pages,created,calls,fetch,tasks,drain:async()=>{for(let i=0;i<tasks.length;i++){assert(i<100,"chain did not stop");await tasks[i]}}}
}
Deno.test("실제 버튼 핸들러: 월수금 날짜순 수업 생성 → 출석 조정 큐 → 학생별 출석·백필·역순 워커·재실행 검증",async()=>{
 const f=mock(),originalFetch=globalThis.fetch;globalThis.fetch=f.fetch as typeof fetch;(globalThis as any).EdgeRuntime={waitUntil:(p:Promise<unknown>)=>f.tasks.push(p)}
 try{
  const unauth=await handler(new Request("https://mock.supabase/functions/v1/generate-classes?mode=bulk",{method:"POST",body:"{}"}));assert(unauth.status===401&&f.created.length===0)
  const response=await handler(new Request("https://mock.supabase/functions/v1/generate-classes?mode=bulk",{method:"POST",headers:{"x-admin-key":"test-only"},body:JSON.stringify({id:"menu"})}));assert(response.status===202);await f.drain()
  const sessions=f.created.filter(p=>p.db==="sessions");assert(sessions.map(p=>p.properties["수업일시"].date.start.slice(0,10)).join()==="2026-10-12,2026-10-14,2026-10-16","wrong order "+JSON.stringify(sessions));assert(f.pages.menu.properties["상태"].select.name==="✅ 완료")
  // v2.6.12: 수업추가는 수업만 명단과 함께 만들고(완료 상태) 출석은 만들지 않는다. 수업마다 출석 조정 큐에 한 건.
  assert(f.created.filter(p=>p.db==="attendance").length===0,"no attendance from generate-classes")
  assert(sessions.every(p=>p.properties["등록"].relation.map((r:any)=>r.id).join()==="a,b"&&p.properties["생성 상태"].select.name==="✅ 완료"))
  const queued=f.calls.filter(c=>c.url.endsWith("/rest/v1/sync_queue")).map(c=>c.body[0]);assert(queued.length===3&&queued.every(q=>q.target==="fix-attendance")&&queued.map(q=>q.payload.pageId).join()===sessions.map(p=>p.id).join(),JSON.stringify(queued))
  // 워커: Notion이 계산한 "출석 조정 정보"(명단 a,b 모두 출석 없음)를 수업 페이지에 두고 큐를 처리한다.
  for(const p of sessions)p.properties["출석 조정 정보"]={type:"formula",formula:{type:"string",string:JSON.stringify({v:1,day:p.properties["수업일시"].date.start.slice(0,10),add:[{reg:"a",att:"",rec:[]},{reg:"b",att:"",rec:[]}],del:[]})}}
  for(const q of queued)await processFixAttendanceQueueItem(q.payload)
  const attends=f.created.filter(p=>p.db==="attendance");assert(attends.length===6)
  assert(sessions.every(p=>p.properties["출석 조정 상태"].select.name==="✅ 완료"))
  // 대기 과제는 수업마다 한 번에 조회(학생마다 조회하지 않음)
  assert(f.calls.filter(c=>c.url.includes("/data_sources/activities/query")).length===3,"one deadline query per session")
  for(const p of attends)assert(p.properties["과제마감 백필 대상"].relation.map((r:any)=>r.id).join()==="task-"+p.properties["등록"].relation[0].id,"cross-student queue target")
  // Execute the same policy used by the actual worker against all attendance pages now present.
  const io={getPage:async(id:string)=>structuredClone(f.pages[id]),activityDb:"activities",attendanceDb:"attendance",query:async(_db:string,b:any)=>({results:attends.filter(p=>p.properties["등록"].relation[0].id===b.filter.and[0].relation.contains&&Date.parse(p.properties["수업일시"].date.start)>Date.parse(b.filter.and[1].date.after)).sort((a,b)=>Date.parse(a.properties["수업일시"].date.start)-Date.parse(b.properties["수업일시"].date.start)),has_more:false}),update:async(id:string,props:any)=>Object.assign(f.pages[id].properties,props)}
  for(const p of [...attends].reverse())for(const target of p.properties["과제마감 백필 대상"].relation)await reconcileDeadline(io,target.id,p.id)
  for(const id of ["a","b"]){const deadline=f.pages[f.pages["task-"+id].properties["과제 마감"].relation[0].id];assert(deadline.properties["등록"].relation[0].id===id && deadline.properties["수업일시"].date.start.startsWith("2026-10-12"))}
  const before=f.created.length;await handler(new Request("https://mock.supabase/functions/v1/generate-classes?mode=bulk",{method:"POST",headers:{"x-admin-key":"test-only"},body:JSON.stringify({isContinuation:true,menuPageId:"menu",horizonDate:"2026-10-18",chainStartedAt:Date.now(),bulkPlan:[]})}));await f.drain();assert(f.created.length===before)
 }finally{globalThis.fetch=originalFetch;delete(globalThis as any).EdgeRuntime}
})
Deno.test("v2.6.12 시간표 자동화: queue는 큐에만 넣고, 워커는 기준일 수식 날짜로 수업 1개를 끝까지 기다려 만든다",async()=>{
 const f=mock(),originalFetch=globalThis.fetch;globalThis.fetch=f.fetch as typeof fetch;(globalThis as any).EdgeRuntime={waitUntil:(p:Promise<unknown>)=>f.tasks.push(p)}
 try{
  const { processGenerateClassesQueueItem } = await import("../_shared/generateClassesQueue.ts")
  const q=await handler(new Request("https://mock.supabase/functions/v1/generate-classes/queue",{method:"POST",headers:{"x-admin-key":"test-only"},body:JSON.stringify({source:{type:"automation"},data:{object:"page",id:"mon",properties:{}}})}))
  assert(q.status===202)
  const enq=f.calls.filter(c=>c.url.endsWith("/rest/v1/sync_queue")).map(c=>c.body[0]);assert(enq.length===1&&enq[0].target==="generate-classes"&&enq[0].payload.timetableId==="mon",JSON.stringify(enq))
  assert(!f.calls.some(c=>c.url.includes("api.notion.com")),"queue reads nothing")
  // 시간표 수식 기준일(휴원을 건너뛴 날짜라고 가정) → 그 날짜로 만든다
  f.pages.mon.properties["기준일"]={type:"formula",formula:{type:"date",date:{start:"2026-10-19"}}}
  const before=f.calls.length
  await processGenerateClassesQueueItem({timetableId:"mon"})
  const used=f.calls.slice(before).filter(c=>c.url.includes("/data_sources/"))
  assert(!used.some(c=>c.url.includes("/data_sources/sessions/")||c.url.includes("/data_sources/events/")),"no latest-session / closure query with 기준일")
  const s=f.created.filter(p=>p.db==="sessions");assert(s.length===1&&s[0].properties["수업일시"].date.start.startsWith("2026-10-19T20:00"),JSON.stringify(s.map(p=>p.properties["수업일시"])))
  assert(f.pages.mon.properties["상태"].select.name==="✅ 완료")
  assert(f.calls.filter(c=>c.url.endsWith("/rest/v1/sync_queue")).at(-1).body[0].target==="fix-attendance","attendance via fix-attendance queue")
 }finally{globalThis.fetch=originalFetch;delete(globalThis as any).EdgeRuntime}
})
Deno.test("v2.6.12 메뉴 일괄 생성(기준일): 가장 이른 빈 주만, 시간표 DB 한 번 조회로 큐에 넣고 워커가 하나씩 만든다",async()=>{
 const f=mock(),originalFetch=globalThis.fetch;globalThis.fetch=f.fetch as typeof fetch;(globalThis as any).EdgeRuntime={waitUntil:(p:Promise<unknown>)=>f.tasks.push(p)}
 try{
  const { processGenerateClassesQueueItem } = await import("../_shared/generateClassesQueue.ts")
  const base=(d:string)=>({type:"formula",formula:{type:"date",date:{start:d}}})
  // 월 10/26, 금 10/30은 같은 주(10/26~11/1), 수는 휴원으로 11/4 → 이번에는 빠진다
  f.pages.mon.properties["기준일"]=base("2026-10-26");f.pages.wed.properties["기준일"]=base("2026-11-04");f.pages.fri.properties["기준일"]=base("2026-10-30")
  const r=await handler(new Request("https://mock.supabase/functions/v1/generate-classes?mode=bulk",{method:"POST",headers:{"x-admin-key":"test-only"},body:JSON.stringify({id:"menu"})}));assert(r.status===202);await f.drain()
  const enq=f.calls.filter(c=>c.url.endsWith("/rest/v1/sync_queue")).map(c=>c.body[0])
  assert(enq.map(q=>q.target+":"+q.payload.timetableId).join()==="generate-classes:mon,generate-classes:fri",JSON.stringify(enq))
  assert(!f.calls.some(c=>c.url.includes("/data_sources/sessions/")||c.url.includes("/data_sources/events/")),"no per-timetable latest/closure queries")
  assert(f.calls.filter(c=>c.url.includes("/data_sources/timetables/")).length===1,"one timetable query")
  assert(f.pages.menu.properties["상태"].select.name==="✅ 완료"&&f.created.length===0)
  for(const q of enq)await processGenerateClassesQueueItem(q.payload)
  const days=f.created.filter(p=>p.db==="sessions").map(p=>p.properties["수업일시"].date.start.slice(0,10));assert(days.join()==="2026-10-26,2026-10-30",days.join())
 }finally{globalThis.fetch=originalFetch;delete(globalThis as any).EdgeRuntime}
})
Deno.test("v2.6.13 큐 재시도: 기준일이 이미 지났으면(앞선 시도가 만든 것) 수업을 또 만들지 않는다",async()=>{
 const f=mock(),originalFetch=globalThis.fetch;globalThis.fetch=f.fetch as typeof fetch;(globalThis as any).EdgeRuntime={waitUntil:(p:Promise<unknown>)=>f.tasks.push(p)}
 try{
  const { processGenerateClassesQueueItem } = await import("../_shared/generateClassesQueue.ts")
  f.pages.mon.properties["기준일"]={type:"formula",formula:{type:"date",date:{start:"2026-10-26"}}}
  await processGenerateClassesQueueItem({timetableId:"mon",date:"2026-10-19"})
  assert(f.created.filter(p=>p.db==="sessions").length===0,"skipped");assert(f.pages.mon.properties["상태"].select.name==="✅ 완료")
  await processGenerateClassesQueueItem({timetableId:"mon",date:"2026-10-26"})
  assert(f.created.filter(p=>p.db==="sessions").length===1,"made when dates match")
 }finally{globalThis.fetch=originalFetch;delete(globalThis as any).EdgeRuntime}
})
const U=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`
const planText=(o:any)=>({type:"formula",formula:{type:"string",string:JSON.stringify({v:1,start:"20:00",end:"21:00",name:"중1 A",tch:[U(9)],reg:[U(1),U(2)],...o})}})
Deno.test("v2.6.14 수업 추가 정보 해석: 형식·기준일·클래스가 맞을 때만 쓴다",async()=>{
 const { sessionPlanFromTimetable, sessionPlanFromText, sessionTitle } = await import("../_shared/timetableSessionPlan.ts")
 const base=(d:string)=>({type:"formula",formula:{type:"date",date:{start:d}}})
 const ok={"클래스":rel(U(7)),"기준일":base("2026-10-26"),"수업 추가 정보":planText({date:"2026-10-26",cls:U(7)})}
 const p=sessionPlanFromTimetable(ok);assert(p&&p.date==="2026-10-26"&&p.regIds.length===2&&p.teacherIds[0]===U(9)&&p.className==="중1 A",JSON.stringify(p))
 assert(!sessionPlanFromTimetable({...ok,"기준일":base("2026-11-02")}),"기준일과 날짜가 다르면 안 씀")
 assert(!sessionPlanFromTimetable({...ok,"클래스":rel(U(8))}),"클래스가 다르면 안 씀")
 assert(!sessionPlanFromText('{"v":1,"date":"2026-10-26","cls":"x","reg":[]}'),"id 형식 오류")
 assert(!sessionPlanFromText('{"v":1,"date":"10/26","cls":"'+U(7)+'","reg":[]}'),"날짜 형식 오류")
 assert(!sessionPlanFromText("")&&!sessionPlanFromText("not json"))
 assert(sessionPlanFromText('{"v":1,"date":"2026-10-26","cls":"'+U(7).replace(/-/g,"")+'","reg":[]}')?.regIds.length===0,"하이픈 없는 id·빈 명단 허용")
 assert(sessionTitle("중1 A","2026-10-26")==="중1 A 10.26(월)")
})
Deno.test("v2.6.14 메뉴 일괄 생성 + 수업 추가 정보: 큐 항목에 값을 담고, 워커는 Notion 호출 1번(만들기)으로 수업을 만든다",async()=>{
 const f=mock(),originalFetch=globalThis.fetch;globalThis.fetch=f.fetch as typeof fetch;(globalThis as any).EdgeRuntime={waitUntil:(p:Promise<unknown>)=>f.tasks.push(p)}
 try{
  const { processGenerateClassesQueueItem } = await import("../_shared/generateClassesQueue.ts")
  const base=(d:string)=>({type:"formula",formula:{type:"date",date:{start:d}}})
  for(const [id,d] of [["mon","2026-10-26"],["wed","2026-11-04"],["fri","2026-10-30"]]){f.pages[id].properties["클래스"]=rel(U(7));f.pages[id].properties["기준일"]=base(d);f.pages[id].properties["수업 추가 정보"]=planText({date:d,cls:U(7)})}
  const r=await handler(new Request("https://mock.supabase/functions/v1/generate-classes?mode=bulk",{method:"POST",headers:{"x-admin-key":"test-only"},body:JSON.stringify({id:"menu"})}));assert(r.status===202);await f.drain()
  const enq=f.calls.filter(c=>c.url.endsWith("/rest/v1/sync_queue")).map(c=>c.body[0])
  assert(enq.length===2&&enq.every(q=>q.payload.plan&&q.payload.plan.date===q.payload.date),JSON.stringify(enq))
  const before=f.calls.length
  for(const q of enq)await processGenerateClassesQueueItem(q.payload)
  const notion=f.calls.slice(before).filter(c=>c.url.includes("api.notion.com"))
  assert(notion.length===2&&notion.every(c=>c.url.endsWith("/pages")),"one create per timetable: "+notion.map(c=>c.url).join())
  assert(!f.calls.slice(before).some(c=>c.url.includes("/functions/v1/generate-classes")),"no HTTP hop to generate-classes")
  const s=f.created.filter(p=>p.db==="sessions")
  assert(s.map(p=>p.properties["이름"].title[0].text.content).join()==="중1 A 10.26(월),중1 A 10.30(금)",JSON.stringify(s.map(p=>p.properties["이름"])))
  assert(s[0].properties["수업일시"].date.start==="2026-10-26T20:00:00+09:00"&&s[0].properties["수업일시"].date.end==="2026-10-26T21:00:00+09:00")
  assert(s.every(p=>p.properties["등록"].relation.map((x:any)=>x.id).join()===U(1)+","+U(2)&&p.properties["담당강사"].relation[0].id===U(9)&&p.properties["클래스"].relation[0].id===U(7)&&p.properties["생성 상태"].select.name==="✅ 완료"))
  assert(s[0].properties["시간표"].relation[0].id==="mon")
  const fix=f.calls.slice(before).filter(c=>c.url.endsWith("/rest/v1/sync_queue")).map(c=>c.body[0]);assert(fix.length===2&&fix.every(q=>q.target==="fix-attendance"),JSON.stringify(fix))
  assert(f.pages.mon.properties["상태"].select.name==="⚪ 대기","timetable status untouched")
 }finally{globalThis.fetch=originalFetch;delete(globalThis as any).EdgeRuntime}
})
Deno.test("v2.6.14 수업 추가 정보로 만들기 실패: 같은 값으로 다시 하지 않고 시간표를 새로 읽는 항목으로 넣는다",async()=>{
 const f=mock(),originalFetch=globalThis.fetch
 globalThis.fetch=(async(input:any,init:any={})=>{if(String(input).endsWith("/v1/pages")&&init.method==="POST")return new Response("bad gateway",{status:502});return f.fetch(input,init)}) as typeof fetch
 try{
  const { processGenerateClassesQueueItem } = await import("../_shared/generateClassesQueue.ts")
  const { sessionPlanFromText } = await import("../_shared/timetableSessionPlan.ts")
  const plan=sessionPlanFromText(planText({date:"2026-10-26",cls:U(7)}).formula.string)!
  await processGenerateClassesQueueItem({timetableId:"mon",date:"2026-10-26",plan})
  const enq=f.calls.filter(c=>c.url.endsWith("/rest/v1/sync_queue")).map(c=>c.body[0])
  assert(enq.length===1&&enq[0].target==="generate-classes"&&enq[0].payload.timetableId==="mon"&&enq[0].payload.date==="2026-10-26"&&!enq[0].payload.plan,JSON.stringify(enq))
 }finally{globalThis.fetch=originalFetch}
})
Deno.test("v2.6.14 버튼·재시도 경로(시간표를 읽음): 수업 추가 정보가 있으면 클래스 읽기·등록 조회를 건너뛴다",async()=>{
 const f=mock(),originalFetch=globalThis.fetch;globalThis.fetch=f.fetch as typeof fetch;(globalThis as any).EdgeRuntime={waitUntil:(p:Promise<unknown>)=>f.tasks.push(p)}
 try{
  const { processGenerateClassesQueueItem } = await import("../_shared/generateClassesQueue.ts")
  f.pages.mon.properties["클래스"]=rel(U(7));f.pages.mon.properties["기준일"]={type:"formula",formula:{type:"date",date:{start:"2026-10-26"}}};f.pages.mon.properties["수업 추가 정보"]=planText({date:"2026-10-26",cls:U(7)})
  const before=f.calls.length
  await processGenerateClassesQueueItem({timetableId:"mon",date:"2026-10-26"})
  const used=f.calls.slice(before).filter(c=>c.url.includes("api.notion.com"))
  assert(!used.some(c=>c.url.includes("/data_sources/")||c.url.includes("/pages/class")),"no registration query / class read: "+used.map(c=>c.url).join())
  const s=f.created.filter(p=>p.db==="sessions");assert(s.length===1&&s[0].properties["등록"].relation.length===2&&s[0].properties["이름"].title[0].text.content==="중1 A 10.26(월)")
 }finally{globalThis.fetch=originalFetch;delete(globalThis as any).EdgeRuntime}
})
Deno.test("v2.6.14 generate-classes/queue: 자동화 본문에 수업추가 정보가 오면 큐 항목에 담는다",async()=>{
 const f=mock(),originalFetch=globalThis.fetch;globalThis.fetch=f.fetch as typeof fetch;(globalThis as any).EdgeRuntime={waitUntil:(p:Promise<unknown>)=>f.tasks.push(p)}
 try{
  const props={"클래스":rel(U(7)),"기준일":{type:"formula",formula:{type:"date",date:{start:"2026-10-26"}}},"수업 추가 정보":planText({date:"2026-10-26",cls:U(7)})}
  const q=await handler(new Request("https://mock.supabase/functions/v1/generate-classes/queue",{method:"POST",headers:{"x-admin-key":"test-only"},body:JSON.stringify({source:{type:"automation"},data:{object:"page",id:"mon",properties:props}})}))
  assert(q.status===202)
  const enq=f.calls.filter(c=>c.url.endsWith("/rest/v1/sync_queue")).map(c=>c.body[0]);assert(enq.length===1&&enq[0].payload.plan?.date==="2026-10-26"&&enq[0].payload.date==="2026-10-26",JSON.stringify(enq))
 }finally{globalThis.fetch=originalFetch;delete(globalThis as any).EdgeRuntime}
})
