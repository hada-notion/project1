// _shared/createLearningRecordTarget.ts
//
// create-learning-record가 처리하는 실제 학습기록 생성 로직을 별도 파일로 분리했다 (2026-09-18,
// 큐 기반 순차 처리 도입, Phase 2). 원래 supabase/functions/create-learning-record/index.ts 안에
// 있던 코드를 그대로 옮긴 것이다. webhook payload 파싱(extractPageId 등)은 index.ts에 그대로 둔다.

import {
	mapWithConcurrency,
	getPage,
	createPage as sharedCreatePage,
	updatePageProperties,
	relIds as relIdsFromProp,
	selectName,
	dateStart as dateStartFromProp,
	checkboxValue as checkboxValueFromProp,
	anyTitleText,
} from "./notionClient.ts"

import {
	DS_REGISTRATION,
	DS_LEARNING_RECORD as DS_STUDY_RECORD,
	DS_CLASS_SESSION,
	DS_ATTENDANCE,
} from "./constants.ts"
// (2026-09-21, 이식성 리팩토링) 위 4개도 constants.ts로 이동함 — 그 파일 상단 주석 참고.
// DS_ATTENDANCE는 create-learning-record/index.ts가 여기서 다시 가져다 쓰고 있었는데, 그쪽도
// constants.ts에서 바로 가져오도록 함께 고쳤다 (아래 참고).

const PROP_SESSION_REGISTRATION = "등록"
const PROP_SESSION_ATTENDANCE = "출석"
const PROP_SESSION_DATETIME = "수업일시"
const PROP_SESSION_CLASS = "클래스"

const PROP_ATTENDANCE_REGISTRATION = "등록"
export const PROP_ATTENDANCE_SESSION = "수업" // 출석(학원) DB의 수업 relation (limit 1) — index.ts가 클릭된 페이지 판별에 씀

const PROP_REGISTRATION_BOOKS = "진도교재"

const PROP_BOOK_TODAY = "오늘 학습"
const PROP_BOOK_PROGRESS_TYPE = "진도방식"
const PROP_BOOK_REGULAR_BOOK = "정규교재"

const PROP_REGULAR_BOOK_SUBJECT = "과목"

const PROP_RECORD_TITLE = "학습"
const PROP_RECORD_BOOK = "진도교재"
const PROP_RECORD_REGULAR_BOOK = "교재"
const PROP_RECORD_SUBJECT = "과목"
const PROP_RECORD_ATTENDANCE = "출석"
const PROP_RECORD_REGISTRATION = "등록"
const PROP_RECORD_SESSION = "수업"
const PROP_RECORD_CATEGORY = "구분"

export const PROP_RECORD_GEN_RUNNING = "학습기록 생성중"
const PROP_SHARED_LAST_ERROR = "마지막 오류"

const PROP_BOOK_GEN_RUNNING = "학습기록 생성중"
const PROP_BOOK_LAST_ERROR = "마지막 오류"

const GROUP_PROGRESS_TYPE = "그룹 진도"

const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"]

type JsonRecord = Record<string, unknown>

async function createPage(parentDataSourceId: string, properties: JsonRecord): Promise<JsonRecord> {
	return (await sharedCreatePage(parentDataSourceId, properties)) as JsonRecord
}

export async function setRecordGenRunning(pageId: string, running: boolean): Promise<void> {
	try {
		const props: Record<string, unknown> = { [PROP_RECORD_GEN_RUNNING]: { checkbox: running } }
		if (running) {
			props[PROP_SHARED_LAST_ERROR] = { rich_text: [] }
		}
		await updatePageProperties(pageId, props)
	} catch (err) {
		console.error(`setRecordGenRunning(${pageId}, ${running}) failed`, err)
	}
}

async function setBookGenRunning(pageId: string, running: boolean): Promise<void> {
	try {
		const props: Record<string, unknown> = { [PROP_BOOK_GEN_RUNNING]: { checkbox: running } }
		if (running) {
			props[PROP_BOOK_LAST_ERROR] = { rich_text: [] }
		}
		await updatePageProperties(pageId, props)
	} catch (err) {
		console.error(`setBookGenRunning(${pageId}, ${running}) failed`, err)
	}
}

async function setBookGenDone(pageId: string): Promise<void> {
	try {
		await updatePageProperties(pageId, {
			[PROP_BOOK_GEN_RUNNING]: { checkbox: false },
			[PROP_BOOK_LAST_ERROR]: { rich_text: [] },
		})
	} catch (err) {
		console.error(`setBookGenDone(${pageId}) failed`, err)
	}
}

async function setBookGenError(pageId: string, message: string): Promise<void> {
	try {
		await updatePageProperties(pageId, {
			[PROP_BOOK_GEN_RUNNING]: { checkbox: false },
			[PROP_BOOK_LAST_ERROR]: { rich_text: [{ text: { content: message.slice(0, 1900) } }] },
		})
	} catch (err) {
		console.error(`setBookGenError(${pageId}) failed`, err)
	}
}

