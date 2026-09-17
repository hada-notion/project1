// create-learning-record v3
// Trigger: 수업(세션) DB 또는 출석(학원) DB의 "학습기록 생성" 버튼 웹훅
//
// v3에서 바뀜: 이제 출석 페이지에서도 같은 버튼/같은 웹훅으로 호출할 수 있다.
// 클릭된 페이지를 한 번 읨어서 parent.data_source_id로 수업 페이지인지 출석 페이지인지 구분하고,
// 출석 페이지면 그 출석의 "수업" 관계(limit 1)를 따라가 실제 수업(세션) 페이지 id로 바꿔치기한다.
// 그 다음부터는 항상 수업 페이지 기준으로 기존 로직(v2)을 그대로 수행하므로, 수업/출석 어느 쪽
// 버튼을 눌러도 결과(그 수업의 모든 등록/출석에 대한 학습기록 생성)는 동일하다.
//
// 흐름:
// 0. 클릭된 페이지 id를 추출하고, 그 페이지가 출석 페이지면 연결된 수업 페이지 id로 치환한다.
// 1. (치환된) 수업(세션) 페이지를 로맥하여 이 수업의 전역 등록/출석 목롭을 가져온다.
// 2. 각 등록의 진도교재 중 "오늘 학습" 체크박스가 켜진 것들을 묶은다(같은 책은 여러 등록이 공유하여 주입되되 있을 수 있음).
// 3. 진도교재마다 학습기록 1건씩 생성:
//    - 개별 진도: 그 진도교재를 실제로 이용하는 등록(들)과 그 등록의 이 수업에 대한 출석만 연결
//    - 그룹 진도: 수업 전역 등록 + 출석을 모두 연결 (수업 페이지에 이뭐 있는 리스트를 직접 사용)
//    - 교재 = 진도교재의 정규교재, 가묽 = 정규교재의 과목 을 우샤 묍링
//    - 수업 = 버튼이 눌린 그 수업(세션) 페이지 자신
// 4. 처리한 진도교재의 "오늘 학습" 체크박스를 자동으로 해제한다.
//
// [2026-09-17] 학습기록(학원) DB의 "수업일"이 직접 입력하는 date 속성에서, "출석"/"수업" 관계로부터
// 자동 계산되는 formula 속성으로 바뀌었다. 계산되는(읡기 전용) 속성에 직접 쓰면 Notion API가
// createPage 요청 전체를 거부하므로, 아래에서 "수업일"에 쓰던 코드를 제거했다 (더 이상 필요 없음 --
// 이미 함께 설정하는 "출석"/"수업" 관계로부터 저절로 계산된다).

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
} from "../_shared/notionClient.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"

// ---- 데이터소스 UUID ----
const DS_REGISTRATION = "16dba040-586b-838a-ae3c-876c0e9cd474" // 등록(학원) DB
const DS_STUDY_RECORD = "d97ba040-586b-8310-b710-8782e29b5c73" // 학습기록(학원) DB
const DS_CLASS_SESSION = "3b1ba040-586b-80ec-af20-000b31bb69b7" // 수업(학원) DB (다른 함수들과 동일 ID)
const DS_ATTENDANCE = "8aaba040-586b-8322-8437-87608a763415" // 출석(학원) DB (다른 함수들과 동일 ID)

// ---- 수업(세션) DS 속성 ----
const PROP_SESSION_REGISTRATION = "등록"
const PROP_SESSION_ATTENDANCE = "출석"
const PROP_SESSION_DATETIME = "수업일시"
const PROP_SESSION_CLASS = "클래스"

// ---- 출석 DS 속성 ----
const PROP_ATTENDANCE_REGISTRATION = "등록"
const PROP_ATTENDANCE_SESSION = "수업" // 출석(학원) DB의 수업 relation (limit 1) — 출석 버튼 클릭 시 이걸로 실제 수업 페이지를 찾는다

