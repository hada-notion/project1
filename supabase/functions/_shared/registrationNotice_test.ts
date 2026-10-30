// All network calls are mocked. No live Notion/Solapi/Supabase calls or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const m = await import("./registrationNotice.ts")
const { registrationNoticeDeps: deps } = m

const rt = (s: string) => ({ type: "rich_text", rich_text: s ? [{ plain_text: s }] : [] })
const rel = (ids: string[]) => ({ type: "relation", relation: ids.map((id) => ({ id })) })
const date = (d: string | null) => ({ type: "date", date: d ? { start: d } : null })
const reg = (o: { id?: string; cls?: string; start?: string | null; end?: string | null; memo?: string; tts?: string[] } = {}) => ({
	id: o.id ?? "reg-new",
	properties: {
		"학생이름(등록)": { type: "rollup", rollup: { array: [{ title: [{ plain_text: "김하윤" }] }] } },
		"클래스": rel([o.cls ?? "cls-b"]),
		"학생정보": rel(["stu-1"]),
		"등록일": date(o.start === undefined ? "2026-11-03" : o.start),
		"종료일": date(o.end ?? null),
		"시간표": rel(o.tts ?? ["t1"]),
		"안내 메모": rt(o.memo ?? ""),
	},
})
const cls = (id: string, name: string) => ({ id, properties: { "클래스명": { type: "title", title: [{ plain_text: name }] } } })
const tt = (id: string, day: string, start: string, end: string, c = "cls-b") => ({ id, properties: { "요일": { select: { name: day } }, "등원시간(HH:mm)": rt(start), "하원시간(HH:mm)": rt(end), "클래스": rel([c]) } })

Deno.test("v2.8.0 등록 안내: 블록 — 시작은 늘, 시간은 있을 때", () => {
	eq(m.enrollInfoBlock({ startOn: "11.03(화)", time: "화·목 17:00~19:00" }), "📅 시작  11.03(화)부터\n🕒 시간  화·목 17:00~19:00")
	eq(m.enrollInfoBlock({ startOn: "11.03(화)" }), "📅 시작  11.03(화)부터")
	eq(m.classChangeBlock({ before: "중1 A 수학", after: "중1 B 수학", time: "화 17:00~19:00", applyOn: "11.03(화)" }), "🔁 기존  중1 A 수학\n🏛 변경  중1 B 수학\n🕒 시간  화 17:00~19:00\n📅 적용  11.03(화)부터")
})

Deno.test("v2.8.0 클래스 변경 안내: 직전 반 = 다른 반 등록 중 종료일이 등록일 이전·가장 늦은 것", () => {
	const me = reg()
	const others = [
		me,
		reg({ id: "old-1", cls: "cls-a", start: "2026-03-02", end: "2026-10-31" }),
		reg({ id: "old-0", cls: "cls-z", start: "2025-03-02", end: "2026-02-28" }),
		reg({ id: "same-class", cls: "cls-b", start: "2026-01-01", end: "2026-11-01" }),
		reg({ id: "running", cls: "cls-e", start: "2026-03-02", end: null }),
		reg({ id: "later", cls: "cls-c", start: "2026-03-02", end: "2026-12-31" }),
	]
	eq(m.previousRegistration(me, others)?.id, "old-1")
	eq(m.previousRegistration(me, [me, others[4]]), null)
	eq(m.previousRegistration(reg({ start: null }), others), null)
})

