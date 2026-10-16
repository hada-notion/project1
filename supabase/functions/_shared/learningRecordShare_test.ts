// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
function assert(value: unknown, message = "assertion failed") { if (!value) throw new Error(message) }
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_ATTENDANCE_ID: "attendance", DATA_SOURCE_STUDY_ACTIVITY_ID: "activities", DATA_SOURCE_REGISTRATION_ID: "registrations", DATA_SOURCE_CLASS_SESSION_ID: "sessions", DATA_SOURCE_LEARNING_RECORD_ID: "records", DATA_SOURCE_TIMETABLE_ID: "timetables" })) Deno.env.set(key, value)
const { decideRecordRemoval } = await import("./learningRecordShare.ts")
const { archiveAttendanceAfterEndDate } = await import("./registrationSync.ts")
const { cascadeDelete } = await import("./cascadeDeleteTarget.ts")

const rel = (...ids: string[]) => ({ relation: ids.map((id) => ({ id })) })
const ids = (p: any, k: string) => (p?.[k]?.relation ?? []).map((r: any) => r.id).join(",")
const ME = "me-reg", OTHER = "other-reg"

Deno.test("v2.6.16 학습기록 판단: 이 학생만의 기록은 지우고, 다른 학생도 쓰는 기록·그룹 진도는 연결만 끊는다", () => {
 const rec = (regs: string[], atts: string[]) => ({ properties: { 등록: rel(...regs), 출석: rel(...atts) } })
 assert(decideRecordRemoval(rec([ME], ["a1"]), ["a1"], [ME], "개별 진도").action === "delete", "개별 진도, 나만")
 assert(decideRecordRemoval(rec([ME], ["a1"]), ["a1"], [ME], undefined).action === "delete", "교재 없는 나만의 기록")
 assert(decideRecordRemoval(rec([], ["a1"]), ["a1"], [ME], undefined).action === "delete", "학생 연결 없음")
 const shared = decideRecordRemoval(rec([ME, OTHER], ["a1", "a2"]), ["a1"], [ME], undefined)
 assert(shared.action === "detach" && ids((shared as any).properties, "등록") === OTHER && ids((shared as any).properties, "출석") === "a2", "주제로 만든 반 전체 기록")
 const group = decideRecordRemoval(rec([ME], ["a1"]), ["a1"], [ME], "그룹 진도")
 assert(group.action === "detach" && ids((group as any).properties, "등록") === "" && ids((group as any).properties, "출석") === "", "그룹 진도는 혼자 남아도 지우지 않음")
 assert(decideRecordRemoval(rec(["me-reg".replace(/-/g, "")], ["a1"]), ["a1"], [ME], undefined).action === "delete", "하이픈 차이 무시")
})

function mock(pages: Record<string, any>) {
 const writes: { id: string; body: any }[] = [], queries: { db: string; body: any }[] = []
 const match = (p: any, f: any): boolean => {
  if (!f) return true
  if (f.and) return f.and.every((x: any) => match(p, x))
  if (f.relation) return (p.properties[f.property]?.relation ?? []).some((r: any) => r.id === f.relation.contains)
  if (f.date) return (p.properties[f.property]?.date?.start ?? "") > f.date.after
  return true
 }
 const fetch = async (input: any, init: any = {}) => {
  const url = String(input), body = init.body ? JSON.parse(init.body) : {}
  if (url.startsWith("https://mock.supabase/")) return new Response("[]")
  const db = url.match(/\/data_sources\/([^/]+)\/query/)?.[1]
  if (db) { queries.push({ db, body }); return new Response(JSON.stringify({ results: Object.values(pages).filter((p: any) => p.parent.data_source_id === db && !p.archived && match(p, body.filter)), has_more: false })) }
  const id = url.match(/\/pages\/([^/?]+)/)?.[1]
  if (id && init.method === "PATCH") {
   writes.push({ id, body })
   if (!pages[id]) throw new Error("missing page " + id)
   if (body.archived || body.in_trash) pages[id].archived = true
   Object.assign(pages[id].properties, body.properties ?? {})
   return new Response(JSON.stringify(pages[id]))
  }
  if (id) { if (!pages[id]) throw new Error("missing page " + id); return new Response(JSON.stringify(pages[id])) }
  throw new Error("unmocked " + url)
 }
 return { writes, queries, fetch }
}
async function withMock(pages: Record<string, any>, run: (m: ReturnType<typeof mock>) => Promise<void>) {
 const m = mock(pages), original = globalThis.fetch
 globalThis.fetch = m.fetch as typeof fetch
 ;(globalThis as any).EdgeRuntime = { waitUntil: (p: Promise<unknown>) => p.catch(() => {}) }
 try { await run(m) } finally { globalThis.fetch = original; delete (globalThis as any).EdgeRuntime }
}
const page = (id: string, db: string, properties: any) => ({ id, parent: { data_source_id: db }, archived: false, properties })
function world() {
 return {
  att: page("att", "attendance", { 출석: { title: [{ plain_text: "출석" }] }, 등록: rel(ME), 수업: rel("sess"), 수업일시: { date: { start: "2026-11-20T20:00:00+09:00" } }, 학습활동: rel(), 학습기록: rel("rec-mine", "rec-topic", "rec-group") }),
  "rec-mine": page("rec-mine", "records", { 학습: { title: [] }, 등록: rel(ME), 출석: rel("att"), 수업: rel("sess"), 진도교재: rel("book-ind") }),
  "rec-topic": page("rec-topic", "records", { 학습: { title: [] }, 등록: rel(ME, OTHER), 출석: rel("att", "att-other"), 수업: rel("sess"), 진도교재: rel() }),
  "rec-group": page("rec-group", "records", { 학습: { title: [] }, 등록: rel(ME, OTHER), 출석: rel("att", "att-other"), 수업: rel("sess"), 진도교재: rel("book-group") }),
  "book-ind": page("book-ind", "books", { 진도방식: { select: { name: "개별 진도" } } }),
  "book-group": page("book-group", "books", { 진도방식: { select: { name: "그룹 진도" } } }),
 } as Record<string, any>
}

