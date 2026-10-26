// All network calls are mocked. No live Notion/Solapi/Supabase calls or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const m = await import("./lessonNotice.ts")
const { lessonNoticeDeps: deps } = m

const formula = (s: string) => ({ type: "formula", formula: { string: s } })
const att = (o: { status?: string; at?: string | null; sent?: string | null; reg?: boolean } = {}) => ({
	id: "att-1",
	properties: {
		"출석 상태": { type: "select", select: o.status ? { name: o.status } : null },
		"수업일시": { type: "date", date: o.at === null ? null : { start: o.at ?? "2026-10-30T17:00:00.000+09:00" } },
		"수업 안내 일시": { type: "date", date: o.sent ? { start: o.sent } : null },
		"등록": { type: "relation", relation: o.reg === false ? [] : [{ id: "reg-1" }] },
		"수업": { type: "relation", relation: [{ id: "ses-1" }] },
		"학생이름(보고서)": formula("김하윤"),
		"클래스(보고서)": formula("고1 A"),
		"학부모 연락처": formula("01012345678"),
	},
})
const ses = (makeup: boolean, memo = "") => ({ id: "ses-1", properties: { "보강": { type: "checkbox", checkbox: makeup }, "수업 안내 메모": { type: "rich_text", rich_text: memo ? [{ plain_text: memo }] : [] } } })

Deno.test("v2.8.0 수업 안내: 일시 표기(서울, 오전·오후, 날짜만)", () => {
	eq(m.formatLessonTime("2026-10-30T17:00:00.000+09:00"), "10월 30일(금) 오후 5:00")
	eq(m.formatLessonTime("2026-10-30T00:30:00.000Z"), "10월 30일(금) 오전 9:30")
	eq(m.formatLessonTime("2026-06-03T12:05:00+09:00"), "6월 3일(수) 오후 12:05")
	eq(m.formatLessonTime("2026-10-30"), "10월 30일(금)")
	eq(m.sameInstant("2026-10-30T17:00:00.000+09:00", "2026-10-30T08:00:00.000Z"), true)
	eq(m.sameInstant("2026-10-30T17:00:00+09:00", "2026-10-30T18:00:00+09:00"), false)
})

Deno.test("v2.8.0 수업 안내: 처음이면 수업 안내, 보강이면 안내구분·기본 문구, 일반은 메모 또는 -", () => {
	const p1: any = m.planLessonNotice(att(), ses(true))
	eq(p1.kind, "수업 안내")
	eq(p1.variables, { "#{안내구분}": "보강 수업", "#{학생이름}": "김하윤", "#{클래스}": "고1 A", "#{안내내용}": "보강 수업이 잡혔습니다", "#{수업일시}": "10월 30일(금) 오후 5:00" })
	const p2: any = m.planLessonNotice(att(), ses(false, "선거일이지만 정상 수업합니다."))
	eq([p2.variables["#{안내구분}"], p2.variables["#{안내내용}"]], ["수업", "선거일이지만 정상 수업합니다."])
	eq((m.planLessonNotice(att(), ses(false)) as any).variables["#{안내내용}"], "-")
	eq((m.planLessonNotice(att(), null) as any).variables["#{안내구분}"], "수업")
})

Deno.test("v2.8.0 수업 안내: 받은 뒤 일시가 바뀌면 변경 안내, 같으면 건너뜀, 결석·일시 없음은 안 보냄", () => {
	const ch: any = m.planLessonNotice(att({ sent: "2026-10-29T17:00:00.000+09:00" }), ses(true))
	eq(ch.kind, "수업 변경 안내")
	eq([ch.variables["#{기존일시}"], ch.variables["#{변경일시}"]], ["10월 29일(목) 오후 5:00", "10월 30일(금) 오후 5:00"])
	eq(ch.variables["#{수업일시}"], undefined)
	eq(m.planLessonNotice(att({ sent: "2026-10-30T08:00:00.000Z" }), ses(true)), { skip: "" })
	eq((m.planLessonNotice(att({ status: "🔴 결석" }), ses(true)) as any).skip.includes("결석"), true)
	eq((m.planLessonNotice(att({ at: null }), ses(true)) as any).skip.includes("수업일시"), true)
})

function mock(o: { page: any; session?: any; sendThrows?: Error }) {
	const calls = { patches: [] as any[], sends: [] as any[], logs: [] as any[] }
	Object.assign(deps, {
		getPage: async (id: string) => id === "ses-1" ? (o.session ?? ses(true)) : o.page,
		patch: async (id: string, props: any) => { calls.patches.push({ id, props }) },
		send: async (kind: string, reg: string, phone: string, vars: any) => { if (o.sendThrows) throw o.sendThrows; calls.sends.push({ kind, reg, phone, vars }) },
		log: async (args: any) => { calls.logs.push({ category: args.category, status: args.status, reg: args.registrationId, att: args.attendanceId ?? null }) },
		botUser: async () => null,
	})
	return calls
}

Deno.test("v2.8.0 수업 안내 큐: 보내고 로그는 등록에만, 출석에 안내 일시·✅", async () => {
	const c = mock({ page: att() })
	await m.processLessonNoticeQueueItem({ attendanceId: "att-1" })
	eq(c.sends.length, 1)
	eq([c.sends[0].kind, c.sends[0].reg, c.sends[0].phone], ["수업 안내", "reg-1", "01012345678"])
	eq(c.logs, [{ category: "수업 안내", status: "성공", reg: "reg-1", att: null }])
	eq(c.patches[0].props["수업 안내 상태"].select.name, "✅ 완료")
	eq(c.patches[0].props["수업 안내 일시"].date.start, "2026-10-30T17:00:00.000+09:00")
})

Deno.test("v2.8.0 수업 안내 큐: 이미 같은 일시로 받은 학생은 보내지 않고 ✅, 결석은 ⚠️", async () => {
	let c = mock({ page: att({ sent: "2026-10-30T17:00:00.000+09:00" }) })
	await m.processLessonNoticeQueueItem({ attendanceId: "att-1" })
	eq(c.sends.length, 0)
	eq(c.patches[0].props["수업 안내 상태"].select.name, "✅ 완료")
	c = mock({ page: att({ status: "🔴 결석" }) })
	await m.processLessonNoticeQueueItem({ attendanceId: "att-1" })
	eq(c.sends.length, 0)
	eq(c.patches[0].props["수업 안내 상태"].select.name, "⚠️ 오류")
})

Deno.test("v2.8.0 수업 안내 큐: 설정 꺼짐·연락처 없음은 로그 없이 ⚠️, 발송 실패는 실패 로그·⚠️(다시 보내지 않음)", async () => {
	let c = mock({ page: att(), sendThrows: new m.LessonConfigError("알림톡 설정의 '수업 안내' 행을 켜고(활성 여부) 카카오 채널 ID·템플릿 ID를 넣어 주세요.") })
	await m.processLessonNoticeQueueItem({ attendanceId: "att-1" })
	eq(c.logs.length, 0)
	eq(c.patches[0].props["수업 안내 오류"].rich_text[0].text.content.includes("'수업 안내' 행"), true)
	eq(c.patches[0].props["마지막 오류"], undefined) // 보고서 오류 칸은 건드리지 않는다
	c = mock({ page: att(), sendThrows: new Error("Solapi 502") })
	await m.processLessonNoticeQueueItem({ attendanceId: "att-1" })
	eq(c.logs, [{ category: "수업 안내", status: "실패", reg: "reg-1", att: null }])
	eq(c.patches[0].props["수업 안내 상태"].select.name, "⚠️ 오류")
	eq(c.patches[0].props["수업 안내 일시"], undefined)
})
