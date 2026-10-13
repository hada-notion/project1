// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
function assert(value: unknown, message = "assertion failed") { if (!value) throw new Error(message) }
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", SB_URL: "https://mock.supabase", DATA_SOURCE_CLASS_SESSION_ID: "sessions", DATA_SOURCE_ATTENDANCE_ID: "attendance", DATA_SOURCE_LEARNING_RECORD_ID: "records", DATA_SOURCE_STUDY_ACTIVITY_ID: "activities", DATA_SOURCE_PROGRESS_BOOK_ID: "books", DATA_SOURCE_REGISTRATION_ID: "registrations" })) Deno.env.set(key, value)
const room = await import("./classRoom.ts")
const rel = (...ids: string[]) => ({ relation: ids.map((id) => ({ id })) })
const title = (s: string) => ({ type: "title", title: [{ plain_text: s, text: { content: s } }] })
const text = (s: string) => ({ type: "rich_text", rich_text: s ? [{ plain_text: s, text: { content: s } }] : [] })
const formula = (s: string) => ({ type: "formula", formula: { type: "string", string: s } })
const ids = (p: any, key: string) => (p.properties[key]?.relation ?? []).map((x: any) => x.id).join(",")
const D = "2026-10-13T08:00:00.000Z" // 17:00 KST
function fixture() {
 const pages: Record<string, any> = {
  cls: { id: "cls", db: "classes", properties: { "클래스명": title("중1 B"), "이모지": text("🟡") } },
  regular: { id: "regular", db: "regulars", properties: { "교재명": title("개념원리 1-2"), "과목": rel("math") } },
  t1: { id: "t1", db: "teachers", properties: { "이름": title("안규빈"), "직책": { select: { name: "강사" } } } },
  s1: { id: "s1", db: "sessions", properties: { "이름": title("중1 B 10.13(화)"), "수업일시": { date: { start: D, end: "2026-10-13T09:00:00.000Z" } }, "담당강사": rel("t1"), "클래스": rel("cls"), "등록": rel("ra", "rb"), "출석": rel("aa", "ab"), "학습기록": rel(), "보강": { checkbox: false }, "출석현황": formula("✅ 정상(2)") } },
  sOther: { id: "sOther", db: "sessions", properties: { "이름": title("다른 날"), "수업일시": { date: { start: "2026-10-14T08:00:00.000Z" } }, "담당강사": rel("t1"), "출석": rel(), "학습기록": rel(), "보강": { checkbox: false } } },
  sPrev: { id: "sPrev", db: "sessions", properties: { "이름": title("중1 B 10.08(목)"), "수업일시": { date: { start: "2026-10-08T08:00:00.000Z" } }, "클래스": rel("cls"), "출석": rel("pa", "pb", "pc"), "학습기록": rel(), "보강": { checkbox: false } } },
  sMk: { id: "sMk", db: "sessions", properties: { "이름": title("보강"), "수업일시": { date: { start: "2026-10-09T08:00:00.000Z" } }, "클래스": rel("cls"), "출석": rel(), "학습기록": rel(), "보강": { checkbox: true } } },
  pa: { id: "pa", db: "attendance", properties: { "출석": title("pa"), "수업": rel("sPrev"), "수업일시": { date: { start: "2026-10-08T08:00:00.000Z" } }, "출석 상태": { select: { name: "🟢 출석" } } } },
  pb: { id: "pb", db: "attendance", properties: { "출석": title("pb"), "수업": rel("sPrev"), "수업일시": { date: { start: "2026-10-08T08:00:00.000Z" } }, "출석 상태": { select: { name: "🔴 결석" } } } },
  pc: { id: "pc", db: "attendance", properties: { "출석": title("pc"), "수업": rel("sPrev"), "수업일시": { date: { start: "2026-10-08T08:00:00.000Z" } }, "출석 상태": { select: null } } },
  ra: { id: "ra", db: "registrations", properties: { "이름": title("김하늘 중1 B"), "진도교재": rel("group", "indA") } },
  rb: { id: "rb", db: "registrations", properties: { "이름": title("박서준 중1 B"), "진도교재": rel("group", "indB") } },
  rc: { id: "rc", db: "registrations", properties: { "이름": title("이도윤 중2 A"), "진도교재": rel("other") } },
  group: { id: "group", db: "books", properties: { "진도교재": title("개념원리(중1 B)"), "진도방식": { select: { name: "그룹 진도" } }, "진행상태": { status: { name: "진행 중" } }, "정규교재": rel("regular"), "반별교재": rel() } },
  indA: { id: "indA", db: "books", properties: { "진도교재": title("RPM(김하늘)"), "진도방식": { select: { name: "개별 진도" } }, "진행상태": { status: { name: "진행 중" } }, "정규교재": rel(), "반별교재": rel("tpl") } },
  indB: { id: "indB", db: "books", properties: { "진도교재": title("RPM(박서준)"), "진도방식": { select: { name: "개별 진도" } }, "진행상태": { status: { name: "진행 중" } }, "정규교재": rel(), "반별교재": rel("tpl") } },
  aa: { id: "aa", db: "attendance", properties: { "출석": title("aa"), "학생이름(보고서)": formula("김하늘"), "등록": rel("ra"), "수업": rel("s1"), "수업일시": { date: { start: D } }, "출석 상태": { select: { name: "🟢 출석" } }, "등원스템프": { date: { start: "2026-10-13T07:52:00.000Z" } }, "메모": text("집중 좋음"), "선생님 한마디": text(""), "과제": rel("hw1") } },
  ab: { id: "ab", db: "attendance", properties: { "출석": title("ab"), "학생이름(보고서)": formula("박서준"), "등록": rel("rb"), "수업": rel("s1"), "수업일시": { date: { start: D } }, "출석 상태": { select: null }, "메모": text(""), "선생님 한마디": text(""), "과제": rel("hw2") } },
  wait1: { id: "wait1", db: "attendance", properties: { "출석": title("w1"), "학생이름(보고서)": formula("이도윤"), "클래스(보고서)": formula("중2 A"), "등록": rel("rc"), "수업": rel(), "수업일시": { date: { start: "2026-10-13T06:00:00.000Z" } }, "출석 상태": { select: { name: "🔵 보강" } } } },
  waitOld: { id: "waitOld", db: "attendance", properties: { "출석": title("old"), "등록": rel("rc"), "수업": rel(), "수업일시": { date: { start: "2026-10-12T06:00:00.000Z" } }, "출석 상태": { select: { name: "🔵 보강" } } } },
  rec0: { id: "rec0", db: "records", properties: { "학습": title("[과제] 개념원리 1-2(중1 B) 10.10(금)"), "구분": { select: { name: "과제" } }, "범위": text("p.31-35"), "학습활동": rel("hw1", "hw2") } },
  hw1: { id: "hw1", db: "activities", properties: { "학습활동": title("hw1"), "학습기록": rel("rec0"), "등록": rel("ra"), "출석": rel("aa"), "과제상태": { select: { name: "🔵 제출" } } } },
  hw2: { id: "hw2", db: "activities", properties: { "학습활동": title("hw2"), "학습기록": rel("rec0"), "등록": rel("rb"), "출석": rel("ab"), "과제상태": { select: { name: "🔴 미제출" } } } },
 }
 const writes: any[] = [], created: any[] = [], queries: any[] = []
 function cond(p: any, f: any): boolean {
  if (!f) return true
  if (f.and) return f.and.every((x: any) => cond(p, x))
  if (f.or) return f.or.some((x: any) => cond(p, x))
  const v = p.properties[f.property]
  if (f.relation?.contains) return (v?.relation ?? []).some((r: any) => r.id === f.relation.contains)
  if (f.relation?.is_empty) return !(v?.relation ?? []).length
  if (f.select?.equals) return v?.select?.name === f.select.equals
  if (f.rich_text?.is_not_empty) return !!(v?.rich_text ?? []).length
  if (f.date?.on_or_after) return Date.parse(v?.date?.start) >= Date.parse(f.date.on_or_after)
  if (f.date?.before) return Date.parse(v?.date?.start) < Date.parse(f.date.before)
  throw new Error("unexpected filter " + JSON.stringify(f))
 }
 const reply = (p: any, status = 200) => new Response(JSON.stringify(structuredClone(p)), { status })
 const fetch = async (input: any, init: any = {}) => {
  const url = String(input), body = init.body ? JSON.parse(init.body) : {}
  if (url.endsWith("/data_sources/sessions")) return reply({ properties: { "담당강사": { relation: { data_source_id: "teachers" } } } })
  const db = url.match(/\/data_sources\/([^/]+)\/query/)?.[1]
  if (db) { queries.push({ db, filter: body.filter }); return reply({ results: Object.values(pages).filter((p) => p.db === db && !p.archived && cond(p, body.filter)), has_more: false }) }
  const id = url.match(/\/pages\/([^/?]+)/)?.[1]
  if (id) {
   if (!pages[id]) return reply({ message: "missing " + id }, 404)
   if (init.method === "PATCH") { writes.push({ id, body }); Object.assign(pages[id].properties, body.properties ?? {}); if (body.archived) pages[id].archived = true }
   return reply(pages[id])
  }
  if (url.endsWith("/pages") && init.method === "POST") { const page = { id: "new" + created.length, db: body.parent.data_source_id, properties: body.properties }; pages[page.id] = page; created.push(page); return reply(page) }
  throw new Error("unmocked " + url)
 }
 return { pages, writes, created, queries, fetch }
}
async function withMock(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
 const f = fixture(), original = globalThis.fetch
 globalThis.fetch = f.fetch as typeof fetch
 try { await run(f) } finally { globalThis.fetch = original }
}
async function rejects(fn: () => Promise<unknown>, status: number) {
 try { await fn() } catch (e) { assert(e instanceof room.ClassRoomError && e.status === status, `expected ${status}, got ${(e as Error).message}`); return }
 throw new Error("expected rejection " + status)
}

