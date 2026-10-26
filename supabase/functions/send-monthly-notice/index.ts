// Supabase Edge Function: send-monthly-notice
//
// (v2.8.0) 학생 월간 안내(수강료·월간 일정, _shared/monthlyNotice.ts). 버튼 웹훅 하나 → 큐. x-admin-key(웹훅 키) 필요.
//   /create         : 클래스 [월 수강료 생성] — 누른 순간의 다음 달(서울). 학생 월간 안내·수강료를 만든다. 상태는 클래스 "수강료 생성 상태".
//   /class-tuition  : 클래스 [수강료 안내 일괄] — 그 반 학생들의 다음 달 수강료 안내. 상태는 클래스 "수강료 안내 상태".
//   /class-schedule : 클래스 [월간 일정 안내] — 그 반 학생들의 다음 달 월간 일정 안내. 상태는 클래스 "일정 안내 상태".
//   /tuition        : 월간 안내 [수강료 안내] — 그 학생. 상태는 월간 안내 "월간 안내 상태".
//   /schedule       : 월간 안내 [월간 일정 안내] — 그 학생. 상태는 월간 안내 "월간 안내 상태".
// 이미 대기열·작업 중이면 두 번 넣지 않는다.
import { authorizeKey, securityEnabled } from "../_shared/adminSecurity.ts"
import { getCurrentAdminKey, resolveAdminKeyFromRequest } from "../_shared/adminShared.ts"
import { describeBody, extractPageId, getPage } from "../_shared/notionClient.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
import { isRunning, markError, markQueued, type StatusSpec } from "../_shared/statusTracking.ts"
import { nextMonthKey } from "../_shared/scheduleNotice.ts"
import {
	CLASS_TUITION_GEN_STATUS_SPEC,
	classSpecOf,
	MONTHLY_STATUS_SPEC,
	TARGET_MONTHLY_CREATE_CLASS,
	TARGET_MONTHLY_SEND_BATCH,
	TARGET_MONTHLY_SEND_CLASS,
} from "../_shared/monthlyNotice.ts"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

const ROUTES: Record<string, { spec: StatusSpec; target: string; payload: (pageId: string) => Record<string, unknown> }> = {
	"create": { spec: CLASS_TUITION_GEN_STATUS_SPEC, target: TARGET_MONTHLY_CREATE_CLASS, payload: (id) => ({ classId: id, month: nextMonthKey() }) },
	"class-tuition": { spec: classSpecOf("tuition"), target: TARGET_MONTHLY_SEND_CLASS, payload: (id) => ({ kind: "tuition", classId: id, month: nextMonthKey() }) },
	"class-schedule": { spec: classSpecOf("schedule"), target: TARGET_MONTHLY_SEND_CLASS, payload: (id) => ({ kind: "schedule", classId: id, month: nextMonthKey() }) },
	"tuition": { spec: MONTHLY_STATUS_SPEC, target: TARGET_MONTHLY_SEND_BATCH, payload: (id) => ({ kind: "tuition", batchId: id }) },
	"schedule": { spec: MONTHLY_STATUS_SPEC, target: TARGET_MONTHLY_SEND_BATCH, payload: (id) => ({ kind: "schedule", batchId: id }) },
}

Deno.serve(async (req: Request) => {
	if (req.method !== "POST") return new Response("Use POST", { status: 405 })
	let body: Record<string, unknown> = {}
	try { body = await req.json() } catch { body = {} }
	console.log("[send-monthly-notice] received:", describeBody(body))

	const adminKey = resolveAdminKeyFromRequest(req, body)
	const currentAdminKey = securityEnabled() ? "" : await getCurrentAdminKey()
	if (!adminKey || !await authorizeKey(req, adminKey, currentAdminKey)) return json({ error: "unauthorized" }, 401)

	const route = new URL(req.url).pathname.split("/").pop() ?? ""
	const r = ROUTES[route]
	if (!r) return json({ error: `주소 끝에 ${Object.keys(ROUTES).map((k) => "/" + k).join(" · ")} 중 하나를 붙여 주세요.` }, 400)
	const pageId = extractPageId(body)
	if (!pageId) return json({ error: "pageId를 찾을 수 없음" }, 400)
	try {
		const page = await getPage(pageId)
		if (isRunning(page, r.spec)) return json({ ok: true, message: "already_processing", pageId })
		await markQueued(pageId, r.spec)
		await enqueueSync(r.target, r.payload(pageId))
		wakeSyncQueueWorker()
		return respondAccepted({ pageId, route })
	} catch (err) {
		console.error("[send-monthly-notice] ERROR:", (err as Error).message)
		await markError(pageId, r.spec, (err as Error).message).catch(() => {})
		return json({ ok: false, error: (err as Error).message }, 500)
	}
})
