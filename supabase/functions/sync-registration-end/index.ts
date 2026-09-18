// Supabase Edge Function: sync-registration-end
//
// 등록(학원) DB "종료 처리" 버튼 전용.
// 종료일 기준으로 아래를 "즉시" 실행한다 (수강상태 수식이 실제로 종료로 바뀌길 기다리지 않음):
//   1. 종료일 이후 날짜의 출석을 삭제(archive)하고, 함께 연결돼 있던 학습활동/학습기록도 정리한다.
//   2. 종료일 이후 날짜의 수업 페이지들에서 이 등록을 roster("등록" relation)에서 제거한다.
//   3. 시간표 관계를 전부 해제한다.
//   4. 진도교재 정리는 sync-registration-textbook의 cleanup-on-end 라우트에 위임한다
//      ("다음 교재" 상태 + 학습기록 없음 인 인스턴스만: 그룹 진도는 연결 해제, 개별 진도는 페이지 삭제.
//      진행 중/완료 상태이거나 학습기록이 있는 교재는 절대 건드리지 않음).
//
// 종료일이 없으면 아무것도 하지 않고 안내만 반환한다 (버튼을 실수로 누러도 안전함).
// 각 단계가 idempotent라 이미 처리된 등록에 다시 눌러도 안전하다 (재실행 가능).
//
// 호출 방식: body에 { pageId: "등록 페이지 id" } 를 담아 호출 ("종료 처리" 버튼용).
//
// (2026-09-18, 큐 기반 순차 처리 도입, Phase 3) 실제 처리 로직은 _shared/registrationEndTarget.ts로
// 옮겼다. 이 파일은 웹훅 body 파싱과 잠금 선체크만 하고, 실제 처리는 큐에 적재한다.

import { PROP_SYNC_END_RUNNING } from "../_shared/constants.ts"
import { getPage, extractPageId, checkboxValue } from "../_shared/notionClient.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
import { setEndSyncStatus } from "../_shared/registrationEndTarget.ts"

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
		console.log("[sync-registration-end] received body:", JSON.stringify(body))

		pageId = extractPageId(body)
		if (!pageId) {
			return new Response(JSON.stringify({ error: "pageId를 찾을 수 없음" }), { status: 400 })
		}

		// 이미 처리 중이면(백그라운드 작업이 아직 안 끝남) 새로 시작하지 않고 즉시 반환한다 --
		// 처리 중 재클릭으로 인한 중복 생성/중복 처리를 막기 위한 락.
		const regPageForLock = await getPage(pageId)
		if (checkboxValue(regPageForLock, PROP_SYNC_END_RUNNING)) {
			return new Response(JSON.stringify({ ok: true, message: "already_processing", pageId }, null, 2), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})
		}

		await setEndSyncStatus(pageId, "처리중")

		// 큐에 적재만 하고 즉시 응답한다 -- 실제 처리는 process-sync-queue 워커가 순서대로
		// 처리한다 (2026-09-18, Phase 3). 진행 상황은 등록의 "동기화 상태"(이미 처리중으로 설정됨)로
		// 확인할 수 있다.
		await enqueueSync("sync-registration-end", { pageId })
		wakeSyncQueueWorker()

		return respondAccepted({ pageId })
	} catch (err) {
		console.error("[sync-registration-end] ERROR:", (err as Error).message, (err as Error).stack)
		if (pageId) {
			await setEndSyncStatus(pageId, "오류", (err as Error).message)
		}
		return new Response(JSON.stringify({ ok: false, error: (err as Error).message, log }, null, 2), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		})
	}
})
