// 수업 관리 복사본(v2.5.113) 테스트. Notion·Supabase 호출은 모두 가짜 응답. 실제 키·데이터 없음.
function assert(value: unknown, message = "assertion failed") { if (!value) throw new Error(message) }
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_CLASS_SESSION_ID: "sessions", DATA_SOURCE_ATTENDANCE_ID: "attendance", DATA_SOURCE_LEARNING_RECORD_ID: "records", DATA_SOURCE_STUDY_ACTIVITY_ID: "activities" })) Deno.env.set(key, value)
const copy = await import("./classRoomCopy.ts")
const rel = (...ids: string[]) => ({ type: "relation", relation: ids.map((id) => ({ id })) })
const title = (s: string) => ({ type: "title", title: [{ plain_text: s }] })
const rt = (s: string) => ({ type: "rich_text", rich_text: s ? [{ plain_text: s }] : [] })
const sel = (s: string | null) => ({ type: "select", select: s ? { name: s } : null })
const fdate = (s: string) => ({ type: "formula", formula: { type: "date", date: { start: s } } })
const NOW = Date.parse("2026-10-14T03:00:00Z")
const E = "2026-10-14T01:00:00.000Z"

function fixture() {
 const pages: Record<string, any> = {
  cls: { id: "cls", properties: { "클래스명": title("중1 A"), "이모지": rt("🟡") } },
  g: { id: "g", properties: { "진도교재": title("RPM(중1 A)") } },
  reg: { id: "reg", properties: { "교재명": title("개념원리 1-2") } },
  s1: { id: "s1", db: "sessions", created_time: E, last_edited_time: E, properties: { "이름": title("중1 A 10.14(수)"), "수업일시": { type: "date", date: { start: "2026-10-14T17:00:00.000+09:00", end: "2026-10-14T18:00:00.000+09:00" } }, "클래스": rel("cls"), "담당강사": rel("t1"), "출석": rel("a1"), "학습기록": rel("r1"), "보강": { type: "checkbox", checkbox: false }, "출석현황": { type: "formula", formula: { type: "string", string: "1/1" } } } },
  s0: { id: "s0", db: "sessions", created_time: E, last_edited_time: E, properties: { "이름": title("중1 A 10.12(월)"), "수업일시": { type: "date", date: { start: "2026-10-12T17:00:00.000+09:00" } }, "클래스": rel("cls"), "출석": rel(), "학습기록": rel() } },
  sOld: { id: "sOld", db: "sessions", created_time: E, last_edited_time: E, properties: { "이름": title("옛 수업"), "수업일시": { type: "date", date: { start: "2025-01-01T17:00:00.000+09:00" } }, "클래스": rel("cls") } },
  a1: { id: "a1", db: "attendance", created_time: E, last_edited_time: E, properties: { "출석": title("a1"), "학생이름(보고서)": { type: "formula", formula: { type: "string", string: "김하늘" } }, "수업": rel("s1"), "등록": rel("ra"), "수업일시": { type: "date", date: { start: "2026-10-14T17:00:00.000+09:00" } }, "출석 상태": sel("🟢 출석"), "등원스템프": { type: "date", date: { start: "2026-10-14T16:52:00.000+09:00" } }, "메모": rt("집중 좋음"), "선생님 한마디": rt(""), "과제": rel("k1") } },
  r1: { id: "r1", db: "records", created_time: E, last_edited_time: E, properties: { "학습": title("[과제] RPM"), "구분": sel("과제"), "수업": rel("s1"), "진도교재": rel("g"), "범위": rt("p.40-45"), "단원": rt("1-1. 소인수분해"), "내용": rt("풀이"), "학습활동": rel("k1") } },
  r2: { id: "r2", db: "records", created_time: E, last_edited_time: E, properties: { "학습": title("[학습] 개념"), "구분": sel("학습"), "수업": rel("s0"), "교재": rel("reg"), "진도교재": rel("g"), "주제": rt("") } },
  k1: { id: "k1", db: "activities", created_time: E, last_edited_time: E, properties: { "학습활동": title("김하늘 과제"), "학습기록": rel("r1"), "출석": rel("a1"), "등록": rel("ra"), "과제상태": sel("🔵 제출"), "과제 마감일": fdate("2026-10-16T00:00:00.000+09:00"), "정답 문항": { type: "number", number: null } } },
 }
 const db: Record<string, Map<string, any>> = { cr_sessions: new Map(), cr_attendance: new Map(), cr_records: new Map(), cr_activities: new Map() }
 const cursors = new Map<string, string>(), queries: any[] = []
 const cond = (p: any, f: any): boolean => {
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
 const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
 const fetch = async (input: any, init: any = {}) => {
  const url = String(input), method = init.method ?? "GET"
  const ds = url.match(/\/data_sources\/([^/]+)\/query/)?.[1]
  if (ds) { const body = JSON.parse(init.body); queries.push({ ds, filter: body.filter }); return reply({ results: Object.values(pages).filter((p) => p.db === ds && cond(p, body.filter)), has_more: false }) }
  const pid = url.match(/\/pages\/([^/?]+)/)?.[1]
  if (pid) return pages[pid] ? reply(pages[pid]) : reply({ message: "not found" }, 404)
  const u = new URL(url)
  if (u.pathname === "/rest/v1/sync_cursors") {
   if (method === "POST") { for (const r of JSON.parse(init.body)) cursors.set(r.source, r.last_synced_at); return reply(null, 201) }
   const src = u.searchParams.get("source")!.replace("eq.", ""); return reply(cursors.has(src) ? [{ last_synced_at: cursors.get(src) }] : [])
  }
  const table = u.pathname.replace("/rest/v1/", "")
  const rows = db[table]
  if (!rows) throw new Error("unexpected url " + url)
  if (method === "POST") { for (const r of JSON.parse(init.body)) rows.set(r.id, r); return reply(null, 201) }
  if (method === "DELETE") { const list = u.searchParams.get("id")!.replace(/^in\.\(|\)$/g, "").split(",").map((x) => x.replace(/"/g, "")); list.forEach((id) => rows.delete(id)); return new Response(null, { status: 204 }) }
  const range = [...u.searchParams.entries()].filter(([k]) => k === "starts_at" || k === "class_at")
  const ok = (r: any) => range.every(([k, v]) => { const [op, val] = v.split(/\.(.+)/); const t = Date.parse(r[k]); return op === "gte" ? t >= Date.parse(val) : t < Date.parse(val) })
  return reply([...rows.values()].filter(ok).map((r) => ({ id: r.id })))
 }
 return { pages, db, cursors, queries, fetch }
}
async function withMock(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
 const original = globalThis.fetch, f = fixture()
 globalThis.fetch = f.fetch as typeof fetch
 try { await run(f) } finally { globalThis.fetch = original }
}

Deno.test("rows: session, attendance, record, activity carry what the class manager shows", () => {
 const f = fixture()
 const s = copy.sessionRow(f.pages.s1, new Map([["cls", { name: "중1 A", emoji: "🟡" }]]))
 assert(s.start_text === "2026-10-14T17:00:00.000+09:00" && s.starts_at === "2026-10-14T08:00:00.000Z" && s.class_name === "중1 A" && s.class_emoji === "🟡", JSON.stringify(s))
 assert(JSON.stringify(s.attendance_ids) === '["a1"]' && JSON.stringify(s.record_ids) === '["r1"]' && s.is_makeup === false && s.attendance_summary === "1/1" && s.notion_edited_at === E)
 const a = copy.attendanceRow(f.pages.a1)
 assert(a.student_name === "김하늘" && a.status === "🟢 출석" && a.arrived_at === "2026-10-14T07:52:00.000Z" && a.left_at === null && a.memo === "집중 좋음" && JSON.stringify(a.due_activity_ids) === '["k1"]', JSON.stringify(a))
 const names = new Map([["g", "RPM(중1 A)"], ["reg", "개념원리 1-2"]])
 assert(copy.recordRow(f.pages.r1, names).subject === "RPM", "progress book name before the brackets")
 assert(copy.recordRow(f.pages.r2, names).subject === "개념원리 1-2", "regular book name first")
 const r = copy.recordRow(f.pages.r1, names)
 assert(r.kind === "과제" && r.range === "p.40-45" && r.unit === "1-1. 소인수분해" && JSON.stringify(r.activity_ids) === '["k1"]', JSON.stringify(r))
 const k = copy.activityRow(f.pages.k1)
 assert(k.record_id === "r1" && k.attendance_id === "a1" && k.homework_status === "🔵 제출" && k.due_on === "2026-10-16" && k.due_at === "2026-10-15T15:00:00.000Z" && k.correct === null, JSON.stringify(k))
 assert(copy.seoulDay("2026-10-15T15:30:00.000Z") === "2026-10-16" && copy.seoulDay("2026-10-16") === "2026-10-16" && copy.seoulDay(null) === null)
})

Deno.test("reconcile: fills a table for the window, removes rows Notion no longer has, sets the first cursor", () => withMock(async (f) => {
 f.db.cr_sessions.set("gone", { id: "gone", starts_at: "2026-10-13T08:00:00.000Z" })
 f.db.cr_sessions.set("oldKeep", { id: "oldKeep", starts_at: "2024-01-01T08:00:00.000Z" })
 const r = await copy.reconcileTable("cr_sessions", 120, 60, NOW)
 assert(r.read === 2 && r.upserted === 2 && r.deleted === 1, JSON.stringify(r))
 assert(f.db.cr_sessions.has("s1") && f.db.cr_sessions.has("s0") && !f.db.cr_sessions.has("sOld") && !f.db.cr_sessions.has("gone") && f.db.cr_sessions.has("oldKeep"), "window only: deleted inside, outside untouched")
 assert(f.db.cr_sessions.get("s1").class_name === "중1 A" && f.cursors.has("cr_sessions"))
 const rec = await copy.reconcileTable("cr_records", 120, 60, NOW)
 assert(rec.upserted === 2 && rec.deleted === 0 && f.db.cr_records.get("r2").subject === "개념원리 1-2", JSON.stringify(rec))
 assert(f.queries.at(-1).filter.timestamp === "created_time", "records by created time")
}))

Deno.test("incremental: needs a cursor, then reads only pages edited since cursor minus 2 minutes", () => withMock(async (f) => {
 let msg = ""; try { await copy.incrementalTable("cr_attendance") } catch (e) { msg = (e as Error).message }
 assert(msg.includes("처음 채우기"), msg)
 f.cursors.set("cr_attendance", "2026-10-14T01:01:00.000Z")
 const r = await copy.incrementalTable("cr_attendance")
 assert(r.upserted === 1 && f.db.cr_attendance.get("a1").student_name === "김하늘", "edited 1 minute before cursor is inside the 2 minute margin")
 assert(f.queries.at(-1).filter.last_edited_time.on_or_after === "2026-10-14T00:59:00.000Z")
 assert(Date.parse(f.cursors.get("cr_attendance")!) > Date.parse("2026-10-14T01:01:00.000Z"), "cursor moves forward")
}))

Deno.test("class: one session's class around it, with attendance, records and activities", () => withMock(async (f) => {
 const r = await copy.syncClassOfSession("s1")
 assert(r.map((x) => x.table + ":" + x.upserted).join() === "cr_sessions:2,cr_attendance:1,cr_records:2,cr_activities:1", JSON.stringify(r))
 assert(!f.db.cr_sessions.has("sOld"), "outside 9 weeks before / 5 weeks after")
}))