Deno.test("date helpers use Seoul time and the existing title shape", () => {
 assert(room.seoulLabel("2026-10-12T15:30:00.000Z") === "10.13(화)")
 assert(room.recordTitle("과제", "실험 정리", "중1 B", D) === "[과제] 실험 정리(중1 B) 10.13(화)")
 assert(room.recordTitle("학습", "개념원리", "", D) === "[학습] 개념원리 10.13(화)")
 const r = room.seoulDayRange("2026-10-13"); assert(r.start === "2026-10-12T15:00:00.000Z" && r.end === "2026-10-13T15:00:00.000Z")
})
Deno.test("day: that day's sessions for the teacher and only unassigned makeup attendance", () => withMock(async (f) => {
 const day = await room.loadDay("2026-10-13", "t1")
 assert(day.sessions.map((s) => s.id).join() === "s1" && day.sessions[0].time === "17:00–18:00" && day.sessions[0].attendanceSummary === "✅ 정상(2)")
 assert(day.makeupWaiting.map((w) => w.attendanceId).join() === "wait1" && day.makeupWaiting[0].className === "중2 A")
 assert(f.queries.some((q) => JSON.stringify(q.filter).includes('"contains":"t1"')))
 const s1 = day.sessions[0]; assert(s1.className === "중1 B" && s1.classEmoji === "🟡" && s1.arrived === 1 && s1.students === 2, "class emoji, name and arrived count")
 await rejects(() => room.loadDay("10/13"), 400)
}))
Deno.test("classes: the teacher's classes with today's sessions, the next and the last one", () => withMock(async () => {
 const mine = (await room.loadClasses("2026-10-13", "t1")).classes
 assert(mine.length === 1 && mine[0].classId === "cls" && mine[0].name === "중1 B" && mine[0].emoji === "🟡", "only classes with the teacher's non-makeup sessions")
 assert(mine[0].today.map((x) => x.id).join() === "s1" && mine[0].today[0].time === "17:00–18:00" && mine[0].next === null && mine[0].last === null)
 const all = (await room.loadClasses("2026-10-12")).classes
 assert(all.length === 1 && !all[0].today.length && all[0].next?.id === "s1" && all[0].next?.date === "2026-10-13" && all[0].last?.id === "sPrev" && all[0].last?.date === "2026-10-08", "makeup sessions are skipped")
 await rejects(() => room.loadClasses("10/13"), 400)
 await rejects(() => room.loadClasses("2026-10-13", "../x"), 400)
}))
Deno.test("days: Seoul dates that have the teacher's sessions in a range", () => withMock(async () => {
 const r = await room.loadDays("2026-10-12", "2026-10-18", "t1")
 assert(r.dates.join() === "2026-10-13,2026-10-14", r.dates.join())
 await rejects(() => room.loadDays("2026-10-18", "2026-10-12"), 400)
 await rejects(() => room.loadDays("2026-09-01", "2026-10-31"), 400)
 await rejects(() => room.loadDays("2026-10-12", "2026-10-18", "../x"), 400)
}))
Deno.test("class-sessions: same class around the session with attendance counts, makeups skipped", () => withMock(async () => {
 const r = await room.loadClassSessions("s1")
 assert(r.sessions.map((s) => s.id).join() === "sPrev,s1", r.sessions.map((s) => s.id).join())
 const p = r.sessions[0]; assert(p.date === "2026-10-08" && p.total === 3 && p.present === 1 && p.absent === 1 && p.missing === 1, JSON.stringify(p))
 const now = r.sessions[1]; assert(now.date === "2026-10-13" && now.time === "17:00–18:00" && now.present === 1 && now.missing === 1, JSON.stringify(now))
 assert((await room.loadClassSessions("sOther")).sessions.length === 0)
 await rejects(() => room.loadClassSessions("../x"), 400)
 await rejects(() => room.loadClassSessions("s1", "10/13"), 400)
 assert((await room.loadClassSessions("s1", "2026-12-20")).sessions.length === 0, "around moves the range")
}))
Deno.test("session: students, today's homework due grouped by record, records", () => withMock(async () => {
 const s = await room.loadSession("s1")
 assert(s.session.classEmoji === "🟡", "class emoji on the session")
 assert(s.session.className === "중1 B" && s.students.map((x) => x.name).join() === "김하늘,박서준")
 assert(s.students[0].memo === "집중 좋음" && s.students[0].status === "🟢 출석" && !("dueActivityIds" in s.students[0]))
 assert(s.homeworkDue.length === 1 && s.homeworkDue[0].items.map((i) => `${i.attendanceId}:${i.submitted}`).join() === "aa:true,ab:false")
}))
Deno.test("books: owners and template grouping data", () => withMock(async () => {
 const b = await room.loadBooks("s1")
 const g = b.books.find((x) => x.id === "group")!; assert(g.ownerIds.join() === "ra,rb" && g.mode === "그룹 진도")
 assert(b.books.filter((x) => x.templateId === "tpl").map((x) => x.ownerIds.join()).join("|") === "ra|rb")
}))
Deno.test("records: group book links the class, repeat returns the existing record", () => withMock(async (f) => {
 const r1 = await room.createRecords({ sessionId: "s1", kind: "학습", bookIds: ["group"] })
 const rec = f.created[0]; assert(r1.records[0].created && ids(rec, "등록") === "ra,rb" && ids(rec, "출석") === "aa,ab" && ids(rec, "교재") === "regular" && ids(rec, "과목") === "math")
 assert(rec.properties["학습"].title[0].text.content === "[학습] 개념원리 1-2(중1 B) 10.13(화)" && rec.properties["보강"] === undefined && rec.properties["학습정보 수정일"])
 f.pages.s1.properties["학습기록"] = rel(rec.id)
 const r2 = await room.createRecords({ sessionId: "s1", kind: "학습", bookIds: ["group"] })
 assert(!r2.records[0].created && r2.records[0].id === rec.id && f.created.length === 1)
}))
Deno.test("records: template batch makes one record per student's own book", () => withMock(async (f) => {
 const r = await room.createRecords({ sessionId: "s1", kind: "과제", bookIds: ["indA", "indB"] })
 assert(r.records.length === 2 && f.created.map((p) => ids(p, "등록") + "/" + ids(p, "출석")).join() === "ra/aa,rb/ab")
 assert(f.created[0].properties["학습"].title[0].text.content === "[과제] RPM(김하늘)(중1 B) 10.13(화)")
}))
Deno.test("records: no book uses the topic; chosen students only", () => withMock(async (f) => {
 await room.createRecords({ sessionId: "s1", kind: "평가", topic: "단원 평가", registrationIds: ["rb"] })
 const rec = f.created[0]; assert(ids(rec, "등록") === "rb" && ids(rec, "출석") === "ab" && rec.properties["진도교재"] === undefined)
 assert(rec.properties["주제"].rich_text[0].text.content === "단원 평가" && rec.properties["학습"].title[0].text.content === "[평가] 단원 평가(중1 B) 10.13(화)")
 const r3 = await room.createRecords({ sessionId: "s1", kind: "학습", topic: "실험 정리", range: " p.1-3 ", content: "• 관찰" })
 const rec3 = f.created.find((p) => p.id === r3.records[0].id); assert(rec3.properties["범위"].rich_text[0].text.content === "p.1-3" && rec3.properties["내용"].rich_text[0].text.content === "• 관찰", "range and content at creation")
 await rejects(() => room.createRecords({ sessionId: "s1", kind: "학습", topic: "x", range: 3 }), 400)
 await rejects(() => room.createRecords({ sessionId: "s1", kind: "숙제" }), 400)
 await rejects(() => room.createRecords({ sessionId: "s1", kind: "학습", registrationIds: ["rc"] }), 400)
}))
Deno.test("records: makeup session links owners only and checks 보강", () => withMock(async (f) => {
 f.pages.s1.properties["보강"] = { checkbox: true }; f.pages.s1.properties["클래스"] = rel()
 await room.createRecords({ sessionId: "s1", kind: "학습", bookIds: ["indB"] })
 const rec = f.created[0]; assert(ids(rec, "등록") === "rb" && rec.properties["보강"].checkbox === true && rec.properties["학습"].title[0].text.content === "[학습] RPM(박서준) 10.13(화)")
 f.pages.ra.properties["진도교재"] = rel("group"); f.pages.rb.properties["진도교재"] = rel("indB")
 await room.createRecords({ sessionId: "s1", kind: "과제", bookIds: ["group"] })
 assert(ids(f.created[1], "등록") === "ra", "group book in a makeup session links its owner only")
}))
Deno.test("update record: topic/range/content and title follow the rule", () => withMock(async (f) => {
 await room.createRecords({ sessionId: "s1", kind: "학습", topic: "실험" }); const id = f.created[0].id
 f.pages[id].properties["수업"] = rel("s1")
 await room.updateRecord({ recordId: id, topic: "실험 정리", range: "p.12-15", content: "• 결과 정리" })
 const w = f.writes.at(-1)!.body.properties
 assert(w["주제"].rich_text[0].text.content === "실험 정리" && w["범위"].rich_text[0].text.content === "p.12-15" && w["학습"].title[0].text.content === "[학습] 실험 정리(중1 B) 10.13(화)")
 await room.updateRecord({ recordId: id, bookId: "group" })
 const w2 = f.writes.at(-1)!.body.properties; assert(ids({ properties: w2 }, "진도교재") === "group" && w2["학습"].title[0].text.content === "[학습] 개념원리 1-2(중1 B) 10.13(화)")
}))
Deno.test("save attendance and activities: validated, stamped for the report sync", () => withMock(async (f) => {
 await room.saveAttendance([{ attendanceId: "ab", status: "🔴 결석", memo: "병결", comment: "다음 시간 보충해요" }])
 const p = f.writes[0].body.properties; assert(p["출석 상태"].select.name === "🔴 결석" && p["메모"].rich_text[0].text.content === "병결" && p["학습정보 수정일"].date.start)
 await rejects(() => room.saveAttendance([{ attendanceId: "ab", status: "🟡 지각" }]), 400)
 await rejects(() => room.saveAttendance([]), 400)
 await room.saveActivities([{ activityId: "hw2", submitted: true }, { activityId: "hw1", correct: 18, total: 20 }])
 assert(f.writes.some((w) => w.id === "hw2" && w.body.properties["과제상태"].select.name === "🔵 제출"))
 assert(f.writes.some((w) => w.id === "hw1" && w.body.properties["정답 문항"].number === 18 && w.body.properties["전체 문항"].number === 20))
 await rejects(() => room.saveActivities([{ activityId: "hw1", correct: 21, total: 20 }]), 400)
}))
Deno.test("makeup: create a session, unlink, and delete without touching attendance pages", () => withMock(async (f) => {
 const m = await room.createMakeupSession({ attendanceIds: ["wait1"], teacherId: "t1", start: "2026-10-13T06:00:00.000Z" })
 const s = f.pages[m.sessionId]; assert(s.properties["보강"].checkbox === true && ids(s, "등록") === "rc" && ids(s, "출석") === "wait1" && s.properties["시간표"] === undefined && s.properties["클래스"] === undefined)
 assert(s.properties["이름"].title[0].text.content === "보강 10.13(화) 15:00" && ids(f.pages.wait1, "수업") === m.sessionId && ids(f.pages.wait1, "담당강사") === "t1")
 await rejects(() => room.createMakeupSession({ attendanceIds: ["wait1"], teacherId: "t1", start: "2026-10-13T06:00:00.000Z" }), 409)
 await rejects(() => room.unlinkMakeup("aa"), 409) // regular session
 await room.unlinkMakeup("wait1"); assert(ids(f.pages.wait1, "수업") === "" && ids(f.pages.wait1, "담당강사") === "" && ids(f.pages[m.sessionId], "출석") === "")
 f.pages[m.sessionId].properties["학습기록"] = rel("rec0"); await rejects(() => room.deleteMakeupSession(m.sessionId), 409)
 f.pages[m.sessionId].properties["학습기록"] = rel(); f.pages[m.sessionId].properties["출석"] = rel("wait1"); f.pages.wait1.properties["수업"] = rel(m.sessionId)
 const del = await room.deleteMakeupSession(m.sessionId); assert(del.released === 1 && f.pages[m.sessionId].archived && !f.pages.wait1.archived && ids(f.pages.wait1, "수업") === "")
 await rejects(() => room.deleteMakeupSession("s1"), 409) // regular session
}))
Deno.test("unknown actions and malformed ids are rejected", () => withMock(async () => {
 await rejects(() => room.handleClassRoom({ action: "drop-all" }), 400)
 await rejects(() => room.handleClassRoom({ action: "session", sessionId: "../x" }), 400)
 await rejects(() => room.handleClassRoom({ action: "save-attendance", items: [{ attendanceId: "1".repeat(32), memo: "x" }].concat(Array(60).fill({ attendanceId: "1".repeat(32) })) }), 400)
}))
Deno.test("student space: recent homework, scored tests and past memos for the registration", () => withMock(async (f) => {
 f.pages.hw1.properties["구분"] = { type: "rollup", rollup: { array: [{ select: { name: "과제" } }] } }
 f.pages.hw1.properties["과제 마감일"] = { type: "formula", formula: { type: "date", date: { start: "2026-10-13" } } }
 f.pages.t9 = { id: "t9", db: "activities", properties: { "학습활동": title("t9"), "학습기록": rel("rec0"), "등록": rel("ra"), "구분": { rollup: { array: [{ select: { name: "평가" } }] } }, "정답 문항": { number: 18 }, "전체 문항": { number: 20 } } }
 f.pages.aOld = { id: "aOld", db: "attendance", properties: { "등록": rel("ra"), "수업일시": { date: { start: "2026-10-10T08:00:00.000Z" } }, "메모": text("지각 15분") } }
 const s = await room.loadStudent("ra")
 assert(s.homework.length === 1 && s.homework[0].submitted && s.homework[0].due === "2026-10-13" && s.homework[0].range === "p.31-35")
 assert(s.tests.length === 1 && s.tests[0].correct === 18 && s.tests[0].total === 20)
 assert(s.memos.map((m) => m.memo).sort().join() === "지각 15분,집중 좋음")
}))
