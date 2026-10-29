// Supabase Edge Function: status-watchdog
//
// (2026-09-21/22, 처리 상태 관리 리팩토링 Phase 2/4) _shared/statusTracking.ts의
// sweepStaleStatus()를 여러 (데이터소스, 상태 속성 스펙) 조합에 대해 실행하는 관리용 엔드포인트.
// process-sync-queue의 recoverStaleSyncQueueItems와 같은 역할을 하되, Postgres sync_queue가
// 아니라 Notion 페이지의 "상태"(select) 속성을 대상으로 한다.
// 마스터플랜: https://app.notion.com/p/903c90386c1d473494c5df6306c53517
//
// Phase 2 대상(시간표 DB + 메뉴 DB)에 이어, Phase 3에서 등록(학원) DB의 상태(종료/수업/등록/교재)를
// 추가했다. 나머지 DB/함수들을 상태(select) 방식으로 전환할 때마다 TARGETS
// 배열에 항목을 추가하면 된다. Phase 4에서 pg_cron이 이 엔드포인트를 5분마다 호출하도록
// 등록했다(20260922150000_status_watchdog_cron.sql). 필요하면 관리자가 수동 호출할 수도 있다.
//
// [2026-09-22, Phase 3] 등록(학원) DB 5개 스펙 추가 직후, 마이그레이션 검증 과정에서 실제로
// sync-registration-end가 테스트 페이지에서 5분 넘게 "🔄 작업중" 상태로 멈춰있는 상황이 실제로
// 발생했다 (notionClient.ts의 fetchWithRetry에 타임아웃이 없다는, 애초에 이 리팩토링을 시작하게
// 만든 Bug 1과 동일한 원인으로 추정). 이 워치독을 등록 DB에 연결해서 실제로 그 멈춘 페이지를
// 회수(⏱️ 타임아웃 복구)할 수 있는지 바로 검증했다 — 아래 TARGETS에 등록 DB 5개를 추가한 커밋의
// 검증 기록은 마스터플랜 문서 참고.
//
// 요청: POST, 헤더 x-admin-key 필요. 바디 { "staleMinutes": <number> } 로 기본 임계값(15분)을
// 이번 호출에 한해 덮어쓸 수 있다(운영 중 급하게 회수해야 할 때 등). 대상별로 다른 임계값이
// 필요해지면 TARGETS 항목에 개별 staleMinutes를 추가하는 방식으로 확장한다.

import { requireAdminKey } from "../_shared/adminShared.ts"
import { sweepStaleStatus, type StatusSpec } from "../_shared/statusTracking.ts"
import {
	DS_TIMETABLE,
	DS_REGISTRATION,
	DS_CLASS_SESSION,
	DS_ATTENDANCE,
	DS_PROGRESS_BOOK,
	DS_CLASS,
	DS_LEARNING_RECORD,
	DS_STUDY_ACTIVITY,
	DS_TEXTBOOK_CART,
	DS_TEXTBOOK_DISTRIBUTION,
	DS_TEXTBOOK_PAYMENT,
	DS_SCHEDULE_EVENT,
} from "../_shared/constants.ts"
import { TEXTBOOK_STATUS_SPEC, CLASS_TEXTBOOK_STATUS_SPEC } from "../_shared/registrationTextbookTarget.ts"
import { ATTENDANCE_FIX_STATUS_SPEC } from "../_shared/fixAttendanceTarget.ts"
import { RECORD_GEN_STATUS_SPEC } from "../_shared/createLearningRecordTarget.ts"
import { CLASS_REPORT_SYNC_STATUS_SPEC } from "../_shared/classReportCacheTarget.ts"
import { CART_STATUS_SPEC } from "../_shared/textbookDistributionTarget.ts"
import { CASCADE_DELETE_STATUS_SPEC } from "../_shared/cascadeDeleteTarget.ts"
import { ASSIGNMENT_GEN_STATUS_SPEC } from "../_shared/createAssignmentTarget.ts"
import { CLASS_REPORT_GEN_STATUS_SPEC, resolveBatchDataSourceId } from "../_shared/classReportPlan.ts"
import { BATCH_EVAL_STATUS_SPEC } from "../_shared/evaluationPlan.ts"
import { FINAL_EVAL_STATUS_SPEC } from "../_shared/finalEvaluation.ts"
import { ROUTINE_STATUS_SPEC } from "../_shared/routineCheck.ts"
import { SCHEDULE_NOTICE_STATUS_SPEC } from "../_shared/scheduleNotice.ts"
import { CLASS_LETTER_GEN_STATUS_SPEC, CLASS_TUITION_GEN_STATUS_SPEC } from "../_shared/monthlyNotice.ts"
import { resolveMenuDataSourceId } from "../_shared/menuDataSource.ts"

