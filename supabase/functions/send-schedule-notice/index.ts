// Supabase Edge Function: send-schedule-notice
//
// (v2.8.0) 일정 안내 알림톡(한 건). 버튼 웹훅 하나 → 큐(_shared/scheduleNotice.ts). x-admin-key(웹훅 키) 필요.
//   /event : 일정 [일정 안내 전송] — 그 일정 한 건. 상태는 일정 "일정 안내 상태".
// 월간 일정 안내는 학생 단위로 바뀌어 send-monthly-notice(/class-schedule·/schedule)가 맡는다.
// 이미 대기열·작업 중이면 두 번 넣지 않는다.
import { authorizeKey, securityEnabled } from "../_shared/adminSecurity.ts"
import { getCurrentAdminKey, resolveAdminKeyFromRequest } from "../_shared/adminShared.ts"
import { describeBody, extractPageId, getPage } from "../_shared/notionClient.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
import { isRunning, markError, markQueued } from "../_shared/statusTracking.ts"
import { SCHEDULE_NOTICE_STATUS_SPEC, TARGET_SCHEDULE_EVENT } from "../_shared/scheduleNotice.ts"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

Deno.serve(async (req: Request) => {
	if (req.method !== "POST") return new Response("Use POST", { status: 405 })
	let body: Record<string, unknown> = {}
	try { body = await req.json() } catch { body = {} }
	console.log("[send-schedule-notice] received:", describeBody(body))

	const adminKey = resolveAdminKeyFromRequest(req, body)
	const currentAdminKey = securityEnabled() ? "" : await getCurrentAdminKey()
	if (!adminKey || !await authorizeKey(req, adminKey, currentAdminKey)) return json({ error: "unauthorized" }, 401)

	const route = new URL(req.url).pathname.split("/").pop()
	if (route === "class") return json({ error: "월간 일정 안내는 send-monthly-notice/class-schedule로 옮겼습니다." }, 400)
	if (route !== "event") return json({ error: "주소 끝에 /event를 붙여 주세요." }, 400)
	const pageId = extractPageId(body)
	if (!pageId) return json({ error: "pageId를 찾을 수 없음" }, 400)
	try {
		const page = await getPage(pageId)
		if (isRunning(page, SCHEDULE_NOTICE_STATUS_SPEC)) return json({ ok: true, message: "already_processing", pageId })
		await markQueued(pageId, SCHEDULE_NOTICE_STATUS_SPEC)
		await enqueueSync(TARGET_SCHEDULE_EVENT, { eventId: pageId })
		wakeSyncQueueWorker()
		return respondAccepted({ pageId, route })
	} catch (err) {
		console.error("[send-schedule-notice] ERROR:", (err as Error).message)
		await markError(pageId, SCHEDULE_NOTICE_STATUS_SPEC, (err as Error).message).catch(() => {})
		return json({ ok: false, error: (err as Error).message }, 500)
	}
})
