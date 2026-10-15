// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
function assert(value: unknown, message = "assertion failed") { if (!value) throw new Error(message) }
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_ATTENDANCE_ID: "attendance", DATA_SOURCE_STUDY_ACTIVITY_ID: "activities", DATA_SOURCE_REGISTRATION_ID: "registrations", DATA_SOURCE_CLASS_SESSION_ID: "sessions", DATA_SOURCE_TIMETABLE_ID: "timetables" })) Deno.env.set(key, value)
const target = await import("./fixAttendanceTarget.ts")
let handler: (req: Request) => Promise<Response>
const serve = Deno.serve
;(Deno as any).serve = (h: any) => { handler = h; return {} }
await import("../fix-attendance/index.ts")
;(Deno as any).serve = serve
const S = "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa", R1 = "11111111111141118111111111111111", R2 = "22222222222242228222222222222222", A1 = "33333333333343338333333333333333", A2 = "44444444444444448444444444444444", REC = "55555555555545558555555555555555", CLS = "66666666666646668666666666666666", T = "77777777777747778777777777777777"
const rel = (...ids: string[]) => ({ relation: ids.map((id) => ({ id })) })
function mock() {
 const calls: any[] = [], writes: any[] = [], created: any[] = []
 const fetch = async (input: any, init: any = {}) => {
  const url = String(input), body = init.body ? JSON.parse(init.body) : {}; calls.push({ url, body, method: init.method ?? "GET" })
  if (url.startsWith("https://mock.supabase/")) return new Response("[]")
  if (url.includes("/data_sources/")) return new Response(JSON.stringify({ results: [], has_more: false }))
  const id = url.match(/\/pages\/([^/?]+)/)?.[1]
  if (id && init.method !== "PATCH" && (globalThis as any).mockPages?.[id]) return new Response(JSON.stringify((globalThis as any).mockPages[id]))
  if (id && init.method === "PATCH") { writes.push({ id, body }); return new Response(JSON.stringify({ id, properties: body.properties })) }
  if (url.endsWith("/pages") && init.method === "POST") { const p = { id: "new-" + created.length, properties: body.properties }; created.push(p); return new Response(JSON.stringify(p)) }
  throw new Error("unmocked " + url)
 }
 return { calls, writes, created, fetch }
}
async function withMock(run: (m: ReturnType<typeof mock>) => Promise<void>) {
 const m = mock(), original = globalThis.fetch, tasks: Promise<unknown>[] = []
 globalThis.fetch = m.fetch as typeof fetch
 ;(globalThis as any).EdgeRuntime = { waitUntil: (p: Promise<unknown>) => tasks.push(p) }
 try { await run(m); for (const t of tasks) await t.catch(() => {}) } finally { globalThis.fetch = original; delete (globalThis as any).EdgeRuntime }
}
const formula = (s: string) => ({ type: "formula", formula: { type: "string", string: s } })
const session = { id: S, classIds: [CLS], teacherIds: [T], start: "2026-10-15T17:00:00.000+09:00", end: "2026-10-15T18:00:00.000+09:00", makeup: false }
const ids = (p: any, k: string) => (p?.[k]?.relation ?? []).map((r: any) => r.id).join(",")