// 메뉴(학원) DB는 전용 Secret이 없다. 이 워치독은 그 안의 "시간표" 단일 행만 상태 관리 대상이다.
// 예전에는 원본 데이터소스 id를 여기 직접 적어 운영 학원에서는 매번 실패했다. 이제 실행할 때
// 이 학원 워크스페이스에서 이름으로 찾는다(_shared/menuDataSource.ts, v2.7.14).
const MENU_LABEL = "메뉴"

const TIMETABLE_STATUS_SPEC: StatusSpec = {
	statusProp: "상태",
	errorProp: "마지막 오류",
	startedAtProp: "처리 시작 시각",
}

// 수업(학원) DB "생성 상태"는 generate-classes/index.ts 안에 로컬로 정의돼 있다 (다른 함수 폴더에서 직접 import하지
// 않는 관례 — TIMETABLE_STATUS_SPEC과 동일한 패턴). 여기서는 같은 속성 이름 literal을 그대로 복제한다.
const SESSION_GEN_STATUS_SPEC: StatusSpec = {
	statusProp: "생성 상태",
	errorProp: "마지막 오류",
	startedAtProp: "생성 처리 시작 시각",
}

// 출석(학원) DB의 "과제마감 백필" 큐(backfill-assignment-deadlines/index.ts)도 같은 관례로
// 로컬에 정의돼 있다 (2026-09-24, 분리 큐 재설계).
const ATTENDANCE_BACKFILL_STATUS_SPEC: StatusSpec = {
	statusProp: "과제마감 백필 상태",
	errorProp: "마지막 오류",
	startedAtProp: "과제마감 백필 처리 시작 시각",
}

