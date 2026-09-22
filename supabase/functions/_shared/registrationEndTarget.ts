// _shared/registrationEndTarget.ts
//
// sync-registration-end가 처리하는 실제 "종료 처리" 버튼 로직을 별도 파일로 분리했다 (2026-09-18, 큐 기반
// 순차 처리 도입, Phase 3). 원래 index.ts 안에 있던 코드를 그대로 옮긴 것이다.
//
// (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환) processSyncRegistrationEndQueueItem은 제거했다.
// index.ts가 processEndForRegistration을 직접 호출한다 — 자세한 설명은 registrationEnrollTarget.ts
// 상단 주석 참고. (PART N-5에서 index.ts가 이 함수를 호출하는 방식이 "응답을 기다림"에서 "백그라운드로
// 넘김"으로 바뀌었지만, 이 함수 자체의 시그니처/동작은 그대로다 — _shared/webhookIngest.ts 상단
// PART N-5 주석 참고.)
//
// [2026-09-22, PART N-5: 종료일 자동 채움] "등록" 버튼(sync-registration-enroll)은 등록일이 비어있으면
// 오늘 날짜로 채워주는데, "종료 처리" 버튼은 반대로 종료일이 비어있으면 아무것도 하지 않고 그냥
// 건너뛰기만 했다 (사용자가 "종료일 없이 종료 처리를 누르면 오늘부로 종료된 걸로 처리해달라"고 요청).
// 이제 종료일이 이미 입력되어 있으면 그 값을 그대로 쓰고, 비어있을 때만 오늘 날짜로 채운 뒤 같은
// 흐름(출석 삭제/수업 연결 해제/시간표 해제/교재 정리)을 그대로 진행한다.

import {
	PROP_END_DATE,
	PROP_TITLE,
	PROP_TIMETABLE,
	PROP_LAST_ERROR,
} from "./constants.ts"
import { getPage, updatePageProperties, relIds, titleText, todaySeoulDate } from "./notionClient.ts"
import {
	archiveAttendanceAfterEndDate,
	disconnectClassSessionsAfterEndDate as disconnectClassSessionsAfterEndDateShared,
	callTextbookCleanup,
} from "./registrationSync.ts"
import { type StatusSpec } from "./statusTracking.ts"

// (2026-09-22, 처리 상태 관리 리팩토링 Phase 3) "종료 처리중" 체크박스 → "종료 상태"(select) +
// "종료 처리 시작 시각"(date). 마스터플랜: https://app.notion.com/p/903c90386c1d473494c5df6306c53517
export const END_STATUS_SPEC: StatusSpec = {
	statusProp: "종료 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "종료 처리 시작 시각",
}

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
	let endDate = reg.properties[PROP_END_DATE]?.date?.start
	if (!endDate) {
		// (2026-09-22, PART N-5) 종료일이 없으면 버튼을 누른 날짜(오늘)로 채운 뒤 계속 진행한다 --
		// "등록" 버튼이 등록일을 오늘로 채우는 것과 대칭되는 동작.
		endDate = todaySeoulDate()
		await updatePageProperties(pageId, { [PROP_END_DATE]: { date: { start: endDate } } })
		log.push(`📅 [${regName}] 종료일이 없어 오늘(${endDate})로 채움`)
	}

	// 출석 삭제와 수업 roster 해제는 서로 다른 리소스를 건드는 독립 작업이라 동시 실행한다.
	await Promise.all([
		deleteAttendanceAfterEndDate(pageId, endDate, regName, log),
		disconnectClassSessionsAfterEndDate(pageId, endDate, regName, log),
	])
	await disconnectTimetable(pageId, regName, log)
	await cleanupTextbooks(pageId, regName, log)
}