export async function setRecordGenDone(pageId: string): Promise<void> {
	try {
		await updatePageProperties(pageId, {
			[PROP_RECORD_GEN_RUNNING]: { checkbox: false },
			[PROP_SHARED_LAST_ERROR]: { rich_text: [] },
		})
	} catch (err) {
		console.error(`setRecordGenDone(${pageId}) failed`, err)
	}
}

export async function setRecordGenError(pageId: string, message: string): Promise<void> {
	try {
		await updatePageProperties(pageId, {
			[PROP_RECORD_GEN_RUNNING]: { checkbox: false },
			[PROP_SHARED_LAST_ERROR]: { rich_text: [{ text: { content: message.slice(0, 1900) } }] },
		})
	} catch (err) {
		console.error(`setRecordGenError(${pageId}) failed`, err)
	}
}

function relIds(page: JsonRecord, propName: string): string[] {
	return relIdsFromProp((page.properties as JsonRecord)?.[propName])
}

function selectValue(page: JsonRecord, propName: string): string | null {
	return selectName(page, propName) ?? null
}

export function checkboxValue(page: JsonRecord, propName: string): boolean {
	return checkboxValueFromProp(page, propName)
}

function dateStart(page: JsonRecord, propName: string): string | null {
	return dateStartFromProp(page, propName)
}

function getTitle(page: JsonRecord): string {
	return anyTitleText(page)
}

function formatKoreanDateLabel(isoDate: string): string {
	const d = new Date(isoDate)
	const mm = String(d.getMonth() + 1).padStart(2, "0")
	const dd = String(d.getDate()).padStart(2, "0")
	const weekday = WEEKDAY_KO[d.getDay()]
	return `${mm}.${dd}(${weekday})`
}

export function dedupe(ids: string[]): string[] {
	return Array.from(new Set(ids))
}

