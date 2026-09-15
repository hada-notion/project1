// create-assignment v2
// Trigger: 학습기록(학원) DB의 "출제" 버튼 웹훅
//
// 학습기록의 "구분"이 과제 또는 평가로 되어 있을 때, 이 버튼을 누르면 그 학습기록에 연결된
// 등록(학생) 각각에 대해 학습활동을 1건씩 생성한다 (그룹 진도로 여러 학생이 연결된 학습기록이면
// 학생 수만큼 학습활동이 생성됨).
//
// v2에서 추가됨: "동기화 상태" 속성을 처리 중 락(lock)으로 사용한다. 같은 학습기록에 대해
// 버튼이 짧은 시간 안에 여러 번(더블클릭, 웹훅 타임아웃 후 재시도 등) 눌려도, 이미 처리 중인
// 요청이 있으면 새 요청은 아무 작업도 하지 않고 즉시 반환한다 — 즉 항상 순차적으로만 실행된다.
//
// 구분별 처리:
// - 과제: 그 학생의 "다음 수업" 출석을 찾아 학습활동의 "과제 마감"에 자동으로 연결하고,
//   "과제상태"는 🔴 미제출로 시작한다.
// - 평가: 마감/점수 관련 필드는 비워두고 선생님이 학습활동 페이지에서 나중에 직접 입력한다.
//
// 흐름:
// 0. 클릭된 학습기록 페이지 id를 웹훅 payload에서 추출한다.
// 1. 학습기록의 "구분"이 과제/평가가 아니면(즉 "학습") 아무것도 하지 않고 종료한다.
// 2. 학습기록에 연결된 등록/출석/수업/수업일을 읨는다.
// 3. 출석들을 조회해 등록 → (이 수업의) 출석 매핑을 만든다.
// 4. 등록마다 학습활동 1건을 생성한다. 과제인 경우 그 학생의 다음 수업 출석을 조회해 마감으로 연결한다.

import {
	fetchWithRetry,
	mapWithConcurrency,
	getPage,
	createPage as sharedCreatePage,
	updatePageProperties,
	queryDataSource,
	relIds as relIdsFromProp,
	selectName,
	dateStart as dateStartFromProp,
	checkboxValue as checkboxValueFromProp,
	anyTitleText,
} from "../_shared/notionClient.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"

// ---- 데이터소스 UUID (다른 함수들과 동일한 값 사용) ----
const DS_STUDY_RECORD = "d97ba040-586b-8310-b710-8782e29b5c73" // 학습기록(학원) DB
const DS_STUDY_ACTIVITY = "ea2ba040-586b-8368-8bb6-070564a5a31c" // 학습활동(학원) DB
const DS_ATTENDANCE = "8aaba040-586b-8322-8437-87608a763415" // 출석(학원) DB
const DS_REGISTRATION = "16dba040-586b-838a-ae3c-876c0e9cd474" // 등록(학원) DB

// ---- 학습기록 DS 속성 ----
const PROP_RECORD_CATEGORY = "구분"
const PROP_RECORD_REGISTRATION = "등록"
const PROP_RECORD_ATTENDANCE = "출석"
const PROP_RECORD_SESSION = "수업"
const PROP_RECORD_DATE = "수업일"

// ---- 출석 DS 속성 ----
const PROP_ATTENDANCE_REGISTRATION = "등록"
const PROP_ATTENDANCE_DATETIME = "수업일시"

// ---- 등록 DS 속성 ----
const PROP_REGISTRATION_TITLE_FALLBACK = "이름" // getTitle()이 title 타입을 직접 찾으므로 참고용

// ---- 학습활동 DS 속성 ----
const PROP_ACTIVITY_TITLE = "학습활동"
const PROP_ACTIVITY_CATEGORY = "구분"
const PROP_ACTIVITY_RECORD = "학습기록"
const PROP_ACTIVITY_REGISTRATION = "등록"
const PROP_ACTIVITY_ATTENDANCE = "출석"
const PROP_ACTIVITY_SESSION = "수업"
const PROP_ACTIVITY_DEADLINE = "과제 마감"
const PROP_ACTIVITY_ASSIGNMENT_STATUS = "과제상태"