// ---- 등록 DS 속성 ----
const PROP_REGISTRATION_BOOKS = "진도교재"

// ---- 진도교재 DS 속성 ----
const PROP_BOOK_TODAY = "오늘 학습"
const PROP_BOOK_PROGRESS_TYPE = "진도방식"
const PROP_BOOK_REGULAR_BOOK = "정규교재"

// ---- 정규교재 DS 속성 ----
const PROP_REGULAR_BOOK_SUBJECT = "과목"

// ---- 클래스 DS 속성 ----
const PROP_CLASS_NAME = "클래스명"

// ---- 학습기록 DS 속성 ----
const PROP_RECORD_TITLE = "학습"
const PROP_RECORD_BOOK = "진도교재"
const PROP_RECORD_REGULAR_BOOK = "교재"
const PROP_RECORD_SUBJECT = "과목"
const PROP_RECORD_ATTENDANCE = "출석"
const PROP_RECORD_REGISTRATION = "등록"
const PROP_RECORD_SESSION = "수업"
const PROP_RECORD_CATEGORY = "구분"

// ---- 수업(세션)/출석 DS 진행 상태 속성 (2026-09-11: 공유 select "동기화 상태"에서 체크박스로 마이그레이션) ----
const PROP_RECORD_GEN_RUNNING = "학습기록 생성중"
const PROP_SHARED_LAST_ERROR = "마지막 오류"

// ---- 진도교재 DS 진행 상태 속성 (책 단위로 학습기록 생성 진행 상황을 표시) ----
const PROP_BOOK_GEN_RUNNING = "학습기록 생성중"
const PROP_BOOK_LAST_ERROR = "마지막 오류"

const GROUP_PROGRESS_TYPE = "그룹 진도"

const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"]

type JsonRecord = Record<string, unknown>

// createPage 시그니처(parentId, properties)를 유지하는 얇은 래퍼 (호출부를 안 건드리기 위함).
async function createPage(parentDataSourceId: string, properties: JsonRecord): Promise<JsonRecord> {
	return (await sharedCreatePage(parentDataSourceId, properties)) as JsonRecord
}

async function setRecordGenRunning(pageId: string, running: boolean): Promise<void> {
	try {
		const props: Record<string, unknown> = { [PROP_RECORD_GEN_RUNNING]: { checkbox: running } }
		if (running) {
			props[PROP_SHARED_LAST_ERROR] = { rich_text: [] }
		}
		await updatePageProperties(pageId, props)
	} catch (err) {
		// 진행 상태 표시는 부가 기능이므로 실패해도 본 로직은 계속 진행한다.
		console.error(`setRecordGenRunning(${pageId}, ${running}) failed`, err)
	}
}

// ---- 진도교재별 개별 진행 상태 (학습기록 생성 버튼 클릭 시, 책 단위로 표시) ----
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

async function setRecordGenDone(pageId: string): Promise<void> {
	try {
		await updatePageProperties(pageId, {
			[PROP_RECORD_GEN_RUNNING]: { checkbox: false },
			[PROP_SHARED_LAST_ERROR]: { rich_text: [] },
		})
	} catch (err) {
		console.error(`setRecordGenDone(${pageId}) failed`, err)
	}
}

async function setRecordGenError(pageId: string, message: string): Promise<void> {
	try {
		await updatePageProperties(pageId, {
			[PROP_RECORD_GEN_RUNNING]: { checkbox: false },
			[PROP_SHARED_LAST_ERROR]: { rich_text: [{ text: { content: message.slice(0, 1900) } }] },
		})
	} catch (err) {
		console.error(`setRecordGenError(${pageId}) failed`, err)
	}
}

// 아래 다섯 함수는 (page, propName) 시그니처를 유지하는 얇은 래퍼 — 실제 파싱은 _shared/notionClient.ts에 있다.
function relIds(page: JsonRecord, propName: string): string[] {
	return relIdsFromProp((page.properties as JsonRecord)?.[propName])
}