// 등록/진도교재 조회 및 학습기록 생성 등 시간이 걸리는 실제 작업. process-sync-queue 워커가 호출한다.
// 실패 시 예외를 던져 상위에서 오류 상태로 표시한다.
export async function finishCreateLearningRecord(sessionId: string): Promise<unknown> {
		const sessionPage = await getPage(sessionId)
		const sessionDate = dateStart(sessionPage, PROP_SESSION_DATETIME)
		const sessionRegistrationIds = dedupe(relIds(sessionPage, PROP_SESSION_REGISTRATION))
		const sessionAttendanceIds = dedupe(relIds(sessionPage, PROP_SESSION_ATTENDANCE))
		const sessionClassIds = relIds(sessionPage, PROP_SESSION_CLASS)

		if (sessionRegistrationIds.length === 0) {
			return { message: "session_has_no_registrations", sessionId }
		}

		const attendancePages = await mapWithConcurrency(sessionAttendanceIds, 6, (id) => getPage(id))
		const registrationToAttendance = new Map<string, string[]>()
		for (const attendancePage of attendancePages) {
			const attendanceId = attendancePage.id as string
			const ownerRegIds = relIds(attendancePage, PROP_ATTENDANCE_REGISTRATION)
			for (const regId of ownerRegIds) {
				const list = registrationToAttendance.get(regId) ?? []
				list.push(attendanceId)
				registrationToAttendance.set(regId, list)
			}
		}

		const registrationPages = await mapWithConcurrency(sessionRegistrationIds, 6, (id) => getPage(id))
		const bookOwnerMap = new Map<string, string[]>()
		for (const registrationPage of registrationPages) {
			const registrationId = registrationPage.id as string
			const bookIds = relIds(registrationPage, PROP_REGISTRATION_BOOKS)
			for (const bookId of bookIds) {
				const list = bookOwnerMap.get(bookId) ?? []
				list.push(registrationId)
				bookOwnerMap.set(bookId, list)
			}
		}

		const uniqueBookIds = Array.from(bookOwnerMap.keys())
		if (uniqueBookIds.length === 0) {
			return { message: "no_books_found", sessionId }
		}

		const bookPages = await mapWithConcurrency(uniqueBookIds, 6, (id) => getPage(id))
		const checkedBookPages = bookPages.filter((p) => checkboxValue(p, PROP_BOOK_TODAY))

		if (checkedBookPages.length === 0) {
			return { message: "no_books_marked_today", sessionId }
		}

		const className = sessionClassIds[0]
			? getTitle(await getPage(sessionClassIds[0]))
			: ""

		const created = await mapWithConcurrency(checkedBookPages, 3, async (bookPage) => {
			const bookId = bookPage.id as string
			await setBookGenRunning(bookId, true)
			try {
				const progressType = selectValue(bookPage, PROP_BOOK_PROGRESS_TYPE)
				const regularBookIds = relIds(bookPage, PROP_BOOK_REGULAR_BOOK)
				const regularBookId = regularBookIds[0] ?? null

				const regularBookPage = regularBookId ? await getPage(regularBookId) : null
				const subjectIds = regularBookPage ? relIds(regularBookPage, PROP_REGULAR_BOOK_SUBJECT) : []
				const regularBookTitle = regularBookPage ? getTitle(regularBookPage) : ""

				let attendanceIds: string[]
				let registrationIds: string[]
				if (progressType === GROUP_PROGRESS_TYPE) {
					attendanceIds = sessionAttendanceIds
					registrationIds = sessionRegistrationIds
				} else {
					const ownerRegistrationIds = bookOwnerMap.get(bookId) ?? []
					registrationIds = ownerRegistrationIds
					attendanceIds = dedupe(
						ownerRegistrationIds.flatMap((regId) => registrationToAttendance.get(regId) ?? []),
					)
				}

				const dateLabel = sessionDate ? formatKoreanDateLabel(sessionDate) : ""
				const classPart = className ? `(${className})` : ""
				const title = [`[학습]`, `${regularBookTitle}${classPart}`, dateLabel]
					.filter(Boolean)
					.join(" ")
					.trim()

				// (2026-09-18 밤, 재시도 안전성 도입) "오늘 학습" 체크는 1회성 필터 신호일 뿐이고, 학습기록은
				// 여러 개 생성될 수 있어야 한다 (진도 -> 과제 -> 평가처럼 다시 체크해서 새 학습활동을 만들 수 있게).
				// 이전에는 학습기록 생성 성공 직후에 체크를 해제했는데, 그 사이(생성 성공 ~ 체크 해제)에 워커가
				// 죽으면 재시도 시 체크가 아직 켜져 있어 학습기록이 중복 생성될 수 있는 좁은 race window가 있었다.
				// 체크 해제를 학습기록 생성보다 먼저 하도록 순서를 바꿔서, 체크는 "소비 즉시" 해제되고 학습기록
				// 생성 자체가 이 작업의 마지막 단계가 되도록 만들었다. 이러면 재시도 시 이미 해제된 체크 때문에
				// no_books_marked_today로 조용히 스킵될 수 있지만, 그 경우 학습기록 생성이 실제로는 이미
				// 끝났을 가능성이 높고(체크 해제는 생성 전에 이미 성공했으므로) 중복 생성보다 안전한 방향이다.
				await updatePageProperties(bookId, {
					[PROP_BOOK_TODAY]: { checkbox: false },
				})

				const createProps: JsonRecord = {
					[PROP_RECORD_TITLE]: { title: [{ text: { content: title } }] },
					[PROP_RECORD_BOOK]: { relation: [{ id: bookId }] },
					[PROP_RECORD_ATTENDANCE]: { relation: attendanceIds.map((id) => ({ id })) },
					[PROP_RECORD_REGISTRATION]: { relation: registrationIds.map((id) => ({ id })) },
					[PROP_RECORD_SESSION]: { relation: [{ id: sessionId }] },
					[PROP_RECORD_CATEGORY]: { select: { name: "학습" } },
				}
				if (regularBookId) {
					createProps[PROP_RECORD_REGULAR_BOOK] = { relation: [{ id: regularBookId }] }
				}
				if (subjectIds.length > 0) {
					createProps[PROP_RECORD_SUBJECT] = { relation: subjectIds.map((id) => ({ id })) }
				}

				const createdPage = await createPage(DS_STUDY_RECORD, createProps)

				await setBookGenDone(bookId)

				return {
					bookId,
					recordId: createdPage.id as string,
					mode: progressType === GROUP_PROGRESS_TYPE ? "group" : "individual",
					attendanceCount: attendanceIds.length,
					registrationCount: registrationIds.length,
				}
			} catch (err) {
				await setBookGenError(bookId, (err as Error)?.message ?? String(err))
				throw err
			}
		})

		return { ok: true, sessionId, created }
}

// process-sync-queue 워커가 target: "create-learning-record" 작업을 처리할 때 호출하는 진입점.
// statusTargetIds는 index.ts가 이미 "처리중"으로 표시해 둔 페이지 id들(클릭된 페이지 + 실제 수업 페이지)이다.
export async function processCreateLearningRecordQueueItem(payload: {
	sessionId: string
	statusTargetIds: string[]
}): Promise<void> {
	try {
		const created = await finishCreateLearningRecord(payload.sessionId)
		await Promise.all(payload.statusTargetIds.map((id) => setRecordGenDone(id)))
		console.log("create-learning-record (queue) finished", payload.sessionId, created)
	} catch (err) {
		console.error("create-learning-record (queue) failed", err)
		await Promise.all(
			payload.statusTargetIds.map((id) => setRecordGenError(id, (err as Error)?.message ?? String(err))),
		)
		throw err
	}
}
