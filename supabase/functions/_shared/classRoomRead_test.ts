// 수업 관리 읽기 전환(v2.5.116) 테스트. 같은 Notion 가짜 자료를 복사본 행으로 바꿔 가짜 Supabase에 넣고,
// Notion 읽기(classRoom.ts)와 복사본 읽기(classRoomRead.ts) 결과가 같은지 동작마다 비교한다. 실제 키·데이터·네트워크 없음.
function assert(value: unknown, message = "assertion failed") { if (!value) throw new Error(message) }
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", CLASS_ROOM_COPY_WRITE: "off", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_CLASS_SESSION_ID: "sessions", DATA_SOURCE_ATTENDANCE_ID: "attendance", DATA_SOURCE_LEARNING_RECORD_ID: "records", DATA_SOURCE_STUDY_ACTIVITY_ID: "activities", DATA_SOURCE_PROGRESS_BOOK_ID: "books", DATA_SOURCE_REGISTRATION_ID: "registrations" })) Deno.env.set(key, value)
Deno.env.delete("CLASS_ROOM_SOURCE")
const room = await import("./classRoom.ts")
const read = await import("./classRoomRead.ts")
const copy = await import("./classRoomCopy.ts")

const rel = (...ids: string[]) => ({ relation: ids.map((id) => ({ id })) })
const title = (s: string) => ({ type: "title", title: [{ plain_text: s, text: { content: s } }] })
const text = (s: string) => ({ type: "rich_text", rich_text: s ? [{ plain_text: s, text: { content: s } }] : [] })
const formula = (s: string) => ({ type: "formula", formula: { type: "string", string: s } })
const num = (n: number | null) => ({ type: "number", number: n })
const due = (d: string) => ({ type: "formula", formula: { type: "date", date: { start: d } } })
const sel = (s: string | null) => ({ select: s ? { name: s } : null })
const D = "2026-10-13T08:00:00.000Z" // 17:00 KST
const NOW = Date.parse("2026-10-14T00:00:00.000Z")

