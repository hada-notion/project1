// All network calls are mocked. No live Notion/Solapi/Supabase calls or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const m = await import("./timetableNotice.ts")
const { timetableNoticeDeps: deps } = m

const rt = (s: string) => ({ type: "rich_text", rich_text: s ? [{ plain_text: s }] : [] })
const tt = (id: string, day: string, start: string, end: string, cls: string | null = "cls-1") => ({
	id,
	properties: { "요일": { type: "select", select: { name: day } }, "등원시간(HH:mm)": rt(start), "하원시간(HH:mm)": rt(end), "클래스": { type: "relation", relation: cls ? [{ id: cls }] : [] } },
})
const reg = (o: { sent?: string; tts?: string[]; apply?: string; memo?: string } = {}) => ({
	id: "reg-1",
	properties: {
		"학생이름(등록)": { type: "rollup", rollup: { array: [{ title: [{ plain_text: "김하윤" }] }] } },
		"클래스": { type: "relation", relation: [{ id: "cls-1" }] },
		"시간표": { type: "relation", relation: (o.tts ?? ["t1", "t2"]).map((id) => ({ id })) },
		"안내한 시간표": rt(o.sent ?? ""),
		"시간표 적용일": { type: "date", date: o.apply ? { start: o.apply } : null },
		"안내 메모": rt(o.memo ?? ""),
	},
})
const cls = (o: { apply?: string; memo?: string } = {}) => ({
	id: "cls-1",
	properties: {
		"클래스명": { type: "title", title: [{ plain_text: "중1 A 수학" }] },
		"시간표 적용일": { type: "date", date: o.apply ? { start: o.apply } : null },
		"시간표 안내 메모": rt(o.memo ?? ""),
	},
})

Deno.test("v2.8.0 시간표 변경 안내: 시간표 글자는 요일 순, 같은 시각끼리 묶음", () => {
	eq(m.timetableText([{ day: "수", start: "16:00", end: "18:00" }, { day: "월", start: "16:00", end: "18:00" }]), "월·수 16:00~18:00")
	eq(m.timetableText([{ day: "수", start: "17:00", end: "19:00" }, { day: "월", start: "16:00", end: "18:00" }]), "월 16:00~18:00 / 수 17:00~19:00")
	eq(m.timetableText([{ day: "토", start: "10:00", end: "" }, { day: "토", start: "10:00", end: "" }]), "토 10:00")
	eq(m.timetableText([]), "")
})

Deno.test("v2.8.0 시간표 변경 안내: 블록은 기존(있고 다를 때)·변경·적용일(있을 때)", () => {
	eq(m.timetableInfoBlock({ after: "화·목 17:00~19:00" }), "🕒 변경  화·목 17:00~19:00")
	eq(m.timetableInfoBlock({ before: "월·수 16:00~18:00", after: "화·목 17:00~19:00", applyOn: "11.03(화)" }), "🔁 기존  월·수 16:00~18:00\n🕒 변경  화·목 17:00~19:00\n📅 적용  11.03(화)부터")
	eq(m.shortDay("2026-11-03"), "11.03(화)")
	eq(m.shortDay(""), "")
})

Deno.test("v2.8.0 시간표 변경 안내: 이 반 시간표와 반 없는(개별) 시간표만", () => {
	const list = [tt("t1", "화", "17:00", "19:00"), tt("t2", "목", "17:00", "19:00", "other"), tt("t3", "토", "10:00", "11:00", null), null]
	eq(m.ownTimetables(list, "cls-1").map((t: any) => t.id), ["t1", "t3"])
	eq(m.ownTimetables(list, undefined).map((t: any) => t.id), ["t1", "t2", "t3"])
})

Deno.test("v2.8.0 시간표 변경 안내: 계획 — 등록 값이 클래스 값보다 먼저, 이미 안내한 학생 건너뛰기", () => {
	const tts = [tt("t1", "화", "17:00", "19:00"), tt("t2", "목", "17:00", "19:00")]
	const p: any = m.planTimetableNotice(reg({ sent: "월·수 16:00~18:00" }), tts, cls({ apply: "2026-11-03", memo: "새 시간표로 안내드립니다." }))
	eq(p.variables, {
		"#{학생이름}": "김하윤",
		"#{클래스}": "중1 A 수학",
		"#{시간표정보}": "🔁 기존  월·수 16:00~18:00\n🕒 변경  화·목 17:00~19:00\n📅 적용  11.03(화)부터",
		"#{전달사항}": "새 시간표로 안내드립니다.",
	})
	eq([p.usedRegApply, p.usedRegMemo], [false, false])
	// 개별 수업: 등록의 적용일·메모가 있으면 그것을 쓴다
	const own: any = m.planTimetableNotice(reg({ apply: "2026-11-10", memo: "개인 일정으로 옮깁니다." }), tts, cls({ apply: "2026-11-03", memo: "반 메모" }))
	eq([own.variables["#{시간표정보}"], own.variables["#{전달사항}"], own.usedRegApply, own.usedRegMemo], ["🕒 변경  화·목 17:00~19:00\n📅 적용  11.10(화)부터", "개인 일정으로 옮깁니다.", true, true])
	eq(m.planTimetableNotice(reg({ sent: "화·목 17:00~19:00" }), tts, cls()), { skip: "" })
	eq(m.planTimetableNotice(reg({ tts: [] }), [], cls()), { skip: "등록에 연결된 시간표가 없습니다." })
})

Deno.test("v2.8.0 시간표 변경 안내: 한 건 — 보내고 안내한 시간표를 적고 등록 적용일·메모를 비운 뒤 ✅", async () => {
	const saved = { ...deps }
	const pages: Record<string, any> = { "reg-1": reg({ sent: "월·수 16:00~18:00", apply: "2026-11-10", memo: "개인 일정" }), "cls-1": cls(), t1: tt("t1", "화", "17:00", "19:00"), t2: tt("t2", "목", "17:00", "19:00", "other-class") }
	const sent: any[] = [], updates: any[] = [], logs: any[] = [], marks: string[] = []
	Object.assign(deps, {
		markRunning: async () => {},
		getPage: async (id: string) => pages[id],
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
		eq(sent[0][3]["#{시간표정보}"], "🔁 기존  월·수 16:00~18:00\n🕒 변경  화 17:00~19:00\n📅 적용  11.10(화)부터")
		eq(logs.map((l) => [l.category, l.status]), [["시간표 변경 안내", "성공"]])
		eq(updates, [["reg-1", { "안내한 시간표": { rich_text: [{ text: { content: "화 17:00~19:00" } }] }, "시간표 적용일": { date: null }, "안내 메모": { rich_text: [] } }]])
		eq(marks, ["done:reg-1"])
		// 이미 같은 시간표로 안내했으면 보내지 않고 ✅
		sent.length = 0; marks.length = 0
		pages["reg-1"] = reg({ sent: "화 17:00~19:00" })
		await m.processTimetableNoticeQueueItem({ regId: "reg-1" })
		eq([sent.length, marks], [0, ["done:reg-1"]])
	} finally {
		Object.assign(deps, saved)
	}
})

Deno.test("v2.8.0 시간표 변경 안내: 연락처 오류는 로그 없이 ⚠️", async () => {
	const saved = { ...deps }
	const pages: Record<string, any> = { "reg-1": reg(), "cls-1": cls(), t1: tt("t1", "화", "17:00", "19:00"), t2: tt("t2", "목", "17:00", "19:00") }
	const marks: string[] = []
	Object.assign(deps, {
		markRunning: async () => {},
		getPage: async (id: string) => pages[id],
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
