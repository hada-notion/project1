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
  if (url.includes("/data_sources/")) return new Response(JSON.stringify({ results: (globalThis as any).mockQuery?.(url, body) ?? [], has_more: false }))
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
 await target.applyFixPlan(session, { v: 1, day: "2026-10-15", add: [{ reg: R1, rec: [REC] }, { reg: R2, att: A1 }], del: [A2], roster: [R1, R2] }, log, { "출석 조정 상태": { select: { name: "✅ 완료" } } })
 const c = m.created[0].properties
 assert(m.created.length === 1 && ids(c, "등록") === R1 && ids(c, "수업") === S && ids(c, "학습기록") === REC && ids(c, "클래스") === CLS && ids(c, "담당강사") === T && c["출석"].title[0].text.content === "2026-10-15 출석")
 const link = m.writes.find((w) => w.id === A1)!; assert(ids(link.body.properties, "수업") === S && ids(link.body.properties, "클래스") === CLS)
 const del = m.writes.find((w) => w.id === A2)!; assert(del.body.properties["삭제 체크"].checkbox === true && !("삭제" in del.body.properties), "uses 삭제 체크")
 const sw = m.writes.filter((w) => w.id === S); assert(sw.length === 1 && ids(sw[0].body.properties, "등록") === `${R1},${R2}` && sw[0].body.properties["출석 조정 상태"].select.name === "✅ 완료")
 // Notion 읽기 없음(과제 마감 확인 조회만): 페이지 GET 없음
 assert(!m.calls.some((x) => x.method === "GET" && x.url.includes("api.notion.com")), "no page reads")
}))
Deno.test("계획 적용: skip(예전 수식의 보강 포함)은 아무것도 만들지 않고 완료만", () => withMock(async (m) => {
 await target.applyFixPlan({ ...session, makeup: true }, { v: 1, skip: "보강 수업", add: [], del: [] }, [], { "출석 조정 상태": { select: { name: "✅ 완료" } } })
 await target.applyFixPlan(session, { v: 1, skip: "시간표·수업일시 없음", add: [], del: [] }, [], { "출석 조정 상태": { select: { name: "✅ 완료" } } })
 assert(m.created.length === 0 && m.writes.length === 2 && m.writes.every((w) => w.id === S))
}))
Deno.test("v2.6.17 보강 수업: 합치기만 — 출석을 🔵 보강으로 만들고 대기실 출석을 연결, 명단을 합치고 지우지 않는다(클래스 없어도 됨)", () => withMock(async (m) => {
 const log: string[] = []
 // 웹훅 본문에 "보강"이 빠져도 수식의 mk 표시로 보강 수업임을 안다.
 const plan = target.planFromText(JSON.stringify({ v: 1, mk: 1, day: "2026-10-15", add: [{ reg: R1, att: "", rec: [] }, { reg: R2, att: A1, rec: [] }], del: [A2], roster: [R1, R2] }))!
 assert(plan.makeup === true)
 await target.applyFixPlan({ ...session, classIds: [], makeup: false }, plan, log, { "출석 조정 상태": { select: { name: "✅ 완료" } } })
 assert(m.created.length === 1 && m.created[0].properties["출석 상태"].select.name === "🔵 보강" && !m.created[0].properties["클래스"] && m.created[0].properties["출석"].title[0].text.content === "2026-10-15 보강", JSON.stringify(m.created[0].properties))
 const link = m.writes.find((w) => w.id === A1); assert(link && ids(link.body.properties, "수업") === S && !link.body.properties["클래스"] && !link.body.properties["과제마감 백필 대상"], "대기실 출석 연결(과제 마감 연결 없음)")
 assert(!m.writes.some((w) => w.id === A2), "지우지 않음(삭제 체크 없음)")
 const sw = m.writes.filter((w) => w.id === S); assert(sw.length === 1 && ids(sw[0].body.properties, "등록") === `${R1},${R2}`, "명단 합치기")
 assert(!m.calls.some((c) => c.url.includes("/data_sources/activities/")), "보강은 대기 과제 조회 안 함")
 assert(log.some((l) => l.includes("지우지 않음")))
}))
Deno.test("v2.8.0 보강 수업: 연달아 쌓인 계획에 이미 출석이 생긴 학생이 있으면 만들지 않는다([보강 배정] 연속 클릭)", () => withMock(async (m) => {
 const log: string[] = []
 // R1은 앞 큐 항목이 이미 만들었다(이 수업·이 등록 출석이 조회됨), R2는 아직 없다.
 ;(globalThis as any).mockQuery = (url: string, body: any) => url.includes("/data_sources/attendance/") && JSON.stringify(body).includes(R1) ? [{ id: A1, properties: {} }] : []
 try {
  const plan = target.planFromText(JSON.stringify({ v: 1, mk: 1, day: "2026-10-29", add: [{ reg: R1, att: "", rec: [] }, { reg: R2, att: "", rec: [] }], del: [], roster: [R1, R2] }))!
  await target.applyFixPlan({ ...session, classIds: [], makeup: true }, plan, log, { "출석 조정 상태": { select: { name: "✅ 완료" } } })
  assert(m.created.length === 1 && ids(m.created[0].properties, "등록") === R2, JSON.stringify(m.created.map((c) => c.properties["등록"])))
  assert(log.some((l) => l.includes("[exists]") && l.includes(R1)))
 } finally { delete (globalThis as any).mockQuery }
}))
Deno.test("안전장치: 다녀야 할 학생 0명 + 출석 삭제 계획은 아무것도 쓰지 않는다(applyFixPlan은 오류, 큐는 페이지 재읽기 항목으로)", () => withMock(async (m) => {
 let threw = false
 try { await target.applyFixPlan(session, { v: 1, day: "2026-10-24", add: [], del: [A1, A2], roster: [] }, []) } catch (e) { threw = /0명/.test((e as Error).message) }
 assert(threw && m.writes.length === 0 && m.created.length === 0)
 await target.processFixAttendanceQueueItem({ pageId: S, plan: { v: 1, day: "2026-10-24", add: [], del: [A1, A2], roster: [] }, session })
 const q = m.calls.filter((c) => c.url.endsWith("/rest/v1/sync_queue")).map((c) => c.body[0])
 assert(q.length === 1 && !("plan" in q[0].payload) && !m.writes.some((w) => w.id === A1 || w.id === A2), JSON.stringify(q))
}))
Deno.test("큐 처리 실패(페이지를 읽은 경우): 오류 상태를 쓰고 재시도를 위해 예외를 다시 던짐", () => withMock(async (m) => {
 ;(globalThis as any).mockPages = { [S]: { id: S, properties: { "출석 조정 정보": formula(JSON.stringify({ v: 1, add: [{ reg: R1 }], del: [] })), "클래스": rel(CLS), "담당강사": rel(T), "수업일시": { date: { start: null } }, "보강": { checkbox: false } } } }
 let threw = false
 try { await target.processFixAttendanceQueueItem({ pageId: S, plan: null, session: null }) } catch { threw = true } finally { delete (globalThis as any).mockPages }
 assert(threw && m.writes.some((w) => w.id === S && w.body.properties["출석 조정 상태"]?.select?.name === "⚠️ 오류") && !m.calls.some((c) => c.url.endsWith("/rest/v1/sync_queue")))
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
Deno.test("v2.8.0 큐 경로: 보강 수업은 계획 없이 넣어 워커가 새로 읽게 하고, 상태를 바로 🔄로 바꾼다(연속 [보강 배정])", () => withMock(async (m) => {
 const plan = JSON.stringify({ v: 1, mk: 1, day: "2026-10-29", add: [{ reg: R1, att: "", rec: [] }], del: [], roster: [R1] })
 const body = JSON.stringify({ data: { object: "page", id: S, properties: { "출석 조정 정보": formula(plan), "클래스": rel(), "담당강사": rel(), "수업일시": { date: { start: "2026-10-29" } }, "보강": { checkbox: true } } } })
 assert((await handler(new Request("https://mock.supabase/functions/v1/fix-attendance/queue", { method: "POST", headers: { "x-admin-key": "test-only" }, body }))).status === 202)
 const q = m.calls.filter((c) => c.url.endsWith("/rest/v1/sync_queue")).at(-1)
 assert(q && q.body[0].payload.pageId === S && !("plan" in q.body[0].payload), JSON.stringify(q?.body))
 assert(m.writes.some((w) => w.id === S && w.body.properties["출석 조정 상태"]?.select?.name === "🔄 작업중"), "상태 🔄")
}))
Deno.test("큐 처리: 본문에 계획이 없으면 수업 페이지를 한 번 읽어 수식 값으로 처리", () => withMock(async (m) => {
 const plan = JSON.stringify({ v: 1, day: "2026-10-15", add: [{ reg: R1, att: "", rec: [] }], del: [] })
 ;(globalThis as any).mockPages = { [S]: { id: S, properties: { "출석 조정 정보": formula(plan), "클래스": rel(CLS), "담당강사": rel(T), "수업일시": { date: { start: session.start, end: session.end } }, "보강": { checkbox: false } } } }
 try {
  await target.processFixAttendanceQueueItem({ pageId: S, plan: null, session: null })
  assert(m.calls.filter((c) => c.method === "GET" && c.url.includes("/pages/")).length === 1, "one page read")
  assert(m.created.length === 1 && ids(m.created[0].properties, "등록") === R1 && m.writes.some((w) => w.id === S && w.body.properties["출석 조정 상태"]?.select?.name === "✅ 완료"))
 } finally { delete (globalThis as any).mockPages }
}))
Deno.test("v2.6.13 본문 계획으로 실패하면 같은 계획을 되풀이하지 않고 페이지를 새로 읽는 항목을 넣는다", () => withMock(async (m) => {
 const failing = mock(); let n = 0
 globalThis.fetch = (async (input: any, init: any = {}) => { const url = String(input); if (url.endsWith("/pages") && init.method === "POST" && n++ === 0) return new Response("boom", { status: 502 }); return failing.fetch(input, init) }) as typeof fetch
 await target.processFixAttendanceQueueItem({ pageId: S, plan: { v: 1, add: [{ reg: R1 }], del: [] }, session })
 const q = failing.calls.filter((c) => c.url.endsWith("/rest/v1/sync_queue")).map((c) => c.body[0])
 assert(q.length === 1 && q[0].target === "fix-attendance" && q[0].payload.pageId === S && !("plan" in q[0].payload), JSON.stringify(q))
 assert(!failing.writes.some((w) => w.id === S && w.body.properties["출석 조정 상태"]?.select?.name === "⚠️ 오류"), "no error state, re-queued instead")
 assert(m.calls.length === 0)
}))

Deno.test("v2.6.21 진도교재: 수식이 books를 보내면 수업 마지막 쓰기 한 번에 진도교재 관계를 맞추고, 없으면 건드리지 않는다", () => withMock(async (m) => {
 const B1 = "77777777777747778777777777777771", B2 = "77777777777747778777777777777772"
 const plan = target.planFromText(JSON.stringify({ v: 1, day: "2026-10-15", add: [], del: [], books: [B1, B2, B1] }))!
 assert(plan.books!.join() === B1 + "," + B2, "중복 제거")
 await target.applyFixPlan(session, plan, [], { "출석 조정 상태": { select: { name: "✅ 완료" } } })
 const sw = m.writes.filter((w) => w.id === S); assert(sw.length === 1 && ids(sw[0].body.properties, "진도교재") === B1 + "," + B2 && sw[0].body.properties["출석 조정 상태"], JSON.stringify(sw))
 await target.applyFixPlan(session, target.planFromText(JSON.stringify({ v: 1, add: [], del: [] }))!, [], { "출석 조정 상태": { select: { name: "✅ 완료" } } })
 assert(!m.writes.at(-1)!.body.properties["진도교재"], "books 없으면 진도교재 안 씀(속성 없는 운영 보호)")
 assert(target.planFromText(JSON.stringify({ v: 1, add: [], del: [], books: ["bad"] })) === null, "형식 오류면 예전 방식")
}))
// ---------- v2.8.0 [보강 배정] ----------
const ABS = "88888888888848888888888888888888", MS = "99999999999949998999999999999999"
const absence = (o: { status?: string; session?: string | null; reg?: string | null } = {}) => ({ id: ABS, properties: { "출석 상태": { select: { name: o.status ?? "🔴 결석" } }, "보강 수업": rel(...(o.session === null ? [] : [o.session ?? MS])), "등록": rel(...(o.reg === null ? [] : [o.reg ?? R2])) } })
const makeupSession = (o: { makeup?: boolean; roster?: string[] } = {}) => ({ id: MS, properties: { "보강": { checkbox: o.makeup ?? true }, "수업일시": { date: { start: "2026-10-30T18:00:00.000+09:00", end: "2026-10-30T19:00:00.000+09:00" } }, "클래스": rel(), "담당강사": rel(T), "등록": rel(...(o.roster ?? [R1])) } })
async function withMakeup(pages: Record<string, unknown>, query: (url: string, body: any) => any[], run: (m: ReturnType<typeof mock>) => Promise<void>) {
 ;(globalThis as any).mockPages = pages
 ;(globalThis as any).mockQuery = query
 try { await withMock(run) } finally { delete (globalThis as any).mockPages; delete (globalThis as any).mockQuery }
}
Deno.test("v2.8.0 [보강 배정] 경로: 인증, 결석 출석 id를 makeup-assign 큐에 넣고 202(노션 읽기 없음)", () => withMock(async (m) => {
 const body = JSON.stringify({ source: { type: "button" }, data: { object: "page", id: ABS, properties: {} } })
 const url = "https://mock.supabase/functions/v1/fix-attendance/makeup"
 assert((await handler(new Request(url, { method: "POST", body }))).status === 401)
 assert((await handler(new Request(url, { method: "POST", headers: { "x-admin-key": "test-only" }, body }))).status === 202)
 const q = m.calls.filter((c) => c.url.endsWith("/rest/v1/sync_queue")).at(-1)
 assert(q && q.body[0].target === "makeup-assign" && q.body[0].payload.attendanceId === ABS, JSON.stringify(q?.body))
 assert(!m.calls.some((c) => c.url.includes("api.notion.com")), "no Notion calls on enqueue")
}))
Deno.test("v2.8.0 [보강 배정]: 🔵 보강 출석을 만들고 수업 명단에 더한 뒤 출석 조정 ⚪", () => withMakeup({ [ABS]: absence(), [MS]: makeupSession() }, () => [], async (m) => {
 await target.processMakeupAssignItem({ attendanceId: ABS })
 assert(m.created.length === 1, "one attendance")
 const c = m.created[0].properties
 assert(ids(c, "등록") === R2 && ids(c, "수업") === MS && c["출석 상태"].select.name === "🔵 보강" && c["출석"].title[0].text.content === "2026-10-30 보강" && ids(c, "담당강사") === T && !c["클래스"] && c["수업일시"].date.start === "2026-10-30T18:00:00.000+09:00", JSON.stringify(c))
 const sw = m.writes.filter((w) => w.id === MS); assert(sw.length === 1 && ids(sw[0].body.properties, "등록") === `${R1},${R2}` && sw[0].body.properties["출석 조정 상태"].select.name === "⚪ 대기", JSON.stringify(sw))
}))
Deno.test("v2.8.0 [보강 배정]: 이미 있으면 만들지 않고, 명단에 있으면 명단은 그대로(출석 조정만 ⚪)", () => withMakeup({ [ABS]: absence(), [MS]: makeupSession({ roster: [R1, R2] }) }, (url, body) => JSON.stringify(body).includes(MS) ? [{ id: A1, properties: {} }] : [], async (m) => {
 await target.processMakeupAssignItem({ attendanceId: ABS })
 assert(m.created.length === 0, "no create")
 const sw = m.writes.filter((w) => w.id === MS); assert(sw.length === 1 && !("등록" in sw[0].body.properties) && sw[0].body.properties["출석 조정 상태"].select.name === "⚪ 대기")
}))
Deno.test("v2.8.0 [보강 배정]: 같은 날 수업 없는 🔵 보강 출석(보강 대기실)이 있으면 새로 만들지 않고 연결", () => withMakeup({ [ABS]: absence(), [MS]: makeupSession() }, (url, body) => JSON.stringify(body).includes("is_empty") ? [{ id: A2, properties: { "출석 상태": { select: { name: "🔵 보강" } } } }] : [], async (m) => {
 await target.processMakeupAssignItem({ attendanceId: ABS })
 assert(m.created.length === 0)
 const link = m.writes.find((w) => w.id === A2); assert(link && ids(link.body.properties, "수업") === MS && ids(link.body.properties, "담당강사") === T)
}))
Deno.test("v2.8.0 [보강 배정]: 결석이 아님·보강 수업 비움·보강 수업이 아님은 아무것도 쓰지 않음", async () => {
 for (const [abs, sess] of [[absence({ status: "🟢 출석" }), makeupSession()], [absence({ session: null }), makeupSession()], [absence(), makeupSession({ makeup: false })]] as const) {
  await withMakeup({ [ABS]: abs, [MS]: sess }, () => [], async (m) => {
   await target.processMakeupAssignItem({ attendanceId: ABS })
   assert(m.created.length === 0 && m.writes.length === 0, JSON.stringify(m.writes))
  })
 }
})
Deno.test("v2.8.0 [보강 배정]: 보강 수업 일시가 비면 그 수업에 ⚠️ 오류를 쓰고 실패", () => withMakeup({ [ABS]: absence(), [MS]: { id: MS, properties: { "보강": { checkbox: true }, "수업일시": { date: null }, "등록": rel() } } }, () => [], async (m) => {
 let threw = false
 try { await target.processMakeupAssignItem({ attendanceId: ABS }) } catch { threw = true }
 assert(threw && m.created.length === 0 && m.writes.some((w) => w.id === MS && w.body.properties["출석 조정 상태"]?.select?.name === "⚠️ 오류"))
}))
