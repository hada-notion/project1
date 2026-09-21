// _shared/registrationEndTarget.ts
//
// sync-registration-end가 처리하는 실제 "종료 처리" 버튼 로직을 별도 파일로 분리했다 (2026-09-18, 큐 기반
// 순차 처리 도입, Phase 3). 원래 index.ts 안에 있던 코드를 그대로 옮긴 것이다.
//
// (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환) processSyncRegistrationEndQueueItem은 제거했다.
// index.ts가 processEndForRegistration을 직접 호출한다 — 자세한 설명은 registrationEnrollTarget.ts
// 상단 주석 참고.

import {
	PROP_END_DATE,
	PROP_TITLE,
	PROP_TIMETABLE,
	PROP_SYNC_END_RUNNING,
} from "./constants.ts"
import { getPage, updatePageProperties, relIds, titleText } from "./notionClient.ts"
import {
	archiveAttendanceAfterEndDate,
	disconnectClassSessionsAfterEndDate as disconnectClassSessionsAfterEndDateShared,
	callTextbookCleanup,
	makeSyncStatusSetter,
} from "./registrationSync.ts"

export const setEndSyncStatus = makeSyncStatusSetter(PROP_SYNC_END_RUNNING)

async function deleteAttendanceAfterEndDate(
	registrationId: string,
	endDateIso: string,
	regName: string | undefined,
	log: string[],
) {
	const { deletedCount, activityCount, recordCount } = await archiveAttendanceAfterEndDate(registrationId, endDateIso)
	if (deletedCount > 0) {
		const extra =
			activityCount || recordCount ? ` (학습활동 ${activityCount}건, 학습기록 ${recordCount}건 함께 삭제)` : ""
		log.push(`🗑️ [${regName}] 종료일 이후 출석 ${deletedCount}건 삭제${extra}`)
	} else {
		log.push(`✓ [${regName}] 종료일 이후 삭제할 출석 없음`)
	}
}

async function disconnectClassSessionsAfterEndDate(
	registrationId: string,
	endDateIso: string,
	regName: string | undefined,
	log: string[],
) {
	const { disconnectedCount } = await disconnectClassSessionsAfterEndDateShared(registrationId, endDateIso)
	if (disconnectedCount > 0) {
		log.push(`🔌 [${regName}] 종료일 이후 수업 ${disconnectedCount}건에서 이 등록 연결 해제`)
	} else {
		log.push(`✓ [${regName}] 종료일 이후 연결 해제할 수업 없음`)
	}
}

async function disconnectTimetable(registrationId: string, regName: string | undefined, log: string[]) {
	const reg = await getPage(registrationId)
	const timetableIds = relIds(reg.properties[PROP_TIMETABLE])
	if (timetableIds.length === 0) {
		log.push(`✓ [${regName}] 이미 시간표 연결 없음`)
		return
	}
	await updatePageProperties(registrationId, { [PROP_TIMETABLE]: { relation: [] } })
	log.push(`🔌 [${regName}] 시간표 연결 ${timetableIds.length}건 전부 해제`)
}

async function cleanupTextbooks(registrationId: string, regName: string | undefined, log: string[]) {
	const result = await callTextbookCleanup(registrationId)
	if (!result.ok) {
		if (result.kind === "http") {
			log.push(`⚠️ [${regName}] 교재 정리 호출 실패: ${result.status} ${result.body}`)
		} else {
			log.push(`⚠️ [${regName}] 교재 정리 호출 오류: ${result.message}`)
		}
		return
	}
	log.push(
		`📚 [${regName}] 진도교재 정리: 연결해제 ${result.unlinked.length}건, 삭제 ${result.deleted.length}건, 보존(진행중/학습기록있음) ${result.kept.length}건`,
	)
}

export async function processEndForRegistration(pageId: string, log: string[]) {
	const reg = await getPage(pageId)
	const regName = titleText(reg, PROP_TITLE)
	const endDate = reg.properties[PROP_END_DATE]?.date?.start
	if (!endDate) {
		log.push(`⏭️ [${regName}] 종료일이 없어 종료 처리를 건너뜀`)
		return
	}

	// 출석 삭제와 수업 roster 해제는 서로 다른 리소스를 건드는 독립 작업이라 동시 실행한다.
	await Promise.all([
		deleteAttendanceAfterEndDate(pageId, endDate, regName, log),
		disconnectClassSessionsAfterEndDate(pageId, endDate, regName, log),
	])
	await disconnectTimetable(pageId, regName, log)
	await cleanupTextbooks(pageId, regName, log)
}