Deno.test("계획 해석: 형식이 맞지 않으면 null(예전 방식으로)", () => {
 assert(target.planFromText("") === null && target.planFromText("not json") === null && target.planFromText(JSON.stringify({ v: 2 })) === null)
 assert(target.planFromText(JSON.stringify({ v: 1, add: [{ reg: "bad" }], del: [] })) === null, "bad id")
 const p = target.planFromText(JSON.stringify({ v: 1, day: "2026-10-15", add: [{ reg: "11111111-1111-4111-8111-111111111111", att: "", rec: [REC] }], del: [A2], roster: [R1, R2] }))!
 assert(p.add[0].reg === R1 && p.add[0].att === undefined && p.add[0].rec!.join() === REC && p.del.join() === A2 && p.roster!.length === 2)
 assert(target.planFromText(JSON.stringify({ v: 1, skip: "보강 수업" }))!.skip === "보강 수업")
})
Deno.test("계획 적용: 새 출석(학습기록 포함)·미연결 출석 연결·삭제 체크·명단과 완료는 수업 쓰기 한 번", () => withMock(async (m) => {
 const log: string[] = []
 await target.applyFixPlan(session, { v: 1, day: "2026-10-15", add: [{ reg: R1, rec: [REC] }, { reg: R2, att: A1 }], del: [A2], roster: [R1, R2] }, log, { "출석조정 상태": { select: { name: "✅ 완료" } } })
 const c = m.created[0].properties
 assert(m.created.length === 1 && ids(c, "등록") === R1 && ids(c, "수업") === S && ids(c, "학습기록") === REC && ids(c, "클래스") === CLS && ids(c, "담당강사") === T && c["출석"].title[0].text.content === "2026-10-15 출석")
 const link = m.writes.find((w) => w.id === A1)!; assert(ids(link.body.properties, "수업") === S && ids(link.body.properties, "클래스") === CLS)
 const del = m.writes.find((w) => w.id === A2)!; assert(del.body.properties["삭제 체크"].checkbox === true && !("삭제" in del.body.properties), "uses 삭제 체크")
 const sw = m.writes.filter((w) => w.id === S); assert(sw.length === 1 && ids(sw[0].body.properties, "등록") === `${R1},${R2}` && sw[0].body.properties["출석조정 상태"].select.name === "✅ 완료")
 // Notion 읽기 없음(과제 마감 확인 조회만): 페이지 GET 없음
 assert(!m.calls.some((x) => x.method === "GET" && x.url.includes("api.notion.com")), "no page reads")
}))
Deno.test("계획 적용: 보강·skip은 아무것도 만들지 않고 완료만", () => withMock(async (m) => {
 await target.applyFixPlan({ ...session, makeup: true }, { v: 1, add: [{ reg: R1 }], del: [A2] }, [], { "출석조정 상태": { select: { name: "✅ 완료" } } })
 await target.applyFixPlan(session, { v: 1, skip: "시간표·수업일시 없음", add: [], del: [] }, [], { "출석조정 상태": { select: { name: "✅ 완료" } } })
 assert(m.created.length === 0 && m.writes.length === 2 && m.writes.every((w) => w.id === S))
}))
Deno.test("안전장치: 다녀야 할 학생 0명 + 출석 삭제 계획은 아무것도 쓰지 않고 오류", () => withMock(async (m) => {
 let threw = false
 try { await target.processFixAttendanceQueueItem({ pageId: S, plan: { v: 1, day: "2026-10-24", add: [], del: [A1, A2], roster: [] }, session }) } catch (e) { threw = /0명/.test((e as Error).message) }
 assert(threw && !m.writes.some((w) => w.id === A1 || w.id === A2) && m.writes.some((w) => w.id === S && w.body.properties["출석조정 상태"]?.select?.name === "⚠️ 오류"))
}))
Deno.test("큐 처리 실패: 오류 상태를 쓰고 재시도를 위해 예외를 다시 던짐", () => withMock(async (m) => {
 let threw = false
 try { await target.processFixAttendanceQueueItem({ pageId: S, plan: { v: 1, add: [{ reg: R1 }], del: [] }, session: { ...session, start: null } }) } catch { threw = true }
 assert(threw && m.writes.some((w) => w.id === S && w.body.properties["출석조정 상태"]?.select?.name === "⚠️ 오류"))
}))
Deno.test("큐 경로: 인증, 본문의 수식 계획을 Notion 읽기 없이 큐에 넣음", () => withMock(async (m) => {
 const plan = JSON.stringify({ v: 1, day: "2026-10-15", add: [{ reg: R1, att: "", rec: [] }], del: [] })
 const body = JSON.stringify({ source: { type: "automation" }, data: { object: "page", id: S, properties: { "출석 조정 정보": formula(plan), "클래스": rel(CLS), "담당강사": rel(T), "수업일시": { date: { start: session.start, end: session.end } }, "보강": { checkbox: false } } } })
 const url = "https://mock.supabase/functions/v1/fix-attendance/queue"
 assert((await handler(new Request(url, { method: "POST", body }))).status === 401)
 assert((await handler(new Request(url, { method: "POST", headers: { "x-admin-key": "test-only" }, body }))).status === 202)
 const q = m.calls.find((c) => c.url.endsWith("/rest/v1/sync_queue"))
 assert(q && q.body[0].target === "fix-attendance" && q.body[0].payload.plan.add[0].reg === R1 && q.body[0].payload.session.classIds[0] === CLS, JSON.stringify(q?.body))
 assert(!m.calls.some((c) => c.url.includes("api.notion.com")), "no Notion calls on enqueue")
 // 수식 속성이 없으면 계획 없이 넣고(워커가 예전 방식) 그래도 202
 const bare = JSON.stringify({ data: { object: "page", id: S, properties: {} } })
 assert((await handler(new Request(url, { method: "POST", headers: { "x-admin-key": "test-only" }, body: bare }))).status === 202)
 assert(m.calls.filter((c) => c.url.endsWith("/rest/v1/sync_queue")).at(-1).body[0].payload.plan === null)
}))
Deno.test("큐 처리: 본문에 계획이 없으면 수업 페이지를 한 번 읽어 수식 값으로 처리", () => withMock(async (m) => {
 const plan = JSON.stringify({ v: 1, day: "2026-10-15", add: [{ reg: R1, att: "", rec: [] }], del: [] })
 ;(globalThis as any).mockPages = { [S]: { id: S, properties: { "출석 조정 정보": formula(plan), "클래스": rel(CLS), "담당강사": rel(T), "수업일시": { date: { start: session.start, end: session.end } }, "보강": { checkbox: false } } } }
 try {
  await target.processFixAttendanceQueueItem({ pageId: S, plan: null, session: null })
  assert(m.calls.filter((c) => c.method === "GET" && c.url.includes("/pages/")).length === 1, "one page read")
  assert(m.created.length === 1 && ids(m.created[0].properties, "등록") === R1 && m.writes.some((w) => w.id === S && w.body.properties["출석조정 상태"]?.select?.name === "✅ 완료"))
 } finally { delete (globalThis as any).mockPages }
}))
