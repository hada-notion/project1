// _shared/registrationTextbookTarget.ts
//
// sync-registration-textbook의 "개별교재 생성" 버튼(create-individual 라우트) 실제 로직을 별도
// 파일로 분리했다 (2026-09-18, 큐 기반 순차 처리 도입, Phase 3). cleanup-on-end 라우트는
// 다른 함수들이 내부적으로 동기 호출(fetch)해서 즉시 결과를 받아야 하므로 큐로 옮기지 않고
// index.ts에 그대로 둔다 (이 파일에서는 그 로직도 함께 두어 라우트 핸들러를 가벼게 유지한다).
//
// (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환) create-individual 라우트도 등록 페이지 1건만
// 대상으로 하는 개별 트리거라 processCreateIndividualBooksQueueItem(process-sync-queue 전용
// 진입점)은 제거했다. index.ts가 createIndividualBooksForRegistration을 직접 호출한다.
//
// (2026-09-22, PART N-7: 클래스 "진도교재" 25개 제한 버그 수정) createIndividualBooksForRegistration이
// 클래스 페이지를 getPage로 통째로 읽어서 그 안의 "진도교재" relation을 후보로 쓰고 있었는데, Notion
// 페이지 조회 API는 relation 속성을 최대 25개까지만 돌려주고 나머지는 잘라버린다. "진도교재"는
// "클래스"<->"진도교재" 양방향 관계라 인스턴스가 생길 때마다 이 목록에도 자동으로 끼어들기 때문에,
// 개별 지도처럼 학생이 많이 쌓이는 클래스는 금방 25개를 넘기고 그 뒤로는 진짜 템플릿 일부가 후보
// 목록에서 조용히 사라진다 (실제로 "고등 과외" 클래스에서 템플릿 8개 중 4개가 이렇게 누락되어 개별
// 진도 교재 인스턴스가 일부만 생성되는 문제로 나타났다). 클래스 페이지를 거치지 않고, 진도교재
// 데이터소스를 "클래스 = 이 클래스"로 직접 쿼리(queryAllPages, 커서 끝까지 따라감)하도록 고쳤다.
//
// (2026-09-22, PART N-8: 클래스 "교재 생성" 버튼 라우트 누락 수정) 클래스(학원) DB "교재 생성" 버튼
// 자동화가 실제로는 sync-registration-textbook의 create-class 라우트를 호출하고 있었는데, 이
// 파일과 index.ts에는 create-individual/cleanup-on-end 두 라우트만 있었고 create-class는 애초에
// 구현된 적이 없었다 (항상 404 "알 수 없는 경로: create-class" — Supabase 로그로 실제 운영 클래스
// "고1 A반"에서도 확인됨, 화면에는 그냥 아무 반응 없음으로만 보였다). 클래스에 연결된 활성(🟢 수강
// 중) 등록 전체에 대해 createIndividualBooksForRegistration을 실행하는 createBooksForClass를
// 추가했다. 현재는 create-individual과 동일한 runSyncWebhookForPage를 재사용해 즉시 응답 후
// EdgeRuntime.waitUntil 백그라운드에서 처리한다. pageId 자리에 classId를 넘기고, 잠금/상태 속성은
// 클래스 DB의 "교재 생성 상태"와 "마지막 오류"를 사용한다.

import {
	PROP_CLASS,
	PROP_LAST_ERROR,
	DS_REGISTRATION,
	PROP_STATUS,
} from "./constants.ts"
import {
	getPage,
	queryDataSource,
	queryAllPages,
	createPage,
	updatePageProperties,
	archivePage,
	relationIds,
	selectName,
	statusName,
	titleText,
	formulaString,
	mapWithConcurrency,
} from "./notionClient.ts"
import { type StatusSpec } from "./statusTracking.ts"

