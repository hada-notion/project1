// All network calls are mocked. No live Notion/Solapi/Supabase calls or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const m = await import("./timetableNotice.ts")
const { timetableNoticeDeps: deps } = m

const rt = (s: string) => ({ type: "rich_text", rich_text: s ? [{ plain_text: s }] : [] })
const date = (d: string | null, end: string | null = null) => ({ type: "date", date: d ? { start: d, end } : null })
const tt = (id: string, day: string, start: string, end: string, period: [string | null, string | null] = [null, null], cls: string | null = "cls-1") => ({
	id,
	properties: {
		"요일": { type: "select", select: { name: day } },
		"등원시간(HH:mm)": rt(start),
		"하원시간(HH:mm)": rt(end),
		"클래스": { type: "relation", relation: cls ? [{ id: cls }] : [] },
		"적용 기간": date(period[0], period[1]),
	},
})
const reg = (o: { sent?: string; tts?: string[]; memo?: string } = {}) => ({
	id: "reg-1",
	properties: {
		"학생이름(등록)": { type: "rollup", rollup: { array: [{ title: [{ plain_text: "김하윤" }] }] } },
		"클래스": { type: "relation", relation: [{ id: "cls-1" }] },
		"시간표": { type: "relation", relation: (o.tts ?? ["old1", "old2", "new1", "new2"]).map((id) => ({ id })) },
		"안내한 시간표": rt(o.sent ?? ""),
		"안내 메모": rt(o.memo ?? ""),
	},
})
const cls = (o: { memo?: string } = {}) => ({
	id: "cls-1",
	properties: { "클래스명": { type: "title", title: [{ plain_text: "중1 A 수학" }] }, "시간표 안내 메모": rt(o.memo ?? "") },
})
// 월·수 16~18 (~11/2) → 화·목 17~19 (11/3~)
const change = () => [
	tt("old1", "월", "16:00", "18:00", ["2026-09-01", "2026-11-02"]),
	tt("old2", "수", "16:00", "18:00", ["2026-09-01", "2026-11-02"]),
	tt("new1", "화", "17:00", "19:00", ["2026-11-03", null]),
	tt("new2", "목", "17:00", "19:00", ["2026-11-03", null]),
]

Deno.test("v2.8.0 시간표 변경 안내: 시간표 글자는 요일 순, 같은 시각끼리 묶음", () => {
	eq(m.timetableText([{ day: "수", start: "16:00", end: "18:00" }, { day: "월", start: "16:00", end: "18:00" }]), "월·수 16:00~18:00")
	eq(m.timetableText([{ day: "수", start: "17:00", end: "19:00" }, { day: "월", start: "16:00", end: "18:00" }]), "월 16:00~18:00 / 수 17:00~19:00")
	eq(m.timetableText([]), "")
})

Deno.test("v2.8.0 시간표 변경 안내: 적용 기간 — 비면 계속, 시작일만이면 그날부터, 끝 포함", () => {
	eq(m.activeOn(tt("a", "월", "", ""), "2026-10-31"), true)
	eq(m.activeOn(tt("a", "월", "", "", ["2026-11-03", "2026-11-03"]), "2026-12-01"), true)
	eq(m.activeOn(tt("a", "월", "", "", ["2026-11-03", null]), "2026-11-02"), false)
	eq(m.activeOn(tt("a", "월", "", "", ["2026-09-01", "2026-11-02"]), "2026-11-02"), true)
	eq(m.activeOn(tt("a", "월", "", "", ["2026-09-01", "2026-11-02"]), "2026-11-03"), false)
})

Deno.test("v2.8.0 시간표 변경 안내: 지금·새 시간표가 함께 있을 때만 기존·변경·적용", () => {
	eq(m.timetableChange(change(), "2026-10-31"), { before: "월·수 16:00~18:00", after: "화·목 17:00~19:00", applyOn: "2026-11-03" })
	// 바뀐 뒤(새 시간표만 적용 중)에는 변경 한 줄
	eq(m.timetableChange(change(), "2026-11-05"), { before: "", after: "화·목 17:00~19:00", applyOn: "" })
	// 기간 없이 바로 바꾼 경우
	eq(m.timetableChange([tt("x", "금", "15:00", "17:00")], "2026-10-31"), { before: "", after: "금 15:00~17:00", applyOn: "" })
	eq(m.timetableInfoBlock({ before: "월·수 16:00~18:00", after: "화·목 17:00~19:00", applyOn: "11.03(화)" }), "🕒 기존  월·수 16:00~18:00\n🕒 변경  화·목 17:00~19:00\n📅 적용  11.03(화)부터")
	eq(m.timetableInfoBlock({ after: "화·목 17:00~19:00" }), "🕒 변경  화·목 17:00~19:00")
})

