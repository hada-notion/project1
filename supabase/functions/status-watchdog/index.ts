// Supabase Edge Function: status-watchdog
//
// (2026-09-21/22, 처리 상태 관리 리팩토링 Phase 2/4) _shared/statusTracking.ts의
// sweepStaleStatus()를 여러 (데이터소스, 상태 속성 스펙) 조합에 대해 실행하는 관리용 엔드포인트.
// process-sync-queue의 recoverStaleSyncQueueItems와 같은 역할을 하되, Postgres sync_queue가
// 아니라 Notion 페이지의 "상태"(select) 속성을 대상으로 한다.
// 마스터플랜: https://app.notion.com/p/903c90386c1d473494c5df6306c53517
//
// Phase 2 대상(시간표 DB + 메뉴 DB)에 이어, Phase 3에서 등록(학원) DB의 5개 상태(종료/시간표/
// 수업/등록/교재)를 추가했다. 나머지 DB/함수들을 상태(select) 방식으로 전환할 때마다 TARGETS
// 배열에 항목을 추가하면 된다. Phase 4에서 pg_cron이 이 엔드포인트를 주기적으로 호출하도록
// 등록할 예정이다(아직 미등록 — 지금은 관리자가 필요할 때 수동으로 호출).
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
import { DS_TIMETABLE, DS_REGISTRATION, DS_CLASS_SESSION, DS_ATTENDANCE, DS_PROGRESS_BOOK, DS_CLASS, DS_EXAM_SCOPE } from "../_shared/constants.ts"
import { END_STATUS_SPEC } from "../_shared/registrationEndTarget.ts"
import { TIMETABLE_STATUS_SPEC as REG_TIMETABLE_STATUS_SPEC } from "../_shared/registrationTimetableTarget.ts"
import { CLASS_SESSION_STATUS_SPEC } from "../_shared/registrationClassSessionTarget.ts"
import { ENROLL_STATUS_SPEC } from "../_shared/registrationEnrollTarget.ts"
import { TEXTBOOK_STATUS_SPEC, CLASS_TEXTBOOK_STATUS_SPEC } from "../_shared/registrationTextbookTarget.ts"
import { ATTENDANCE_FIX_STATUS_SPEC } from "../_shared/fixAttendanceTarget.ts"
import { RECORD_GEN_STATUS_SPEC } from "../_shared/createLearningRecordTarget.ts"
import { CLASS_REPORT_SYNC_STATUS_SPEC } from "../_shared/classReportCacheTarget.ts"
import { CLASS_CART_STATUS_SPEC } from "../_shared/textbookDistributionTarget.ts"
import { EXAM_SCOPE_STATUS_SPEC } from "../_shared/examScopeTarget.ts"

// 메뉴(학원) DB는 다른 함수들이 DS.xxx 형태로 쿼리한 적이 없어서 전용 환경변수가 없다.
// 이 워치독은 메뉴 DB 전체가 아니라 그 안의 "시간표" 단일 행 하나만 상태 관리 대상이므로,
// 새 환경변수를 추가하는 대신 데이터소스 id를 여기 직접 적었다 (변경 시 여기만 고치면 됨).
const DS_MENU = "0dcba040-586b-83c8-9974-07588b9ab04d" // 메뉴(학원) DB

const TIMETABLE_STATUS_SPEC: StatusSpec = {
	statusProp: "상태",
	errorProp: "마지막 오류",
	startedAtProp: "처리 시작 시각",
}

// 수업(학원) DB 자체 레벨 2개(생성/보고서 일괄전송)는 각각 generate-classes/index.ts,
// send-class-daily-reports/index.ts 안에 로컬로 정의돼 있다 (다른 함수 폴더에서 직접 import하지
// 않는 관례 — TIMETABLE_STATUS_SPEC과 동일한 패턴). 여기서는 같은 속성 이름 literal을 그대로 복제한다.
const SESSION_GEN_STATUS_SPEC: StatusSpec = {
	statusProp: "생성 상태",
	errorProp: "마지막 오류",
	startedAtProp: "생성 처리 시작 시각",
}
const CLASS_BULK_SEND_STATUS_SPEC: StatusSpec = {
	statusProp: "보고서 일괄전송 상태",
	errorProp: "마지막 오류",
	startedAtProp: "보고서 일괄전송 처리 시작 시각",
}

