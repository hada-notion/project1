// Supabase Edge Function: sync-exam-scope
//
// 시험범위(학원) DB의 "응시학생 등록" 버튼이 호출한다.
// 일정(학원) DB에서는 이 함수를 호출하지 않는다. 시험 관련 데이터의 원본은 시험범위 DB이며,
// 일정 DB에서 시험범위로 역동기화하는 자동화는 사용하지 않는다.
//
// 노션 수식이던 "응시학생 현황"이 학생 DB에 없는 "상태"/"수강중" 값을 참조하고 있던 버그를
// 계기로, 응시학생 현황과 시험일 계산을 한때 이 함수로 옮겼다 (로드맵 4-5, 2026-09-16).
// 같은 날, "응시학생 현황"은 정확한 속성명("등록상태" == "🟢 등록 중")을 쓰는 노션 수식으로
// 다시 전환했다. "시험일" 자동 계산은 요청한 적 없는 기능이라 같은 날 삭제했다 — "시험일"은
// 이제 사용자가 직접 입력하는 수동 날짜 속성이다. 이 함수는 이제 응시 대상 학생을 찾아 아직
// 없는 성적 행을 만드는 것만 한다.
//
//   1. (응시 대상 학생 찾기) 시험범위와 같은 학년이면서, 학교가 지정돼 있으면 같은 학교인
//      "등록상태 = 🟢 등록 중" 학생 중 아직 이 시험범위에 성적 행이 없는 학생을 찾아 성적 행을
//      만든다. 이미 성적 행이 있는 학생은 건드리지 않는다 (점수 등 기존 입력값 보존).
//
// 호출 방식: body에 { pageId: "시험범위 페이지 id" } 를 담아 호출 ("응시학생 등록" 버튼용).
//
// (2026-09-18, 큐 기반 순차 처리 도입, Phase 3) 실제 처리 로직은 _shared/examScopeTarget.ts로 옮겼다.
//
// (2026-09-20, 웹훅 코드 정리 3단계) 반복되던 "pageId 추출 -> 잠금 확인 -> 처리중 표시 -> 큐 적재 ->
// 202 응답" 뼈대를 _shared/webhookIngest.ts로 옮겼다.
//
// (2026-09-21, PART N: 관리자 키 인증 추가) 이 함수를 호출하는 버튼/자동화 웹훅에 x-admin-key
// 커스텀 헤더를 미리 추가해둔 뒤, requireAdminKey: true로 함수 쪽 검증을 켠다. 헤더가 없으면
// body.adminKey도 확인한다 (webhookIngest.ts의 handleLockedQueueWebhook 참고).
//
// (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환) "응시학생 등록"은 시험범위 1건만 대상으로
// 하는 개별 트리거라 sync_queue를 거칠 필요가 없다. handleLockedQueueWebhook(큐 적재) 대신
// handleSyncWebhook을 써서 버튼 클릭과 동시에 끝나도록 바꿨다.
//
// (2026-09-22, 처리 상태 관리 리팩토링 Phase 3) "처리중" 체크박스를 상태(select)+처리 시작 시각으로
// 전환했다. lockProp/setStatus 대신 statusSpec(EXAM_SCOPE_STATUS_SPEC)을 넘기면 handleSyncWebhook이
// 자동으로 markRunning/markDone/markError를 호출한다. 마스터플랜:
// https://app.notion.com/p/903c90386c1d473494c5df6306c53517

import { handleSyncWebhook } from "../_shared/webhookIngest.ts"
import { EXAM_SCOPE_STATUS_SPEC, processExamScope } from "../_shared/examScopeTarget.ts"

async function processPage(pageId: string): Promise<void> {
	const log: string[] = []
	try {
		await processExamScope(pageId, log)
	} finally {
		console.log("[sync-exam-scope] finished:", pageId, "\n", log.join("\n"))
	}
}

Deno.serve((req: Request) =>
	handleSyncWebhook(req, {
		functionName: "sync-exam-scope",
		statusSpec: EXAM_SCOPE_STATUS_SPEC,
		process: processPage,
		requireAdminKey: true,
	}),
)
