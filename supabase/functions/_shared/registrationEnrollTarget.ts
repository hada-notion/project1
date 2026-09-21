// _shared/registrationEnrollTarget.ts
//
// sync-registration-enroll이 처리하는 실제 "등록" 버튼 로직을 별도 파일로 분리했다 (2026-09-18, 큐 기반
// 순차 처리 도입, Phase 3). 원래 index.ts 안에 있던 코드를 그대로 옮긴 것이다.
//
// (2026-09-21, PART N-3 버그 수정) 클래스가 비어있으면 시간표 설정을 조용히 건너뛰고 그대로
// "완료" 처리해서, 사용자에게는 아무 안내도 없이 시간표만 비어있는 상태로 끝나는 문제가 있었다
// (버튼을 다시 눌러도 이미 등록일이 채워져 있어 겉보기엔 아무 변화가 없어 보임). 이제 클래스가
// 비어있으면 오류로 처리해서 "마지막 오류"/"실시간 처리 상태"에 안내 메세지가 뜨도록 한다.
// 등록일 입력·종료일 제거는 이 오류 이전에 이미 저장되므로 그대로 유지된다. 클래스를 채운 뒤 다시
// "등록"을 누르면 시간표까지 정상적으로 이어서 채워진다 (재시도 시 처음부터 다시 실행되는 구조라
// 별도 복구 로직이 필요 없음).
//
// (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환) "등록" 버튼은 등록 페이지 1건만 대상으로
// 하고(개별 트리거) 실제 작업도 Notion API 호출 1~2건 수준으로 가벼워서, sync_queue를 거칠 이유가
// 없었다. process-sync-queue 워커가 담당하던 processSyncRegistrationEnrollQueueItem은 제거하고,
// index.ts가 이 파일의 processEnrollForRegistration을 직접 호출해서 버튼 클릭과 동시에 끝낸다.
//
// (2026-09-22, PART N-6) 클래스에 연결된 시간표를 무조건 전부 자동 연결하던 로직이, 개별 수업(과외)
// 클래스처럼 같은 클래스 안에 시간대별 시간표 row가 여러 개 있는 경우 전부 다 연결해버리는 문제가
// 있었다 — 학생 1명이 그 반의 모든 시간대(예: 17:00/18:00/19:00)에 한꺼번에 연결되고, 그대로
// "수업 생성"을 누르면 모든 시간대에 출석이 생겨버렸다(등록 시점에는 어느 시간대에 배정될지 아직
// 정해지지 않았기 때문). 이제 클래스의 시간표 중 "수업 방식"이 "개별 수업"인 것은 자동 연결
// 대상에서 제외하고, 그룹 수업(또는 수업 방식 미설정) 시간표만 자동 연결한다. 개별 수업은 담당자가
// 실제 배정될 시간표를 수동으로 연결한 뒤 "수업 생성"을 누르는 흐름으로 처리한다 — "수업 생성"
// 버튼 자체의 로직은 변경하지 않는다(연결된 시간표를 그대로 따라간다).

import {
	PROP_CLASS,
	PROP_ENROLL_DATE,
	PROP_END_DATE,
	PROP_TITLE,
	PROP_TIMETABLE,
	PROP_SYNC_ENROLL_RUNNING,
	PROP_TIMETABLE_CLASS_MODE,
	TIMETABLE_MODE_INDIVIDUAL,
} from "./constants.ts"
import { getPage, updatePageProperties, relIds, titleText, todaySeoulDate, mapWithConcurrency } from "./notionClient.ts"
import { makeSyncStatusSetter } from "./registrationSync.ts"

const PROP_CLASS_TIMETABLE = "시간표" // 클래스(학원) DB의 시간표 relation

export const setEnrollSyncStatus = makeSyncStatusSetter(PROP_SYNC_ENROLL_RUNNING)

