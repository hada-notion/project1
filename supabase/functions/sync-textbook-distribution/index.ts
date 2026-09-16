// sync-textbook-distribution
//
// 교재비 기능(로드맵 5-37) 1차 구현: 장바구니(교재비) 자동 생성 + 진도교재 일괄 담기(교재배부 생성).
// 결제(교재배부 "결재" 버튼 → 미납/결제완료 전환)는 기존 노션 자동화를 그대로 사용하며 이 함수는 건드리지 않는다.
//
// 담기 대상 판정 규칙 (사용자 제안 중 "완료+진행중 제외" 방향을 채택):
//   진도교재(학원) DB의 "진행상태"가 정확히 "다음 교재"(아직 시작 전)인 것만 담는다.
//   - "진행 중"/"완료"는 이미 그 교재를 쓰고 있거나 다 썼다는 뜻이라, 이미 예전에 배부(구매)됐을 가능성이 높아 제외.
//   - "미사용"도 이 학생에게 필요 없다고 확정된 상태라 제외.
//   추가로, 이미 이 등록의 기존 교재배부에 실려 있는 정규교재는(재클릭 등으로) 중복으로 다시 담기지 않도록 별도로 거른다.
//
// 일괄처리 방식: 개별 버튼(교재비 페이지 "진도교재 담기")과 클래스 버튼(클래스 페이지 "교재 일괄 배부")
// 두 트리거 모두 동일한 핵심 로직(distributeForRegistration)을 공유한다. 클래스 버튼은 그 클래스의
// 활성 등록 전체에 대해 개별 로직을 반복 호출하는 것뿐이다 (구현 중복 없이 두 방식을 함께 지원).
//
// 라우트:
//   POST /sync-textbook-distribution/from-cart   <- 교재비(학원) DB "진도교재 담기" 버튼 (학생 1명)
//   POST /sync-textbook-distribution/from-class  <- 클래스(학원) DB "교재 일괄 배부" 버튼 (반 전체 활성 등록)

import { PROP_LAST_ERROR, PROP_SYNCED_AT, PROP_ENROLL_DATE, PROP_END_DATE } from "../_shared/constants.ts"
import {
	getPage,
	createPage,
	queryAllPages,
	relIds,
	relationIds,
	statusName,
	dateStart,
	checkboxValue,
	anyTitleText,
	extractPageId,
	todaySeoulDate,
	mapWithConcurrency,
} from "../_shared/notionClient.ts"
import { makeSyncStatusSetter } from "../_shared/registrationSync.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"

// 이 함수 하나에서만 쓰는 데이터소스 ID/속성명이라 _shared/constants.ts로 옮기지 않고 여기 둔다
// (constants.ts 상단 원칙 참고).
const DATA_SOURCE_TEXTBOOK_CART = Deno.env.get("DATA_SOURCE_TEXTBOOK_CART_ID")! // 교재비(학원) DB
const DATA_SOURCE_TEXTBOOK_DISTRIBUTION = Deno.env.get("DATA_SOURCE_TEXTBOOK_DISTRIBUTION_ID")! // 교재배부(학원) DB
// sync-registration-textbook이 이미 쓰고 있는 것과 동일한 환경변수 이름을 재사용한다 (진도교재 DB).
const DATA_SOURCE_PROGRESS_BOOK = Deno.env.get("DATA_SOURCE_PROGRESS_BOOK_ID")!

// 교재비(학원) DB 속성
const PROP_CART_TITLE = "이름"
const PROP_CART_REGISTRATION = "등록" // relation -> 등록(학원) DB
const PROP_CART_RUNNING = "담기 처리중"

// 교재배부(학원) DB 속성
const PROP_DIST_TITLE = "이름"
const PROP_DIST_REGISTRATION = "등록" // relation -> 등록(학원) DB
const PROP_DIST_REGULAR_BOOK = "정규교재" // relation -> 정규교재(학원) DB (단방향)
const PROP_DIST_DATE = "배부일"

// 진도교재(학원) DB 속성
const PROP_PROGRESS_STATUS = "진행상태"
const PROP_REGULAR_BOOK_ON_PROGRESS = "정규교재" // relation, limit 1
const STATUS_NEXT = "다음 교재" // 이 상태만 "아직 담기 전"으로 간주

// 등록(학원) DB 속성
const PROP_REGISTRATION_BOOKS = "진도교재" // relation -> 진도교재(학원) DB
const PROP_REGISTRATION_CART = "교재비" // relation -> 교재비(학원) DB