function selectValue(page: JsonRecord, propName: string): string | null {
	return selectName(page, propName) ?? null
}

function checkboxValue(page: JsonRecord, propName: string): boolean {
	return checkboxValueFromProp(page, propName)
}

function dateStart(page: JsonRecord, propName: string): string | null {
	return dateStartFromProp(page, propName)
}

function getTitle(page: JsonRecord): string {
	return anyTitleText(page)
}

// 노션 자동화(버튼) 웹훅 payload에서 페이지 ID를 다단계로 추출한다.
function extractPageId(body: JsonRecord): string | null {
	const data = body.data as JsonRecord | undefined
	if (data && typeof data.id === "string") {
		const found = findUuid(data.id)
		if (found) return found
	}

	const topLevelCandidates = [body.pageId, body.pageUrl, body.url, body.id]
	for (const candidate of topLevelCandidates) {
		const found = findUuid(typeof candidate === "string" ? candidate : "")
		if (found) return found
	}

	const recursiveMatch = findPageObjectId(body)
	if (recursiveMatch) return recursiveMatch

	return findUuid(JSON.stringify(body))
}

function findUuid(text: string): string | null {
	const match = text.match(
		/[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}/,
	)
	if (!match) return null
	return normalizeUuid(match[0])
}

function normalizeUuid(raw: string): string {
	const hex = raw.replace(/-/g, "")
	if (hex.length !== 32) return raw
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function findPageObjectId(node: unknown): string | null {
	if (!node || typeof node !== "object") return null
	const obj = node as JsonRecord
	if (obj.object === "page" && typeof obj.id === "string") {
		return normalizeUuid(obj.id)
	}
	for (const value of Object.values(obj)) {
		if (value && typeof value === "object") {
			const found: string | null = Array.isArray(value)
				? (value.map(findPageObjectId).find((v) => v) ?? null)
				: findPageObjectId(value)
			if (found) return found
		}
	}
	return null
}

function formatKoreanDateLabel(isoDate: string): string {
	const d = new Date(isoDate)
	const mm = String(d.getMonth() + 1).padStart(2, "0")
	const dd = String(d.getDate()).padStart(2, "0")
	const weekday = WEEKDAY_KO[d.getDay()]
	return `${mm}.${dd}(${weekday})`
}

function dedupe(ids: string[]): string[] {
	return Array.from(new Set(ids))
}

type BookInfo = {
	bookId: string
	progressType: string | null
	regularBookId: string | null
	ownerRegistrationIds: string[]
}

async function handleRequest(req: Request): Promise<Response> {
	if (req.method === "OPTIONS") {
		return new Response("ok", {
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Headers": "*",
			},
		})
	}

	let body: JsonRecord = {}
	try {
		const text = await req.text()
		console.log("create-learning-record raw body:", text)
		body = text ? (JSON.parse(text) as JsonRecord) : {}
	} catch (err) {
		console.error("Failed to parse request body", err)
		return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 })
	}

	const clickedId = extractPageId(body)
	if (!clickedId) {
		console.error("Could not extract clicked pageId from payload", body)
		return new Response(JSON.stringify({ error: "missing_page_id" }), { status: 400 })
	}

	// 클릭된 페이지가 출석 페이지면, 그 출석이 연결된 수업(세션) 페이지 id로 바꿔치기한다.
	// 수업 페이지가 클릭된 경우(기존 동���)나 parent 조회가 실패한 경우는 그대로 sessionId로 사용한다.
	let sessionId = clickedId
	try {
		const clickedPage = await getPage(clickedId)
		const parentDataSourceId = (clickedPage as JsonRecord | undefined)?.parent
			? ((clickedPage.parent as JsonRecord).data_source_id as string | undefined)
			: undefined
		if (parentDataSourceId === DS_ATTENDANCE) {
			const linkedSessionIds = relIds(clickedPage, PROP_ATTENDANCE_SESSION)
			if (linkedSessionIds.length === 0) {
				console.error("Attendance page has no linked session", clickedId)
				return new Response(
					JSON.stringify({ error: "attendance_missing_session", pageId: clickedId }),
					{ status: 400 },
				)
			}
			sessionId = linkedSessionIds[0]
		}
	} catch (err) {
		// 클릭된 페이지 조회에 실패해도, 원래 id를 수업 페이지로 간주하고 계속 진행한다 (기존 동작 유지).
		console.error(`Failed to resolve session from clicked page ${clickedId}, falling back to it directly`, err)
	}

	// 출석 페이지에서 버튼을 눌렀을 때도 그 출석 페이지 자신의 "학습기록 생성중" 체크박스가 갱신되도록,
	// 클릭된 페이지와 (치환된) 수업 페이지 둘 다에 상태를 표시한다. 같은 페이지면 한 번만 호출된다.
	const statusTargetIds = dedupe([clickedId, sessionId])
	async function markRunning(): Promise<void> {
		await Promise.all(statusTargetIds.map((id) => setRecordGenRunning(id, true)))
	}
	async function markDone(): Promise<void> {
		await Promise.all(statusTargetIds.map((id) => setRecordGenDone(id)))
	}
	async function markError(message: string): Promise<void> {
		await Promise.all(statusTargetIds.map((id) => setRecordGenError(id, message)))
	}

	await markRunning()

	// Notion의 "웹훅 보내기" 버튼 액션은 이 응답을 동기적으로 기다린다. 등록/진도교재 수가 많으면
	// 처리 시간이 길어져 "버튼 실행 실패: 웹훅 요청 시간이 초과되었습니다" 알림이 뜰 수 있으므로
	// (실제로는 끝까지 정상 처리됨), 여기서부터는 응답을 먼저 보내고 나머지는 백그라운드로 미룬다.
	// 진행 상황은 수업/출석의 "학습기록 생성중" 체크박스(이미 켜져 있음)로 확인할 수 있다.
	runInBackground(async () => {
		try {
			const created = await finishCreateLearningRecord(sessionId)
			await markDone()
			console.log("create-learning-record (background) finished", sessionId, created)
		} catch (err) {
			console.error("create-learning-record (background) failed", err)
			await markError((err as Error)?.message ?? String(err))
		}
	})

	return respondAccepted({ sessionId })
}

