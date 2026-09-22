// _shared/registrationClassSessionTarget.ts
//
// sync-registration-class-session이 처리하는 실제 "수업 생성" 버튼 로직을 별도 파일로 분리했다
// (2026-09-20, 웹훅 코드 정리 2단계). 실제 Notion 조작(수업 roster 연결 + 출석 생성)은
// registrationSync.ts의 attachSessionsAndAttendance를 그대로 재사용한다.
//
// (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환) "수업 생성" 버튼은 등록 페이지 1건만
// 대상으로 하는 개별 트리거라 sync_queue를 거칠 필요가 없다고 판단했다.
// processSyncRegistrationClassSessionQueueItem(process-sync-queue 전용 진입점)은 제거했다.
// index.ts가 createSessionsAndAttendanceForRegistration을 직접 호출한다. 이 버튼이 웹훅
// 응답을 기다리지 않고 큐 뒤에서 조용히 처리되던 것이 그동안 "실시간 처리 상태"가 실제 완료
// 시점보다 훨씬 먼저 사라져 보이는 문제(Bug 1)의 원인 중 하나였다 — 동기 처리로 바꾸면 버튼
// 클릭에 대한 응답이 실제 완료(또는 실패) 시점과 정확히 일치한다.

import {
	DS_REGISTRATION,
	PROP_CLASS,
	PROP_ENROLL_DATE,
	PROP_END_DATE,
	PROP_TITLE,
	PROP_STATUS,
	PROP_TIMETABLE,
	STATUS_ENDED,
	PROP_LAST_ERROR,
} from "./constants.ts"
import { queryDataSource, relIds, titleText, mapWithConcurrency } from "./notionClient.ts"
import { attachSessionsAndAttendance } from "./registrationSync.ts"
import { type StatusSpec } from "./statusTracking.ts"

// (2026-09-22, 처리 상태 관리 리팩토링 Phase 3) "수업 처리중" 체크박스 → "수업 상태"(select) +
// "수업 처리 시작 시각"(date). 마스터플랜: https://app.notion.com/p/903c90386c1d473494c5df6306c53517
export const CLASS_SESSION_STATUS_SPEC: StatusSpec = {
	statusProp: "수업 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "수업 처리 시작 시각",
}

// 등록 1건에 대해, 연결된 시간표의 기존 수업들에 이 등록을 붙이고(roster) 출석을 생성한다.
// 시간표는 "등록" 버튼(sync-registration-enroll)에서 클래스 기준으로 세팅하고, 필요하면
// 담당자가 수동으로 조정한 뒤 이 함수(수업 생성 버튼)를 누르는 흐름이라 여기서는 시간표를
// 건드리지 않고 이미 연결된 시간표만 그대로 사용한다.
export async function createSessionsAndAttendanceForRegistration(reg: any, log: string[]) {
	const regName = titleText(reg, PROP_TITLE)

	const enrollDate = reg.properties[PROP_ENROLL_DATE]?.date?.start
	if (!enrollDate) {
		log.push(`⏭️ [${regName}] 등록일이 없어 건너뜀`)
		return
	}

	const timetableIds = relIds(reg.properties[PROP_TIMETABLE])
	if (timetableIds.length === 0) {
		log.push(`⏭️ [${regName}] 연결된 시간표가 없어 건너뜀 ("등록" 버튼을 먼저 눌러 시간표를 연결하세요)`)
		return
	}

	const endDate = reg.properties[PROP_END_DATE]?.date?.start
	const classIds = relIds(reg.properties[PROP_CLASS])

	const {
		sessionsTouched: touchedSessions,
		attendanceCreated: createdAttendance,
		recordsLinked,
	} = await attachSessionsAndAttendance(reg, timetableIds, enrollDate, endDate, classIds)

	if (createdAttendance > 0) {
		log.push(
			`✅ [${regName}] 수업 ${touchedSessions}건 확인, 출석 ${createdAttendance}건 생성 (기존 학습기록 연결 ${recordsLinked}건)`,
		)
	} else {
		log.push(`✓ [${regName}] 이미 모든 수업/출석이 연결되어 있음 (수업 ${touchedSessions}건 확인)`)
	}
}

// 안전망: 등록일이 있고 아직 종료되지 않은 모든 등록을 훑어서 누락분을 보정한다 (선택적 cron용).
// 버튼이 기다리는 응답이 아니므로, index.ts에서 큐를 거치지 않고 그대로 동기 호출한다
// (sync-registration-timetable의 매일 cron 전체 스캔 경로와 동일한 패턴).
export async function createSessionsForAllPending(log: string[]) {
	const data = await queryDataSource(DS_REGISTRATION, {
		filter: {
			and: [
				{ property: PROP_ENROLL_DATE, date: { is_not_empty: true } },
				{ property: PROP_TIMETABLE, relation: { is_not_empty: true } },
				{ property: PROP_STATUS, formula: { string: { does_not_equal: STATUS_ENDED } } },
			],
		},
		page_size: 100,
	})
	await mapWithConcurrency(data.results, 4, (reg: any) => createSessionsAndAttendanceForRegistration(reg, log))
}