// 클래스(학원) DB 속성
const PROP_CLASS_REGISTRATION = "등록" // relation -> 등록(학원) DB
const PROP_CLASS_TEXTBOOK_BATCH_RUNNING = "교재배부 처리중"

// 교재비 DB는 이 함수 혼자만 처리 상태를 쓰므로 otherFlagProps가 필요 없다.
const setCartStatus = makeSyncStatusSetter(PROP_CART_RUNNING, [])
// 클래스 DB는 수강료/보고서/교재 생성과 "실시간 처리 상태"를 공유하므로, 다른 3개 플래그를 함께 넘겨서
// "하나라도 처리중이면 전체를 처리중으로" 판단하는 기존 조합 방식을 그대로 따른다.
const setClassStatus = makeSyncStatusSetter(PROP_CLASS_TEXTBOOK_BATCH_RUNNING, [
	"수강료 생성중",
	"보고서 생성중",
	"교재 생성중",
])

// 등록 하나에 대해: 아직 담기지 않은 "다음 교재" 진도교재를 모아 교재배부 1건을 생성한다.
// 장바구니(교재비 페이지)가 없으면 이 시점에 자동으로 만든다 (하나만 존재, 사용자 설계대로).
async function distributeForRegistration(registrationId: string): Promise<
	| { status: "no_eligible_books" }
	| { status: "already_billed" }
	| { status: "distributed"; distributionPageId: string; bookCount: number; cartId: string; cartCreated: boolean }
