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
	PROP_LAST_ERROR,
} from "./constants.ts"
// (2026-09-21, 이식성 리팩토링) 위 4개도 constants.ts로 이동함 — 그 파일 상단 주석 참고.
// DS_ATTENDANCE는 create-learning-record/index.ts가 여기서 다시 가져다 쓰고 있었는데, 그쪽도
// constants.ts에서 바로 가져오도록 함께 고쳤다 (아래 참고).
import { markQueued, markRunning, markDone, markError, type StatusSpec } from "./statusTracking.ts"

const PROP_SESSION_REGISTRATION = "등록"
const PROP_SESSION_ATTENDANCE = "출석"
const PROP_SESSION_DATETIME = "수업일시"
const PROP_SESSION_CLASS = "클래스"

const PROP_ATTENDANCE_REGISTRATION = "등록"
export const PROP_ATTENDANCE_SESSION = "수업" // 출석(학원) DB의 수업 relation (limit 1) — index.ts가 클릭된 페이지 판별에 씀
const PROP_ATTENDANCE_DATETIME = "수업일시" // 출석(학원) DB 자신의 날짜 속성 (수업 없이도 항상 채워져 있음)
const PROP_ATTENDANCE_CLASS = "클래스" // 출석(학원) DB 자신의 클래스 relation (수업 없이도 채워져 있음)

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
// (2026-09-27, 그룹 진도 보강 지원) 그룹 진도 학생이 결석 후 보강으로 별도 진도를 이행했을 때
// 자동으로 체크되는 checkbox. 진도교재(학원) DB의 "진행도" 계산에서 이 값이 true인 학습기록은
// 제외된다 (그 학생 본인의 실제 진도만 반영되도록).
const PROP_RECORD_MAKEUP = "보강"

// (2026-09-22, 처리 상태 관리 리팩토링 Phase 3) "학습기록 생성중" checkbox를 "학습기록 상태"(select)
// + "학습기록 처리 시작 시각"(date)로 전환. 수업/출석/진도교재(학원) 3개 DB 모두 같은 속성 이름을
// 쓰므로 하나의 스펙(RECORD_GEN_STATUS_SPEC)을 그대로 재사용한다. 기존 checkbox는 폐기. 마스터플랜 참고.
export const RECORD_GEN_STATUS_SPEC: StatusSpec = {
	statusProp: "학습기록 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "학습기록 처리 시작 시각",
}

const GROUP_PROGRESS_TYPE = "그룹 진도"

const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"]

type JsonRecord = Record<string, unknown>

async function createPage(parentDataSourceId: string, properties: JsonRecord): Promise<JsonRecord> {
	return (await sharedCreatePage(parentDataSourceId, properties)) as JsonRecord
}

// (2026-09-22, Phase 6) index.ts가 웹훅 접수 시점에 호출한다 -- 실제 처리는 아직 시작되지 않았고
// sync_queue에 적재만 된 상태임을 나타낸다. 실제 markRunning은
// processCreateLearningRecordQueueItem이 이 항목을 집어서 처리를 시작할 때 호출한다.
export async function setRecordGenQueued(pageId: string): Promise<void> {
	try {
		await markQueued(pageId, RECORD_GEN_STATUS_SPEC)
	} catch (err) {
		console.error(`setRecordGenQueued(${pageId}) failed`, err)
	}
}

// index.ts는 항상 running=true로만 호출한다(버튼 클릭 시 상태 표시 목적) — 시그니처는 이전과
// 호환되도록 유지.
export async function setRecordGenRunning(pageId: string, running: boolean): Promise<void> {
	try {
		if (running) {
			await markRunning(pageId, RECORD_GEN_STATUS_SPEC)
		} else {
			await markDone(pageId, RECORD_GEN_STATUS_SPEC)
		}
	} catch (err) {
		console.error(`setRecordGenRunning(${pageId}, ${running}) failed`, err)
	}
}

async function setBookGenRunning(pageId: string, running: boolean): Promise<void> {
	try {
		if (running) {
			await markRunning(pageId, RECORD_GEN_STATUS_SPEC)
		} else {
			await markDone(pageId, RECORD_GEN_STATUS_SPEC)
		}
	} catch (err) {
		console.error(`setBookGenRunning(${pageId}, ${running}) failed`, err)
	}
}

async function setBookGenDone(pageId: string): Promise<void> {
	try {
		await markDone(pageId, RECORD_GEN_STATUS_SPEC)
	} catch (err) {
		console.error(`setBookGenDone(${pageId}) failed`, err)
	}
}

async function setBookGenError(pageId: string, message: string): Promise<void> {
	try {
		await markError(pageId, RECORD_GEN_STATUS_SPEC, message)
	} catch (err) {
		console.error(`setBookGenError(${pageId}) failed`, err)
	}
}

export async function setRecordGenDone(pageId: string): Promise<void> {
	try {
		await markDone(pageId, RECORD_GEN_STATUS_SPEC)
	} catch (err) {
		console.error(`setRecordGenDone(${pageId}) failed`, err)
	}
}

