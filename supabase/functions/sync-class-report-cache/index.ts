// Supabase Edge Function: sync-class-report-cache
//
// 클래스(학원) DB의 "학생 페이지 동기화" 버튼이 호출한다. 보고서를 발송하지 않고, 이 클래스에
// 속한 학생 중 리포트 토큰이 발급된 등록의 report_cache만 미리 다시 계산한다.
// send-report가 발송 직전에 등록 1건에 수행하는 계산을 클래스 전체에 적용하는 수동 점검용 경로다.
//
// 클래스 전체를 처리하면 Notion API 호출이 많아 웹훅 응답이 늦어질 수 있으므로, 버튼에는 즉시
// 202를 응답하고 실제 작업은 sync_queue 워커가 순차 처리한다. x-admin-key 인증을 사용하며,
// 진행 상황은 클래스 페이지의 "학생 페이지 동기화 상태"와 "마지막 오류"에서 확인한다.
//
// (2026-09-18) 실제 재계산 로직과 상태 처리는 _shared/classReportCacheTarget.ts로 분리했다.
// (2026-09-20) 잠금 확인 → 작업중 표시 → 큐 적재 흐름은 _shared/webhookIngest.ts의
// handleLockedQueueWebhook으로 통합했다. 오류가 나면 "마지막 오류"를 기록하고 재실행할 수 있다.

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