const TARGETS: Array<{ label: string; dataSourceId: string | (() => Promise<string | null>); spec: StatusSpec }> = [
	{ label: "시간표", dataSourceId: DS_TIMETABLE, spec: TIMETABLE_STATUS_SPEC },
	{ label: MENU_LABEL, dataSourceId: resolveMenuDataSourceId, spec: TIMETABLE_STATUS_SPEC },
	// 등록(학원) DB 상태. (v2.7.11) 종료·수업·등록 상태는 v2.7부터 Notion 버튼만 쓰므로 뺐다.
	{ label: "등록:교재", dataSourceId: DS_REGISTRATION, spec: TEXTBOOK_STATUS_SPEC },
	// (2026-09-22, Phase 3) 수업(학원) DB 4개 상태 + 학습기록 상태가 함께 걸린 출석/진도교재 DB.
	{ label: "수업:생성", dataSourceId: DS_CLASS_SESSION, spec: SESSION_GEN_STATUS_SPEC },
	{ label: "수업:출석조정", dataSourceId: DS_CLASS_SESSION, spec: ATTENDANCE_FIX_STATUS_SPEC },
	{ label: "수업:학습기록", dataSourceId: DS_CLASS_SESSION, spec: RECORD_GEN_STATUS_SPEC },
	{ label: "출석:학습기록", dataSourceId: DS_ATTENDANCE, spec: RECORD_GEN_STATUS_SPEC },
	{ label: "진도교재:학습기록", dataSourceId: DS_PROGRESS_BOOK, spec: RECORD_GEN_STATUS_SPEC },
	// 클래스(학원) DB 상태. (v2.7.11) 보고서·수강료·교재비 생성 상태는 Notion 자동화만 쓰므로 뺐다.
	{ label: "클래스:학생페이지동기화", dataSourceId: DS_CLASS, spec: CLASS_REPORT_SYNC_STATUS_SPEC },
	// (v2.8.0) 보고서 생성은 다시 서버(create-class-reports, 큐)가 한다. 마지막 학생이 끝나지 못하고 멈추면 회수.
	{ label: "클래스:보고서생성", dataSourceId: DS_CLASS, spec: CLASS_REPORT_GEN_STATUS_SPEC },
	// (v2.8.0) 알림톡 발송함 [평가 생성]. 발송함 DB는 전용 Secret 없이 보고서 DB 관계에서 찾는다.
	{ label: "발송함:평가생성", dataSourceId: resolveBatchDataSourceId, spec: BATCH_EVAL_STATUS_SPEC },
	// (v2.8.0) 진도교재 [진도 평가 생성](예전 단원·마무리 두 버튼 포함).
	{ label: "진도교재:진도평가", dataSourceId: DS_PROGRESS_BOOK, spec: FINAL_EVAL_STATUS_SPEC },
	// (v2.8.0 루틴) 수업 [루틴 체크 생성].
	{ label: "수업:루틴체크", dataSourceId: DS_CLASS_SESSION, spec: ROUTINE_STATUS_SPEC },
	// (v2.8.0) 일정 안내(일정 한 건).
	{ label: "일정:일정안내", dataSourceId: DS_SCHEDULE_EVENT, spec: SCHEDULE_NOTICE_STATUS_SPEC },
	// (v2.8.0) 클래스 [월 수강료 생성].
	{ label: "클래스:수강료생성", dataSourceId: DS_CLASS, spec: CLASS_TUITION_GEN_STATUS_SPEC },
	{ label: "클래스:가정통신문생성", dataSourceId: DS_CLASS, spec: CLASS_LETTER_GEN_STATUS_SPEC },
	{ label: "클래스:교재생성", dataSourceId: DS_CLASS, spec: CLASS_TEXTBOOK_STATUS_SPEC },
	// (2026-09-22, Phase 3) cascade-delete가 공유하는 "삭제 처리중" 상태 — 7개 DB(원래 마스터플랜
	// 표엔 4개만 있었으나 코드 확인 후 교재비 계열 3개까지 범위 확장, cascadeDeleteTarget.ts 참고).
	{ label: "수업:삭제", dataSourceId: DS_CLASS_SESSION, spec: CASCADE_DELETE_STATUS_SPEC },
	{ label: "출석:삭제", dataSourceId: DS_ATTENDANCE, spec: CASCADE_DELETE_STATUS_SPEC },
	{ label: "학습기록:삭제", dataSourceId: DS_LEARNING_RECORD, spec: CASCADE_DELETE_STATUS_SPEC },
	{ label: "학습활동:삭제", dataSourceId: DS_STUDY_ACTIVITY, spec: CASCADE_DELETE_STATUS_SPEC },
	{ label: "교재비(카트):삭제", dataSourceId: DS_TEXTBOOK_CART, spec: CASCADE_DELETE_STATUS_SPEC },
	{ label: "교재배부:삭제", dataSourceId: DS_TEXTBOOK_DISTRIBUTION, spec: CASCADE_DELETE_STATUS_SPEC },
	{ label: "교재결제:삭제", dataSourceId: DS_TEXTBOOK_PAYMENT, spec: CASCADE_DELETE_STATUS_SPEC },
	// (2026-09-22, Phase 3) create-assignment("학습활동 생성" 버튼)의 활동 생성 상태 -> 상태 전환.
	// 마스터플랜 표엔 "학습활동 DB 활동 생성 상태"으로 적혀 있었으나, 실제 버튼/속성은 학습기록 DB에
	// 있다 (createAssignmentTarget.ts 상단 주석 참고).
	{ label: "학습기록:활동생성", dataSourceId: DS_LEARNING_RECORD, spec: ASSIGNMENT_GEN_STATUS_SPEC },
	// (2026-09-22, Phase 3) sync-textbook-distribution의 from-cart 라우트("진도교재 담기" 버튼)의
	// "담기 처리중" checkbox -> 상태 전환.
	{ label: "교재비(카트):담기", dataSourceId: DS_TEXTBOOK_CART, spec: CART_STATUS_SPEC },
	// (2026-09-24, 분리 큐 재설계) generate-classes가 채우고 backfill-assignment-deadlines가
	// 드레인하는 출석(학원) DB "과제마감 백필" 큐.
	{ label: "출석:과제마감백필", dataSourceId: DS_ATTENDANCE, spec: ATTENDANCE_BACKFILL_STATUS_SPEC },
]

Deno.serve(async (req) => {
	if (req.method === "OPTIONS") {
		return new Response(null, {
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
				"Access-Control-Allow-Methods": "POST, OPTIONS",
			},
		})
	}

	const authError = await requireAdminKey(req)
	if (authError) return authError

	let staleMinutesOverride: number | undefined
	try {
		const body = await req.json()
		if (typeof body?.staleMinutes === "number" && body.staleMinutes > 0) {
			staleMinutesOverride = body.staleMinutes
		}
	} catch {
		// 바디 없음 -> 각 대상 기본값(15분) 사용
	}

	const results: Array<{ label: string; recovered: number; ids: string[]; skipped?: string }> = []
	for (const target of TARGETS) {
		try {
			const dataSourceId = typeof target.dataSourceId === "function" ? await target.dataSourceId() : target.dataSourceId
			if (!dataSourceId) {
				console.warn(`[status-watchdog] ${target.label}: 데이터소스를 찾지 못해 건너뜀`)
				results.push({ label: target.label, recovered: 0, ids: [], skipped: "data_source_not_found" })
				continue
			}
			const { recovered, ids } = await sweepStaleStatus(
				dataSourceId,
				target.spec,
				staleMinutesOverride ?? 15,
			)
			results.push({ label: target.label, recovered, ids })
		} catch (err) {
			console.error(`[status-watchdog] ${target.label} sweep 실패:`, (err as Error).message)
			results.push({ label: target.label, recovered: 0, ids: [] })
		}
	}

	return new Response(JSON.stringify({ ok: true, results }, null, 2), {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
		},
	})
})
