// Supabase Edge Function: sync-registration-class-session
//
// 등록(학원) DB "수업 생성" 버튼 전용.
// 연결된 시간표의 기존 수업(수업 학원 DB) 각각에 대해 이 등록의 출석을 생성/연결한다.
//   - 새 수업 페이지는 만들지 않는다 (그건 generate-classes가 시간표를 기준으로 반복 생성하는 몫).
//   - 등록일~종료일(있으면) 범위 안의 수업만 대상으로 한다.
//   - 이미 등록(roster)/출석이 연결된 수업은 건너뛰므로 종료일 변경 등으로 다시 눌러도 안전
//     (재실행 가능).
//   - 이미 만들어져 있는 학습기록이 있으면(같은 수업 + 같은 등록) 새로 만드는 출석에 바로 연결한다
//     (학습기록/학습활동을 새로 만들거나 억지로 매칭하지는 않음).
//
// 호출 방식:
//   - body에 { pageId: "등록 페이지 id" } 를 담아 호출하면 그 등록 1건만 처리 ("수업 생성" 버튼용).
//   - body 없이 호출하면 전체 스캔: 등록일이 있고 아직 종료되지 않은 모든 등록에 대해 처리
//     (cron 안전망용, 선택적).
//
// 수업/출석 생성의 실제 로직은 sync-registration-timetable의 복원(restore) 로직과 거의 동일했기
// 때문에 _shared/registrationSync.ts로 옮겼다.
//
// (2026-09-20, 웹훅 코드 정리 2단계) 이 버튼도 sync-registration-enroll/end/timetable/textbook과
// 동일하게 큐 기반으로 전환했다 (2026-09-18 Phase 3에서 이 버튼만 빠져 있었음 -- 여러 등록에서
// 동시에 "수업 생성"이 눌리면 이 함수만 Notion API 요청이 서로 겹칠 수 있는 구조였다). 실제 처리
// 로직은 _shared/registrationClassSessionTarget.ts로 옮겼고, 이 파일은 다른 등록 버튼들과 동일하게
// 웹훅 body 파싱 + 잠금 선체크 + 큐 적재만 담당한다. body 없이 호출하는 cron 전체 스캔 경로는
// 버튼이 기다리는 응답이 아니므로 기존과 동일하게 동기 처리를 유지한다.
//
// (2026-09-20, 웹훅 코드 정리 3단계) pageId가 있는 웹훅 단건 경로의 "잠금 확인 -> 처리중 표시 ->
// 큐 적재 -> 202 응답" 부분을 _shared/webhookIngest.ts의 runLockedQueueWebhookForPage로 옮겼다.

import { PROP_SYNC_CLASS_SESSION_RUNNING } from "../_shared/constants.ts"
import { extractPageId } from "../_shared/notionClient.ts"
import {
	setClassSessionSyncStatus,
	createSessionsForAllPending,
} from "../_shared/registrationClassSessionTarget.ts"
import { runLockedQueueWebhookForPage } from "../_shared/webhookIngest.ts"

Deno.serve(async (req: Request) => {
	if (req.method !== "POST") {
		return new Response("Use POST", { status: 405 })
	}
	const log: string[] = []
	try {
		let body: Record<string, unknown> = {}
		try {
			body = await req.json()
		} catch {
			body = {}
		}
		console.log("[sync-registration-class-session] received body:", JSON.stringify(body))

		const pageId = extractPageId(body)
		console.log("[sync-registration-class-session] extracted pageId:", pageId)

		if (pageId) {
			return await runLockedQueueWebhookForPage(pageId, {
				functionName: "sync-registration-class-session",
				lockProp: PROP_SYNC_CLASS_SESSION_RUNNING,
				target: "sync-registration-class-session",
				setStatus: setClassSessionSyncStatus,
			})
		}

		// body가 없거나 페이지를 못 찾았으면(cron용) 전체 스캔 -- 버튼이 기다리는 응답이 아니므로
		// 동기적으로 유지한다 (다른 등록 함수의 cron 안전망 경로와 동일한 패턴).
		await createSessionsForAllPending(log)

		return new Response(JSON.stringify({ ok: true, log }, null, 2), {
			headers: { "Content-Type": "application/json" },
		})
	} catch (err) {
		console.error("[sync-registration-class-session] ERROR:", (err as Error).message, (err as Error).stack)
		return new Response(JSON.stringify({ ok: false, error: (err as Error).message, log }, null, 2), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		})
	}
})
