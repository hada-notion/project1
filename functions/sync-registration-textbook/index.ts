// sync-registration-textbook
//
// 등록 DB "개별교재 생성" 버튼 하나로 그룹/개별 진도 모두 처리한다 (등록일/종료일 편집
// 웹훅에는 더 이상 반응하지 않음 - 그 자동화는 삭제됨, 클래스 세팅은 완전 수동).
//
// 클래스 세팅(수동): 담당자가 진도교재(학원) DB에 "반별교재"(템플릿) 행을 직접 만들어
// 클래스에 연결해둔다. 템플릿은 정규교재/클래스/진도방식(그룹 진도 | 개별 진도)을 가진다.
//
// "개별교재 생성" 버튼(등록 페이지)을 누르면:
//   1. 등록에 연결된 클래스를 찾고, 그 클래스에 연결된 반별교재(템플릿) 전체를 확인한다.
//   2. 템플릿마다, 이 등록용 "개별교재" 인스턴스를 만든다 (반별교재 self-relation으로 템플릿과
//      연결, 정규교재/클래스/진도방식은 템플릿에서 그대로 복사, 진행상태는 "다음 교재"로 시작).
//      그룹 진도든 개별 진도든 학생마다 자기 진행상태/학습기록을 갖도록 항상 인스턴스를 만든다.
//   3. 새로 만든 인스턴스를 등록의 "진도교재" relation에 연결한다.
//   4. 이미 이 등록 + 이 템플릿 조합의 인스턴스가 있으면 건너뛴다 (재실행 안전 - 버튼을
//      여러 번 눌러도, 나중에 클래스에 템플릿이 추가된 뒤 다시 눌러도 중복 생성되지 않음).
//   5. 등록일이 없어도 진행 가능 (교재 준비는 수강 시작 전에도 할 수 있어야 함).
//
// 종료 처리 시 교재 정리(사용자가 확정한 규칙 - 무조건 삭제/연결해제 아님):
//   진행상태가 "다음 교재"이고 학습기록이 하나도 없는 인스턴스만 정리 대상이다.
//   (진행 중/완료 상태이거나 학습기록이 있으면 실제 학습 흔적이므로 절대 건드리지 않는다.)
//     - 진도방식 = 그룹 진도: 등록의 "진도교재"에서 연결만 해제한다 (인스턴스 페이지 자체는
//       보존 - 반에서 공유되는 템플릿에 딸린 자원이라 삭제하지 않음).
//     - 진도방식 = 개별 진도: 인스턴스 페이지 자체를 아카이브(삭제)한다.
//
// 라우트:
//   POST /sync-registration-textbook/create-individual  <- 등록 DB "개별교재 생성" 버튼
//   POST /sync-registration-textbook/cleanup-on-end      <- sync-registration-timetable이 등록
//                                                            종료 확정 시 내부적으로 호출

import {
	PROP_CLASS,
	PROP_SYNC_TEXTBOOK_RUNNING,
	PROP_SYNC_TIMETABLE_RUNNING,
	PROP_SYNC_CLASS_SESSION_RUNNING,
	PROP_SYNC_END_RUNNING,
	PROP_SYNCED_AT,
} from "../_shared/constants.ts"
import {
	getPage,
	queryDataSource,
	createPage,
	updatePageProperties,
	archivePage,
	relationIds,
	selectName,
	statusName,
	titleText,
	extractPageId,
	mapWithConcurrency,
	checkboxValue,
} from "../_shared/notionClient.ts"
import { makeSyncStatusSetter } from "../_shared/registrationSync.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"

// NOTE: otherFlagProps here has only 3 entries, missing PROP_SYNC_ENROLL_RUNNING that the other
// 4 sync-registration-* functions all include (pre-existing inconsistency, not something
// introduced by this refactor). Kept exactly as-is per the "no functional change" rule;
// a human can decide later whether to add it.
const setSyncStatus = makeSyncStatusSetter(PROP_SYNC_TEXTBOOK_RUNNING, [
	PROP_SYNC_TIMETABLE_RUNNING,
	PROP_SYNC_CLASS_SESSION_RUNNING,
	PROP_SYNC_END_RUNNING,
])

