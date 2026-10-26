// All network calls are mocked. No live Notion/Solapi/Supabase calls or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_REGISTRATION_ID: "registrations", DATA_SOURCE_SCHEDULE_EVENT_ID: "events", REPORT_PATH: "/r.html" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const m = await import("./scheduleNotice.ts")
const { scheduleDeps: deps } = m
const { LessonConfigError } = await import("./lessonNotice.ts")

const rel = (...ids: string[]) => ({ type: "relation", relation: ids.map((id) => ({ id })), has_more: false })
const title = (s: string) => ({ type: "title", title: [{ plain_text: s }] })
const rt = (s: string) => ({ type: "rich_text", rich_text: s ? [{ plain_text: s }] : [] })
const ev = (id: string, o: { name?: string; cat?: string; start: string; end?: string | null; pub?: boolean; hidden?: boolean; cls?: string[]; stu?: string[]; school?: string[]; grade?: string[]; memo?: string; label?: string; sent?: string }) => ({
	id,
	properties: {
		"이름": title(o.name ?? ""),
		"구분": { type: "select", select: { name: o.cat ?? "📆 학원 일정" } },
		"날짜": { type: "date", date: { start: o.start, end: o.end ?? null } },
		"학부모 공개": { type: "checkbox", checkbox: o.pub ?? true },
		"숨김": { type: "checkbox", checkbox: o.hidden ?? false },
		"클래스": rel(...(o.cls ?? [])), "학생": rel(...(o.stu ?? [])), "학교": rel(...(o.school ?? [])), "학년": rel(...(o.grade ?? [])),
		"메모": rt(o.memo ?? ""), "안내 구분": rt(o.label ?? ""),
		"일정 안내 일시": { type: "date", date: o.sent ? { start: o.sent } : null },
	},
})
const reg = (id: string, student: string, name: string, active = true) => ({ id, properties: { "학생정보": rel(student), "수강상태": { type: "status", status: { name: active ? "🟢 수강 중" : "종료" } }, "학생이름(등록)": { type: "rollup", rollup: { array: [{ type: "title", title: [{ plain_text: name }] }] } }, "등록": rel() } })

Deno.test("v2.8.0 일정 안내: 다음 달, 한 줄·요약(5줄+외 N건), 학원 전체 판정, 구분 문구, 일시 표기", () => {
	eq(m.nextMonthKey(new Date("2026-10-27T03:00:00Z")), "2026-11")
	eq(m.nextMonthKey(new Date("2026-12-31T16:00:00Z")), "2027-02") // 서울은 이미 1월 1일
	eq(m.eventLine(ev("e", { name: "휴원", start: "2026-11-03" }))!.line, "11/3(화) 휴원")
	eq(m.eventLine(ev("e", { name: "시험 대비", start: "2026-11-09", end: "2026-11-11" }))!.line, "11/9(월)~11/11(수) 시험 대비")
	eq(m.eventLine(ev("e", { cat: "💤 휴원", start: "2026-11-03" }))!.line, "11/3(화) 휴원")
	const lines = [7, 1, 3, 2, 5, 4, 6].map((d) => ({ day: `2026-11-0${d}`, line: `L${d}` }))
	eq(m.summarize(lines), "L1\nL2\nL3\nL4\nL5\n외 2건")
	eq(m.isAcademyWide(ev("e", { start: "2026-11-03" })), true)
	eq(m.isAcademyWide(ev("e", { start: "2026-11-03", cls: ["c"] })), false)
	eq(m.eventLabel(ev("e", { cat: "💤 휴원", start: "2026-11-03" })), "휴원")
	eq(m.eventLabel(ev("e", { cat: "🏫 학사 일정", start: "2026-11-03" })), "학사 일정")
	eq(m.eventLabel(ev("e", { start: "2026-11-03", label: "휴강" })), "휴강")
	eq([m.sectionOf(ev("e", { cat: "💤 휴원", start: "2026-11-03" })), m.sectionOf(ev("e", { cat: "🏫 학사 일정", start: "2026-11-03" })), m.sectionOf(ev("e", { start: "2026-11-03" }))], ["휴원", "학교", "학원"])
	eq(m.sectionText([{ day: "2026-11-03", line: "11/3(화) 휴원", sec: "휴원" }], "학교"), "없음")
	eq(m.eventTimeText(ev("e", { start: "2026-11-03" })), "26.11.03(화)")
	eq(m.eventTimeText(ev("e", { start: "2026-11-03T14:00:00+09:00", end: "2026-11-03T16:00:00+09:00" })), "26.11.03(화) 14:00~16:00")
	eq(m.eventTimeText(ev("e", { start: "2026-11-09", end: "2026-11-11" })), "26.11.09(월)~26.11.11(수)")
})

