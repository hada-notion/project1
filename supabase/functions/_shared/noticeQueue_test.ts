// All network calls are mocked. No live Notion/Supabase/Solapi calls or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const { noticeDeps, processNoticeQueueItem } = await import("./noticeQueue.ts")

const REG = "3ecba040586b8061a932dc4c4869e7a9"
const text = (s: string) => ({ type: "rich_text", rich_text: [{ plain_text: s }] })
const formula = (s: string) => ({ type: "formula", formula: { string: s } })
const rollup = (s: string) => ({ type: "rollup", rollup: { type: "array", array: [text(s)] } })
const rel = (id: string) => ({ relation: [{ id }] })
const select = (name: string) => ({ select: { name } })

function fake(page: any, opts: { sendFails?: boolean; refreshFails?: boolean } = {}) {
	const calls = { reads: 0, patches: [] as any[], sent: [] as any[], logs: [] as any[], refresh: [] as any[], recipients: [] as any[] }
	const saved = { ...noticeDeps }
	Object.assign(noticeDeps, {
		getPage: async () => { calls.reads++; return page },
		patch: async (_id: string, props: any) => { calls.patches.push(props) },
		refresh: async (reg: string, o: any) => { calls.refresh.push({ reg, ...o }); if (opts.refreshFails) throw new Error("최신화 실패"); return { access_token: "tok", cacheRow: { registration_detail: { report_comments: [] } } } },
		config: async () => ({ pfId: "pf", templateId: "tpl", senderNumber: "0200000000", notice: "안내", recipientTarget: "우선 연락 대상" }),
		recipients: async (a: any) => { calls.recipients.push(a); return [{ label: "우선 연락 대상", phone: "01000000000" }] },
		send: async (to: string, vars: any) => { if (opts.sendFails) throw new Error("발송 실패"); calls.sent.push({ to, vars }) },
		log: async (a: any) => { calls.logs.push(a) },
		botUserId: async () => "bot",
		now: () => 0,
	})
	return { calls, restore: () => Object.assign(noticeDeps, saved) }
}

const reportPage = (status = "⚪ 대기") => ({
	id: "report-1",
	properties: {
		"보고서 전송 상태": select(status),
		"보고서 구분": select("월간 보고서"),
		등록: rel(REG),
		"알림톡 발송함": rel("batch-1"),
		"리포트 토큰": rollup("raw-token"),
		"학생이름(보고서)": formula("한지민"),
		"학부모 연락처(보고서)": formula("010-0000-0000"),
		"보고서기간(보고서)": formula("10월"),
		"보고서 기간": { date: { start: "2026-10-01", end: "2026-10-31" } },
	},
})

Deno.test("v2.6.24 보고서: 한 번 읽고 공용 캐시·토큰 롤업으로 최신화, 보낸 뒤 쓰기 1번(✅·일괄전송 선택 해제)", async () => {
	const { calls, restore } = fake(reportPage())
	try {
		await processNoticeQueueItem({ kind: "report", pageId: "report-1", clickerUserId: "teacher" })
		eq(calls.reads, 1)
		eq(calls.refresh, [{ reg: REG, sharedRunKey: "notice:batch-1:0", tokenRaw: "raw-token" }])
		eq(calls.recipients[0].primaryPhone, "010-0000-0000")
		eq(calls.sent.length, 1)
		eq(calls.sent[0].vars["#{페이지ID}"].endsWith("?token=tok"), true)
		eq(calls.logs.map((l) => [l.status, l.reportId, l.senderUserId, l.category]), [["성공", "report-1", "teacher", "월간 보고서"]])
		eq(calls.patches.length, 1)
		eq(calls.patches[0]["보고서 전송 상태"].select.name, "✅ 완료")
		eq(calls.patches[0]["일괄전송 선택"].checkbox, false)
	} finally { restore() }
})

Deno.test("v2.6.24 이미 처리된 건(전송 상태가 ⚪ 대기 아님)은 건너뛴다 — 두 번 눌러도 한 번", async () => {
	const { calls, restore } = fake(reportPage("✅ 완료"))
	try {
		await processNoticeQueueItem({ kind: "report", pageId: "report-1" })
		eq(calls.sent.length, 0)
		eq(calls.patches.length, 0)
		eq(calls.refresh.length, 0)
	} finally { restore() }
})

Deno.test("v2.6.24 발송 전 실패 → 오류만 적고 예외(큐 재시도, 상태는 ⚪ 대기 그대로)", async () => {
	const { calls, restore } = fake(reportPage(), { refreshFails: true })
	try {
		let threw = false
		try { await processNoticeQueueItem({ kind: "report", pageId: "report-1" }) } catch { threw = true }
		eq(threw, true)
		eq(calls.sent.length, 0)
		eq(calls.patches.length, 1)
		eq("보고서 전송 상태" in calls.patches[0], false)
		eq(calls.patches[0]["마지막 오류"].rich_text[0].text.content, "최신화 실패")
	} finally { restore() }
})

Deno.test("v2.6.24 발송 단계 실패 → 다시 보내지 않고 ⚠️ 오류·실패 로그", async () => {
	const tuition = { id: "tuition-1", properties: { "안내문 전송 상태": select("⚪ 대기"), 등록: rel(REG), 학생정보: formula("임현우"), "학부모 연락처": rollup("010-1111-1111"), 청구기간: { date: { start: "2026-10-01", end: "2026-10-31" } } } }
	const { calls, restore } = fake(tuition, { sendFails: true })
	try {
		await processNoticeQueueItem({ kind: "tuition", pageId: "tuition-1" })
		eq(calls.logs.map((l) => [l.status, l.tuitionId, l.category, l.senderUserId]), [["실패", "tuition-1", "수강료 안내", "bot"]])
		eq(calls.patches[0]["안내문 전송 상태"].select.name, "⚠️ 오류")
		eq(calls.patches[0]["마지막 오류"].rich_text[0].text.content, "발송 실패")
		eq(calls.recipients[0].primaryPhone, "010-1111-1111")
	} finally { restore() }
})

Deno.test("v2.6.24 교재비 안내문: 안내문 전송 상태, 일괄전송 선택은 건드리지 않음, 안내멘트는 알림톡 설정", async () => {
	const cart = { id: "cart-1", properties: { "안내문 전송 상태": select("⚪ 대기"), 등록: rel(REG), "학생이름(표시)": rollup("조하은"), "클래스명(표시)": rollup("중1 B"), 미납교재: formula("쎈 1권") } }
	const { calls, restore } = fake(cart)
	try {
		await processNoticeQueueItem({ kind: "textbook", pageId: "cart-1" })
		eq(calls.sent[0].vars, { "#{학생이름}": "조하은", "#{클래스}": "중1 B", "#{교재비안내}": "쎈 1권", "#{안내멘트}": "안내" })
		eq(calls.logs[0].textbookCartId, "cart-1")
		eq(calls.patches[0]["안내문 전송 상태"].select.name, "✅ 완료")
		eq("일괄전송 선택" in calls.patches[0], false)
	} finally { restore() }
})
