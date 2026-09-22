// Supabase Edge Function: generate-report (v2)
//
// 클래스(학원) DB의 "보고서 생성" 버튼이 호출한다. 실제 생성 로직/상태 스펙은
// _shared/generateReportTarget.ts로 옮겼다(2026-09-22, Phase 6: 동시성 제어 -- 큐 도입).
//
// v2 변경 사항 (2026-09-22, Phase 6): 클래스 여러 개를 한꺼번에(멀티 셀렉트 등으로) "보고서 생성"을
// 누르면, v1 방식(즉시 202 + handleLockedBackgroundWebhook의 runInBackground로 각자 바로 실행)에서는
// Notion API 호출이 한꺼번에 몰릴 수 있고, 화면에는 클릭한 클래스 전부가 "🔄 작업중"으로 보여서
// 실제 몇 건이 동시에 처리되는지 알 수 없었다. sync_queue로 옮기고(target: "generate-report",
// _shared/generateReportTarget.ts의 processGenerateReportQueueItem), process-sync-queue가 정한 동시
// 처리 한도(현재 3)만큼만 실제로 처리하도록 바꿨다. 이 함수는 이제 "이미 접수(대기열 포함)돼 있으면
// 즉시 반환 -> 아니면 '⏳ 대기열' 표시 -> sync_queue 적재 -> 즉시 202 응답"까지만 하고, 실제
// processClass 호출/완료·오류 반영은 큐 워커가 담당한다. 마스터플랜:
// https://app.notion.com/p/903c90386c1d473494c5df6306c53517
//
// (2026-09-21, PART N-2: 관리자 키 인증 추가) 이 함수를 호출하는 클래스(학원) DB "보고서 생성"
// 버튼 자동화에 x-admin-key 헤더를 먼저 추가해둔 뒤, webhookIngest.ts의 handleQueuedBackgroundWebhook
// 에 있는 opt-in requireAdminKey 옵션을 여기서 켠다.

import { handleQueuedBackgroundWebhook } from "../_shared/webhookIngest.ts"
import { CLASS_REPORT_STATUS_SPEC } from "../_shared/generateReportTarget.ts"

Deno.serve((req: Request) =>
	handleQueuedBackgroundWebhook(req, {
		functionName: "generate-report",
		statusSpec: CLASS_REPORT_STATUS_SPEC,
		target: "generate-report",
		missingIdError: "classId를 찾지 못함",
		idField: "classId",
		requireAdminKey: true,
	}),
)
