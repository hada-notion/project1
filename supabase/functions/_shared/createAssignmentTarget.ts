// _shared/createAssignmentTarget.ts
//
// create-assignment가 처리하는 실제 학습활동 생성 로직을 별도 파일로 분리했다 (2026-09-18, 큐 기반
// 순차 처리 도입, Phase 2). 원래 supabase/functions/create-assignment/index.ts 안에 있던 코드를
// 그대로 옮긴 것이다. webhook payload 파싱(extractPageId 등)은 index.ts에 그대로 둔다.
//
// (2026-09-18 밤) 사용자 확인: 학습기록(recordId) 하나당 학습활동(과제/평가)은 한 번만 만들어지고
// 끝나야 한다. 새로운 학습활동이 필요하면 학습기록을 새로 만들어서 다시 출제하는 방식이 맞는 흐름이고,
// 같은 학습기록으로 또 출제하는 것은 의도된 동작이 아니다. 그래서 생성 전에 이미 이 학습기록+등록
// 조합으로 만들어진 학습활동이 있는지 확인해서, 있으면 새로 만들지 않고 그 페이지를 그대로 재사용한다.
// 이 확인은 (2026-09-22 이전) process-sync-queue의 재시도(최대 3회)가 이 함수를 다시 호출해도
// 중복 생성되지 않도록 만드는 안전장치이기도 했다.
//
// (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환) "출제" 버튼은 학습기록 1건만 대상으로 하는
// 개별 트리거라 sync_queue를 거칠 필요가 없다고 판단했다. process-sync-queue 전용 진입점
// processCreateAssignmentQueueItem은 제거했고, index.ts가 finishCreateAssignment를 직접 호출한다.
// (재시도가 없어졌지만, 기존에도 재시도는 최대 3회뿐이었고 실패 시 "마지막 오류"에 안내가 남으므로
// 사용자가 버튼을 다시 누르면 된다 -- 위 중복 방지 확인 덕분에 다시 눌러도 안전하다.)

import {
	mapWithConcurrency,
	getPage,
	createPage as sharedCreatePage,
	updatePageProperties,
	queryDataSource,
	relIds as relIdsFromProp,
	selectName,
	dateStart as dateStartFromProp,
	anyTitleText,
} from "./notionClient.ts"

import {
	DS_LEARNING_RECORD as DS_STUDY_RECORD,
	DS_STUDY_ACTIVITY,
	DS_ATTENDANCE,
	DS_REGISTRATION,
} from "./constants.ts"
// (2026-09-21, 이식성 리팩토링) 위 4개도 constants.ts로 이동함 — 그 파일 상단 주석 참고.

const PROP_RECORD_REGISTRATION = "등록"
const PROP_RECORD_ATTENDANCE = "출석"
const PROP_RECORD_SESSION = "수업"
const PROP_RECORD_DATE = "수업일"

const PROP_ATTENDANCE_REGISTRATION = "등록"
const PROP_ATTENDANCE_DATETIME = "수업일시"

const PROP_ACTIVITY_TITLE = "학습활동"
const PROP_ACTIVITY_RECORD = "학습기록"
const PROP_ACTIVITY_REGISTRATION = "등록"
const PROP_ACTIVITY_ATTENDANCE = "출석"
const PROP_ACTIVITY_SESSION = "수업"
const PROP_ACTIVITY_DEADLINE = "과제 마감"
const PROP_ACTIVITY_ASSIGNMENT_STATUS = "과제상태"

export const CATEGORY_ASSIGNMENT = "과제"
export const CATEGORY_EVALUATION = "평가"
const ASSIGNMENT_STATUS_NOT_SUBMITTED = "🔴 밌제출"

const PROP_SHARED_LAST_ERROR = "마지막 오류"
export const PROP_ASSIGNMENT_GEN_RUNNING = "출제 처리중"

const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"]

type JsonRecord = Record<string, unknown>

async function createPage(parentDataSourceId: string, properties: JsonRecord): Promise<JsonRecord> {
	return (await sharedCreatePage(parentDataSourceId, properties)) as JsonRecord
}

export async function setAssignmentGenRunning(recordId: string, running: boolean): Promise<void> {
	try {
		const props: Record<string, unknown> = { [PROP_ASSIGNMENT_GEN_RUNNING]: { checkbox: running } }
		if (running) {
			props[PROP_SHARED_LAST_ERROR] = { rich_text: [] }
		}
		await updatePageProperties(recordId, props)
	} catch (err) {
		console.error(`setAssignmentGenRunning(${recordId}, ${running}) failed`, err)
	}
}

export async function setAssignmentGenDone(recordId: string): Promise<void> {
	try {
		await updatePageProperties(recordId, {
			[PROP_ASSIGNMENT_GEN_RUNNING]: { checkbox: false },
			[PROP_SHARED_LAST_ERROR]: { rich_text: [] },
		})
	} catch (err) {
		console.error(`setAssignmentGenDone(${recordId}) failed`, err)
	}
}

export async function setAssignmentGenError(recordId: string, message: string): Promise<void> {
	try {
		await updatePageProperties(recordId, {
			[PROP_ASSIGNMENT_GEN_RUNNING]: { checkbox: false },
			[PROP_SHARED_LAST_ERROR]: { rich_text: [{ text: { content: message.slice(0, 1900) } }] },
		})
	} catch (err) {
		console.error(`setAssignmentGenError(${recordId}) failed`, err)
	}
}

function relIds(page: JsonRecord, propName: string): string[] {
	return relIdsFromProp((page.properties as JsonRecord)?.[propName])
}

export function selectValue(page: JsonRecord, propName: string): string | null {
	return selectName(page, propName) ?? null
}

function dateStart(page: JsonRecord, propName: string): string | null {
	return dateStartFromProp(page, propName)
}