function fixture() {
 const pages: Record<string, any> = {
  cls: { id: "cls", db: "classes", properties: { "클래스명": title("중1 B"), "이모지": text("🟡") } },
  regular: { id: "regular", db: "regulars", properties: { "교재명": title("개념원리 1-2") } },
  t1: { id: "t1", db: "teachers", properties: { "이름": title("안규빈") } },
  group: { id: "group", db: "books", properties: { "진도교재": title("개념원리(중1 B)") } },
  indA: { id: "indA", db: "books", properties: { "진도교재": title("RPM(김하늘)") } },
  s1: { id: "s1", db: "sessions", properties: { "이름": title("중1 B 10.13(화)"), "수업일시": { date: { start: D, end: "2026-10-13T09:00:00.000Z" } }, "담당강사": rel("t1"), "클래스": rel("cls"), "보강": { checkbox: false }, "출석현황": formula("✅ 정상(2)") } },
  sOther: { id: "sOther", db: "sessions", properties: { "이름": title("다른 날"), "수업일시": { date: { start: "2026-10-14T17:00:00.000+09:00" } }, "담당강사": rel("t1"), "보강": { checkbox: false } } },
  sPrev: { id: "sPrev", db: "sessions", properties: { "이름": title("중1 B 10.08(목)"), "수업일시": { date: { start: "2026-10-08T08:00:00.000Z" } }, "담당강사": rel("t1"), "클래스": rel("cls"), "보강": { checkbox: false } } },
  sNext: { id: "sNext", db: "sessions", properties: { "이름": title("중1 B 10.20(화)"), "수업일시": { date: { start: "2026-10-20T08:00:00.000Z" } }, "담당강사": rel("t1"), "클래스": rel("cls"), "보강": { checkbox: false } } },
  sMk: { id: "sMk", db: "sessions", properties: { "이름": title("보강"), "수업일시": { date: { start: "2026-10-09T08:00:00.000Z" } }, "클래스": rel("cls"), "보강": { checkbox: true } } },
  aa: { id: "aa", db: "attendance", properties: { "출석": title("aa"), "학생이름(보고서)": formula("김하늘"), "등록": rel("ra"), "수업": rel("s1"), "수업일시": { date: { start: D } }, "출석 상태": sel("🟢 출석"), "등원스템프": { date: { start: "2026-10-13T16:52:00.000+09:00" } }, "메모": text(" 집중 좋음 "), "선생님 한마디": text(""), "과제": rel("hw1") } },
  ab: { id: "ab", db: "attendance", properties: { "출석": title("ab"), "학생이름(보고서)": formula("박서준"), "등록": rel("rb"), "수업": rel("s1"), "수업일시": { date: { start: D } }, "출석 상태": sel(null), "메모": text(""), "선생님 한마디": text("잘했어요"), "과제": rel("hw2") } },
  pa: { id: "pa", db: "attendance", properties: { "출석": title("pa"), "등록": rel("ra"), "수업": rel("sPrev"), "수업일시": { date: { start: "2026-10-08T08:00:00.000Z" } }, "출석 상태": sel("🟢 출석") } },
  pb: { id: "pb", db: "attendance", properties: { "출석": title("pb"), "등록": rel("rb"), "수업": rel("sPrev"), "수업일시": { date: { start: "2026-10-08T08:00:00.000Z" } }, "출석 상태": sel("🔴 결석") } },
  pc: { id: "pc", db: "attendance", properties: { "출석": title("pc"), "수업": rel("sPrev"), "수업일시": { date: { start: "2026-10-08T08:00:00.000Z" } }, "출석 상태": sel("🔵 보강") } },
  wait1: { id: "wait1", db: "attendance", properties: { "출석": title("w1"), "학생이름(보고서)": formula("이도윤"), "클래스(보고서)": formula("중2 A"), "등록": rel("rc"), "수업": rel(), "수업일시": { date: { start: "2026-10-13T15:00:00.000+09:00" } }, "출석 상태": sel("🔵 보강") } },
  rec0: { id: "rec0", db: "records", properties: { "학습": title("[과제] 개념원리 1-2(중1 B) 10.13(화)"), "구분": sel("과제"), "수업": rel("s1"), "진도교재": rel("group"), "범위": text("p.31-35 "), "단원": text(" 1-1. 평면좌표 "), "내용": text("선과제") } },
  recA: { id: "recA", db: "records", properties: { "학습": title("[학습] 개념원리"), "구분": sel("학습"), "수업": rel("s1"), "교재": rel("regular"), "진도교재": rel("group"), "범위": text("p.80-85") } },
  recB: { id: "recB", db: "records", properties: { "학습": title("[과제] RPM"), "구분": sel("과제"), "수업": rel("sPrev"), "진도교재": rel("indA"), "범위": text("p.70-76") } },
  rT1: { id: "rT1", db: "records", properties: { "학습": title("[평가] 개념원리"), "구분": sel("평가"), "수업": rel("sPrev"), "교재": rel("regular"), "범위": text("Ⅲ-1") } },
  rT2: { id: "rT2", db: "records", properties: { "학습": title("[평가] 개념원리 2"), "구분": sel("평가"), "수업": rel("s1"), "교재": rel("regular"), "범위": text("Ⅲ-2") } },
  recMk: { id: "recMk", db: "records", properties: { "학습": title("[학습] 보강"), "구분": sel("학습"), "수업": rel("sMk"), "주제": text("보강 주제 ") } },
  hw1: { id: "hw1", db: "activities", properties: { "학습활동": title("hw1"), "학습기록": rel("rec0"), "등록": rel("ra"), "출석": rel("aa"), "과제상태": sel("🔵 제출"), "과제 마감일": due("2026-10-13T00:00:00.000+09:00") } },
  hw2: { id: "hw2", db: "activities", properties: { "학습활동": title("hw2"), "학습기록": rel("rec0"), "등록": rel("rb"), "출석": rel("ab"), "과제상태": sel("🔴 미제출"), "과제 마감일": due("2026-10-13") } },
  k1: { id: "k1", db: "activities", properties: { "학습활동": title("k1"), "학습기록": rel("recB"), "등록": rel("ra"), "과제상태": sel("🔵 제출"), "과제 마감일": due("2026-10-08") } },
  t1a: { id: "t1a", db: "activities", properties: { "학습활동": title("t1a"), "학습기록": rel("rT1"), "등록": rel("ra"), "정답 문항": num(8), "전체 문항": num(10) } },
  t1b: { id: "t1b", db: "activities", properties: { "학습활동": title("t1b"), "학습기록": rel("rT1"), "등록": rel("rb"), "정답 문항": num(6), "전체 문항": num(10) } },
  t2a: { id: "t2a", db: "activities", properties: { "학습활동": title("t2a"), "학습기록": rel("rT2"), "등록": rel("ra"), "정답 문항": num(10), "전체 문항": num(10) } },
  t2b: { id: "t2b", db: "activities", properties: { "학습활동": title("t2b"), "학습기록": rel("rT2"), "등록": rel("rb"), "정답 문항": num(null), "전체 문항": num(10) } },
  // Notion에서 지운 기록(복사본에는 남아 있다)
  rGone: { id: "rGone", db: "records", properties: { "학습": title("[학습] 지운 기록"), "구분": sel("학습"), "수업": rel("s1") } },
 }
 // 실제 Notion처럼 속성마다 type, 그리고 양쪽 관계(수업↔출석·학습기록, 학습기록↔학습활동)를 맞춘다
 for (const p of Object.values(pages)) {
  p.last_edited_time = "2026-10-13T00:00:00.000Z"
  for (const v of Object.values(p.properties) as any[]) if (!v.type) v.type = ["relation", "date", "checkbox", "select"].find((k) => k in v)
 }
 const back = (db: string, from: string, to: string) => {
  for (const p of Object.values(pages).filter((x) => x.db === db)) {
   p.properties[to] = { type: "relation", relation: Object.values(pages).filter((x) => (x.properties[from]?.relation ?? []).some((r: any) => r.id === p.id)).map((x) => ({ id: x.id })) }
  }
 }
 back("sessions", "수업", "출석"); for (const s of Object.values(pages).filter((x) => x.db === "sessions")) s.properties["출석"].relation = s.properties["출석"].relation.filter((r: any) => pages[r.id].db === "attendance")
 for (const s of Object.values(pages).filter((x) => x.db === "sessions")) s.properties["학습기록"] = { type: "relation", relation: Object.values(pages).filter((x) => x.db === "records" && x.id !== "rGone" && x.properties["수업"].relation.some((r: any) => r.id === s.id)).map((x) => ({ id: x.id })) }
 back("records", "학습기록", "학습활동")
 const notionPages = () => Object.values(pages).filter((p) => !p.archived)

 const store: Record<string, Map<string, any>> = { cr_sessions: new Map(), cr_attendance: new Map(), cr_records: new Map(), cr_activities: new Map() }
 const sbCalls: string[] = []
 function cond(p: any, f: any): boolean {
  if (!f) return true
  if (f.and) return f.and.every((x: any) => cond(p, x))
  if (f.or) return f.or.some((x: any) => cond(p, x))
  if (f.timestamp) return Date.parse(p[f.timestamp]) >= Date.parse(f[f.timestamp].on_or_after)
  const v = p.properties[f.property]
  if (f.relation?.contains) return (v?.relation ?? []).some((r: any) => r.id === f.relation.contains)
  if (f.date?.on_or_after) return Date.parse(v?.date?.start) >= Date.parse(f.date.on_or_after)
  if (f.date?.before) return Date.parse(v?.date?.start) < Date.parse(f.date.before)
  throw new Error("unexpected filter " + JSON.stringify(f))
 }
 function rowMatch(row: any, col: string, expr: string): boolean {
  const i = expr.indexOf("."), op = expr.slice(0, i), val = expr.slice(i + 1), cell = row[col]
  const list = (s: string) => s.slice(1, -1).split(",").map((x) => x.replace(/^"|"$/g, "")).filter(Boolean)
  if (op === "eq") return String(cell) === val
  if (op === "in") return list(val).includes(cell)
  if (op === "cs") return list(val).every((x) => (cell ?? []).includes(x))
  if (op === "ov") return list(val).some((x) => (cell ?? []).includes(x))
  if (op === "gte") return cell != null && Date.parse(cell) >= Date.parse(val)
  if (op === "lt") return cell != null && Date.parse(cell) < Date.parse(val)
  throw new Error("unexpected op " + expr)
 }
 const reply = (b: unknown, status = 200) => new Response(JSON.stringify(structuredClone(b)), { status })
 const fetch = async (input: any, init: any = {}) => {
  const url = String(input), method = init.method ?? "GET"
  if (url.startsWith("https://mock.supabase/rest/v1/")) {
   const u = new URL(url), table = u.pathname.split("/").pop()!
   sbCalls.push(method + " " + table)
   if (table === "sync_cursors") return reply(method === "GET" ? [{ last_synced_at: "2026-10-13T00:00:00.000Z" }] : null, method === "GET" ? 200 : 201)
   const t = store[table]
   if (method === "POST") { for (const r of JSON.parse(init.body)) t.set(r.id, { ...t.get(r.id), ...r }); return new Response(null, { status: 201 }) }
   if (method === "DELETE") { for (const [c, e] of u.searchParams) if (c === "id") for (const id of [...t.keys()]) if (rowMatch({ id }, "id", e)) t.delete(id); return new Response(null, { status: 204 }) }
   let rows = [...t.values()]
   let order: string[] = [], limit = 1000, offset = 0
   for (const [c, e] of u.searchParams) {
    if (c === "select") continue
    if (c === "order") order = e.split(","); else if (c === "limit") limit = Number(e); else if (c === "offset") offset = Number(e)
    else rows = rows.filter((r) => rowMatch(r, c, e))
   }
   rows.sort((a, b) => { for (const k of order) { const x = String(a[k] ?? "￿"), y = String(b[k] ?? "￿"); if (x !== y) return x < y ? -1 : 1 } return 0 })
   return reply(rows.slice(offset, offset + limit))
  }
  const body = init.body ? JSON.parse(init.body) : {}
  if (url.endsWith("/data_sources/sessions")) return reply({ properties: { "담당강사": { relation: { data_source_id: "teachers" } } } })
  const blk = url.match(/\/blocks\/([^/]+)\/children/)?.[1]
  if (blk) return reply({ results: [], has_more: false })
  const db = url.match(/\/data_sources\/([^/]+)\/query/)?.[1]
  if (db) return reply({ results: notionPages().filter((p) => p.db === db && cond(p, body.filter)), has_more: false })
  const id = url.match(/\/pages\/([^/?]+)/)?.[1]
  if (id) {
   if (!pages[id]) return reply({ message: "missing " + id }, 404)
   if (method === "PATCH") { // 실제 Notion 응답처럼 type·plain_text를 채운 페이지를 돌려준다
    for (const [k, v] of Object.entries(body.properties ?? {}) as [string, any][]) {
     const type = ["rich_text", "title", "select", "number", "date", "relation", "checkbox"].find((t) => t in v)
     if (type === "rich_text" || type === "title") v[type] = v[type].map((t: any) => ({ ...t, plain_text: t.text?.content ?? "" }))
     pages[id].properties[k] = { type, ...v }
    }
   }
   return reply(pages[id])
  }
  throw new Error("unmocked " + url)
 }
 return { pages, store, sbCalls, fetch }
}
async function withMock(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
 const f = fixture(), original = globalThis.fetch
 globalThis.fetch = f.fetch as typeof fetch
 try {
  // 복사본 채우기: 지운 기록까지 포함한 모든 페이지를 동기화 함수와 같은 행 변환으로 넣는다
  const of = (db: string) => Object.values(f.pages).filter((p) => p.db === db)
  const fill = (t: string, rows: any[]) => rows.forEach((r) => f.store[t].set(r.id, structuredClone(r)))
  fill("cr_sessions", await copy.toSessionRows(of("sessions")))
  fill("cr_attendance", of("attendance").map(copy.attendanceRow))
  fill("cr_records", await copy.toRecordRows(of("records")))
  fill("cr_activities", of("activities").map(copy.activityRow))
  f.pages.rGone.archived = true
  await run(f)
 } finally { globalThis.fetch = original; Deno.env.delete("CLASS_ROOM_SOURCE"); Deno.env.set("CLASS_ROOM_COPY_WRITE", "off") }
}
function same(label: string, a: unknown, b: unknown) {
 const diffs = read.compareResults(a, b)
 assert(!diffs.length, `${label}: ${diffs.join(" | ")}\nnotion=${JSON.stringify(a)}\ncopy=${JSON.stringify(b)}`)
}

