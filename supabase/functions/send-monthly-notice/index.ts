// Supabase Edge Function: send-monthly-notice
//
// (v2.8.0) 가정통신문(수강료·월간 일정, _shared/monthlyNotice.ts). 버튼 웹훅 하나 → 큐. x-admin-key(웹훅 키) 필요.
//   /create         : 클래스 [월 수강료 생성] — 클래스 "수강료 기간"의 달(비면 누른 날의 다음 달, 서울). 반 수강료 발송함(구분 수강료)·수강료를 만들고
//                     같은 학생의 그 달 다른 반 수강료와 "같은 달 수강료"로 잇는다. 상태는 클래스 "수강료 생성 상태".
//   /batch-tuition  : 발송함 [수강료 일괄 전송] — 그 발송함 가정통신문 중 "수강료 전송 선택"이 체크된 것. 상태는 발송함 "가정통신문 상태".
//   /batch-schedule : 발송함 [일정 일괄 전송] — 그 발송함 가정통신문 중 "일정 전송 선택"이 체크된 것. 상태는 발송함 "가정통신문 상태".
//   /tuition        : 가정통신문 [수강료 안내] — 그 학생. 상태는 가정통신문 "가정통신문 상태".
//   /schedule       : 가정통신문 [일정 안내] — 그 학생. 상태는 가정통신문 "가정통신문 상태".
// 이미 대기열·작업 중이면 두 번 넣지 않는다.
import { authorizeKey, securityEnabled } from "../_shared/adminSecurity.ts"
import { getCurrentAdminKey, resolveAdminKeyFromRequest } from "../_shared/adminShared.ts"
import { describeBody, extractPageId, getPage } from "../_shared/notionClient.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
import { isRunning, markError, markQueued, type StatusSpec } from "../_shared/statusTracking.ts"
import {
	CLASS_TUITION_GEN_STATUS_SPEC,
	tuitionMonthFromClass,
	MONTHLY_STATUS_SPEC,
	TARGET_MONTHLY_CREATE_CLASS,
	TARGET_MONTHLY_SEND_LETTER,
	TARGET_MONTHLY_SEND_MAILBOX,
} from "../_shared/monthlyNotice.ts"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

// 클래스 경로의 대상 달은 클래스 "수강료 기간"(비면 누른 날의 다음 달). 누른 순간의 값으로 정해 큐에 담는다.
const ROUTES: Record<string, { spec: StatusSpec; target: string; payload: (pageId: string, page: any) => Record<string, unknown> }> = {
	"create": { spec: CLASS_TUITION_GEN_STATUS_SPEC, target: TARGET_MONTHLY_CREATE_CLASS, payload: (id, page) => ({ classId: id, month: tuitionMonthFromClass(page) }) },
	"batch-tuition": { spec: MONTHLY_STATUS_SPEC, target: TARGET_MONTHLY_SEND_MAILBOX, payload: (id) => ({ kind: "tuition", mailboxId: id }) },
	"batch-schedule": { spec: MONTHLY_STATUS_SPEC, target: TARGET_MONTHLY_SEND_MAILBOX, payload: (id) => ({ kind: "schedule", mailboxId: id }) },
	"tuition": { spec: MONTHLY_STATUS_SPEC, target: TARGET_MONTHLY_SEND_LETTER, payload: (id) => ({ kind: "tuition", letterId: id }) },
	"schedule": { spec: MONTHLY_STATUS_SPEC, target: TARGET_MONTHLY_SEND_LETTER, payload: (id) => ({ kind: "schedule", letterId: id }) },
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
		const payload = r.payload(pageId, page)
		await markQueued(pageId, r.spec)
		await enqueueSync(r.target, payload)
		wakeSyncQueueWorker()
		return respondAccepted({ pageId, route })
	} catch (err) {
		console.error("[send-monthly-notice] ERROR:", (err as Error).message)
		await markError(pageId, r.spec, (err as Error).message).catch(() => {})
		return json({ ok: false, error: (err as Error).message }, 500)
	}
})