type Calls = { enq: any[]; sends: any[]; logs: any[]; marks: string[]; updates: any[]; sent: any[] }
function mock(pages: Record<string, any>, o: { academy?: any[]; regs?: any[]; already?: string[]; sendThrows?: Error; byLink?: Record<string, any[]> } = {}): Calls {
	const c: Calls = { enq: [], sends: [], logs: [], marks: [], updates: [], sent: [] }
	Object.assign(deps, {
		getPage: async (id: string) => { if (!(id in pages)) throw new Error(`unexpected page ${id}`); return pages[id] },
		queryAllPages: async (ds: string, filter: any) => {
			const link = filter?.and?.find((f: any) => f.relation)
			if (ds === "events") return link ? (o.byLink?.[`${link.property}:${link.relation.contains}`] ?? []) : (o.academy ?? [])
			return ds === "registrations" ? (o.regs ?? []) : []
		},
		update: async (id: string, props: any) => { c.updates.push({ id, props }); if (props["마지막 오류"] && pages[id]) pages[id].properties["마지막 오류"] = { type: "rich_text", rich_text: props["마지막 오류"].rich_text.map((t: any) => ({ plain_text: t.text.content })) } },
		fullRelationIds: async (page: any, name: string) => (page.properties?.[name]?.relation ?? []).map((r: any) => r.id),
		enqueue: async (target: string, payload: any) => { c.enq.push({ target, payload }) },
		send: async (code: string, regId: string, _phone: string, vars: any) => { if (o.sendThrows) throw o.sendThrows; c.sends.push({ code, regId, vars }) },
		log: async (a: any) => { c.logs.push({ cat: a.category, status: a.status, reg: a.registrationId }) },
		botUser: async () => null,
		token: async () => "tok",
		sentAcademy: async () => new Set(o.already ?? []),
		markSent: async (s: string, ids: string[], month: string) => { c.sent.push({ s, ids, month }) },
		markRunning: async (id: string) => { c.marks.push(`running:${id}`) },
		markDone: async (id: string) => { c.marks.push(`done:${id}`) },
		markError: async (id: string, msg: string) => { c.marks.push(`error:${id}:${msg}`) },
	})
	return c
}

Deno.test("v2.8.0 월간 일정 안내(반): 다음 달 반 공개 일정 + 학원 전체 일정, 학생마다 큐", async () => {
	const pages: Record<string, any> = {
		cls: { id: "cls", properties: { "클래스명": title("중2 B"), "일정 안내 월": rt(""), "일정": rel("c1", "c2", "c3", "c4") } },
		c1: ev("c1", { name: "보충", start: "2026-11-14", cls: ["cls"] }),
		c2: ev("c2", { name: "비공개", start: "2026-11-15", cls: ["cls"], pub: false }),
		c3: ev("c3", { name: "지난달", start: "2026-10-30", cls: ["cls"] }),
		c4: ev("c4", { name: "숨김", start: "2026-11-16", cls: ["cls"], hidden: true }),
	}
	const c = mock(pages, { academy: [ev("a1", { name: "휴원", cat: "💤 휴원", start: "2026-11-03" }), ev("x", { name: "다른 반", start: "2026-11-05", cls: ["other"] })], regs: [reg("r1", "s1", "김하윤"), reg("r2", "s2", "박지민"), reg("r3", "s3", "종료", false)] })
	await m.processScheduleMonthClassItem({ classId: "cls", month: "2026-11" })
	eq(c.enq.length, 2)
	eq(c.enq[0].target, "schedule-month-student")
	eq(c.enq[0].payload.classEvents, [{ id: "c1", day: "2026-11-14", line: "11/14(토) 보충", sec: "학원" }])
	eq(c.enq[0].payload.academyEvents, [{ id: "a1", day: "2026-11-03", line: "11/3(화) 휴원", sec: "휴원" }])
	eq([c.enq[0].payload.className, c.enq[1].payload.last], ["중2 B", true])
	eq(c.marks, ["running:cls"])
})

