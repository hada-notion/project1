// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
function assert(value: unknown, message = "assertion failed") { if (!value) throw new Error(message) }
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_PROGRESS_BOOK_ID: "books", DATA_SOURCE_REGISTRATION_ID: "registrations", DATA_SOURCE_LEARNING_RECORD_ID: "records", DATA_SOURCE_CLASS_SESSION_ID: "sessions", DATA_SOURCE_ATTENDANCE_ID: "attendance" })) Deno.env.set(key, value)
const target = await import("./registrationTextbookTarget.ts")
const learning = await import("./createLearningRecordTarget.ts")
let handler: (req: Request) => Promise<Response>
const serve = Deno.serve
;(Deno as any).serve = (h: any) => { handler = h; return {} }
await import("../sync-registration-textbook/index.ts")
;(Deno as any).serve = serve
const rel = (...ids: string[]) => ({ relation: ids.map(id => ({ id })) })
const title = (s: string) => ({ type: "title", title: [{ plain_text: s, text: { content: s } }] })
function book(id: string, mode = "개별 진도", cls: string[] = ["class"], regs: string[] = [], template: string[] = []) {
 return { id, db: "books", properties: { "진도교재": title("기준 교재(반)"), "진도방식": { select: { name: mode } }, "클래스": rel(...cls), "등록": rel(...regs), "반별교재": rel(...template), "라이브러리": rel("regular"), "진행상태": { status: { name: "다음 교재" } }, "학습기록": rel() } }
}
function fixture() {
 const pages: Record<string, any> = {
  class: { id: "class", db: "classes", properties: { "클래스명": title("중3 A"), "교재 생성 상태": { select: { name: "⚪ 대기" } } } },
  regular: { id: "regular", db: "regulars", properties: { "교재명": title("쎈 중등 수학 3-2"), "과목": rel("math") } },
  template: book("template"),
 }
 for (const id of ["a", "b"]) pages[id] = { id, db: "registrations", properties: { "이름": title(id === "a" ? "김철수 중3 A" : "박영희 중3 A"), "클래스": rel("class"), "진도교재": rel(), "수강상태": { formula: { type: "string", string: "🟢 수강 중" } }, "교재 생성 상태": { select: { name: "⚪ 대기" } } } }
 const calls: any[] = [], writes: any[] = [], created: any[] = [], tasks: Promise<unknown>[] = []
 let pageLimit = 100, createFailure = false
 function matches(p: any, f: any): boolean {
  if (!f) return true
  if (f.and) return f.and.every((x: any) => matches(p, x))
  if (f.or) return f.or.some((x: any) => matches(p, x))
  if (f.relation) return (p.properties[f.property]?.relation ?? []).some((r: any) => r.id === f.relation.contains)
  throw new Error("unexpected filter " + JSON.stringify(f))
 }
 const reply = (p: any, status = 200) => new Response(JSON.stringify(structuredClone(p)), { status })
 const fetch = async (input: any, init: any = {}) => {
  const url = String(input), body = init.body ? JSON.parse(init.body) : {}; calls.push({ url, body, method: init.method ?? "GET" })
  if (url.includes("/functions/v1/sync-registration-textbook/")) return await handler(new Request(url, init))
  if (url.startsWith("https://mock.supabase/rest/v1/")) return reply([])
  const db = url.match(/\/data_sources\/([^/]+)\/query/)?.[1]
  if (db) {
   const all = Object.values(pages).filter(p => p.db === db && !p.archived && matches(p, body.filter))
   const offset = Number(body.start_cursor ?? 0), size = Math.min(pageLimit, body.page_size ?? 100), results = all.slice(offset, offset + size)
   return reply({ results, has_more: offset + size < all.length, next_cursor: offset + size < all.length ? String(offset + size) : null })
  }
  const id = url.match(/\/pages\/([^/?]+)/)?.[1]
  if (id) {
   assert(pages[id], "missing mock page " + id)
   if (init.method === "PATCH") { writes.push({ id, body }); const before = pages[id].properties; const prev = { 진도교재: relOf(before, "진도교재"), 등록: relOf(before, "등록") }; Object.assign(pages[id].properties, body.properties); if (body.archived) pages[id].archived = true; syncPair(id, prev) }
   return reply(pages[id])
  }
  if (url.endsWith("/pages") && init.method === "POST") {
   if (createFailure) return reply({ message: "mock create rejected" }, 400)
   const page = { id: "created-" + created.length, db: body.parent.data_source_id, properties: body.properties }; pages[page.id] = page; created.push(page); syncPair(page.id, { 진도교재: [], 등록: [] }); return reply(page)
  }
  throw new Error("unmocked network request " + url)
 }
 // 쓴 쪽의 바뀐 연결만 반대쪽에 반영한다(테스트가 일부러 만든 한쪽 연결 자료는 건드리지 않음).
 function relOf(props: any, key: string): string[] { return (props?.[key]?.relation ?? []).map((r: any) => r.id) }
 function syncPair(id: string, prev: { 진도교재: string[]; 등록: string[] }) {
  const p = pages[id], [mine, other] = p.db === "registrations" ? ["진도교재", "등록"] : p.db === "books" ? ["등록", "진도교재"] : [null, null]
  if (!mine) return
  const now = relOf(p.properties, mine), was = (prev as any)[mine] as string[]
  for (const t of now.filter((x) => !was.includes(x))) { const q = pages[t]; if (q && !relOf(q.properties, other!).includes(id)) q.properties[other!] = { relation: [...relOf(q.properties, other!), id].map((x) => ({ id: x })) } }
  for (const t of was.filter((x) => !now.includes(x))) { const q = pages[t]; if (q) q.properties[other!] = { relation: relOf(q.properties, other!).filter((x) => x !== id).map((x) => ({ id: x })) } }
 }
 const drain = async () => { for (let i = 0; i < tasks.length; i++) { assert(i < 100, "continuation loop"); await tasks[i] } }
 return { pages, calls, writes, created, tasks, fetch, drain, paginate: (n: number) => { pageLimit = n }, failCreate: () => { createFailure = true } }
}
async function withMock(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
 const f = fixture(), originalFetch = globalThis.fetch
 globalThis.fetch = f.fetch as typeof fetch
 ;(globalThis as any).EdgeRuntime = { waitUntil: (p: Promise<unknown>) => f.tasks.push(p) }
 try { await run(f); await f.drain() } finally { globalThis.fetch = originalFetch; delete (globalThis as any).EdgeRuntime }
}
const ids = (p: any, key: string) => (p.properties[key]?.relation ?? []).map((x: any) => x.id).join(",")
const mockIds: Record<string, string> = { a: "11111111111141118111111111111111", b: "22222222222242228222222222222222", class: "33333333333343338333333333333333" }
// Handler requests use UUIDs because extractPageId deliberately rejects short labels.
function useUuidIds(f: ReturnType<typeof fixture>) {
 for (const p of Object.values(f.pages)) {
  p.id = mockIds[p.id] ?? p.id
  for (const prop of Object.values(p.properties) as any[]) for (const r of prop.relation ?? []) r.id = mockIds[r.id] ?? r.id
 }
 for (const [alias, id] of Object.entries(mockIds)) {
  const page = f.pages[alias]; delete f.pages[alias]; f.pages[id] = page
  Object.defineProperty(f.pages, alias, { get: () => f.pages[id], enumerable: false })
 }
}
const request = (route: string, id: string, authorized = true) => new Request("https://mock.supabase/functions/v1/sync-registration-textbook/" + route, { method: "POST", headers: authorized ? { "x-admin-key": "test-only" } : {}, body: JSON.stringify({ pageId: mockIds[id] ?? id }) })
Deno.test("등록 생성: 개별교재 클래스 미복사·등록/출처/라이브러리·초기 이름", () => withMock(async f => {
 await target.createIndividualBooksForRegistration("a"); assert(f.created.length === 1); const p = f.created[0]
 assert(!("클래스" in p.properties)); assert(ids(p,"등록") === "a" && ids(p,"반별교재") === "template" && ids(p,"라이브러리") === "regular")
 assert(p.properties["진도교재"].title[0].text.content === "쎈 중등 수학 3-2(김철수 중3 A)"); assert(p.properties["진행상태"].status.name === "다음 교재")
}))
Deno.test("등록 버튼 반복 실행: 같은 등록+기준은 중복 생성하지 않음", () => withMock(async f => {
 await target.createIndividualBooksForRegistration("a"); await target.createIndividualBooksForRegistration("a"); assert(f.created.length === 1)
}))
Deno.test("같은 기준 교재여도 등록이 다르면 각각 생성", () => withMock(async f => {
 await target.createIndividualBooksForRegistration("a"); await target.createIndividualBooksForRegistration("b"); assert(f.created.length === 2 && ids(f.created[1],"등록") === "b")
}))
Deno.test("클래스 없는 개별교재를 클래스 버튼 완료 판정에서 발견", () => withMock(async f => {
 await target.createIndividualBooksForRegistration("a"); assert((await target.getPendingClassTextbookRegistrations("class")).map(p => p.id).join() === "b")
}))
Deno.test("구형 클래스 연결 개별교재 재사용·클래스/제목 변경 없음", () => withMock(async f => {
 f.pages.legacy = book("legacy","개별 진도",["class"],["a"],["template"]); f.pages.a.properties["진도교재"] = rel("legacy")
 await target.createIndividualBooksForRegistration("a"); assert(f.created.length === 0 && !f.writes.some(w => w.id === "legacy")); assert((await target.getPendingClassTextbookRegistrations("class")).map(p=>p.id).join() === "b")
}))
Deno.test("인스턴스는 있지만 등록 쪽 연결 누락: 재실행으로 연결만 복구", () => withMock(async f => {
 f.pages.existing = book("existing","개별 진도",[],["a"],["template"]); assert((await target.getPendingClassTextbookRegistrations("class")).some(p=>p.id==="a"))
 await target.createIndividualBooksForRegistration("a"); assert(f.created.length===0 && ids(f.pages.a,"진도교재")==="existing")
}))
Deno.test("새 기준 추가: 상태 완료라도 실제 누락을 찾아 생성", () => withMock(async f => {
 await target.createIndividualBooksForRegistration("a"); f.pages.a.properties["교재 생성 상태"].select.name="✅ 완료"; f.pages.template2=book("template2")
 assert((await target.getPendingClassTextbookRegistrations("class")).some(p=>p.id==="a")); await target.createIndividualBooksForRegistration("a"); assert(f.created.length===2)
}))
Deno.test("직접 만든 개별교재 보존·기준으로 재배포하지 않음", () => withMock(async f => {
 f.pages.direct=book("direct","개별 진도",[],["a"]); f.pages.a.properties["진도교재"]=rel("direct")
 await target.createIndividualBooksForRegistration("a"); assert(ids(f.pages.a,"진도교재").includes("direct") && !f.writes.some(w=>w.id==="direct"))
 assert(f.created.every(p=>ids(p,"반별교재")!=="direct"))
}))
Deno.test("직접 교재에 클래스가 잘못 남아 있어도 템플릿으로 오인하지 않음", () => withMock(async f => {
 f.pages.direct=book("direct","개별 진도",["class"],["a"]); f.pages.a.properties["진도교재"]=rel("direct")
 await target.createIndividualBooksForRegistration("b"); assert(f.created.length===1 && ids(f.created[0],"반별교재")==="template")
}))
Deno.test("그룹 교재: 클래스 유지·여러 등록 공유·학생별 복사 없음", () => withMock(async f => {
 f.pages.template.properties["진도방식"].select.name="그룹 진도"
 await target.createIndividualBooksForRegistration("a"); await target.createIndividualBooksForRegistration("b"); assert(f.created.length===0 && ids(f.pages.template,"등록")==="a,b" && ids(f.pages.template,"클래스")==="class")
 assert((await target.getPendingClassTextbookRegistrations("class")).length===0)
}))
// v2.6.10: 실제 Notion에서는 하나의 양방향 쌍이라 한쪽만 연결된 상태가 생기지 않는다. 그런 자료가 있으면 등록 쪽에 다시 써서 고친다(템플릿은 쓰지 않음).
Deno.test("그룹 교재 양방향 연결 누락을 판정하고 등록 쪽 쓰기로 복구", () => withMock(async f => {
 f.pages.template.properties["진도방식"].select.name="그룹 진도"; f.pages.a.properties["진도교재"]=rel("template")
 assert((await target.getPendingClassTextbookRegistrations("class")).some(p=>p.id==="a")); await target.createIndividualBooksForRegistration("a")
 assert(!f.writes.some(w=>w.id==="template") && f.writes.some(w=>w.id==="a" && w.body.properties["진도교재"].relation.some((r:any)=>r.id==="template")))
}))
Deno.test("그룹/개별 혼합 반은 각각 공유/복사 규칙 적용", () => withMock(async f => {
 f.pages.group=book("group","그룹 진도"); await target.createIndividualBooksForRegistration("a")
 assert(f.created.length===1 && ids(f.pages.a,"진도교재").includes("group") && ids(f.pages.group,"클래스")==="class")
}))
Deno.test("기준 없는 경우 직접 교재 보존·임의 책 생성 없음", () => withMock(async f => {
 delete f.pages.template; f.pages.direct=book("direct","개별 진도",[],["a"]); f.pages.a.properties["진도교재"]=rel("direct")
 assert("skipped" in await target.createIndividualBooksForRegistration("a")); assert(f.created.length===0 && f.writes.length===0 && ids(f.pages.a,"진도교재")==="direct"); assert((await target.getPendingClassTextbookRegistrations("class")).length===0)
}))
Deno.test("등록에 클래스 없는 경우 안전하게 건너뜀", () => withMock(async f => {
 f.pages.a.properties["클래스"]=rel(); assert("skipped" in await target.createIndividualBooksForRegistration("a")); assert(f.created.length===0)
}))
Deno.test("수강 종료/대기 등록은 클래스 일괄 처리에서 제외", () => withMock(async f => {
 f.pages.a.properties["수강상태"].formula.string="🔴 수강 종료"; f.pages.b.properties["수강상태"].formula.string="🟡 수강 대기"; assert((await target.getPendingClassTextbookRegistrations("class")).length===0)
}))
Deno.test("클래스 기준·출처 조회 페이지네이션: 뒤쪽 인스턴스까지 확인", () => withMock(async f => {
 f.paginate(1); f.pages.template2=book("template2"); f.pages.first=book("first","개별 진도",[],["b"],["template"]); f.pages.last=book("last","개별 진도",[],["a"],["template"]); f.pages.last2=book("last2","개별 진도",[],["a"],["template2"]); f.pages.a.properties["진도교재"]=rel("last","last2")
 assert((await target.getPendingClassTextbookRegistrations("class")).map(p=>p.id).join()==="b"); assert(f.calls.some(c=>c.body.start_cursor))
}))
Deno.test("기준 51개: 출처 필터를 50개씩 나누고 클래스 없이 조회", () => withMock(async f => {
 for(let i=1;i<=50;i++)f.pages["t"+i]=book("t"+i)
 await target.getPendingClassTextbookRegistrations("class"); const q=f.calls.filter(c=>c.body.filter?.or); assert(q.length===2 && q[0].body.filter.or.length===50 && q[1].body.filter.or.length===1)
 assert(q.every(c=>c.body.filter.or.every((x:any)=>x.property==="반별교재")))
}))
Deno.test("라이브러리 미연결이면 새 제목에 연결 필요 표시", () => withMock(async f => {
 f.pages.template.properties["라이브러리"]=rel(); await target.createIndividualBooksForRegistration("a"); assert(f.created[0].properties["진도교재"].title[0].text.content==="라이브러리 연결 필요(김철수 중3 A)")
}))
Deno.test("옛 속성 이름 정규교재도 읽고 같은 이름으로 쓴다(Notion 이름을 아직 안 바꾼 학원)", () => withMock(async f => {
 const t=f.pages.template.properties;t["정규교재"]=t["라이브러리"];delete t["라이브러리"]
 await target.createIndividualBooksForRegistration("a"); const p=f.created[0]
 assert(ids(p,"정규교재")==="regular" && !("라이브러리" in p.properties)); assert(p.properties["진도교재"].title[0].text.content==="쎈 중등 수학 3-2(김철수 중3 A)")
}))
Deno.test("등록 버튼 핸들러: 인증 유지·202·처리 상태 완료", () => withMock(async f => {
 useUuidIds(f)
 assert((await handler(request("create-individual","a",false))).status===401 && f.created.length===0)
 assert((await handler(request("create-individual","a"))).status===202); await f.drain(); assert(f.created.length===1 && f.pages.a.properties["교재 생성 상태"].select.name==="✅ 완료")
}))
Deno.test("클래스 버튼 핸들러: 순차 이어달리기·두 학생 생성·재실행 중복 없음", () => withMock(async f => {
 useUuidIds(f)
 assert((await handler(request("create-class","class"))).status===202); await f.drain(); assert(f.created.length===2 && f.pages.class.properties["교재 생성 상태"].select.name==="✅ 완료")
 assert(f.calls.some(c=>c.body.isContinuation===true)); await handler(request("create-class","class")); await f.drain(); assert(f.created.length===2)
}))
Deno.test("등록 생성 실패: 완료로 숨기지 않고 오류 상태 표시", () => withMock(async f => {
 useUuidIds(f)
 f.failCreate(); await handler(request("create-individual","a")); await f.drain(); assert(f.pages.a.properties["교재 생성 상태"].select.name==="⚠️ 오류" && f.created.length===0)
}))
Deno.test("학습기록: 클래스 없는 복사/직접 교재는 해당 등록·출석에만 연결", () => withMock(async f => {
 for(const direct of [false,true]){
  f.pages.a.properties["진도교재"]=rel(); let owned: any
  if(direct){owned=book("direct","개별 진도",[],["a"]);f.pages.direct=owned;f.pages.a.properties["진도교재"]=rel("direct")}
  else{await target.createIndividualBooksForRegistration("a");owned=f.created[0]}
  owned.properties["오늘 학습"]={checkbox:true}
  f.pages.session={id:"session",db:"sessions",properties:{"등록":rel("a","b"),"출석":rel("att-a","att-b"),"클래스":rel("class"),"수업일시":{date:{start:"2026-10-06T20:00:00+09:00"}}}}
  for(const id of ["a","b"])f.pages["att-"+id]={id:"att-"+id,db:"attendance",properties:{"등록":rel(id)}}
  await learning.finishCreateLearningRecord("session");const rec=f.created.filter(p=>p.db==="records").at(-1);assert(rec && ids(rec,"등록")==="a" && ids(rec,"출석")==="att-a" && ids(rec,"진도교재")===owned.id)
 }
}))
Deno.test("학습기록: 보강 수업은 반 교재도 가진 학생만 연결하고 보강 체크", () => withMock(async f => {
 for(const makeup of [false,true]){
  const grp: any=book("group"+makeup,"그룹 진도",["class"],["a"]);f.pages[grp.id]=grp;grp.properties["오늘 학습"]={checkbox:true}
  f.pages.a.properties["진도교재"]=rel(grp.id);f.pages.b.properties["진도교재"]=rel()
  f.pages.session={id:"session",db:"sessions",properties:{"등록":rel("a","b"),"출석":rel("att-a","att-b"),"클래스":rel(),"수업일시":{date:{start:"2026-10-06T20:00:00+09:00"}},"보강":{checkbox:makeup}}}
  for(const id of ["a","b"])f.pages["att-"+id]={id:"att-"+id,db:"attendance",properties:{"등록":rel(id)}}
  await learning.finishCreateLearningRecord("session");const rec=f.created.filter(p=>p.db==="records").at(-1)
  if(makeup)assert(rec && ids(rec,"등록")==="a" && ids(rec,"출석")==="att-a" && rec.properties["보강"]?.checkbox===true,"보강 수업")
  else assert(rec && ids(rec,"등록")==="a,b" && ids(rec,"출석")==="att-a,att-b" && rec.properties["보강"]===undefined,"정규 수업")
 }
}))
Deno.test("서식으로 나뉜 교재명·등록명도 전체 제목 사용", () => withMock(async f => {
 f.pages.regular.properties["교재명"].title=[{plain_text:"쎈 ",text:{content:"쎈 "}},{plain_text:"중등 수학 3-2",text:{content:"중등 수학 3-2"}}]
 f.pages.a.properties["이름"].title=[{plain_text:"김철수 ",text:{content:"김철수 "}},{plain_text:"중3 A",text:{content:"중3 A"}}]
 await target.createIndividualBooksForRegistration("a");assert(f.created[0].properties["진도교재"].title[0].text.content==="쎈 중등 수학 3-2(김철수 중3 A)")
}))
Deno.test("그룹 전용 반은 개별교재 출처 조회를 하지 않음", () => withMock(async f => {
 f.pages.template.properties["진도방식"].select.name="그룹 진도"; await target.getPendingClassTextbookRegistrations("class");assert(!f.calls.some(c=>c.body.filter?.or))
}))
Deno.test("타 학생의 개별교재 존재로 현재 학생 누락을 숨기지 않음", () => withMock(async f => {
 f.pages.other=book("other","개별 진도",[],["b"],["template"]);f.pages.b.properties["진도교재"]=rel("other"); assert((await target.getPendingClassTextbookRegistrations("class")).map(p=>p.id).join()==="a")
 await target.createIndividualBooksForRegistration("a");assert(f.created.length===1 && ids(f.created[0],"등록")==="a" && !f.writes.some(w=>w.id==="other"))
}))

