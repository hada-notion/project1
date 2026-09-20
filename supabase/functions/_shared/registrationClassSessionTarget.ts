// _shared/registrationClassSessionTarget.ts
//
// sync-registration-class-session이 처리하는 실제 "수업 생성" 버튼 로직을 별도 파일로 분리했다
// (2026-09-20, 웹훅 코드 정리 2단계). 등록(학원) DB의 나머지 버튼들(등록/종료 처리/개별교재 생성/
// 시간표 단건 동기화)은 이미 2026-09-18(Phase 3)에 sync_queue 기반으로 옮겨졌는데, 이 "수업 생성"
// 버튼만 그 리팩토링에서 빠진 채 완전 동기 처리로 남아 있었다. 같은 등록 DB의 버튼인데 하나만 다른
// 동시성 모델을 쓰는 게 일관성이 없고, 여러 등록에서 동시에 "수업 생성" 버튼이 눌리면(반 전체 등록
// 직후 등) 이 함수만 Notion API 요청이 서로 겹칠 수 있었다. registrationEnrollTarget.ts /
// registrationEndTarget.ts와 동일한 모양(실제 로직 + processXQueueItem 진입점)으로 맞춘다.
//
// 실제 Notion 조작(수업 roster 연결 + 출석 생성)은 registrationSync.ts의 attachSessionsAndAttendance를
// 그대로 재사용한다 (원래도 index.ts에서 그렇게 쓰고 있었음, 로직 자체는 변경 없음).

import {
	DS_REGISTRATION,
	PROP_CLASS,
	PROP_ENROLL_DATE,
	PROP_END_DATE,
	PROP_TITLE,
	PROP_STATUS,
	PROP_TIMETABLE,
	STATUS_ENDED,
	PROP_SYNC_CLASS_SESSION_RUNNING,
} from "./constants.ts"
import { queryDataSource, getPage, relIds, titleText, mapWithConcurrency } from "./notionClient.ts"
import { attachSessionsAndAttendance, makeSyncStatusSetter } from "./registrationSync.ts"

export const setClassSessionSyncStatus = makeSyncStatusSetter(PROP_SYNC_CLASS_SESSION_RUNNING)

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

// process-sync-queue 워커가 target: "sync-registration-class-session" 작업을 처리할 때 호출하는 진입점.
export async function processSyncRegistrationClassSessionQueueItem(payload: { pageId: string }): Promise<void> {
	const bgLog: string[] = []
	try {
		const reg = await getPage(payload.pageId)
		await createSessionsAndAttendanceForRegistration(reg, bgLog)
		await setClassSessionSyncStatus(payload.pageId, "완료")
		console.log("[sync-registration-class-session] (queue) finished:", payload.pageId, "\n", bgLog.join("\n"))
	} catch (err) {
		console.error(
			"[sync-registration-class-session] (queue) ERROR:",
			(err as Error).message,
			(err as Error).stack,
		)
		await setClassSessionSyncStatus(payload.pageId, "오류", (err as Error).message)
		throw err
	}
}