export async function setRecordGenError(pageId: string, message: string): Promise<void> {
	try {
		await markError(pageId, RECORD_GEN_STATUS_SPEC, message)
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

// (2026-09-27, 그룹 진도 보강 지원) 그룹 진도로 진행되는 반에서 학생이 결석한 뒤, 학원 내에서
// 개인적으로 보강(별도 진도 이행)을 했을 때 쓰는 경로. 이 학생의 출석은 그 날의 실제 수업(세션)과
// 연결되어 있지 않으므로(수업 relation이 비어 있음) 세션 로스터 전체를 대상으로 하는
// finishCreateLearningRecord와는 완전히 별개로, 이 출석 건 자신의 "등록"(limit 1) 하나만을 대상으로
// 학습기록을 생성한다. 수업 relation은 비워두고, 생성되는 학습기록마다 "보강" checkbox를 켜서
// 진도교재의 "진행도" 계산(다른 학생들의 정상 수업 학습기록만 반영하도록)에서 자동으로 제외되게 한다.
export async function finishCreateLearningRecordForAttendance(attendanceId: string): Promise<unknown> {
	const attendancePage = await getPage(attendanceId)
	const registrationIds = dedupe(relIds(attendancePage, PROP_ATTENDANCE_REGISTRATION))
	const registrationId = registrationIds[0]
	if (!registrationId) {
		return { message: "attendance_has_no_registration", attendanceId }
	}

	const registrationPage = await getPage(registrationId)
	const bookIds = dedupe(relIds(registrationPage, PROP_REGISTRATION_BOOKS))
	if (bookIds.length === 0) {
		return { message: "no_books_found", attendanceId }
	}

	const bookPages = await mapWithConcurrency(bookIds, 6, (id) => getPage(id))
	const checkedBookPages = bookPages.filter((p) => checkboxValue(p, PROP_BOOK_TODAY))
	if (checkedBookPages.length === 0) {
		return { message: "no_books_marked_today", attendanceId }
	}

	const attendanceDate = dateStart(attendancePage, PROP_ATTENDANCE_DATETIME)
	const attendanceClassIds = relIds(attendancePage, PROP_ATTENDANCE_CLASS)
	const className = attendanceClassIds[0]
		? getTitle(await getPage(attendanceClassIds[0]))
		: ""

	const created = await mapWithConcurrency(checkedBookPages, 3, async (bookPage) => {
		const bookId = bookPage.id as string
		await setBookGenRunning(bookId, true)
		try {
			const regularBookIds = relIds(bookPage, PROP_BOOK_REGULAR_BOOK)
			const regularBookId = regularBookIds[0] ?? null

			const regularBookPage = regularBookId ? await getPage(regularBookId) : null
			const subjectIds = regularBookPage ? relIds(regularBookPage, PROP_REGULAR_BOOK_SUBJECT) : []
			const regularBookTitle = regularBookPage ? getTitle(regularBookPage) : ""

			const dateLabel = attendanceDate ? formatKoreanDateLabel(attendanceDate) : ""
			const classPart = className ? `(${className})` : ""
			const title = [`[보강]`, `${regularBookTitle}${classPart}`, dateLabel]
				.filter(Boolean)
				.join(" ")
				.trim()

			// finishCreateLearningRecord와 동일한 이유로, 체크 해제를 학습기록 생성보다 먼저 한다
			// (재시도 안전성 -- 위쪽 finishCreateLearningRecord의 2026-09-18 밤 주석 참고).
			await updatePageProperties(bookId, {
				[PROP_BOOK_TODAY]: { checkbox: false },
			})

			const createProps: JsonRecord = {
				[PROP_RECORD_TITLE]: { title: [{ text: { content: title } }] },
				[PROP_RECORD_BOOK]: { relation: [{ id: bookId }] },
				[PROP_RECORD_ATTENDANCE]: { relation: [{ id: attendanceId }] },
				[PROP_RECORD_REGISTRATION]: { relation: [{ id: registrationId }] },
				[PROP_RECORD_CATEGORY]: { select: { name: "학습" } },
				[PROP_RECORD_MAKEUP]: { checkbox: true },
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
				mode: "makeup",
				registrationId,
			}
		} catch (err) {
			await setBookGenError(bookId, (err as Error)?.message ?? String(err))
			throw err
		}
	})

	return { ok: true, attendanceId, created }
}

// process-sync-queue 워커가 target: "create-learning-record" 작업을 처리할 때 호출하는 진입점.
// statusTargetIds는 index.ts가 이미 "⏳ 대기열"로 표시해 둔 페이지 id들(클릭된 페이지 + 실제 수업
// 페이지)이다. (2026-09-22, Phase 6) 실제로 이 항목을 집어서 처리를 시작하는 지금 여기서
// markRunning("🔄 작업중")으로 갱신해야, 동시에 여러 건이 큐에 쌓여 있어도 실제 처리 중인 것만
// "작업중"으로 구분되어 보인다.
export async function processCreateLearningRecordQueueItem(payload: {
	sessionId?: string
	attendanceId?: string
	statusTargetIds: string[]
}): Promise<void> {
	// (2026-09-27, 그룹 진도 보강 지원) attendanceId가 있으면(= index.ts가 수업 없는 출석을 감지한
	// 경우) 세션 로스터 전체를 대상으로 하는 기존 경로 대신, 그 출석 하나만을 위한 단일 학생 경로를
	// 사용한다. 둘 다 있을 수는 없다(index.ts가 둘 중 하나만 채워서 넘긴다).
	const label = payload.sessionId ?? payload.attendanceId ?? "unknown"
	try {
		await Promise.all(payload.statusTargetIds.map((id) => setRecordGenRunning(id, true)))
		const created = payload.attendanceId
			? await finishCreateLearningRecordForAttendance(payload.attendanceId)
			: await finishCreateLearningRecord(payload.sessionId as string)
		await Promise.all(payload.statusTargetIds.map((id) => setRecordGenDone(id)))
		console.log("create-learning-record (queue) finished", label, created)
	} catch (err) {
		console.error("create-learning-record (queue) failed", err)
		await Promise.all(
			payload.statusTargetIds.map((id) => setRecordGenError(id, (err as Error)?.message ?? String(err))),
		)
		throw err
	}
}
