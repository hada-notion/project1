// End-to-end handler test with every network boundary mocked; never writes real Notion/Supabase.
import { reconcileDeadline } from "../_shared/assignmentDeadline.ts"
function assert(v: unknown,msg="assertion failed"){if(!v)throw new Error(msg)}
for(const [name,value] of Object.entries({ADMIN_SECRET:"test-only",SB_URL:"https://mock.supabase",NOTION_TOKEN:"mock",DATA_SOURCE_TIMETABLE_ID:"timetables",DATA_SOURCE_CLASS_SESSION_ID:"sessions",DATA_SOURCE_CLASS_ID:"classes",DATA_SOURCE_ATTENDANCE_ID:"attendance",DATA_SOURCE_REGISTRATION_ID:"registrations",DATA_SOURCE_SCHEDULE_EVENT_ID:"events",DATA_SOURCE_STUDY_ACTIVITY_ID:"activities"}))Deno.env.set(name,value)
let handler: (r:Request)=>Promise<Response>
const serve=Deno.serve;(Deno as any).serve=(h:any)=>{handler=h;return {}}
await import("./index.ts");(Deno as any).serve=serve
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
   if(db==="activities"){const reg=body.filter.and[0].relation.contains;return result([pages["task-"+reg]])}
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
Deno.test("실제 버튼 핸들러: 월수금 날짜순 생성·학생별 백필·역순 워커 실행·재실행 검증",async()=>{
 const f=mock(),originalFetch=globalThis.fetch;globalThis.fetch=f.fetch as typeof fetch;(globalThis as any).EdgeRuntime={waitUntil:(p:Promise<unknown>)=>f.tasks.push(p)}
 try{
  const unauth=await handler(new Request("https://mock.supabase/functions/v1/generate-classes?mode=bulk",{method:"POST",body:"{}"}));assert(unauth.status===401&&f.created.length===0)
  const response=await handler(new Request("https://mock.supabase/functions/v1/generate-classes?mode=bulk",{method:"POST",headers:{"x-admin-key":"test-only"},body:JSON.stringify({id:"menu"})}));assert(response.status===202);await f.drain()
  const sessions=f.created.filter(p=>p.db==="sessions");assert(sessions.map(p=>p.properties["수업일시"].date.start.slice(0,10)).join()==="2026-10-12,2026-10-14,2026-10-16","wrong order "+JSON.stringify(sessions));assert(f.pages.menu.properties["상태"].select.name==="✅ 완료")
  const attends=f.created.filter(p=>p.db==="attendance");assert(attends.length===6)
  for(const p of attends)assert(p.properties["과제마감 백필 대상"].relation.map((r:any)=>r.id).join()==="task-"+p.properties["등록"].relation[0].id,"cross-student queue target")
  // Execute the same policy used by the actual worker against all attendance pages now present.
  const io={getPage:async(id:string)=>structuredClone(f.pages[id]),activityDb:"activities",attendanceDb:"attendance",query:async(_db:string,b:any)=>({results:attends.filter(p=>p.properties["등록"].relation[0].id===b.filter.and[0].relation.contains&&Date.parse(p.properties["수업일시"].date.start)>Date.parse(b.filter.and[1].date.after)).sort((a,b)=>Date.parse(a.properties["수업일시"].date.start)-Date.parse(b.properties["수업일시"].date.start)),has_more:false}),update:async(id:string,props:any)=>Object.assign(f.pages[id].properties,props)}
  for(const p of [...attends].reverse())for(const target of p.properties["과제마감 백필 대상"].relation)await reconcileDeadline(io,target.id,p.id)
  for(const id of ["a","b"]){const deadline=f.pages[f.pages["task-"+id].properties["과제 마감"].relation[0].id];assert(deadline.properties["등록"].relation[0].id===id && deadline.properties["수업일시"].date.start.startsWith("2026-10-12"))}
  const before=f.created.length;await handler(new Request("https://mock.supabase/functions/v1/generate-classes?mode=bulk",{method:"POST",headers:{"x-admin-key":"test-only"},body:JSON.stringify({isContinuation:true,menuPageId:"menu",horizonDate:"2026-10-18",chainStartedAt:Date.now(),bulkPlan:[]})}));await f.drain();assert(f.created.length===before)
 }finally{globalThis.fetch=originalFetch;delete(globalThis as any).EdgeRuntime}
})