Deno.test("copy reads match Notion reads for every switched action", () => withMock(async () => {
 same("day t1", await room.loadDay("2026-10-13", "t1"), await read.loadDay("2026-10-13", "t1"))
 const day = await read.loadDay("2026-10-13")
 same("day all", await room.loadDay("2026-10-13"), day)
 assert(day.sessions[0].className === "중1 B" && day.sessions[0].arrived === 1 && day.makeupWaiting[0]?.className === "중2 A", "day content is real: " + JSON.stringify(day))
 same("days", await room.loadDays("2026-10-01", "2026-10-31", "t1"), await read.loadDays("2026-10-01", "2026-10-31", "t1"))
 same("classes t1", await room.loadClasses("2026-10-13", "t1"), await read.loadClasses("2026-10-13", "t1"))
 same("classes all", await room.loadClasses("2026-10-12"), await read.loadClasses("2026-10-12"))
 const session = await read.loadSession("s1")
 same("session", await room.loadSession("s1"), session)
 assert(session.students.length === 2 && session.homeworkDue[0]?.items.length === 2 && session.records.length === 3 && session.students[0].memo === " 집중 좋음 ", "session content is real; deleted record skipped; memo spaces kept")
 same("class-sessions", await room.loadClassSessions("s1"), await read.loadClassSessions("s1"))
 same("class-sessions around", await room.loadClassSessions("s1", "2026-10-20"), await read.loadClassSessions("s1", "2026-10-20"))
 const recs = await read.loadClassRecords("s1")
 same("class-records", await room.loadClassRecords("s1"), recs)
 assert(recs.records.length === 5 && !recs.records.some((r: any) => r.id === "rGone" || r.id === "recMk"), "class records: makeup session and deleted record left out")
 same("class-records makeup", await room.loadClassRecords("sMk"), await read.loadClassRecords("sMk"))
 const stats = await read.loadClassStats("s1", NOW)
 same("class-stats", await room.loadClassStats("s1", NOW), stats)
 assert(stats.month.counted === 4 && stats.homework.total === 3 && stats.tests.length === 2, "stats content is real: " + JSON.stringify(stats))
}))