// (2026-09-22, 처리 상태 관리 리팩토링 Phase 3) "교재 처리중" 체크박스(등록 DB, create-individual
// 라우트 전용) → "교재 상태"(select) + "교재 처리 시작 시각"(date). 마스터플랜:
// https://app.notion.com/p/903c90386c1d473494c5df6306c53517
export const TEXTBOOK_STATUS_SPEC: StatusSpec = {
	statusProp: "교재 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "교재 처리 시작 시각",
}

// (2026-09-22, PART N-8 -> Phase 3 전환) 클래스(학원) DB "교재 생성" 버튼 전용 상태. "교재 생성중"
// 체크박스 -> "교재 생성 상태"(select) + "교재 생성 처리 시작 시각"(date). 클래스 DB의 "마지막
// 오류"는 수강료 생성/보고서 생성 등과 공유하는 필드다(PROP_LAST_ERROR, 값 동일). 마스터플랜:
// https://app.notion.com/p/903c90386c1d473494c5df6306c53517
export const CLASS_TEXTBOOK_STATUS_SPEC: StatusSpec = {
	statusProp: "교재 생성 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "교재 생성 처리 시작 시각",
}

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

// 클래스(학원) DB "교재 생성" 버튼 대상 판정 기준. 보고서 생성/수강료 생성/교재비 생성 등 다른
// 클래스 단위 일괄 버튼과 동일하게 "현재 🟢 수강 중"인 등록만 대상으로 한다.
const STATUS_ACTIVE = "🟢 수강 중"