// 클래스(학원) DB 자체 레벨 2개(보고서 생성/수강료 생성)는 각각 generate-report/index.ts,
// generate-tuition/index.ts 안에 로컬로 정의돼 있다 (TIMETABLE_STATUS_SPEC/SESSION_GEN_STATUS_SPEC과
// 동일한 관례). 여기서는 같은 속성 이름 literal을 그대로 복제한다.
const CLASS_REPORT_GEN_STATUS_SPEC: StatusSpec = {
	statusProp: "보고서 생성 상태",
	errorProp: "마지막 오류",
	startedAtProp: "보고서 생성 처리 시작 시각",
}
const CLASS_TUITION_GEN_STATUS_SPEC: StatusSpec = {
	statusProp: "수강료 생성 상태",
	errorProp: "마지막 오류",
	startedAtProp: "수강료 생성 처리 시작 시각",
}

const TARGETS: Array<{ label: string; dataSourceId: string; spec: StatusSpec }> = [
	{ label: "시간표", dataSourceId: DS_TIMETABLE, spec: TIMETABLE_STATUS_SPEC },
	{ label: "메뉴", dataSourceId: DS_MENU, spec: TIMETABLE_STATUS_SPEC },
	// (2026-09-22, Phase 3) 등록(학원) DB 5개 상태.
	{ label: "등록:종료", dataSourceId: DS_REGISTRATION, spec: END_STATUS_SPEC },
	{ label: "등록:시간표", dataSourceId: DS_REGISTRATION, spec: REG_TIMETABLE_STATUS_SPEC },
	{ label: "등록:수업", dataSourceId: DS_REGISTRATION, spec: CLASS_SESSION_STATUS_SPEC },
	{ label: "등록:등록", dataSourceId: DS_REGISTRATION, spec: ENROLL_STATUS_SPEC },
	{ label: "등록:교재", dataSourceId: DS_REGISTRATION, spec: TEXTBOOK_STATUS_SPEC },
	// (2026-09-22, Phase 3) 수업(학원) DB 4개 상태 + 학습기록 상태가 함께 걸린 출석/진도교재 DB.
	{ label: "수업:생성", dataSourceId: DS_CLASS_SESSION, spec: SESSION_GEN_STATUS_SPEC },
	{ label: "수업:출석조정", dataSourceId: DS_CLASS_SESSION, spec: ATTENDANCE_FIX_STATUS_SPEC },
	{ label: "수업:학습기록", dataSourceId: DS_CLASS_SESSION, spec: RECORD_GEN_STATUS_SPEC },
	{ label: "수업:보고서일괄전송", dataSourceId: DS_CLASS_SESSION, spec: CLASS_BULK_SEND_STATUS_SPEC },
	{ label: "출석:학습기록", dataSourceId: DS_ATTENDANCE, spec: RECORD_GEN_STATUS_SPEC },
	{ label: "진도교재:학습기록", dataSourceId: DS_PROGRESS_BOOK, spec: RECORD_GEN_STATUS_SPEC },
	// (2026-09-22, Phase 3) 클래스(학원) DB 5개 상태.
	{ label: "클래스:보고서생성", dataSourceId: DS_CLASS, spec: CLASS_REPORT_GEN_STATUS_SPEC },
	{ label: "클래스:수강료생성", dataSourceId: DS_CLASS, spec: CLASS_TUITION_GEN_STATUS_SPEC },
	{ label: "클래스:학생페이지동기화", dataSourceId: DS_CLASS, spec: CLASS_REPORT_SYNC_STATUS_SPEC },
	{ label: "클래스:교재비생성", dataSourceId: DS_CLASS, spec: CLASS_CART_STATUS_SPEC },
	{ label: "클래스:교재생성", dataSourceId: DS_CLASS, spec: CLASS_TEXTBOOK_STATUS_SPEC },
	// (2026-09-22, Phase 3) 시험범위(학원) DB 1개 상태.
	{ label: "시험범위:처리", dataSourceId: DS_EXAM_SCOPE, spec: EXAM_SCOPE_STATUS_SPEC },
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

	const results: Array<{ label: string; recovered: number; ids: string[] }> = []
	for (const target of TARGETS) {
		try {
			const { recovered, ids } = await sweepStaleStatus(
				target.dataSourceId,
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