Deno.test("v2.6.16 예전 종료 처리 경로: 종료일 이후 출석을 지울 때 반 전체 학습기록은 남기고 연결만 끊는다", async () => {
 const pages = world()
 await withMock(pages, async (m) => {
  const r = await archiveAttendanceAfterEndDate(ME, "2026-10-20")
  assert(r.deletedCount === 1 && r.recordCount === 1 && r.recordDetachedCount === 2, JSON.stringify(r))
  assert(pages.att.archived && pages["rec-mine"].archived, "출석·나만의 기록 삭제")
  for (const id of ["rec-topic", "rec-group"]) {
   assert(!pages[id].archived, id + " 남음")
   assert(ids(pages[id].properties, "등록") === OTHER && ids(pages[id].properties, "출석") === "att-other", id + " 연결만 해제")
  }
  assert(m.queries.filter((q) => q.db === "records").length === 1, "기록은 학생 기준으로 한 번 조회")
  assert(m.writes.filter((w) => w.id === "book-ind" || w.id === "book-group").length === 0)
 })
})

Deno.test("v2.6.16 삭제 자동화: 출석을 지우면 나만의 기록은 지우고 반 전체·그룹 진도 기록은 연결만 끊는다", async () => {
 const pages = world()
 await withMock(pages, async () => {
  const log: string[] = []
  await cascadeDelete("att", log, new Set())
  assert(pages.att.archived && pages["rec-mine"].archived, log.join("\n"))
  for (const id of ["rec-topic", "rec-group"]) {
   assert(!pages[id].archived, id + " 남음\n" + log.join("\n"))
   assert(ids(pages[id].properties, "등록") === OTHER && ids(pages[id].properties, "출석") === "att-other", id + " 연결만 해제")
  }
 })
})

Deno.test("v2.6.16 삭제 자동화: 수업째 지울 때는 출석 쪽에서 기록 연결을 끊지 않는다(수업 쪽이 처리)", async () => {
 const pages = world()
 pages.sess = page("sess", "sessions", { 이름: { title: [{ plain_text: "수업" }] } })
 await withMock(pages, async (m) => {
  const log: string[] = []
  await cascadeDelete("sess", log, new Set())
  assert(pages.sess.archived && pages.att.archived, log.join("\n"))
  assert(pages["rec-mine"].archived && pages["rec-topic"].archived, "그룹 진도가 아닌 수업 기록은 수업과 함께 삭제(예전과 같음)")
  assert(!pages["rec-group"].archived && ids(pages["rec-group"].properties, "수업") === "", "그룹 진도는 수업 연결만 해제(예전과 같음)")
  assert(!m.writes.some((w) => w.id === "rec-topic" && w.body.properties?.["등록"]), "출석 쪽에서 등록을 고치지 않음")
 })
})
