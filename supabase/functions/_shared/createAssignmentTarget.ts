// _shared/createAssignmentTarget.ts
//
// create-assignment가 처리하는 실제 학습활동 생성 로직을 별도 파일로 분리했다 (2026-09-18, 큐 기반
// 순차 처리 도입, Phase 2). 원래 supabase/functions/create-assignment/index.ts 안에 있던 코드를
// 그대로 옮긴 것이다. webhook payload 파싱(extractPageId 등)은 index.ts에 그대로 둔다.

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

export const DS_STUDY_RECORD = "d97ba040-586b-8310-b710-8782e29b5c73" // 학습기록(학원) DB
export const DS_STUDY_ACTIVITY = "ea2ba040-586b-8368-8bb6-070564a5a31c" // 학습활동(학원) DB
export const DS_ATTENDANCE = "8aaba040-586b-8322-8437-87608a763415" // 출석(학원) DB
export const DS_REGISTRATION = "16dba040-586b-838a-ae3c-876c0e9cd474" // 등록(학원) DB

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

// 등록/학습활동 생성 등 시간이 걸리는 실제 작업. process-sync-queue 워커가 호출한다.
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
		console.log("create-assignment (queue) finished", recordId, category, created)
}

// process-sync-queue 워커가 target: "create-assignment" 작업을 처리할 때 호출하는 진입점.
export async function processCreateAssignmentQueueItem(payload: {
	recordId: string
	category: string
	registrationIds: string[]
}): Promise<void> {
	try {
		await finishCreateAssignment(payload.recordId, payload.category, payload.registrationIds)
	} catch (err) {
		console.error("create-assignment (queue) failed", err)
		await setAssignmentGenError(payload.recordId, (err as Error)?.message ?? String(err))
		throw err
	}
}