Deno.test("v2.8.0 월간 일정 안내(반): 같은 달 다시 누르면·일정이 없으면 ⚠️로 멈춤", async () => {
	let c = mock({ cls: { id: "cls", properties: { "클래스명": title("중2 B"), "일정 안내 월": rt("2026-11"), "일정": rel() } } })
	await m.processScheduleMonthClassItem({ classId: "cls", month: "2026-11" })
	eq(c.enq.length, 0)
	eq(c.marks[1].includes("이미 11월 일정 안내"), true)
	c = mock({ cls: { id: "cls", properties: { "클래스명": title("중2 B"), "일정 안내 월": rt(""), "일정": rel() } } }, { regs: [reg("r1", "s1", "김하윤")] })
	await m.processScheduleMonthClassItem({ classId: "cls", month: "2026-11" })
	eq(c.marks[1].includes("공개 일정이 없습니다"), true)
})

Deno.test("v2.8.0 월간 일정 안내(반): 학생 학교·학년 일정을 리포트 규칙대로 학생마다 더함", async () => {
	const pages: Record<string, any> = {
		cls: { id: "cls", properties: { "클래스명": title("중2 B"), "일정 안내 월": rt(""), "일정": rel() } },
		s1: { id: "s1", properties: { "학교": rel("schA"), "학년": rel("g2") } },
		s2: { id: "s2", properties: { "학교": rel("schB"), "학년": rel("g2") } },
	}
	const exam = ev("x1", { name: "A중 기말고사", cat: "🏫 학사 일정", start: "2026-11-09", end: "2026-11-11", school: ["schA"], grade: ["g2"] })
	const g3only = ev("x2", { name: "A중 3학년 행사", cat: "🏫 학사 일정", start: "2026-11-12", school: ["schA"], grade: ["g3"] })
	const allG2 = ev("x3", { name: "중2 전체 행사", cat: "🏫 학사 일정", start: "2026-11-20", grade: ["g2"] })
	const c = mock(pages, { regs: [reg("r1", "s1", "김하윤"), reg("r2", "s2", "박지민")], byLink: { "학교:schA": [exam, g3only], "학년:g2": [exam, allG2] } })
	await m.processScheduleMonthClassItem({ classId: "cls", month: "2026-11" })
	eq(c.enq.map((e) => e.payload.academyEvents.map((l: any) => l.id)), [["x1", "x3"], ["x3"]])
	eq(c.enq[0].payload.academyEvents[0], { id: "x1", day: "2026-11-09", line: "11/9(월)~11/11(수) A중 기말고사", sec: "학교" })
})

Deno.test("v2.8.0 월간 일정 안내(학생): 이미 받은 학원 전체 일정은 빼고 보내며, 보낸 학원 일정을 기록하고 마지막에 반 마침", async () => {
	const pages: Record<string, any> = { r1: reg("r1", "s1", "김하윤"), cls: { id: "cls", properties: { "마지막 오류": rt("") } } }
	const c = mock(pages, { already: ["a1"] })
	const base = { classId: "cls", className: "중2 B", month: "2026-11", classEvents: [{ id: "c1", day: "2026-11-14", line: "11/14(토) 보충", sec: "학원" as const }], academyEvents: [{ id: "a1", day: "2026-11-03", line: "11/3(화) 휴원", sec: "휴원" as const }, { id: "a2", day: "2026-11-20", line: "11/20(금) 설명회", sec: "학원" as const }, { id: "x1", day: "2026-11-09", line: "11/9(월)~11/11(수) A중 기말고사", sec: "학교" as const }] }
	await m.processScheduleMonthStudentItem({ ...base, regId: "r1", last: true })
	eq(c.sends.length, 1)
	eq(c.sends[0].code, "월간 일정 안내")
	eq(c.sends[0].vars, { "#{학생이름}": "김하윤", "#{클래스}": "중2 B", "#{안내월}": "11월", "#{휴원일정}": "없음", "#{학원일정}": "11/14(토) 보충\n11/20(금) 설명회", "#{학사일정}": "11/9(월)~11/11(수) A중 기말고사", "#{페이지ID}": "/r.html?token=tok" })
	eq(c.sent, [{ s: "s1", ids: ["a2", "x1"], month: "2026-11" }])
	eq(c.logs, [{ cat: "월간 일정 안내", status: "성공", reg: "r1" }])
	eq(c.updates.at(-1), { id: "cls", props: { "일정 안내 월": { rich_text: [{ text: { content: "2026-11" } }] } } })
	eq(c.marks, ["done:cls"])
})