const CATEGORY_ASSIGNMENT = "과제"
const CATEGORY_EVALUATION = "평가"
const ASSIGNMENT_STATUS_NOT_SUBMITTED = "🔴 미제출"

// ---- 학습기록 DS 진행 상태 속성 (중복/동시 실행 방지 락 + 진행 상태 표시, 2026-09-11: 체크박스로 마이그레이션) ----
const PROP_ASSIGNMENT_GEN_RUNNING = "출제 처리중"
const PROP_SHARED_LAST_ERROR = "마지막 오류"

const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"]

type JsonRecord = Record<string, unknown>

// createPage 시그니처(parentId, properties)를 그대로 유지하는 얇은 래퍼 (호출부를 안 건드리기 위함).
async function createPage(parentDataSourceId: string, properties: JsonRecord): Promise<JsonRecord> {
	return (await sharedCreatePage(parentDataSourceId, properties)) as JsonRecord
}

async function setAssignmentGenRunning(recordId: string, running: boolean): Promise<void> {
	try {
		const props: Record<string, unknown> = { [PROP_ASSIGNMENT_GEN_RUNNING]: { checkbox: running } }
		// 새 실행이 시작되는 순간(버튼 클릭 직후) 이전 오류를 바로 지워서, 끝날 때까지 오래된 오류
		// 텍스트가 남아있지 않도록 합니다 (2026-09-11 fix).
		if (running) {
			props[PROP_SHARED_LAST_ERROR] = { rich_text: [] }
		}
		await updatePageProperties(recordId, props)
	} catch (err) {
		// 진행 상태 표시는 부가 기능이므로 실패해도 본 로직은 계속 진행한다.
		console.error(`setAssignmentGenRunning(${recordId}, ${running}) failed`, err)
	}
}

async function setAssignmentGenDone(recordId: string): Promise<void> {
	try {
		await updatePageProperties(recordId, {
			[PROP_ASSIGNMENT_GEN_RUNNING]: { checkbox: false },
			[PROP_SHARED_LAST_ERROR]: { rich_text: [] },
		})
	} catch (err) {
		console.error(`setAssignmentGenDone(${recordId}) failed`, err)
	}
}

async function setAssignmentGenError(recordId: string, message: string): Promise<void> {
	try {
		await updatePageProperties(recordId, {
			[PROP_ASSIGNMENT_GEN_RUNNING]: { checkbox: false },
			[PROP_SHARED_LAST_ERROR]: { rich_text: [{ text: { content: message.slice(0, 1900) } }] },
		})
	} catch (err) {
		console.error(`setAssignmentGenError(${recordId}) failed`, err)
	}
}

// 아래 세 함수�� (page, propName) 시그니처를 유지하는 얇은 래퍼 — 실제 파싱은 _shared/notionClient.ts에 있다.
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

function dedupe(ids: string[]): string[] {
	return Array.from(new Set(ids))
}

function formatKoreanDateLabel(isoDate: string): string {
	const d = new Date(isoDate)
	const mm = String(d.getMonth() + 1).padStart(2, "0")
	const dd = String(d.getDate()).padStart(2, "0")
	const weekday = WEEKDAY_KO[d.getDay()]
	return `${mm}.${dd}(${weekday})`
}

// 노션 자동화(버튼) 웹훅 payload에서 페이지 ID를 다단계로 추출한다 (create-learning-record와 동일한 로직).
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

