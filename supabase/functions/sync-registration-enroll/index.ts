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
// 호출 방식: body에 { pageId: \"등록 페이지 id\" } 를 담아 호출 (\"등록\" 버튼용).
//
// (2026-09-18, 큐 기반 순차 처리 도입, Phase 3) 실제 처리 로직은 _shared/registrationEnrollTarget.ts로
// 옮겼다. 이 파일은 웹훅 body 파싱과 잠금 선체크만 하고, 실제 처리는 큐에 적재한다.
//
// (2026-09-20, 웹훅 코드 정리 3단계) 반복되던 "pageId 추출 -> 잠금 확인 -> 처리중 표시 -> 큐 적재 ->
// 202 응답" 뼈대를 _shared/webhookIngest.ts로 옮겼다. 이 파일은 이제 자신의 target 이름 / 잠금
// 속성 / 상태 setter만 넘긴다.
//
// (2026-09-21, PART N-2) 등록(학원) DB "등록" 버튼 자동화에 x-admin-key 헤더를 미리 추가해둔 뒤,
// requireAdminKey: true로 인증을 켰다 (다른 관리자 함수들과 동일한 패턴).

import { PROP_SYNC_ENROLL_RUNNING } from "../_shared/constants.ts"
import { handleLockedQueueWebhook } from "../_shared/webhookIngest.ts"
import { setEnrollSyncStatus } from "../_shared/registrationEnrollTarget.ts"

Deno.serve((req: Request) =>
	handleLockedQueueWebhook(req, {
		functionName: "sync-registration-enroll",
		lockProp: PROP_SYNC_ENROLL_RUNNING,
		target: "sync-registration-enroll",
		setStatus: setEnrollSyncStatus,
		requireAdminKey: true,
	}),
)
