// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_REGISTRATION_ID: "registrations", DATA_SOURCE_TUITION_ID: "tuitions", DATA_SOURCE_REPORT_ID: "reports", DATA_SOURCE_ATTENDANCE_ID: "attendance" })) Deno.env.set(key, value)
const assert = (v: unknown, m = "assertion failed") => { if (!v) throw new Error(m) }
const { ConfigError, makeQueuedBackgroundProcessor } = await import("./webhookIngest.ts")
const report = await import("./generateReportTarget.ts")
const tuition = await import("./generateTuitionTarget.ts")

const CLASS = "3ecba040586b80329482e0a8c7bb548f", BATCH = "3eeba040586b80018194e8480601ae46"
function withNotion(pages: Record<string, any>, fn: (patches: any[]) => Promise<void>) {
	const patches: any[] = []
	const saved = globalThis.fetch
	globalThis.fetch = (async (input: any, init?: any) => {
		const url = String(input)
		const id = url.split("/pages/")[1]?.replace(/-/g, "")
		if (init?.method === "PATCH") { patches.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }) }
		if (id && pages[id]) return new Response(JSON.stringify(pages[id]), { status: 200 })
		return new Response(JSON.stringify({ results: [], has_more: false }), { status: 200 })
	}) as typeof fetch
	return fn(patches).finally(() => { globalThis.fetch = saved })
}
const classPage = (rel: string) => ({ id: CLASS, properties: { 클래스명: { title: [{ plain_text: "고1 A" }] }, [rel]: { relation: [{ id: BATCH }] }, "월간 수업 총량": { number: 12 } } })
const batchPage = (type: string) => ({ id: BATCH, properties: { 구분: { select: { name: type } }, 기간: { date: { start: "2026-10-01", end: "2026-10-31" } } } })

Deno.test("v2.6.25 설정 오류는 ⚠️ 오류로 남기고 큐 재시도하지 않는다(예외를 다시 던지지 않음)", async () => {
	await withNotion({}, async (patches) => {
		const run = makeQueuedBackgroundProcessor("t", { statusProp: "상태", errorProp: "마지막 오류", startedAtProp: "시작" }, "classId", async () => { throw new ConfigError("발송함이 없습니다.") })
		await run({ classId: CLASS })
		const last = patches.at(-1)
		assert(last.properties["상태"].select.name.includes("오류"), "status must be error")
		assert(last.properties["마지막 오류"].rich_text[0].text.content === "발송함이 없습니다.")
	})
	await withNotion({}, async () => {
		const run = makeQueuedBackgroundProcessor("t", { statusProp: "상태", errorProp: "마지막 오류", startedAtProp: "시작" }, "classId", async () => { throw new Error("일시 오류") })
		let threw = false
		try { await run({ classId: CLASS }) } catch { threw = true }
		assert(threw, "other errors must still be retried by the queue")
	})
})

Deno.test("v2.6.25 보고서 생성: 보고서 생성 대상이 수강료 발송함이면 ConfigError", async () => {
	await withNotion({ [CLASS]: classPage("보고서 생성 대상"), [BATCH]: batchPage("수강료") }, async () => {
		let err: unknown
		try { await report.processClass(CLASS, []) } catch (e) { err = e }
		assert(err instanceof ConfigError && /구분이 "수강료"/.test((err as Error).message), String(err))
	})
})

Deno.test("v2.6.25 수강료 생성: 수강료 생성 대상이 보고서 발송함이거나 발송함이 없으면 ConfigError", async () => {
	await withNotion({ [CLASS]: classPage("수강료 생성 대상"), [BATCH]: batchPage("월간 보고서") }, async () => {
		let err: unknown
		try { await tuition.processClass(CLASS, []) } catch (e) { err = e }
		assert(err instanceof ConfigError && /구분이 "월간 보고서"/.test((err as Error).message), String(err))
	})
	await withNotion({ [CLASS]: { id: CLASS, properties: { 클래스명: { title: [{ plain_text: "고1 A" }] } } } }, async () => {
		let err: unknown
		try { await tuition.processClass(CLASS, []) } catch (e) { err = e }
		assert(err instanceof ConfigError, String(err))
	})
})