export async function processEnrollForRegistration(pageId: string, log: string[]) {
	const reg = await getPage(pageId)
	const regName = titleText(reg, PROP_TITLE)

	const updates: Record<string, unknown> = {}

	const enrollDate = reg.properties[PROP_ENROLL_DATE]?.date?.start
	if (!enrollDate) {
		const today = todaySeoulDate()
		updates[PROP_ENROLL_DATE] = { date: { start: today } }
		log.push(`📅 [${regName}] 등록일이 비어있어 오늘(${today})로 설정함`)
	} else {
		log.push(`✓ [${regName}] 이미 등록일이 있어 유지함 (${enrollDate})`)
	}

	if (reg.properties[PROP_END_DATE]?.date?.start) {
		updates[PROP_END_DATE] = { date: null }
		log.push(`🗑️ [${regName}] 종료일 제거함`)
	}

	if (Object.keys(updates).length > 0) {
		await updatePageProperties(pageId, updates)
	}

	// 시간표는 등록/종료일 변경과 별개로, 비어있을 때만 클래스 기준으로 세팅한다.
	const existingTimetables = relIds(reg.properties[PROP_TIMETABLE])
	if (existingTimetables.length > 0) {
		log.push(`✓ [${regName}] 이미 시간표가 연결되어 있어 유지함 (수동 조정 보존)`)
		return
	}

	const classIds = relIds(reg.properties[PROP_CLASS])
	if (classIds.length === 0) {
		// (2026-09-21, PART N-3) 예전에는 여기서 로그만 남기고 조용히 끝냈다 (사용자에게는 아무
		// 안내도 뜨지 않았음). 등록일/종료일 처리는 이미 위에서 저장이 끝났으므로, 여기서부터는
		// 명시적인 오류로 처리해서 "클래스를 선택하세요" 안내가 화면에 뜨도록 한다.
		throw new Error(`클래스를 선택하세요 (등록일/종료일은 정상 반영됨, 클래스를 연결해야 시간표를 채울 수 있습니다)`)
	}

	const classPage = await getPage(classIds[0])
	const allTimetableIds = relIds(classPage.properties[PROP_CLASS_TIMETABLE])
	if (allTimetableIds.length === 0) {
		log.push(`⚠️ [${regName}] 클래스에 연결된 시간표가 없어 세팅하지 못함`)
		return
	}

	// (2026-09-22, PART N-6) 개별 수업(과외) 시간표는 등록 시점에 어느 시간대에 배정될지 아직
	// 정해지지 않았으므로 자동 연결 대상에서 제외한다. 그룹 수업(또는 수업 방식 미설정) 시간표만
	// 자동으로 연결한다.
	const timetablePages = await mapWithConcurrency(allTimetableIds, 4, (id: string) => getPage(id))
	const groupTimetableIds = timetablePages
		.filter((tt: any) => tt.properties[PROP_TIMETABLE_CLASS_MODE]?.select?.name !== TIMETABLE_MODE_INDIVIDUAL)
		.map((tt: any) => tt.id)
	const individualCount = allTimetableIds.length - groupTimetableIds.length

	if (groupTimetableIds.length === 0) {
		log.push(
			`⚠️ [${regName}] 클래스의 시간표가 모두 개별 수업이라 자동 연결하지 않음 (실제 배정될 시간표를 수동으로 연결한 뒤 "수업 생성"을 누르세요)`,
		)
		return
	}

	await updatePageProperties(pageId, {
		[PROP_TIMETABLE]: { relation: groupTimetableIds.map((id: string) => ({ id })) },
	})
	log.push(
		`🔗 [${regName}] 클래스 기준 그룹 수업 시간표 ${groupTimetableIds.length}건 연결함` +
			(individualCount > 0
				? ` (개별 수업 시간표 ${individualCount}건은 자동 연결 제외 — 필요하면 수동으로 연결 후 "수업 생성"을 누르세요)`
				: ` (필요하면 지금 수동으로 조정 후 "수업 생성"을 누르세요)`),
	)
}
