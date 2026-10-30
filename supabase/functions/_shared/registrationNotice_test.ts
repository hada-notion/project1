// All network calls are mocked. No live Notion/Solapi/Supabase calls or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const m = await import("./registrationNotice.ts")
const { registrationNoticeDeps: deps } = m

const rt = (s: string) => ({ type: "rich_text", rich_text: s ? [{ plain_text: s }] : [] })
const rel = (ids: string[]) => ({ type: "relation", relation: ids.map((id) => ({ id })) })
const date = (d: string | null, end: string | null = null) => ({ type: "date", date: d ? { start: d, end } : null })
const reg = (o: { start?: string | null; memo?: string; tts?: string[] } = {}) => ({
	id: "reg-new",
	properties: {
		"학생이름(등록)": { type: "rollup", rollup: { array: [{ title: [{ plain_text: "김하윤" }] }] } },
		"클래스": rel(["cls-b"]),
		"학생정보": rel(["stu-1"]),
		"등록일": date(o.start === undefined ? "2026-11-03" : o.start),
		"시간표": rel(o.tts ?? ["t1"]),
		"안내 메모": rt(o.memo ?? ""),
	},
})
const cls = (id: string, name: string) => ({ id, properties: { "클래스명": { type: "title", title: [{ plain_text: name }] } } })
const tt = (id: string, day: string, start: string, end: string, period: [string | null, string | null] = [null, null]) => ({
	id,
	properties: { "요일": { select: { name: day } }, "등원시간(HH:mm)": rt(start), "하원시간(HH:mm)": rt(end), "클래스": rel(["cls-b"]), "적용 기간": date(period[0], period[1]) },
})

Deno.test("v2.8.0 등록 안내: 블록 — 시작은 늘, 시간은 있을 때", () => {
	eq(m.enrollInfoBlock({ startOn: "11.03(화)", time: "화·목 17:00~19:00" }), "📅 시작  11.03(화)부터\n🕒 시간  화·목 17:00~19:00")
	eq(m.enrollInfoBlock({ startOn: "11.03(화)" }), "📅 시작  11.03(화)부터")
	eq(m.titleOf({ properties: { "학교명": { type: "title", title: [{ plain_text: "하다중" }] } } }), "하다중")
})

Deno.test("v2.8.0 등록 안내·클래스 변경 안내: 같은 변수, 시간은 등록일에 적용되는 시간표", () => {
	// 예전 시간표(~11/2)와 새 시간표(11/3~)가 함께 연결돼 있으면 등록일(11/3) 기준으로 새 시간표만
	const tts = [tt("old", "월", "16:00", "18:00", ["2026-09-01", "2026-11-02"]), tt("t1", "화", "17:00", "19:00", ["2026-11-03", null]), tt("t2", "목", "17:00", "19:00", ["2026-11-03", null])]
	const p: any = m.planRegistrationNotice(reg({ memo: "중1 A에서 옮깁니다." }), cls("cls-b", "중1 B 수학"), tts, "/r?token=x", "2026-10-31", { school: "하다중", grade: "중1" })
	eq(p.variables, {
		"#{학생이름}": "김하윤",
		"#{학교}": "하다중",
		"#{학년}": "중1",
		"#{클래스}": "중1 B 수학",
		"#{등록정보}": "📅 시작  11.03(화)부터\n🕒 시간  화·목 17:00~19:00",
		"#{전달사항}": "중1 A에서 옮깁니다.",
		"#{페이지ID}": "/r?token=x",
	})
	eq(p.timetable, "화·목 17:00~19:00")
	// 등록일이 지났으면 오늘 적용 중인 시간표
	const past: any = m.planRegistrationNotice(reg({ start: "2026-10-01" }), cls("cls-b", "중1 B 수학"), tts, "/r", "2026-10-31")
	eq([past.timetable, past.variables["#{학교}"], past.variables["#{전달사항}"]], ["월 16:00~18:00", "-", "없음"])
	eq(m.planRegistrationNotice(reg({ start: null }), cls("cls-b", "x"), [], "/r", "2026-10-31"), { error: "등록일이 비어 있습니다." })
	eq(m.planRegistrationNotice(reg(), null, [], "/r", "2026-10-31"), { error: "등록의 클래스가 비어 있습니다." })
})

Deno.test("v2.8.0 등록 안내: 등록의 (알림톡) 수식 값을 먼저 쓴다", () => {
	const f = (s: string) => ({ type: "formula", formula: { type: "string", string: s } })
	const r: any = reg()
	Object.assign(r.properties, { "학교(알림톡)": f("하다고"), "등록정보(알림톡)": f("📅 시작  11.04(수)부터"), "전달사항(알림톡)": f("수식 메모") })
	const p: any = m.planRegistrationNotice(r, cls("cls-b", "중1 B 수학"), [], "/r", "2026-10-31", { school: "서버값" })
	eq([p.variables["#{학교}"], p.variables["#{등록정보}"], p.variables["#{전달사항}"]], ["하다고", "📅 시작  11.04(수)부터", "수식 메모"])
})

Deno.test("v2.8.0 클래스 변경 안내: 한 건 — 클래스 변경 안내 행으로 보내고 안내한 시간표·메모 정리 뒤 ✅", async () => {
	const saved = { ...deps }
	const pages: Record<string, any> = { "reg-new": reg({ memo: "진도에 맞춰 옮깁니다." }), "cls-b": cls("cls-b", "중1 B 수학"), t1: tt("t1", "화", "17:00", "19:00"), "stu-1": { properties: {} } }
	const sent: any[] = [], updates: any[] = [], marks: string[] = [], logs: any[] = []
	Object.assign(deps, {
		markRunning: async () => {},
		getPage: async (id: string) => pages[id],
		reportToken: async () => "tok",
		today: () => "2026-10-31",
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
		eq(sent[0][3]["#{등록정보}"], "📅 시작  11.03(화)부터\n🕒 시간  화 17:00~19:00")
		eq(sent[0][3]["#{페이지ID}"].endsWith("?token=tok"), true)
		eq(logs, [["클래스 변경 안내", "성공"]])
		eq(updates, [["reg-new", ["안내한 시간표", "안내 메모"]]])
		eq(marks, ["done:reg-new"])
	} finally {
		Object.assign(deps, saved)
	}
})