Deno.test("validation errors are the same 400s", async () => {
 for (const fn of [() => read.loadDay("10/13"), () => read.loadDays("2026-10-18", "2026-10-12"), () => read.loadClasses("2026-10-13", "../x"), () => read.loadSession("../x"), () => read.loadClassSessions("s1", "10/1")]) {
  let status = 0
  try { await fn() } catch (e) { status = (e as any).status }
  assert(status === 400, "expected 400")
 }
})

Deno.test("source switch: notion by default, copy with fallback when the copy is missing a row, shadow returns Notion", () => withMock(async (f) => {
 const r1: any = await read.handleClassRoomWithSource({ action: "session", sessionId: "s1" })
 assert(r1._source === undefined && !f.sbCalls.length, "default reads Notion only")
 assert((await read.handleClassRoomWithSource({ action: "sync-copy" }) as any).synced === false, "sync-copy does nothing on notion")
 Deno.env.set("CLASS_ROOM_SOURCE", "copy")
 const r2: any = await read.handleClassRoomWithSource({ action: "session", sessionId: "s1" })
 assert(r2._source === "copy" && r2.students.length === 2)
 f.store.cr_attendance.delete("ab")
 const r3: any = await read.handleClassRoomWithSource({ action: "session", sessionId: "s1" })
 assert(r3._source === "notion" && r3.students.length === 2, "a missing attendance row falls back to Notion")
 f.store.cr_sessions.delete("sOther")
 assert((await read.handleClassRoomWithSource({ action: "session", sessionId: "sOther" }) as any)._source === "notion", "a missing session falls back to Notion")
 const books: any = await read.handleClassRoomWithSource({ action: "teachers" })
 assert(books._source === undefined, "actions without a copy reader stay on Notion")
 let status = 0
 try { await read.handleClassRoomWithSource({ action: "session", sessionId: "../x" }) } catch (e) { status = (e as any).status }
 assert(status === 400, "validation errors are not hidden by the fallback")
 const synced: any = await read.handleClassRoomWithSource({ action: "sync-copy" })
 assert(synced.synced === true, "sync-copy runs incremental on copy")
 Deno.env.set("CLASS_ROOM_SOURCE", "shadow")
 const r4: any = await read.handleClassRoomWithSource({ action: "class-stats", sessionId: "s1" })
 assert(r4._source === undefined && r4.month, "shadow answers with the Notion result")
 await new Promise((r) => setTimeout(r, 50)) // 뒤에서 도는 비교가 끝나도록
}))