const DATA_SOURCE_PROGRESS_BOOK = Deno.env.get("DATA_SOURCE_PROGRESS_BOOK_ID")! // 진도교재(학원) DB

// 진도교재(학원) DB 속성 이름
const PROP_BOOK_TITLE = "진도교재" // title
const PROP_TEMPLATE_RELATION = "반별교재" // 인스턴스 -> 템플릿 (self-relation, limit 1)
const PROP_PROGRESS_MODE = "진도방식" // 개별 진도 | 그룹 진도
const PROP_PROGRESS_STATUS = "진행상태" // 다음 교재 | 진행 중 | 미사용 | 완료
const PROP_REGULAR_BOOK = "정규교재" // relation
const PROP_CLASS_ON_BOOK = "클래스" // relation (진도교재 DB 쪽)
const PROP_REGISTRATION_ON_BOOK = "등록" // relation
const PROP_LEARNING_RECORD = "학습기록" // relation
const PROP_REGISTRATION_BOOKS = "진도교재" // 등록 DB 쪽 relation
const STATUS_NEXT = "다음 교재"

// 반별교재(템플릿) 하나를 보고, 이 등록에 연결할 개별교재 인스턴스를 확보한다.
// - 그룹 진도: 반 전체가 인스턴스 "하나"를 공유한다. 이미 이 템플릿의 인스턴스가 있으면
//   새로 만들지 않고 그 인스턴스에 이 등록을 추가로 연결(등록 relation에 추가)만 한다.
// - 개별 진도: 학생(등록)마다 자기만의 인스턴스를 갖는다. 이미 (이 등록 + 이 템플릿)
//   조합의 인스턴스가 있으면 건너뛰고, 없으면 새로 만든다.
// 주의: 등록 페이지의 "진도교재" relation은 여기서 건드리지 않는다. 여러 템플릿을 동시에
// 처리할 때 각자 등록 페이지�� read-modify-write 하면 서로 덮어써서 일부가 유실되는
// 문제가 있었기 때문에, 호출부(createIndividualBooksForRegistration)에서 결과를 모아
// 마지막에 한 번만 반영한다.
async function resolveInstanceForTemplate(registrationId: string, templatePage: any) {
	const templateId = templatePage.id
	const mode = selectName(templatePage, PROP_PROGRESS_MODE) ?? "그룹 진도"

	// 그룹 진도: 반별교재(템플릿) 페이지 자체가 곳 반 전체가 쓰는 "그 교재"이다 - 별도 인스턴스를
	// 찾거나 만들지 않고, 이 등록을 템플릿 자체의 "등록" relation에만 추가로 연결한다.
	if (mode === "그룹 진도") {
		const registrationIds = relationIds(templatePage, PROP_REGISTRATION_ON_BOOK)
		if (!registrationIds.includes(registrationId)) {
			await updatePageProperties(templateId, {
				[PROP_REGISTRATION_ON_BOOK]: { relation: [...registrationIds, registrationId].map((id) => ({ id })) },
			})
		}
		return { instanceId: templateId, linked: true }
	} else {
		const already = await queryDataSource(DATA_SOURCE_PROGRESS_BOOK, {
			filter: {
				and: [
					{ property: PROP_REGISTRATION_ON_BOOK, relation: { contains: registrationId } },
					{ property: PROP_TEMPLATE_RELATION, relation: { contains: templateId } },
				],
			},
			page_size: 1,
		})
		if (already.results.length > 0) return { instanceId: already.results[0].id, linked: true }
	}

	const regularBookIds = relationIds(templatePage, PROP_REGULAR_BOOK)
	const classIds = relationIds(templatePage, PROP_CLASS_ON_BOOK)
	const templateTitle = titleText(templatePage, PROP_BOOK_TITLE) ?? "진도교재"

	const properties: Record<string, unknown> = {
		[PROP_BOOK_TITLE]: { title: [{ text: { content: templateTitle } }] },
		[PROP_TEMPLATE_RELATION]: { relation: [{ id: templateId }] },
		[PROP_PROGRESS_MODE]: { select: { name: mode } },
		// 새 인스턴스는 아직 진도를 시작하지 않았으니 "다음 교재"로 생성한다.
		// 실제로 진도를 시작할 때 사용자가 "진행 중"으로 수동 전환한다.
		[PROP_PROGRESS_STATUS]: { status: { name: STATUS_NEXT } },
		[PROP_REGISTRATION_ON_BOOK]: { relation: [{ id: registrationId }] },
	}
	if (regularBookIds.length > 0) properties[PROP_REGULAR_BOOK] = { relation: [{ id: regularBookIds[0] }] }
	if (classIds.length > 0) properties[PROP_CLASS_ON_BOOK] = { relation: [{ id: classIds[0] }] }

	const page = await createPage(DATA_SOURCE_PROGRESS_BOOK, properties)
	return { instanceId: page.id, created: true }
}