Deno.test("v2.8.0 월간 일정 안내(학생): 받을 일정이 없으면 보내지 않고, 설정 꺼짐은 반 마지막 오류에 남기고 마지막에 ⚠️", async () => {
	let c = mock({ r1: reg("r1", "s1", "김하윤"), cls: { id: "cls", properties: { "마지막 오류": rt("") } } }, { already: ["a1"] })
	await m.processScheduleMonthStudentItem({ classId: "cls", className: "중2 B", month: "2026-11", regId: "r1", classEvents: [], academyEvents: [{ id: "a1", day: "2026-11-03", line: "x", sec: "휴원" }] })
	eq(c.sends.length, 0)
	const pages: Record<string, any> = { r1: reg("r1", "s1", "김하윤"), cls: { id: "cls", properties: { "마지막 오류": rt("") } } }
	c = mock(pages, { sendThrows: new LessonConfigError("알림톡 설정의 '월간 일정 안내' 행을 켜고…") })
	await m.processScheduleMonthStudentItem({ classId: "cls", className: "중2 B", month: "2026-11", regId: "r1", classEvents: [{ id: "c1", day: "2026-11-14", line: "x", sec: "학원" }], academyEvents: [], last: true })
	eq(c.logs.length, 0)
	eq(c.sent.length, 0)
	eq(c.marks.length, 1)
	eq(c.marks[0].startsWith("error:cls:김하윤: 알림톡 설정의 '월간 일정 안내'"), true)
})

Deno.test("v2.8.0 일정 안내(한 건): 연결된 학생·반의 수강 중 학생(겹치면 한 번), 날짜가 같으면 다시 안 보냄", async () => {
	const pages: Record<string, any> = {
		e1: ev("e1", { name: "휴강", cat: "💤 휴원", start: "2026-11-03", stu: ["s1"], cls: ["cls"], memo: "선생님 사정", label: "휴강" }),
		s1: { id: "s1", properties: { "등록": rel("r1", "r0") } },
		r1: reg("r1", "s1", "김하윤"), r0: reg("r0", "s1", "김하윤", false),
	}
	const c = mock(pages, { regs: [reg("r1", "s1", "김하윤"), reg("r2", "s2", "박지민")] })
	await m.processScheduleEventItem({ eventId: "e1" })
	eq(c.enq.map((e) => e.payload.regId), ["r1", "r2"])
	eq(c.enq[0].payload.vars, { "#{일정구분}": "휴강", "#{일정명}": "휴강", "#{일정일시}": "26.11.03(화)", "#{전달사항}": "선생님 사정" })
	eq(c.enq[1].payload.last, true)
	const c2 = mock({ e1: ev("e1", { start: "2026-11-03", cls: ["cls"], sent: "2026-11-03" }) })
	await m.processScheduleEventItem({ eventId: "e1" })
	eq(c2.enq.length, 0)
	eq(c2.marks[1].includes("이미 이 날짜로"), true)
	// 일정 페이지의 (일정안내) 수식이 있으면 그 값을 보낸다.
	const withF: any = ev("e1", { name: "휴강", start: "2026-11-03", cls: ["cls"] })
	withF.properties["일정일시(일정안내)"] = { type: "formula", formula: { type: "string", string: "수식 일시" } }
	const cf = mock({ e1: withF }, { regs: [reg("r1", "s1", "김하윤")] })
	await m.processScheduleEventItem({ eventId: "e1" })
	eq(cf.enq[0].payload.vars["#{일정일시}"], "수식 일시")
	const c3 = mock({ e1: ev("e1", { start: "2026-11-03" }) })
	await m.processScheduleEventItem({ eventId: "e1" })
	eq(c3.marks[1].includes("학생이나 클래스를 연결"), true)
})

Deno.test("v2.8.0 일정 안내(학생): 학생 이름을 넣어 보내고, 마지막이면 일정 안내 일시를 적고 ✅", async () => {
	const pages: Record<string, any> = { r1: reg("r1", "s1", "김하윤"), e1: { id: "e1", properties: { "마지막 오류": rt("") } } }
	const c = mock(pages)
	await m.processScheduleEventStudentItem({ eventId: "e1", regId: "r1", vars: { "#{일정구분}": "휴강", "#{일정명}": "휴강", "#{일정일시}": "26.11.03(화)", "#{전달사항}": "없음" }, dateStart: "2026-11-03", last: true })
	eq(c.sends[0].code, "일정 안내")
	eq(c.sends[0].vars["#{학생이름}"], "김하윤")
	eq(c.updates.at(-1), { id: "e1", props: { "일정 안내 일시": { date: { start: "2026-11-03" } } } })
	eq(c.marks, ["done:e1"])
})