Deno.test("v2.8.0 시간표 변경 안내: 이 반 시간표와 반 없는(개별) 시간표만", () => {
	const list = [tt("t1", "화", "17:00", "19:00"), tt("t2", "목", "17:00", "19:00", [null, null], "other"), tt("t3", "토", "10:00", "11:00", [null, null], null), null]
	eq(m.ownTimetables(list, "cls-1").map((t: any) => t.id), ["t1", "t3"])
})

Deno.test("v2.8.0 시간표 변경 안내: 계획 — 변수, 메모 우선순위, 이미 안내한 학생 건너뛰기", () => {
	const p: any = m.planTimetableNotice(reg(), change(), cls({ memo: "학교 시험 기간에 맞춰 옮깁니다." }), "2026-10-31")
	eq(p.variables, {
		"#{학생이름}": "김하윤",
		"#{클래스}": "중1 A 수학",
		"#{시간표정보}": "🕒 기존  월·수 16:00~18:00\n🕒 변경  화·목 17:00~19:00\n📅 적용  11.03(화)부터",
		"#{전달사항}": "학교 시험 기간에 맞춰 옮깁니다.",
	})
	eq([p.now, p.usedRegMemo], ["화·목 17:00~19:00", false])
	const own: any = m.planTimetableNotice(reg({ memo: "개인 일정으로 옮깁니다." }), change(), cls({ memo: "반 메모" }), "2026-10-31")
	eq([own.variables["#{전달사항}"], own.usedRegMemo], ["개인 일정으로 옮깁니다.", true])
	eq(m.planTimetableNotice(reg({ sent: "화·목 17:00~19:00" }), change(), cls(), "2026-10-31"), { skip: "" })
	eq(m.planTimetableNotice(reg({ tts: [] }), [], cls(), "2026-10-31"), { skip: "적용 중이거나 앞으로 적용될 시간표가 없습니다." })
})

Deno.test("v2.8.0 시간표 변경 안내: 한 건 — 보내고 안내한 시간표를 적고 등록 메모를 비운 뒤 ✅", async () => {
	const saved = { ...deps }
	const pages: Record<string, any> = { "reg-1": reg({ memo: "개인 일정" }), "cls-1": cls() }
	for (const t of change()) pages[t.id] = t
	const sent: any[] = [], updates: any[] = [], logs: any[] = [], marks: string[] = []
	Object.assign(deps, {
		markRunning: async () => {},
		getPage: async (id: string) => pages[id],
		today: () => "2026-10-31",
		send: async (...a: any[]) => { sent.push(a); return [] },
		log: async (a: any) => { logs.push(a) },
		update: async (id: string, props: any) => { updates.push([id, props]) },
		botUser: async () => "bot",
		markDone: async (id: string) => { marks.push("done:" + id) },
		markError: async (id: string, msg: string) => { marks.push("error:" + msg) },
	})
	try {
		await m.processTimetableNoticeQueueItem({ regId: "reg-1" })
		eq(sent[0][0], "시간표 변경 안내")
		eq(sent[0][3]["#{시간표정보}"], "🕒 기존  월·수 16:00~18:00\n🕒 변경  화·목 17:00~19:00\n📅 적용  11.03(화)부터")
		eq(logs.map((l) => [l.category, l.status]), [["시간표 변경 안내", "성공"]])
		eq(updates, [["reg-1", { "안내한 시간표": { rich_text: [{ text: { content: "화·목 17:00~19:00" } }] }, "안내 메모": { rich_text: [] } }]])
		eq(marks, ["done:reg-1"])
	} finally {
		Object.assign(deps, saved)
	}
})

Deno.test("v2.8.0 시간표 변경 안내: 연락처 오류는 로그 없이 ⚠️", async () => {
	const saved = { ...deps }
	const pages: Record<string, any> = { "reg-1": reg(), "cls-1": cls() }
	for (const t of change()) pages[t.id] = t
	const marks: string[] = []
	Object.assign(deps, {
		markRunning: async () => {},
		getPage: async (id: string) => pages[id],
		today: () => "2026-10-31",
		send: async () => { throw new Error("연락처 오류: 우선 연락처가 비어 있습니다.") },
		log: async () => { throw new Error("should not log contact errors") },
		update: async () => {},
		botUser: async () => "bot",
		markDone: async () => { marks.push("done") },
		markError: async (_id: string, msg: string) => { marks.push("error:" + msg) },
	})
	try {
		await m.processTimetableNoticeQueueItem({ regId: "reg-1" })
		eq(marks, ["error:연락처 오류: 우선 연락처가 비어 있습니다."])
	} finally {
		Object.assign(deps, saved)
	}
})