// 등록에 연결된 클래스의 반별교재(템플릿) 전체에 대해 개별교재 인스턴스를 만든다.
// 클래스가 없거나 템플릿이 하나도 없으면 건너뛴다 (에러로 취급하지 않음 - 클래스 세팅 전에도
// 버튼을 눌러볼 수 있어야 하며, 그 경우 안내만 반환한다).
async function createIndividualBooksForRegistration(registrationId: string) {
	const registration = await getPage(registrationId)
	const classIds = relationIds(registration, PROP_CLASS)
	if (classIds.length === 0) return { skipped: "클래스가 아직 연결되어 있지 않음" }

	const classPage = await getPage(classIds[0])
	const candidateIds = relationIds(classPage, "진도교재")
	if (candidateIds.length === 0) return { skipped: "클래스에 반별교재(템플릿)가 아직 없음 - 먼저 진도교재 DB에서 템플릿을 만들어 클래스에 연결하세요" }

	// 클래스."진도교재"는 "클래스"<->"진도교재" 양방향 관계라서, 인스턴스를 만들 때 인스턴스의
	// "클래스"를 채우기만 해도 그 인스턴스가 이 목록에 자동으로 끼어든다. 그래서 이 목록에는
	// 진짜 반별교재(템플릿) 외에 이미 생성된 개별교재 인스턴스도 섞여 있을 수 있다.
	// 진짜 템플릿은 절대 PROP_TEMPLATE_RELATION("반별교재")이 채워지지 않으므로, 그것으로만
	// 필터링해서 인��턴스가 실수로 "템플릿"으로 취급되어 또 다른 인스턴스를 낳는(무한 증식) 일을 막는다.
	const candidates = await mapWithConcurrency(candidateIds, 4, (id) => getPage(id))
	const templatePages = candidates.filter((p: any) => relationIds(p, PROP_TEMPLATE_RELATION).length === 0)
	if (templatePages.length === 0) {
		return { skipped: "클래스에 연결된 진도교재 중 진짜 템플릿이 없음 (전부 이미 생성된 개별교재 인스턴스로 보임)" }
	}

	const results = await mapWithConcurrency(templatePages, 4, (templatePage) => resolveInstanceForTemplate(registrationId, templatePage))

	// 등록의 "진도교재" relation은 여기서 한 번만 최신 상태를 읽어서 반영한다 (동시 처리로 인한
	// read-modify-write 유실 방���).
	const freshRegistration = await getPage(registrationId)
	const existingBookIds = relationIds(freshRegistration, PROP_REGISTRATION_BOOKS)
	const newIds = results.map((r) => r.instanceId).filter((id) => !existingBookIds.includes(id))
	if (newIds.length > 0) {
		await updatePageProperties(registrationId, {
			[PROP_REGISTRATION_BOOKS]: { relation: [...existingBookIds, ...newIds].map((id) => ({ id })) },
		})
	}

	return { results }
}