// 특정 등록(학생)의 "다음 수업" 출석을 찾는다: 그 등록에 연결된 출석 중 기준 시각(afterIso) 이후로
// 가장 이른 것 1건. 과제 마감을 자동으로 잡는 데 쓰인다.
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
		console.log("create-assignment raw body:", text)
		body = text ? (JSON.parse(text) as JsonRecord) : {}
	} catch (err) {
		console.error("Failed to parse request body", err)
		return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 })
	}

	const recordId = extractPageId(body)
	if (!recordId) {
		console.error("Could not extract 학습기록 pageId from payload", body)
		return new Response(JSON.stringify({ error: "missing_page_id" }), { status: 400 })
	}

	try {
		const recordPage = await getPage(recordId)
		const category = selectValue(recordPage, PROP_RECORD_CATEGORY)

		if (category !== CATEGORY_ASSIGNMENT && category !== CATEGORY_EVALUATION) {
			// "학습"이거나 구분이 ���어있으면 출제 대상이 아니다.
			return new Response(
				JSON.stringify({ message: "category_not_assignable", recordId, category }),
				{ status: 200 },
			)
		}

		// 같은 학습기록에 대해 버튼이 짧은 시간에 여러 번(더블클릭, 웹훅 타임아웃 후 재시도 등) 눌려도
		// 학습활동이 중복 생성되지 않도록, 이미 처리 중이면 새 요청은 아무 것도 하지 않고 즉시 반환한다.
		if (checkboxValue(recordPage, PROP_ASSIGNMENT_GEN_RUNNING)) {
			return new Response(
				JSON.stringify({ message: "already_processing", recordId }),
				{ status: 200 },
			)
		}
		await setAssignmentGenRunning(recordId, true)

		const registrationIds = dedupe(relIds(recordPage, PROP_RECORD_REGISTRATION))
		if (registrationIds.length === 0) {
			await setAssignmentGenDone(recordId)
			return new Response(
				JSON.stringify({ message: "record_has_no_registrations", recordId }),
				{ status: 200 },
			)
		}

		// Notion의 "웹훅 보내기" 버튼 액션은 이 응답을 동기적으로 기다린다. 등록/학습활동 수가 많으면
		// 처리 시간이 길어져 "버튼 실행 실패: 웹훅 요청 시간이 초과되었습니다" 알림이 뜰 수 있으므로
		// (실제로는 끝까지 정상 처리됨), 여기서부터는 응답을 먼저 보내고 나머지는 백그라운드로 미룬다.
		// 진행 상황은 학습기록의 "동기화 상태"(이미 🔄 처리 중으로 설정됨)로 확인할 수 있다.
		runInBackground(async () => {
			try {
				await finishCreateAssignment(recordId, category, registrationIds)
			} catch (err) {
				console.error("create-assignment (background) failed", err)
				await setAssignmentGenError(recordId, (err as Error)?.message ?? String(err))
			}
		})

		return respondAccepted({ recordId, category })
	} catch (err) {
		console.error("create-assignment failed", err)
		await setAssignmentGenError(recordId, (err as Error)?.message ?? String(err))
		return new Response(
			JSON.stringify({ error: "internal_error", message: String(err) }),
			{ status: 500 },
		)
	}
}

// 등록/학습활동 생성 등 시간이 걸리는 실제 작업. handleRequest가 응답을 먼저 보낸 뒤
// runInBackground를 통해 이 함수를 호출한다.
async function finishCreateAssignment(
	recordId: string,
	category: string,
	registrationIds: string[],
): Promise<void> {
		const recordPage = await getPage(recordId)
		const attendanceIds = dedupe(relIds(recordPage, PROP_RECORD_ATTENDANCE))
		const sessionIds = relIds(recordPage, PROP_RECORD_SESSION)
		const sessionId = sessionIds[0] ?? null
		const recordDate = dateStart(recordPage, PROP_RECORD_DATE)

		// 이 학습기록에 걸린 출석들을 조회해 등록 → 출석 매핑을 만든다 (등록마다 출석은 1건).
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
				// 마감 기준 시각: 이 학생의 이번 출석 수업일시가 있으면 그걸, 없으면 학습기록의 수업일을 쓴다.
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
				[PROP_ACTIVITY_CATEGORY]: { select: { name: category } },
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
			// 평가(CATEGORY_EVALUATION)는 전체 문항/정답 문항을 비워둔다 — 선생님이 나중에 직접 입력.

			const createdPage = await createPage(DS_STUDY_ACTIVITY, createProps)

			return {
				registrationId,
				activityId: createdPage.id as string,
				attendanceId: currentAttendanceId,
				deadlineAttendanceId,
			}
		})

		await setAssignmentGenDone(recordId)
		console.log("create-assignment (background) finished", recordId, category, created)
}

Deno.serve(handleRequest)
