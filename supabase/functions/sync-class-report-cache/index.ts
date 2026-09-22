// Supabase Edge Function: sync-class-report-cache
//
// 클래스(학원) DB의 "학생 페이지 보다 동기화" 버튼이 호출한다.
// 돴고서를 실제로 발송하지 않고, 이 클래스에 속한 학생들 중 리포트 토큰이 발급된 등록 전에의
// 학부모 리포트 캐쉬(report_cache 토이러별)만 미리 강제로 다시 계산한다.
// send-report가 발송 직전에 등록 1건에 대해 하는 ensureFreshReportCache와 같은 계산(reportCacheBuilder.ts의
// buildCacheRowForRegistration)을, 발송 없이 클래스 전엑 학생에 대해 보다 실행하는 버전이다.
//
// 사용 배경(2026-09-18): 및송 발송 전에 여러 학생의 리포트 웹사이트를 한 번에 보다
// 확인하고 싶다는 요샕. 실제로 이액 알림톡을 발송해버리면 되널마 없으므로, 발송과 전혀
// 분리된 별도의 보다이기/확인자용 동기화 경로가 필요했다.
//
// generate-report/generate-tuition과 같은 버튼-웹훅 패턴: 즉시 202 응답 -> 해당 작업을 sync_queue에
// 적재해 순차대로 처리. (등록 1건만 재가곱해땄 Notion API를 수십 번 호출해야 해서, 반 전체를 듙 엱으난
// 춘적으로 처리하면 Notion "웹훅 보내기" 자동화가 응답을 기다리다 타임아웃난다. 그러른데
// sync-report-cache와 동일하게 항상 즉시 202로 응답하고 나리네 작업은 큐 워커가 처리한다.)
// (2026-09-21, PART N-2: 관리자 키 인증 추가) 이 함수를 호출하는 클래스(학원) DB "학생 페이지
// 동기화" 버튼 자동화에 x-admin-key 헤더를 먼저 추가해둔 뒤, webhookIngest.ts의 handleLockedQueueWebhook
// 에 이미 있는 opt-in requireAdminKey 옵션을 여기서 켠다(더 이상 무인증 신뢰 버튼 웹훅이 아니다).
// 진행 상황은 클래스 페이지의 "실시간 처리 상태" 속성("학생 페이지 동기화중" 체크박스 + "마지막 오류")으로 확인한다.
//
// [FIX, 2026-09-18] CLASS_REPORT_SYNC_RUNNING이 "리포트 동기화중"으로 하드코딩되어 있었는데,
// 클래스(학원) DB의 실제 체크박스 이맄이 이땄까지 돰 하("리포트 보다 동기화중" -> "학생 페이지
// 동기화중") 변되어서 탑넊 달려지 안뜻되느 데이타에 됬다. 그 결과 이 함수가 시작하자마자
// (runInBackground로 넘어가기도 전에) setClassStatus가 존재하지 않는 속성에 PATCH를 시도해
// Notion API 400 에러로 즉시 실패했고, 실제 재생산(processClass)은 단 한 번도 실행되지 몷한 채
// 클래스 버튼 클릭이 러버마다 조용히 실패하고 있었다 (등록 페이지의 개별 "학생 페이지 동기화"
// 버튼은 이 체크박스를 쓰지 않아 영향이 없었다). 실제 스키마의 체크박스 이맄으로 상수를 맞추다.
//
// (2026-09-18, 큐 기반 순차 처리 도입, Phase 2) 실제 재생산 로직(processClass)과 상태 setter는
// _shared/classReportCacheTarget.ts로 옮겼다. 이 파일은 웹훅 payload 파싱 + 사전 잠금 확인 +
// sync_queue에 작업 적재까지만 담당하고, 실제 작업은 process-sync-queue 워커가 순차적으로 처리한다.
//
// (2026-09-20, 웹훅 코드 정리 3단계) "잠금 확인 -> 처리중 표시 -> 큐 적재 -> 202 응답" 부분을
// _shared/webhookIngest.ts로 옮겼다. 이전에는 이 파일에 try/catch가 전혀 없어서(다른 등록 버튼
// 웹훅들과 달리) getPage/setClassStatus 등에서 예외가 나면 "오류" 표시 없이 조용히 500만 나가는
// 차이가 있었는데, 공용 헬퍼로 옮기면서 다른 함수들과 동일하게 오류 시에도 "마지막 오류"가
// 기록되고 재클릭이 가능해지도록 맞췄다 (부수적인 안정성 개선). classId를 못 찾았을 때 오류 문구의
// 오타("찾지 목함" -> "찾지 못함")도 함께 고쳤다.

import { handleLockedQueueWebhook } from "../_shared/webhookIngest.ts"
import { CLASS_REPORT_SYNC_STATUS_SPEC } from "../_shared/classReportCacheTarget.ts"

Deno.serve((req: Request) =>
	handleLockedQueueWebhook(req, {
		functionName: "sync-class-report-cache",
		statusSpec: CLASS_REPORT_SYNC_STATUS_SPEC,
		target: "sync-class-report-cache",
		buildPayload: (pageId) => ({ classId: pageId }),
		requireAdminKey: true,
	}),
)