// 종료 처리 시 교재 정리: "다음 교재" 상태 + 학습기록 없음 인 인스턴스만 정리 대상.
// 그룹 진도 -> 등록에서 연결만 해제 (인스턴스 페이지는 보존)
// 개별 진도 -> 인스턴스 페이지 자체를 아카이브
// 그 외(진행 중/완료 상태이거나 학습기록이 있음)는 절대 건드리지 않고 그대로 둔다.
async function cleanupUnusedBooksOnEnd(registrationId: string) {
	const registration = await getPage(registrationId)
	const bookIds = relationIds(registration, PROP_REGISTRATION_BOOKS)
	const unlinked: string[] = []
	const deleted: string[] = []
	const kept: string[] = []
	let remaining = bookIds

	for (const bookId of bookIds) {
		const book = await getPage(bookId)
		const mode = selectName(book, PROP_PROGRESS_MODE)
		const status = statusName(book, PROP_PROGRESS_STATUS)
		const hasRecords = relationIds(book, PROP_LEARNING_RECORD).length > 0

		if (status !== STATUS_NEXT || hasRecords) {
			kept.push(bookId)
			continue
		}

		if (mode === "그룹 진도") {
			remaining = remaining.filter((id) => id !== bookId)
			unlinked.push(bookId)
			// 그룹 진도 인스턴스는 반 전체가 공유하므로, 이 등록만 그 인스턴스의 "등록" relation에서 뺀다
			// (인스턴스 자체는 다른 학생들이 계속 쓰므로 보존).
			const bookRegistrationIds = relationIds(book, PROP_REGISTRATION_ON_BOOK).filter((id) => id !== registrationId)
			await updatePageProperties(bookId, {
				[PROP_REGISTRATION_ON_BOOK]: { relation: bookRegistrationIds.map((id) => ({ id })) },
			})
		} else {
			await archivePage(bookId)
			deleted.push(bookId)
			remaining = remaining.filter((id) => id !== bookId)
		}
	}

	if (unlinked.length > 0 || deleted.length > 0) {
		await updatePageProperties(registrationId, {
			[PROP_REGISTRATION_BOOKS]: { relation: remaining.map((id) => ({ id })) },
		})
	}

	return { unlinked, deleted, kept }
}

Deno.serve(async (req: Request) => {
	const url = new URL(req.url)
	const route = url.pathname.split("/").pop()
	let body: unknown = {}
	try {
		body = await req.json()
	} catch {
		// 빈 바디 허용하지 않음 - 아래에서 pageId 누락으로 에러 처리
	}
	console.log("sync-registration-textbook payload:", route, JSON.stringify(body))

	const pageId = extractPageId(body)
	if (!pageId) {
		return new Response(JSON.stringify({ error: "pageId를 찾을 수 없음" }), { status: 400 })
	}

	try {
		if (route === "create-individual") {
			// 이미 처리 중이면 새로 시작하지 않고 즉시 반환 -- 처리 중 재클릭으로 인한 중복 개별교재 생성 방지.
			const regPageForLock = await getPage(pageId)
			if (checkboxValue(regPageForLock, PROP_SYNC_TEXTBOOK_RUNNING)) {
				return new Response(JSON.stringify({ ok: true, message: "already_processing", pageId, route }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}
			await setSyncStatus(pageId, "처리중")

			// Notion의 "웹훅 보내기" 버튼 액션은 이 응답을 동기적으로 기다린다. 개별교재 생성이
			// 많으면 시간이 길어져 "버튼 실행 실패: 웹훅 요청 시간이 초과되었습니다" 알림이 뜰 수 있으므로
			// (실제로는 끝까지 정상 처리됨), 응답을 먼저 보내고 나머지는 백그라운드로 미룬다. 진행 상황은
			// 등록의 "동기화 상태"(이미 처리중으로 설정됨)로 확인할 수 있다.
			runInBackground(async () => {
				try {
					const result = await createIndividualBooksForRegistration(pageId)
					await setSyncStatus(pageId, "완료")
					console.log("[sync-registration-textbook] (background) create-individual finished:", pageId, result)
				} catch (err) {
					console.error("[sync-registration-textbook] (background) create-individual ERROR:", err)
					await setSyncStatus(pageId, "오류", (err as Error)?.message ?? String(err))
				}
			})

			return respondAccepted({ pageId, route })
		} else if (route === "cleanup-on-end") {
			const result = await cleanupUnusedBooksOnEnd(pageId)
			return new Response(JSON.stringify({ ok: true, result }), { status: 200 })
		} else {
			return new Response(JSON.stringify({ error: `알 수 없는 경로: ${route}` }), { status: 404 })
		}
	} catch (err) {
		console.error(err)
		return new Response(JSON.stringify({ error: String(err) }), { status: 400 })
	}
})
