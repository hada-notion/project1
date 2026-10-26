// Supabase Edge Function: send-lesson-notice
//
// (v2.8.0) 수업 안내 알림톡. 출석 DB 자동화 [웹훅] 수업 안내("수업 안내 상태"가 ⚪ 대기로 바뀌면)가 /queue로 부른다.
// 수업 [수업 안내 일괄 전송]·출석 [수업 안내 전송] 버튼은 상태만 바꾼다(일일 보고서 send-daily-report/queue와 같은 방식).
// 큐에 넣고 바로 202, process-sync-queue가 한 건씩 보낸다(_shared/lessonNotice.ts). x-admin-key(웹훅 키) 필요.
import { authorizeKey, securityEnabled } from "../_shared/adminSecurity.ts"
import { getCurrentAdminKey, resolveAdminKeyFromRequest } from "../_shared/adminShared.ts"
import { describeBody, extractPageId } from "../_shared/notionClient.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
import { TARGET_LESSON_NOTICE } from "../_shared/lessonNotice.ts"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

Deno.serve(async (req: Request) => {
	if (req.method !== "POST") return new Response("Use POST", { status: 405 })
	let body: Record<string, any> = {}
	try { body = await req.json() } catch { body = {} }
	console.log("[send-lesson-notice] received:", describeBody(body))

	const adminKey = resolveAdminKeyFromRequest(req, body)
	const currentAdminKey = securityEnabled() ? "" : await getCurrentAdminKey()
	if (!adminKey || !await authorizeKey(req, adminKey, currentAdminKey)) return json({ error: "unauthorized" }, 401)

	if (new URL(req.url).pathname.split("/").pop() !== "queue") return json({ error: "주소 끝에 /queue를 붙여 주세요." }, 400)
	const attendanceId = extractPageId(body)
	if (!attendanceId) return json({ error: "출석 페이지 id를 찾지 못했어요." }, 400)
	const clickerUserId = body?.data?.properties?.["실행자"]?.people?.[0]?.id ?? null
	await enqueueSync(TARGET_LESSON_NOTICE, { attendanceId, clickerUserId })
	wakeSyncQueueWorker()
	return respondAccepted({ attendanceId, queued: true })
})
