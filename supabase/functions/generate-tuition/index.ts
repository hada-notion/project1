// supabase/functions/generate-tuition/index.ts (v2)
//
// 클래스(학원) DB의 "월 수강료 생성" 버튼이 호출한다. 실제 생성 로직/상태 스펙은
// _shared/generateTuitionTarget.ts로 옮겼다(2026-09-22, Phase 6: 동시성 제어 -- 큐 도입, 사유는
// generate-report/index.ts와 동일 -- 그 파일 상단 주석 참고).
//
// (2026-09-21, PART N-2: 관리자 키 인증 추가) 이 함수를 호출하는 클래스(학원) DB "월 수강료 생성"
// 버튼 자동화에 x-admin-key 헤더를 먼저 추가해둔 뒤, webhookIngest.ts의 handleQueuedBackgroundWebhook
// 에 있는 opt-in requireAdminKey 옵션을 여기서 켠다.

import { handleQueuedBackgroundWebhook } from "../_shared/webhookIngest.ts"
import { CLASS_TUITION_STATUS_SPEC } from "../_shared/generateTuitionTarget.ts"

Deno.serve((req: Request) =>
	handleQueuedBackgroundWebhook(req, {
		functionName: "generate-tuition",
		statusSpec: CLASS_TUITION_STATUS_SPEC,
		target: "generate-tuition",
		missingIdError: "classId를 찾지 못함",
		idField: "classId",
		requireAdminKey: true,
	}),
)