// 등록/진도교재 조회 및 학습기록 생성 등 시간이 걸리는 실제 작업. handleRequest가 응답을 먼저
// 보낸 뒤 runInBackground를 통해 이 함수를 호출한다. 실패 시 예외를 던져 상위에서 오류 상태로 표시한다.
async function finishCreateLearningRecord(sessionId: string): Promise<unknown> {
		const sessionPage = await getPage(sessionId)
		const sessionDate = dateStart(sessionPage, PROP_SESSION_DATETIME)
		const sessionRegistrationIds = dedupe(relIds(sessionPage, PROP_SESSION_REGISTRATION))
		const sessionAttendanceIds = dedupe(relIds(sessionPage, PROP_SESSION_ATTENDANCE))
		const sessionClassIds = relIds(sessionPage, PROP_SESSION_CLASS)

		if (sessionRegistrationIds.length === 0) {
			return { message: "session_has_no_registrations", sessionId }
		}

		// 이 수업의 출석들을 묈어서 각 출석이 어느 등록 소유인지 매한다 (개별 진도용 정밀 연결)
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

		// 각 등록의 진도교재 목롭을 묈어서 책 소유자 지닉다
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

		// 클래스명 하나만 미리 로맥해둔다 (제목 생성에 사용)
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

				await updatePageProperties(bookId, {
					[PROP_BOOK_TODAY]: { checkbox: false },
				})

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

Deno.serve(handleRequest)
