// Supabase Edge Function: sync-registration-enroll
//
// 등록(학원) DB "등록" 버튼 전용 — "종료 처리" 버튼의 반대 동작.
//   1. 등록일이 비어 있으면 버튼을 누른 날짜(오늘)로 등록일을 채운다. 이미 등록일이 있으면 건드리지 않는다.
//   2. 종료일이 있으면 제거한다 (종료 처리로 종료됐던 등록을 다시 등록 상태로 되돌림).
//   3. 시간표 관계가 비어 있으면, 연결된 클래스의 시간표 전체를 그대로 등록에 연결한다.
//      이미 시간표가 연결되어 있으면 덮어쓰지 않는다 — 클래스의 시간표가 학생 개개인에게
//      완전히 똑같이 적용되지 않을 수 있어서, 한 번 수동으로 조정해 둔 값은 유지한다.
//      (기존에는 클래스 속성 편집 웹훅으로 자동 처리했지만, 이제 이 버튼으로 기능을 옮겼다.)
//
// 호출 방식: body에 { pageId: "등록 페이지 id" } 를 담아 호출 ("등록" 버튼용).
//
// (2026-09-18, 큐 기반 순차 처리 도입, Phase 3) 실제 처리 로직은 _shared/registrationEnrollTarget.ts로
// 옮겼다. 이 파일은 웹훅 body 파싱과 잠금 선체크만 하고, 실제 처리는 큐에 적재한다.

import { PROP_SYNC_ENROLL_RUNNING } from "../_shared/constants.ts"
import { getPage, extractPageId, checkboxValue } from "../_shared/notionClient.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
import { setEnrollSyncStatus } from "../_shared/registrationEnrollTarget.ts"

Deno.serve(async (req: Request) => {
	if (req.method !== "POST") {
		return new Response("Use POST", { status: 405 })
	}
	const log: string[] = []
	let pageId: string | null = null
	try {
		let body: Record<string, unknown> = {}
		try {
			body = await req.json()
		} catch {
			body = {}
		}
		console.log("[sync-registration-enroll] received body:", JSON.stringify(body))

		pageId = extractPageId(body)
		if (!pageId) {
			return new Response(JSON.stringify({ error: "pageId를 찾을 수 없음" }), { status: 400 })
		}

		// 이미 처리 중이면 새로 시작하지 않고 즉시 반환 -- 처리 중 재클릭으로 인한 중복 처리 방지.
		const regPageForLock = await getPage(pageId)
		if (checkboxValue(regPageForLock, PROP_SYNC_ENROLL_RUNNING)) {
			return new Response(JSON.stringify({ ok: true, message: "already_processing", pageId }, null, 2), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})
		}

		await setEnrollSyncStatus(pageId, "처리중")

		// 큐에 적재만 하고 즉시 응답한다 -- 실제 처리는 process-sync-queue 워커가 순서대로
		// 처리한다 (2026-09-18, Phase 3). 진행 상황은 등록의 "동기화 상태"(이미 처리중으로 설정됨)로
		// 확인할 수 있다.
		await enqueueSync("sync-registration-enroll", { pageId })
		wakeSyncQueueWorker()

		return respondAccepted({ pageId })
	} catch (err) {
		console.error("[sync-registration-enroll] ERROR:", (err as Error).message, (err as Error).stack)
		if (pageId) {
			await setEnrollSyncStatus(pageId, "오류", (err as Error).message)
		}
		return new Response(JSON.stringify({ ok: false, error: (err as Error).message, log }, null, 2), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		})
	}
})
