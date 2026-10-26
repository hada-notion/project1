// Supabase Edge Function: create-class-reports
//
// (v2.8.0) 클래스(학원) DB [보고서 생성] 버튼이 호출한다. 클래스의 '보고서 구분'·'보고서 기간'으로 이 반의 알림톡 발송함을
// 찾거나 만들고, 기간 안에 다니는 학생마다 보고서를 만든다. 실제 작업은 큐(process-sync-queue)가 한 건씩 한다.
// 흐름과 건너뛰기 규칙은 _shared/classReportPlan.ts 맨 위 주석.
//
// 웹훅 본문에 클래스의 '보고서 구분'·'보고서 기간'·'클래스명'을 실어 보내면(버튼의 "웹훅 보내기" 속성 포함) 누른 순간의 값을
// 그대로 큐에 담는다. 본문에 없으면 잠금 확인 때 읽은 클래스 페이지 값을 쓴다. 값이 틀리면 만들지 않고 ⚠️ 오류와
// '마지막 오류'에 고칠 곳을 남긴다. x-admin-key(웹훅 키) 필요.
//
// (v2.8.0) 경로 /evaluations: 알림톡 발송함 [평가 만들기]. 본문의 발송함 수식 '평가 계획'(체크한 진도교재마다 평가 1개)을
// 큐에 넣는다. 처리는 _shared/evaluationPlan.ts. 상태는 발송함 '평가 생성 상태'.
import { authorizeKey, securityEnabled } from "../_shared/adminSecurity.ts"
import { getCurrentAdminKey, resolveAdminKeyFromRequest } from "../_shared/adminShared.ts"
import { describeBody, extractPageId, getPage } from "../_shared/notionClient.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
import { isRunning, markError, markQueued } from "../_shared/statusTracking.ts"
import { CLASS_REPORT_GEN_STATUS_SPEC, TARGET_CLASS_REPORTS, reportRequestFromProps, type ClassReportsPayload } from "../_shared/classReportPlan.ts"
import { BATCH_EVAL_STATUS_SPEC, EVAL_PLAN_PROP, TARGET_BATCH_EVALUATIONS, evalPlanText } from "../_shared/evaluationPlan.ts"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

Deno.serve(async (req: Request) => {
	if (req.method !== "POST") return new Response("Use POST", { status: 405 })
	let body: Record<string, unknown> = {}
	try { body = await req.json() } catch { body = {} }
	console.log("[create-class-reports] received:", describeBody(body))

	const adminKey = resolveAdminKeyFromRequest(req, body)
	const currentAdminKey = securityEnabled() ? "" : await getCurrentAdminKey()
	if (!adminKey || !await authorizeKey(req, adminKey, currentAdminKey)) return json({ error: "unauthorized" }, 401)

	if (new URL(req.url).pathname.split("/").pop() === "evaluations") return await queueEvaluations(body)

	const classId = extractPageId(body)
	if (!classId) return json({ error: "pageId를 찾을 수 없음" }, 400)

	try {
		const page = await getPage(classId)
		// 이미 대기열에 있거나 만드는 중이면 두 번 넣지 않는다(두 번 눌러도 한 번만).
		if (isRunning(page, CLASS_REPORT_GEN_STATUS_SPEC)) return json({ ok: true, message: "already_processing", classId })
		const bodyProps = (body.data as Record<string, any> | undefined)?.properties
		const props = bodyProps && "보고서 구분" in bodyProps && "보고서 기간" in bodyProps ? { 클래스명: page.properties?.["클래스명"], ...bodyProps } : page.properties
		let payload: ClassReportsPayload
		try {
			payload = { classId, ...reportRequestFromProps(props) }
		} catch (err) {
			await markError(classId, CLASS_REPORT_GEN_STATUS_SPEC, (err as Error).message)
			return json({ ok: false, message: (err as Error).message, classId })
		}
		await markQueued(classId, CLASS_REPORT_GEN_STATUS_SPEC)
		await enqueueSync(TARGET_CLASS_REPORTS, payload)
		wakeSyncQueueWorker()
		return respondAccepted({ classId, kind: payload.kind, start: payload.start, end: payload.end })
	} catch (err) {
		console.error("[create-class-reports] ERROR:", (err as Error).message)
		await markError(classId, CLASS_REPORT_GEN_STATUS_SPEC, (err as Error).message).catch(() => {})
		return json({ ok: false, error: (err as Error).message }, 500)
	}
})

// 발송함 [평가 만들기]: 잠금 확인 → ⏳ 대기열 → 큐. 계획 검사·발송함 구분 확인은 큐가 한다(발송함을 이미 읽으므로).
async function queueEvaluations(body: Record<string, unknown>): Promise<Response> {
	const batchId = extractPageId(body)
	if (!batchId) return json({ error: "pageId를 찾을 수 없음" }, 400)
	try {
		const page = await getPage(batchId)
		if (isRunning(page, BATCH_EVAL_STATUS_SPEC)) return json({ ok: true, message: "already_processing", batchId })
		const plan = evalPlanText((body.data as Record<string, any> | undefined)?.properties?.[EVAL_PLAN_PROP]) || null
		await markQueued(batchId, BATCH_EVAL_STATUS_SPEC)
		await enqueueSync(TARGET_BATCH_EVALUATIONS, { batchId, plan })
		wakeSyncQueueWorker()
		return respondAccepted({ batchId, queued: true, plan: !!plan })
	} catch (err) {
		console.error("[create-class-reports/evaluations] ERROR:", (err as Error).message)
		await markError(batchId, BATCH_EVAL_STATUS_SPEC, (err as Error).message).catch(() => {})
		return json({ ok: false, error: (err as Error).message }, 500)
	}
}