Deno.test("copy mode: saves update the copy before answering (the screen reads right after)", () => withMock(async (f) => {
 Deno.env.set("CLASS_ROOM_SOURCE", "copy"); Deno.env.delete("CLASS_ROOM_COPY_WRITE")
 await room.saveAttendance([{ attendanceId: "aa", memo: "새 메모", status: "🔴 결석" }])
 const row = f.store.cr_attendance.get("aa")
 assert(row.memo === "새 메모" && row.status === "🔴 결석", "attendance row updated from the Notion response: " + JSON.stringify(row))
 await room.saveActivities([{ activityId: "hw2", submitted: true }])
 assert(f.store.cr_activities.get("hw2").homework_status === "🔵 제출", "activity row updated")
 const after: any = await read.handleClassRoomWithSource({ action: "session", sessionId: "s1" })
 assert(after._source === "copy" && after.students.find((s: any) => s.attendanceId === "aa").memo === "새 메모")
}))

Deno.test("compareResults: same instant in different formats is equal, order-only differences are named", () => {
 assert(!read.compareResults({ a: "2026-10-13T16:52:00.000+09:00" }, { a: "2026-10-13T07:52:00+00:00" }).length)
 assert(read.compareResults({ a: [{ x: 1 }, { x: 2 }] }, { a: [{ x: 2 }, { x: 1 }] }).join() === "순서만 다름")
 const d = read.compareResults({ a: { b: "x" }, _source: "n" }, { a: { b: "y" }, _source: "c" })
 assert(d.length === 1 && d[0].startsWith("a.b notion=\"x\""), d.join())
})
