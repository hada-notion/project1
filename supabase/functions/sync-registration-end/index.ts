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
// 종료일이 없으면 아무것도 하지 않고 안내만 반환한다 (버튼을 실수로 눌러도 안전함).
// 각 단계가 idempotent라 이미 처리된 등록에 다시 눌러도 안전하다 (재실행 가능).
//
// 호출 방식: body에 { pageId: "등록 페이지 id" } 를 담아 호출 ("종료 처리" 버튼용).
//
// (2026-09-18, 큐 기반 순차 처리 도입, Phase 3) 실제 처리 로직은 _shared/registrationEndTarget.ts로
// 옮겼다. 이 파일은 웹훅 body 파싱과 사전 잠금 확인만 하고, 실제 처리는 큐에 적재한다.
//
// (2026-09-20, 웹훅 코드 정리 3단계) 반복되던 "pageId 추출 -> 잠금 확인 -> 처리중 표시 -> 큐 적재 ->
// 202 응답" 뼈대를 _shared/webhookIngest.ts로 옮겼다.
//
// (2026-09-21, PART N-2) 등록(학원) DB "종료 처리" 버튼 자동화에 x-admin-key 헤더를 미리 추가해둔 뒤,
// requireAdminKey: true로 인증을 켰다.
//
// (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환) "종료 처리"도 등록 페이지 1건만 대상으로
// 하는 개별 트리거라 sync_queue를 거칠 필요가 없다. handleSyncWebhook으로 바꿔서 버튼 클릭과
// 동시에 끝나도록 한다 — 자세한 설명은 sync-registration-enroll/index.ts 참고.

import { handleSyncWebhook } from "../_shared/webhookIngest.ts"
import { END_STATUS_SPEC, processEndForRegistration } from "../_shared/registrationEndTarget.ts"

async function processPage(pageId: string): Promise<void> {
	const log: string[] = []
	try {
		await processEndForRegistration(pageId, log)
	} finally {
		console.log("[sync-registration-end] finished:", pageId, "\n", log.join("\n"))
	}
}

Deno.serve((req: Request) =>
	handleSyncWebhook(req, {
		functionName: "sync-registration-end",
		statusSpec: END_STATUS_SPEC,
		process: processPage,
		requireAdminKey: true,
	}),
)