Deno.test("v2.8.0 등록 안내·클래스 변경 안내: 계획 변수와 오류", () => {
	const p: any = m.planRegistrationNotice("등록 안내", reg({ memo: "첫 수업에 교재를 챙겨 주세요." }), cls("cls-b", "중1 B 수학"), [tt("t1", "화", "17:00", "19:00"), tt("t2", "목", "17:00", "19:00")], null, "/r?token=x", { school: "하다중", grade: "중1" })
	eq(p.variables, {
		"#{학생이름}": "김하윤",
		"#{전달사항}": "첫 수업에 교재를 챙겨 주세요.",
		"#{페이지ID}": "/r?token=x",
		"#{학교}": "하다중",
		"#{학년}": "중1",
		"#{클래스}": "중1 B 수학",
		"#{등록정보}": "📅 시작  11.03(화)부터\n🕒 시간  화·목 17:00~19:00",
	})
	eq(p.timetable, "화·목 17:00~19:00")
	// 학교·학년이 없으면 "-"(빈 변수로 보내지 않음)
	const blank: any = m.planRegistrationNotice("등록 안내", reg(), cls("cls-b", "중1 B 수학"), [], null, "/r")
	eq([blank.variables["#{학교}"], blank.variables["#{학년}"], blank.variables["#{등록정보}"]], ["-", "-", "📅 시작  11.03(화)부터"])
	eq(m.titleOf({ properties: { "학교명": { type: "title", title: [{ plain_text: "하다중" }] } } }), "하다중")
	const c: any = m.planRegistrationNotice("클래스 변경 안내", reg(), cls("cls-b", "중1 B 수학"), [], cls("cls-a", "중1 A 수학"), "/r")
	eq([c.variables["#{변경정보}"], c.variables["#{전달사항}"], c.timetable], ["🔁 기존  중1 A 수학\n🏛 변경  중1 B 수학\n📅 적용  11.03(화)부터", "없음", ""])
	eq(m.planRegistrationNotice("클래스 변경 안내", reg(), cls("cls-b", "중1 B 수학"), [], null, "/r"), { error: "직전 반 등록을 찾지 못했습니다. 같은 학생의 예전 반 등록에 종료일(이 등록일 이전)이 있어야 합니다." })
	eq(m.planRegistrationNotice("등록 안내", reg({ start: null }), cls("cls-b", "x"), [], null, "/r"), { error: "등록일이 비어 있습니다." })
	eq(m.planRegistrationNotice("등록 안내", reg(), null, [], null, "/r"), { error: "등록의 클래스가 비어 있습니다." })
})

Deno.test("v2.8.0 클래스 변경 안내: 한 건 — 직전 반을 찾아 보내고 안내한 시간표를 적은 뒤 ✅", async () => {
	const saved = { ...deps }
	const pages: Record<string, any> = { "reg-new": reg(), "cls-b": cls("cls-b", "중1 B 수학"), "cls-a": cls("cls-a", "중1 A 수학"), t1: tt("t1", "화", "17:00", "19:00") }
	const sent: any[] = [], updates: any[] = [], marks: string[] = [], logs: any[] = []
	Object.assign(deps, {
		markRunning: async () => {},
		getPage: async (id: string) => pages[id],
		queryAllPages: async () => [pages["reg-new"], reg({ id: "old-1", cls: "cls-a", start: "2026-03-02", end: "2026-10-31" })],
		reportToken: async () => "tok",
		send: async (...a: any[]) => { sent.push(a) },
		log: async (a: any) => { logs.push([a.category, a.status]) },
		update: async (id: string, props: any) => { updates.push([id, Object.keys(props)]) },
		botUser: async () => "bot",
		markDone: async (id: string) => { marks.push("done:" + id) },
		markError: async (id: string, msg: string) => { marks.push("error:" + msg) },
	})
	try {
		await m.processRegistrationNoticeQueueItem({ regId: "reg-new", kind: "클래스 변경 안내" })
		eq(sent[0][0], "클래스 변경 안내")
		eq(sent[0][3]["#{변경정보}"], "🔁 기존  중1 A 수학\n🏛 변경  중1 B 수학\n🕒 시간  화 17:00~19:00\n📅 적용  11.03(화)부터")
		eq(sent[0][3]["#{페이지ID}"].endsWith("?token=tok"), true)
		eq(logs, [["클래스 변경 안내", "성공"]])
		eq(updates, [["reg-new", ["안내한 시간표", "안내 메모"]]])
		eq(marks, ["done:reg-new"])
		// 직전 반이 없으면 보내지 않고 ⚠️
		sent.length = 0; marks.length = 0
		deps.queryAllPages = async () => [pages["reg-new"]]
		await m.processRegistrationNoticeQueueItem({ regId: "reg-new", kind: "클래스 변경 안내" })
		eq([sent.length, marks[0].startsWith("error:직전 반")], [0, true])
	} finally {
		Object.assign(deps, saved)
	}
})