function getTitle(page: JsonRecord): string {
	return anyTitleText(page)
}

export function dedupe(ids: string[]): string[] {
	return Array.from(new Set(ids))
}

function formatKoreanDateLabel(isoDate: string): string {
	const d = new Date(isoDate)
	const mm = String(d.getMonth() + 1).padStart(2, "0")
	const dd = String(d.getDate()).padStart(2, "0")
	const weekday = WEEKDAY_KO[d.getDay()]
	return `${mm}.${dd}(${weekday})`
}

async function findNextAttendance(registrationId: string, afterIso: string): Promise<string | null> {
	const result = await queryDataSource(DS_ATTENDANCE, {
		filter: {
			and: [
				{ property: PROP_ATTENDANCE_REGISTRATION, relation: { contains: registrationId } },
				{ property: PROP_ATTENDANCE_DATETIME, date: { after: afterIso } },
			],
		},
		sorts: [{ property: PROP_ATTENDANCE_DATETIME, direction: "ascending" }],
		page_size: 1,
	})
	const results = (result.results as JsonRecord[]) ?? []
	return (results[0]?.id as string) ?? null
}

// 이 학습기록(recordId)+등록(registrationId) 조합으로 이미 만들어진 학습활동이 있는지 확인한다.
// 있으면 그 페이지 id를 반환하고, 없으면 null을 반환한다.
async function findExistingActivity(recordId: string, registrationId: string): Promise<string | null> {
	const result = await queryDataSource(DS_STUDY_ACTIVITY, {
		filter: {
			and: [
				{ property: PROP_ACTIVITY_RECORD, relation: { contains: recordId } },
				{ property: PROP_ACTIVITY_REGISTRATION, relation: { contains: registrationId } },
			],
		},
		page_size: 1,
	})
	const results = (result.results as JsonRecord[]) ?? []
	return (results[0]?.id as string) ?? null
}

// 등록/학습활동 생성 등 실제 작업. index.ts가 직접 호출한다.
export async function finishCreateAssignment(
	recordId: string,
	category: string,
	registrationIds: string[],
): Promise<void> {
		const recordPage = await getPage(recordId)
		const attendanceIds = dedupe(relIds(recordPage, PROP_RECORD_ATTENDANCE))
		const sessionIds = relIds(recordPage, PROP_RECORD_SESSION)
		const sessionId = sessionIds[0] ?? null
		const recordDate = dateStart(recordPage, PROP_RECORD_DATE)

		const attendancePages = await mapWithConcurrency(attendanceIds, 6, (id) => getPage(id))
		const registrationToAttendance = new Map<string, string>()
		for (const attendancePage of attendancePages) {
			const attendanceId = attendancePage.id as string
			for (const regId of relIds(attendancePage, PROP_ATTENDANCE_REGISTRATION)) {
				registrationToAttendance.set(regId, attendanceId)
			}
		}

		const created = await mapWithConcurrency(registrationIds, 3, async (registrationId) => {
			// 학습기록당 학습활동은 한 번만 생성되어야 한다 (버튼을 다시 눌러도 이미 만들어진 게
			// 있으면 새로 만들지 않고 그대로 재사용한다).
			const existingActivityId = await findExistingActivity(recordId, registrationId)
			if (existingActivityId) {
				return {
					registrationId,
					activityId: existingActivityId,
					attendanceId: registrationToAttendance.get(registrationId) ?? null,
					deadlineAttendanceId: null,
					reused: true,
				}
			}

			const currentAttendanceId = registrationToAttendance.get(registrationId) ?? null

			let deadlineAttendanceId: string | null = null
			if (category === CATEGORY_ASSIGNMENT) {
				let afterIso = recordDate
				if (currentAttendanceId) {
					const currentAttendancePage = attendancePages.find((p) => (p.id as string) === currentAttendanceId)
					if (currentAttendancePage) {
						afterIso = dateStart(currentAttendancePage, PROP_ATTENDANCE_DATETIME) ?? afterIso
					}
				}
				if (afterIso) {
					deadlineAttendanceId = await findNextAttendance(registrationId, afterIso)
				}
			}

			const registrationPage = await getPage(registrationId)
			const studentName = getTitle(registrationPage)

			const dateLabel = recordDate ? formatKoreanDateLabel(recordDate) : ""
			const title = [`[${category}]`, studentName, dateLabel].filter(Boolean).join(" ").trim()

			const createProps: JsonRecord = {
				[PROP_ACTIVITY_TITLE]: { title: [{ text: { content: title } }] },
				[PROP_ACTIVITY_RECORD]: { relation: [{ id: recordId }] },
				[PROP_ACTIVITY_REGISTRATION]: { relation: [{ id: registrationId }] },
			}
			if (sessionId) {
				createProps[PROP_ACTIVITY_SESSION] = { relation: [{ id: sessionId }] }
			}
			if (currentAttendanceId) {
				createProps[PROP_ACTIVITY_ATTENDANCE] = { relation: [{ id: currentAttendanceId }] }
			}
			if (category === CATEGORY_ASSIGNMENT) {
				createProps[PROP_ACTIVITY_ASSIGNMENT_STATUS] = { select: { name: ASSIGNMENT_STATUS_NOT_SUBMITTED } }
				if (deadlineAttendanceId) {
					createProps[PROP_ACTIVITY_DEADLINE] = { relation: [{ id: deadlineAttendanceId }] }
				}
			}

			const createdPage = await createPage(DS_STUDY_ACTIVITY, createProps)

			return {
				registrationId,
				activityId: createdPage.id as string,
				attendanceId: currentAttendanceId,
				deadlineAttendanceId,
			}
		})

		await setAssignmentGenDone(recordId)
		console.log("create-assignment finished", recordId, category, created)
}