> {
	const registration = await getPage(registrationId)
	const progressBookIds = relationIds(registration, PROP_REGISTRATION_BOOKS)
	if (progressBookIds.length === 0) return { status: "no_eligible_books" }

	const progressBooks = await mapWithConcurrency(progressBookIds, 4, (id) => getPage(id))
	const eligibleBookIds = new Set<string>()
	for (const book of progressBooks) {
		if (statusName(book, PROP_PROGRESS_STATUS) !== STATUS_NEXT) continue
		const regularBookIds = relationIds(book, PROP_REGULAR_BOOK_ON_PROGRESS)
		if (regularBookIds.length > 0) eligibleBookIds.add(regularBookIds[0])
	}
	if (eligibleBookIds.size === 0) return { status: "no_eligible_books" }

	// 이미 이 등록의 기존 교재배부에 실려 있는 정규교재는 다시 담지 않는다 (재클릭 안전).
	const existingDistributions = await queryAllPages(DATA_SOURCE_TEXTBOOK_DISTRIBUTION, {
		property: PROP_DIST_REGISTRATION,
		relation: { contains: registrationId },
	})
	const billedBookIds = new Set<string>()
	for (const dist of existingDistributions) {
		for (const id of relIds(dist.properties[PROP_DIST_REGULAR_BOOK])) billedBookIds.add(id)
	}

	const newBookIds = [...eligibleBookIds].filter((id) => !billedBookIds.has(id))
	if (newBookIds.length === 0) return { status: "already_billed" }

	// 장바구니(교재비 페이지) 확보: 이미 있으면 재사용(항상 학생당 1개만 존재해야 함), 없으면 이 시점에 생성.
	const cartIds = relationIds(registration, PROP_CART... 
	// (placeholder replaced below)
	const existingCartIds = relationIds(registration, PROP_REGISTRATION_CART)
	let cartId: string
	let cartCreated = false
	if (existingCartIds.length > 0) {
		cartId = existingCartIds[0]
	} else {
		const studentName = anyTitleText(registration) || "학생"
		const cart = await createPage(DATA_SOURCE_TEXTBOOK_CART, {
			[PROP_CART_TITLE]: { title: [{ text: { content: `${studentName} 교재비` } }] },
			[PROP_CART_REGISTRATION]: { relation: [{ id: registrationId }] },
		})
		cartId = cart.id
		cartCreated = true
	}

	const distribution = await createPage(DATA_SOURCE_TEXTBOOK_DISTRIBUTION, {
		[PROP_DIST_TITLE]: { title: [{ text: { content: `${todaySeoulDate()} 교재 배부` } }] },
		[PROP_DIST_REGISTRATION]: { relation: [{ id: registrationId }] },
		[PROP_DIST_REGULAR_BOOK]: { relation: newBookIds.map((id) => ({ id })) },
		[PROP_DIST_DATE]: { date: { start: todaySeoulDate() } },
	})

	return { status: "distributed", distributionPageId: distribution.id, bookCount: newBookIds.length, cartId, cartCreated }
}

// 오늘 기준으로 활성 등록인지 판정 (등록일 <= 오늘 <= 종료일, 종료일 없으면 계속 활성).
// 등록(학원) DB "수강상태" 수식과 동일한 정의를 그대로 따른다 (날짜 문자열 사전식 비교로 충분: YYYY-MM-DD).
function isActiveRegistration(reg: any, todayStr: string): boolean {
	const enrollDate = dateStart(reg, PROP_ENROLL_DATE)
	const endDate = dateStart(reg, PROP_END_DATE)
	if (enrollDate && enrollDate.slice(0, 10) > todayStr) return false
	if (endDate && endDate.slice(0, 10) < todayStr) return false
	return true
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
	console.log("sync-textbook-distribution payload:", route, JSON.stringify(body))

	const pageId = extractPageId(body)
	if (!pageId) {
		return new Response(JSON.stringify({ error: "pageId를 찾을 수 없음" }), { status: 400 })
	}

	try {
		if (route === "from-cart") {
			// 교재비 페이지 자신이 클릭 대상. 이미 처리 중이면 재클릭을 무시한다.
			const cartForLock = await getPage(pageId)
			if (checkboxValue(cartForLock, PROP_CART_RUNNING)) {
				return new Response(JSON.stringify({ ok: true, message: "already_processing", pageId, route }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}
			await setCartStatus(pageId, "처리중")

			runInBackground(async () => {
				try {
					const cart = await getPage(pageId)
					const registrationIds = relationIds(cart, PROP_CART_REGISTRATION)
					if (registrationIds.length === 0) throw new Error("교재비 페이지에 연결된 등록이 없음")
					const result = await distributeForRegistration(registrationIds[0])
					await setCartStatus(pageId, "완료")
					console.log("[sync-textbook-distribution] (background) from-cart finished:", pageId, result)
				} catch (err) {
					console.error("[sync-textbook-distribution] (background) from-cart ERROR:", err)
					await setCartStatus(pageId, "오류", (err as Error)?.message ?? String(err))
				}
			})

			return respondAccepted({ pageId, route })
		} else if (route === "from-class") {
			// 클래스 페이지 자신이 클릭 대상. 이미 처리 중이면 재클릭을 무시한다.
			const classForLock = await getPage(pageId)
			if (checkboxValue(classForLock, PROP_CLASS_TEXTBOOK_BATCH_RUNNING)) {
				return new Response(JSON.stringify({ ok: true, message: "already_processing", pageId, route }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}
			await setClassStatus(pageId, "처리중")

			runInBackground(async () => {
				try {
					const classPage = await getPage(pageId)
					const registrationIds = relationIds(classPage, PROP_CLASS_REGISTRATION)
					const today = todaySeoulDate()
					const registrations = await mapWithConcurrency(registrationIds, 4, (id) => getPage(id))
					const activeIds = registrations.filter((r) => isActiveRegistration(r, today)).map((r) => r.id)

					const results = await mapWithConcurrency(activeIds, 3, async (id) => {
						try {
							return await distributeForRegistration(id)
						} catch (err) {
							return { status: "error" as const, message: (err as Error)?.message ?? String(err), registrationId: id }
						}
					})
					const distributedCount = results.filter((r: any) => r.status === "distributed").length
					const errorCount = results.filter((r: any) => r.status === "error").length
					if (errorCount > 0) {
						const firstError = (results.find((r: any) => r.status === "error") as any)?.message ?? "알 수 없는 오류"
						await setClassStatus(pageId, "오류", `${errorCount}건 실패 (예: ${firstError})`)
					} else {
						await setClassStatus(pageId, "완료")
					}
					console.log("[sync-textbook-distribution] (background) from-class finished:", pageId, {
						total: activeIds.length,
						distributed: distributedCount,
						errors: errorCount,
					})
				} catch (err) {
					console.error("[sync-textbook-distribution] (background) from-class ERROR:", err)
					await setClassStatus(pageId, "오류", (err as Error)?.message ?? String(err))
				}
			})

			return respondAccepted({ pageId, route })
		} else {
			return new Response(JSON.stringify({ error: `알 수 없는 경로: ${route}` }), { status: 404 })
		}
	} catch (err) {
		console.error(err)
		return new Response(JSON.stringify({ error: String(err) }), { status: 400 })
	}
})
