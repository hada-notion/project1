import { automaticDeadlineAllowed, pendingDeadlineActivities, reconcileDeadline, findNextDeadline, AUTO_DEADLINE_PROP, type DeadlineIO } from "./assignmentDeadline.ts"
function assert(v: unknown, msg = "assertion failed") { if (!v) throw new Error(msg) }
const rel = (id?: string) => ({ relation: id ? [{ id }] : [] })
function attendance(id: string, reg: string, day: number) { return { id, properties: { "등록": rel(reg), "수업일시": { date: { start: `2026-10-${String(day).padStart(2,"0")}T20:00:00+09:00` } }, "삭제 체크": { checkbox: false } } } }
function fixture() {
 const pages: any = {
  source: attendance("source", "student-a", 9), fri: attendance("fri", "student-a", 16), mon: attendance("mon", "student-a", 12),
  wrong: attendance("wrong", "student-b", 12),
  record: { id: "record", properties: { "구분": { select: { name: "과제" } }, "등록": { relation: [{id:"student-b"}, {id:"student-a"}] } } },
  task: { id: "task", properties: { "등록": rel("student-a"), "출석": rel("source"), "학습기록": rel("record"), "과제 마감": rel(), [AUTO_DEADLINE_PROP]: rel(), "과제상태": { select: { name: "🔴 미제출" } } } },
 }
 const writes: any[] = [], queries: any[] = []
 let candidates = [pages.mon, pages.fri]
 const io: DeadlineIO = {
  getPage: async id => structuredClone(pages[id]),
  query: async (db, body: any) => { queries.push({db,body}); return { results: db === "attendance" ? candidates : [pages.task], has_more: false } },
  update: async (id, props) => { writes.push({id,props}); Object.assign(pages[id].properties,props); return pages[id] },
  attendanceDb: "attendance", activityDb: "activity",
 }
 return { io, pages, writes, queries, setCandidates: (p: any[]) => { candidates = p } }
}
Deno.test("빈 마감만 초기 자동화, 출처 없는 기존값 보존", () => {
 const {pages} = fixture(); assert(automaticDeadlineAllowed(pages.task)); pages.task.properties["과제 마감"] = rel("fri"); assert(!automaticDeadlineAllowed(pages.task))
})
Deno.test("자동 마감 marker 일치만 재계산, 수동 변경·삭제 보존", () => {
 const {pages} = fixture(); pages.task.properties[AUTO_DEADLINE_PROP] = rel("fri"); pages.task.properties["과제 마감"] = rel("fri"); assert(automaticDeadlineAllowed(pages.task)); pages.task.properties["과제 마감"] = rel("mon"); assert(!automaticDeadlineAllowed(pages.task)); pages.task.properties["과제 마감"] = rel(); assert(!automaticDeadlineAllowed(pages.task))
})
Deno.test("요일 무관 가까운 출석 조회, 삭제 제외·시간순 정렬", async () => {
 const {io,queries} = fixture(); assert(await findNextDeadline(io,"student-a","2026-10-09T20:00:00+09:00") === "mon"); const q=queries[0].body as any; assert(q.sorts[0].direction === "ascending" && q.filter.and[0].relation.contains === "student-a" && q.filter.and[2].checkbox.equals === false)
})
Deno.test("같은 학생 여부와 출제 이후 시간 검증", async () => {
 const f=fixture(); f.setCandidates([f.pages.wrong,f.pages.source,f.pages.mon]); assert(await findNextDeadline(f.io,"student-a","2026-10-09T20:00:00+09:00") === "mon")
})
Deno.test("다음 수업 없는 경우 날짜 임의 지정 없음", async () => { const f=fixture(); f.setCandidates([]); assert(await findNextDeadline(f.io,"student-a","2026-10-09T20:00:00+09:00") === null) })
Deno.test("금요일 트리거여도 이미 있는 월요일로 연결", async () => {
 const f=fixture(); assert(await reconcileDeadline(f.io,"task","fri") === "updated"); assert(f.writes[0].props["과제 마감"].relation[0].id === "mon" && f.writes[0].props[AUTO_DEADLINE_PROP].relation[0].id === "mon")
})
Deno.test("금 먼저 생성 후 월 생성: 자동값만 금→월 보정", async () => {
 const f=fixture(); f.setCandidates([f.pages.fri]); await reconcileDeadline(f.io,"task","fri"); assert(f.pages.task.properties["과제 마감"].relation[0].id === "fri"); f.setCandidates([f.pages.mon,f.pages.fri]); await reconcileDeadline(f.io,"task","mon"); assert(f.pages.task.properties["과제 마감"].relation[0].id === "mon" && f.writes.length === 2)
})
Deno.test("학습기록 첫 등록과 달라도 활동 자체의 학생으로 연결", async () => {
 const f=fixture(); await reconcileDeadline(f.io,"task","mon"); assert(f.queries[0].body.filter.and[0].relation.contains === "student-a")
})
Deno.test("다른 학생 출석으로 큐가 잘못 전달되면 쓰기 없음", async () => {
 const f=fixture(); assert(await reconcileDeadline(f.io,"task","wrong") === "invalid_source" && f.writes.length === 0)
})
Deno.test("출제 출석의 등록 불일치·잘못된 시간·삭제 출석 거부", async () => {
 for(const mode of ["owner","time","deleted"]){ const f=fixture(); if(mode==="owner") f.pages.source.properties["등록"]=rel("student-b"); if(mode==="time") f.pages.mon.properties["수업일시"].date.start="2026-10-08T20:00:00+09:00"; if(mode==="deleted")f.pages.source.archived=true; await reconcileDeadline(f.io,"task","mon"); assert(f.writes.length===0,mode) }
})
Deno.test("기존값 출처 미확인·제출·평가·수동 지정은 보존", async () => {
 for(const mode of ["legacy","submitted","evaluation","manual"]){const f=fixture(); if(mode==="legacy")f.pages.task.properties["과제 마감"]=rel("fri"); if(mode==="submitted")f.pages.task.properties["과제상태"].select.name="🔵 제출"; if(mode==="evaluation")f.pages.record.properties["구분"].select.name="평가"; if(mode==="manual"){f.pages.task.properties["과제 마감"]=rel("mon");f.pages.task.properties[AUTO_DEADLINE_PROP]=rel("fri")};await reconcileDeadline(f.io,"task","mon");assert(f.writes.length===0,mode)}
})
Deno.test("이미 올바른 자동 마감 재실행은 무쓰기", async () => { const f=fixture(); await reconcileDeadline(f.io,"task","mon"); assert(await reconcileDeadline(f.io,"task","fri") === "unchanged" && f.writes.length === 1) })
Deno.test("큐 적재 후 수동 변경 감지", async () => {
 const f=fixture();let n=0;const get=f.io.getPage;f.io.getPage=async id=>{if(id==="task" && ++n===2)f.pages.task.properties["과제 마감"]=rel("fri");return get(id)};assert(await reconcileDeadline(f.io,"task","mon")==="changed"&&f.writes.length===0)
})
Deno.test("활동 소유 등록 없거나 복수이면 안전하게 보류", async () => { const f=fixture();f.pages.task.properties["등록"].relation.push({id:"student-b"});assert(await reconcileDeadline(f.io,"task","mon")==="invalid_relations" && f.writes.length===0) })
Deno.test("학생별 후보 검색은 완료 과제 제외하고 페이지 끝까지", async () => {
 const f=fixture(); let n=0;f.io.query=async(db,b:any)=>{n++;assert(b.filter.and[0].relation.contains==="student-a"&&b.filter.and[1].select.equals==="🔴 미제출");return n===1?{results:[f.pages.task],has_more:true,next_cursor:"two"}:{results:[{...f.pages.task,id:"second"},f.pages.wrong],has_more:false}};assert((await pendingDeadlineActivities(f.io,"student-a")).join()==="task,second"&&n===2)
})
Deno.test("잘못된 페이지네이션은 부분 성공 처리하지 않음", async () => { const f=fixture();f.io.query=async()=>({results:[],has_more:true});let failed=false;try{await pendingDeadlineActivities(f.io,"student-a")}catch{failed=true}assert(failed) })