const notionCalls = (f: any) => f.calls.filter((c: any) => c.url.startsWith("https://api.notion.com/")).length
Deno.test("v2.6.10 그룹 교재: 템플릿 등록을 다시 쓰지 않고 등록 쪽에서만 연결(26번째 학생도 앞 연결 유지)", () => withMock(async f => {
 f.pages.template.properties["진도방식"].select.name = "그룹 진도"
 const many = Array.from({ length: 25 }, (_, i) => "r" + i)
 f.pages.template.properties["등록"] = rel(...many)
 for (const id of many) f.pages[id] = { id, db: "registrations", properties: { "이름": title(id), "클래스": rel("class"), "진도교재": rel("template") } }
 await target.createIndividualBooksForRegistration("a")
 assert(!f.writes.some((w: any) => w.id === "template"), "template not rewritten")
 assert(ids(f.pages.a, "진도교재") === "template" && ids(f.pages.template, "등록").split(",").length === 26, ids(f.pages.template, "등록"))
}))
Deno.test("v2.6.10 큐 경로: 웹훅 본문의 클래스·이름으로 페이지 조회 없이 처리, 완료를 등록 쓰기 한 번에", () => withMock(async f => {
 f.pages.group = book("group", "그룹 진도"); f.pages.template2 = book("template2")
 useUuidIds(f)
 const a = f.pages.a, body = { source: { type: "automation" }, data: { object: "page", id: a.id, properties: { "클래스": { type: "relation", relation: [{ id: mockIds.class }], has_more: false }, "이름": a.properties["이름"] } } }
 const enq: any[] = []
 const res = await handler(new Request("https://mock.supabase/functions/v1/sync-registration-textbook/queue", { method: "POST", headers: { "x-admin-key": "test-only" }, body: JSON.stringify(body) }))
 assert(res.status === 202)
 const q = f.calls.find((c: any) => c.url.endsWith("/rest/v1/sync_queue")); assert(q && q.body[0].target === "sync-registration-textbook" && q.body[0].payload.snapshot.classId === mockIds.class && q.body[0].payload.snapshot.name === "김철수 중3 A", JSON.stringify(q?.body))
 assert(notionCalls(f) === 0, "enqueue reads nothing from Notion")
 const before = notionCalls(f)
 await target.processRegistrationTextbookQueueItem(q.body[0].payload)
 const used = f.calls.slice(f.calls.findIndex((c: any) => c === q) + 1).filter((c: any) => c.url.startsWith("https://api.notion.com/"))
 // 클래스 교재 조회 1 + 이 등록 교재 조회 1 + 라이브러리 1 + 개별교재 생성 2 + 등록 쓰기 1 = 6 (페이지 조회 없음)
 assert(!used.some((c: any) => c.method === "GET" && c.url.includes("/pages/" + a.id)), "no registration page read")
 assert(notionCalls(f) - before === 6, "calls " + (notionCalls(f) - before) + " " + used.map((c: any) => c.method + " " + c.url.replace("https://api.notion.com/v1", "")).join(" | "))
 const regWrites = f.writes.filter((w: any) => w.id === a.id); assert(regWrites.length === 1 && regWrites[0].body.properties["교재 생성 상태"].select.name === "✅ 완료")
 assert(f.created.length === 2 && ids(a, "진도교재").split(",").length === 3 && ids(f.pages.group, "등록") === a.id)
 // 다시 실행: 만들 것이 없으면 완료 쓰기 1번만
 const n = f.writes.length; await target.processRegistrationTextbookQueueItem(q.body[0].payload); assert(f.created.length === 2 && f.writes.length === n + 1)
}))
Deno.test("v2.6.10 큐 경로 실패: 오류 상태를 쓰고 큐 재시도를 위해 예외를 다시 던짐", () => withMock(async f => {
 f.failCreate(); let threw = false
 try { await target.processRegistrationTextbookQueueItem({ pageId: "a", snapshot: { id: "a", classId: "class", name: "김철수 중3 A" } }) } catch { threw = true }
 assert(threw && f.pages.a.properties["교재 생성 상태"].select.name === "⚠️ 오류")
}))
Deno.test("v2.6.10 본문에 클래스·이름이 없으면 페이지를 읽는다", () => withMock(async f => {
 assert(target.snapshotFromWebhookBody({ pageId: "a" }, "a") === null)
 assert(target.snapshotFromWebhookBody({ data: { properties: { "클래스": { relation: [] }, "이름": { title: [] } } } }, "a")?.classId === null)
}))
Deno.test("v2.6.10 종료 처리 교재 정리: 그룹 교재의 등록을 다시 쓰지 않고 등록 쪽에서만 뺀다", () => withMock(async f => {
 f.pages.template.properties["진도방식"].select.name = "그룹 진도"
 f.pages.b.properties["진도교재"] = rel("template"); f.pages.template.properties["등록"] = rel("b")
 await target.createIndividualBooksForRegistration("a")
 const r = await target.cleanupUnusedBooksOnEnd("a")
 assert(r.unlinked.join() === "template" && !f.writes.some((w: any) => w.id === "template") && ids(f.pages.a, "진도교재") === "" && ids(f.pages.template, "등록") === "b")
}))
Deno.test("v2.6.10 로그용 본문 요약은 값을 남기지 않는다", async () => {
 const { describeBody } = await import("./notionClient.ts")
 const text = describeBody({ adminKey: "secret-value", data: { id: "11111111111141118111111111111111", properties: { "학생 연락처": { phone_number: "010-0000-0001" } } } })
 assert(text.includes("pageId=11111111111141118111111111111111") && text.includes("keys=[adminKey,data]") && !text.includes("secret-value") && !text.includes("010-0000-0001"), text)
})