// 반별교재(템플릿) 하나를 보고, 이 등록에 연결할 개별교재 인스턴스를 확보한다.
// - 그룹 진도: 반 전체가 인스턴스 "하나"를 공유한다. 이미 이 템플릿의 인스턴스가 있으면
//   새로 만들지 않고 그 인스턴스에 이 등록을 추가로 연결(등록 relation에 추가)만 한다.
// - 개별 진도: 학생(등록)마다 자기만의 인스턴스를 갖는다. 이미 (이 등록 + 이 템플릿)
//   조합의 인스턴스가 있으면 건너뛰고, 없으면 새로 만든다.
// 주의: 등록 페이지의 "진도교재" relation은 여기서 건드리지 않는다. 여러 템플릿을 동시에
// 처리할 때 각자 등록 페이지를 read-modify-write 하면 서로 덮어써서 일부가 유실되는
// 문제가 있었기 때문에, 호출부(createIndividualBooksForRegistration)에서 결과를 모아
// 마지막에 한 번만 반영한다.
async function resolveInstanceForTemplate(registrationId: string, templatePage: any) {
	const templateId = templatePage.id
	const mode = selectName(templatePage, PROP_PROGRESS_MODE) ?? "그룹 진도"

	// 그룹 진도: 반별교재(템플릿) 페이지 자체가 곧 반 전체가 쓰는 "그 교재"이다 - 별도 인스턴스를
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

// 등록에 연결된 클래스의 반별교재(템플릿) 전체를 그룹/개별 진도 규칙에 따라 연결하거나 생성한다.
// 클래스가 없거나 템플릿이 하나도 없으면 건너뛴다 (에러로 취급하지 않음 - 클래스 세팅 전에도
// 버튼을 눌러볼 수 있어야 하며, 그 경우 안내만 반환한다).
export async function createIndividualBooksForRegistration(registrationId: string) {
	const registration = await getPage(registrationId)
	const classIds = relationIds(registration, PROP_CLASS)
	if (classIds.length === 0) return { skipped: "클래스가 아직 연결되어 있지 않음" }

	// (PART N-7) 클래스 페이지를 getPage로 읽어서 그 안의 "진도교재" relation을 쓰면 25개까지만
	// 돌아온다 (Notion 페이지 조회 API의 relation 절단 제약). "진도교재"는 "클래스"<->"진도교재"
	// 양방향 관계라서 인스턴스가 생길 때마다 이 목록에도 자동으로 끼어들기 때문에, 개별 지도처럼
	// 학생이 쌓이는 클래스는 금방 25개를 넘기고 그 뒤 진짜 템플릿 일부가 조용히 누락된다. 그 대신
	// 진도교재 데이터소스를 "클래스 = 이 클래스"로 직접 쿼리한다 - queryAllPages가 커서를 끝까지
	// 따라가므로 개수 제한 없이 전부 가져온다.
	const candidates = await queryAllPages(DATA_SOURCE_PROGRESS_BOOK, {
		property: PROP_CLASS_ON_BOOK,
		relation: { contains: classIds[0] },
	})
	if (candidates.length === 0) return { skipped: "클래스에 반별교재(템플릿)가 아직 없음 - 먼저 진도교재 DB에서 템플릿을 만들어 클래스에 연결하세요" }

	// 이 쿼리 결과에도 진짜 반별교재(템플릿) 외에 이미 생성된 개별교재 인스턴스가 섞여 있다 (둘 다
	// "클래스"를 갖기 때문). 진짜 템플릿은 절대 PROP_TEMPLATE_RELATION("반별교재")이 채워지지 않으므로,
	// 그것으로만 필터링해서 인스턴스가 실수로 "템플릿"으로 취급되어 또 다른 인스턴스를 낳는(무한 증식) 일을 막는다.
	const templatePages = candidates.filter((p: any) => relationIds(p, PROP_TEMPLATE_RELATION).length === 0)
	if (templatePages.length === 0) {
		return { skipped: "클래스에 연결된 진도교재 중 진짜 템플릿이 없음 (전부 이미 생성된 개별교재 인스턴스로 보임)" }
	}

	const results = await mapWithConcurrency(templatePages, 4, (templatePage) => resolveInstanceForTemplate(registrationId, templatePage))

	// 등록의 "진도교재" relation은 여기서 한 번만 최신 상태를 읽어서 반영한다 (동시 처리로 인한
	// read-modify-write 유실 방지).
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

// 클래스에 연결된 등록 중 현재 "🟢 수강 중"인 등록만 반환한다. (PART N-8) 보고서 생성/수강료 생성/
// 교재비 생성처럼 "학생수" 수식과 같은 기준으로 대상을 정한다 -- 종료된 학생은 새로 교재를 만들
// 필요가 없기 때문이다.
async function getActiveRegistrationsForClassNow(classId: string): Promise<any[]> {
	const registrations = await queryAllPages(DS_REGISTRATION, {
		property: PROP_CLASS,
		relation: { contains: classId },
	})
	return registrations.filter((reg: any) => formulaString(reg, PROP_STATUS) === STATUS_ACTIVE)
}

// index.ts의 create-class 라우트가 직접 호출하는 진입점 (2026-09-22, PART N-8). 클래스(학원) DB
// "교재 생성" 버튼 -- 클래스에서 수강 중인 등록 전체에 대해 createIndividualBooksForRegistration을
// 실행한다. createIndividualBooksForRegistration은 이미 (등록+템플릿) 조합 단위로 멱등이므로,
// 이 버튼을 여러 번 눌러도 나중에 클래스에 템플릿이 추가된 뒤 다시 눌러도 중복 생성되지 않는다.
export async function createBooksForClass(classId: string): Promise<{ processed: number }> {
	const registrations = await getActiveRegistrationsForClassNow(classId)
	await mapWithConcurrency(registrations, 4, (reg: any) => createIndividualBooksForRegistration(reg.id))
	return { processed: registrations.length }
}

// 종료 처리 시 교재 정리: "다음 교재" 상태 + 학습기록 없음 인 인스턴스만 정리 대상.
// 그룹 진도 -> 등록에서 연결만 해제 (인스턴스 페이지는 보존)
// 개별 진도 -> 인스턴스 페이지 자체를 아카이브
// 그 외(진행 중/완료 상태이거나 학습기록이 있음)는 절대 건드리지 않고 그대로 둔다.
export async function cleanupUnusedBooksOnEnd(registrationId: string) {
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
			// 그룹 진도 교재는 반 전체가 공유하므로, 이 등록만 해당 교재의 "등록" relation에서 뺀다
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
