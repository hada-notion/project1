// sync-textbook-distribution
//
// 교재뱄 기능(로드맵 5-37): 진도교재 담기(교재배부 생성) + 필요 시 교재비(카트) 자동 생성.
// 결제(교재배부 "결재" 버튼 → 미납/결제완료 전환)는 기존 노션 자동화를 그대로 사용하야 이 함수는 건드리지 않는다.
//
// 담기 대상 판정 규식:
//   진도교재(학원) DB의 "진행상태"가 정확히 "진행 중"(실제로 지금 쓰고 있는 교재)인 것만 담는다.
//   - "다음 교재"는 아직 시작 전이며, 다음 학기에나 쓰게 될 수도 있는 "진짜 다음" 교재라 아직 청구하지 않는다.
//   - "완료"/"미사용"은 이미 지난 교재라 제외 (이미 예전에 배부(청구)됐을 가능성이 높음).
//   추가로, 이미 이 등록의 기존 교재배부에 실려 있는 정규교재는(재클릭 등으로) 중복으로 다시 담기지 않도록 별도로 거른다.
//
// 교재배부 1건 = 정규교재 1개. 새로 담을 정규교재가 여러 개이면, 한 번의 버튼 호출에서도
// 교재배부 페이지를 교재당 1건씩 여러 개 만든다 (교재비의 "정규교재" 관계는 1건만 가리킨다는 가정).
//
// (2026-09-16) 교재비(카트) 페이지를 새로 만들 때 "알림톡 설정" 관계(표시 전용)도 함께 채운다.
// send-textbook-notice는 여전히 발송 시점에 "발송 구분" 문자열로 알림톡 설정 DB를 조회하므로,
// 실제 발송 동작에는 영향이 없다 -- Notion 화면에서 이 카트가 어떤 발송 설정과 연결되는지
// 직관적으로 보이도록 하기 위한 것뿐이다 (조회 실패 시 조용히 건너뜀).
//
// (2026-09-17) 이전에는 클래스(학원) DB "교재 일괄 배부" 버튼으로 반 전체 활성 등록을 한 번에
// 처리하는 일괄 생성 경로(from-class)도 함께 제공했었다. 하지만 여러 차례(1~7차) 동시성/조회
// 구조를 수정해도 "교재배부 처리중" 체크박스가 간헐적으로 자동 해제되지 않는 문제가 반복 재현됐고,
// 근본 원인이 "학생 수만큼 학생별 Notion API 호출을 한 배치 실행 안에서 처리해야 하는" 구조적
// 한계로 파악되어, 반 전체 일괄 생성/배포 기능 자체를 포기했었다.
//
// (2026-09-17, 같은 날 재도입) 다만 반 전체 "교재비" 일괄 생성만 다시 필요해졌다. 위에서 포기한
// from-class는 학생 1명당 진도교재 조회 + 기존 교재배부 조회 + 교재배부 페이지 생성(여러 건)까지
// 묶어서 처리했기 때문에 학생 수에 비례해 호출 부담이 커졌던 것이 문제였다. 아래 from-class-carts는
// 그 무거운 배부(청구) 단계를 전혀 하지 않고, 학생별로 "교재비 페이지가 없으면 1건만 생성"하는
// 단순 작업만 반복한다 -- 학생 수만큼 늘어나는 건 맞지만 각 건이 가벼운 단일 페이지 생성 정도라 같은
// 구조적 한계에 해당하지 않는다고 판단했다. 실제 교재 배부(청구)는 여전히 교재비 페이지의
// "진도교재 담기" 버튼(from-cart)으로 학생별로 개별 진행한다.
//
// (2026-09-17, 디버깅 1차) from-class-carts 버튼을 누르보대 노션 쪽에 "버튼 실행에 실패했습니다" 토스트만
// 뜨고 어렘에도 기록이 안 남았다. route === "from-class-carts"입려에만 임시 디버깅 로깅을 둘늘다.
// 배포 후 버튼을 다시 누르둔 이 임시 로깅 DB(🔧 웹훅 디버그 로그 (임시))에 결과가 0건 -
// 증, 요샕이 이 함수에 전혀 도달하지 않고 있다는 뜻. 가장 의심되는 원인은 URL 끔의 쉐랑시(trailing
// slash) 따위 route 파싱이 깜끔하게 다른 것(예: ".../from-class-carts/" → pop()이 빈 문자열을 맞럈)
// 이다. 아래 둘을 수정: (1) route 파싱을 filter(Boolean)을 뎊션 쉐랑시에 안전하게, (2) 디버깅
// 로깅을 route에 상관없이 버튼마다 무조건 남기도록 확대로 범위를 늘릴. 원인 파악 후 이 벼생적 DATA_SOURCE_DEBUG_LOG
// / logDebugWebhookCall / 이 주석 바땔은 모드 제거할 예정.
//
// 라우트:
//   POST /sync-textbook-distribution/from-cart         <- 교재비(학원) DB "진도교재 담기" 버튼 (학생 1명, 담기까지 수행)
//   POST /sync-textbook-distribution/from-class-carts   <- 클래스(학원) DB "교재비 생성" 버튼 (반 전체, 교재비 페이지만 일괄 생성 - 교재 배부는 하지 않음)

import { PROP_LAST_ERROR, PROP_SYNCED_AT, DS_REGISTRATION, PROP_CLASS, PROP_STATUS } from "../_shared/constants.ts"
import {
	getPage,
	createPage,
	queryAllPages,
	relIds,
	relationIds,
	statusName,
	formulaString,
	checkboxValue,
	anyTitleText,
	extractPageId,
	todaySeoulDate,
	mapWithConcurrency,
} from "../_shared/notionClient.ts"
import { makeSyncStatusSetter } from "../_shared/registrationSync.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"
import { getScheduleConfig } from "../_shared/adminShared.ts"

// 이 함수 하나에서만 쓰는 데이터소스 ID/속성명이라 _shared/constants.ts로 옮기지 않고 여기 둔다
// (constants.ts 상단 원칙 참고).
const DATA_SOURCE_TEXTBOOK_CART = Deno.env.get("DATA_SOURCE_TEXTBOOK_CART_ID")! // 교재비(학원) DB
const DATA_SOURCE_TEXTBOOK_DISTRIBUTION = Deno.env.get("DATA_SOURCE_TEXTBOOK_DISTRIBUTION_ID")! // 교재배부(학원) DB
// sync-registration-textbook이 이미 쓰고 있는 것과 동일한 환경변수 이름을 재사용한다 (진도교재 DB).
const DATA_SOURCE_PROGRESS_BOOK = Deno.env.get("DATA_SOURCE_PROGRESS_BOOK_ID")!

// [TEMP DEBUG] from-class-carts 실패 원인 진단용 임시 로그 DB ("🔧 웹훅 디버그 로그 (임시)", 교재비 관리
// 페이지 하위). 민감 정보가 아니라 데이타소스 ID를 그대로 하드코딩한다. 원인 파악 후 제거할 예정.
const DATA_SOURCE_DEBUG_LOG = "65bd92de36864b57be320cb4b8b5a3c8"

// 교재비(학원) DB 속성
const PROP_CART_TITLE = "이름"
const PROP_CART_REGISTRATION = "등록" // relation -> 등록(학원) DB
const PROP_CART_RUNNING = "담기 처리중"

// 교재배부(학원) DB 속성
const PROP_DIST_TITLE = "이름"
const PROP_DIST_REGISTRATION = "등록" // relation -> 등록(학원) DB
const PROP_DIST_REGULAR_BOOK = "정규교재" // relation -> 정규교재(학원) DB (단방향, 한 교재배부당 1건만)
const PROP_DIST_DATE = "배부일"
// 교재비(카트) <-> 교재배부는 양방향 관계. 이 속성을 명시적으로 채워야 카트 쪽 "교재배부"에도
// 새 배부건이 나타나고 "총 금액" 등 롤업/수식이 정상적으로 갱신된다.
const PROP_DIST_CART = "교재비" // relation -> 교재비(학원) DB

// 진도교재(학원) DB 속성
const PROP_PROGRESS_STATUS = "진행상태"
const PROP_REGULAR_BOOK_ON_PROGRESS = "정규교재" // relation, limit 1
const STATUS_ELIGIBLE = "진행 중" // 이 상태인 진도교재만 청구 대상으로 담는다 ("다음 교재"는 아직 청구 X)

// 등록(학원) DB 속성
const PROP_REGISTRATION_BOOKS = "진도교재" // relation -> 진도교재(학원) DB
const PROP_REGISTRATION_CART = "교재비" // relation -> 교재비(학원) DB
// 등록(학원) DB "수강상태" 수식 값 - from-class-carts가 반 전체 등록 중 이 값인 것만 대상으로 삼는다.
const STATUS_ACTIVE = "🟢 수강 중"

// 클래스(학원) DB 속성
const PROP_CLASS_CART_RUNNING = "교재비 생성중" // 이 클래스의 교재비 일괄 생성(from-class-carts)이 처리 중인지 표시 (내부용)

// 배지 작업 전체가 이 시간 안에 못 끝나면, 무한정 기다리게 하지 않고 곧바로
// "처리 시간 초과" 오류로 표시하고 락을 풀어서 바로 재클릭해서 다시 시도할 수 있게 한다.
const BATCH_TIMEOUT_MS = 120 * 1000

// 교재비 DB는 이 함수 혼자만 처리 상태를 쓰므로 otherFlagProps가 필요 없다.
const setCartStatus = makeSyncStatusSetter(PROP_CART_RUNNING, [])
// 클래스 DB는 수강료 생성중/보고서 생성중/교재 생성중과 "실시간 처리 상태" 수식을 공유하지만,
// 그 수식은 체크박스들을 실시간으로 조합해서 보여주므로 여기 setter는 자기 자신만 갱신하면 된다.
const setClassCartStatus = makeSyncStatusSetter(PROP_CLASS_CART_RUNNING, [])

// [TEMP DEBUG] 실제로 들어온 요샕을 노션의 임시 로그 DB에 기록한다 (fire-and-forget, 절대 메인 응답을
// 막거나 실패시키지 않음). 원인 파악 후 제거할 예정.
async function logDebugWebhookCall(
	route: string | undefined,
	method: string,
	rawBody: string,
	pageId: string | null,
): Promise<void> {
	try {
		const nowIso = new Date().toISOString()
		await createPage(DATA_SOURCE_DEBUG_LOG, {
			["이름"]: { title: [{ text: { content: `${nowIso} ${route ?? "(no route)"}` } }] },
			["라우트"]: { rich_text: [{ text: { content: route ?? "" } }] },
			["메소드"]: { rich_text: [{ text: { content: method } }] },
			["pageId 추출 결과"]: { rich_text: [{ text: { content: pageId ?? "(추출 실패 - null)" } }] },
			["원본 바디"]: { rich_text: [{ text: { content: rawBody.slice(0, 1900) } }] },
			["수신시각(KST)"]: { rich_text: [{ text: { content: nowIso } }] },
		})
	} catch (err) {
		console.error("[sync-textbook-distribution] (debug) logDebugWebhookCall 실패:", err)
	}
}

// 백그라운드 배지 작업이 예상 밖으로 오래 걸리면 사용자가 "처리중" 표시만 보며 무한정
// 기다리지 않도록, 정해진 시간 안에 못 끝나면 즉시 오류 상태로 바꿔서 알려주고 락도 풀어준다
// (재클릭하면 바로 다시 시도 가능). 원본 작업 자신은 자바스크립트 특성상 취소할 수 없어
// 백그라운드에서 계속 흐르지만, 그 작업이 뒤늦게 스스로 완료/오류 상태를 기록하므로(각 라우트의
// 기존 try/catch), 이 함수는 시간 초과 시점에만 개입해서 사용자에게 먼저 알려주는 역할만 한다.
async function runWithSafetyTimeout(
	label: string,
	task: () => Promise<void>,
	onTimeout: () => Promise<void>,
): Promise<void> {
	let finished = false
	const taskPromise = task().finally(() => {
		finished = true
	})
	const timedOut = await Promise.race([
		taskPromise.then(() => false),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(true), BATCH_TIMEOUT_MS)),
	])
	if (timedOut && !finished) {
		console.error(`[sync-textbook-distribution] (background) ${label} TIMEOUT after ${BATCH_TIMEOUT_MS}ms`)
		await onTimeout()
		// 원래 작업이 뒤늦게 끝나면 그 안의 try/catch가 알아서 최종 상태(완료/오류)를 다시 기록한다.
		taskPromise.catch(() => {})
	}
}

// 등록 하나에 대해 교재비(장바구니) 페이지를 확보한다: 이미 있으면 재사용(항상 학생당 1개만 존재해야
// 함), 없으면 이 시점에 생성한다. from-cart(진도교재 담기)와 from-class-carts(교재비 페이지만
// 반 전체 일괄 생성 - 교재 배부는 하지 않음) 두 경로가 공통으로 쓰게.
async function ensureCartForRegistration(
	registrationId: string,
	preFetchedRegistration?: any,
): Promise<{ cartId: string; cartCreated: boolean }> {
	const registration = preFetchedRegistration ?? (await getPage(registrationId))
	const existingCartIds = relationIds(registration, PROP_REGISTRATION_CART)
	if (existingCartIds.length > 0) {
		return { cartId: existingCartIds[0], cartCreated: false }
	}
	const studentName = anyTitleText(registration) || "학생"
	// [NEW] 표시용: 이 카트의 발송 설정이 알림톡 설정(학원) DB의 어느 행인지 한눈에 보여준다
	// (실제 발송 동작에는 영향 없음, 위 파일 상단 주석 참고).
	// getScheduleConfig에 60초 캐시가 있어서, 같은 배지 안에서 여러 학생의 신규 카트를 만들 때도
	// 실제 Notion 조회는 한 번만 일어난다.
	const textbookConfig = await getScheduleConfig("교재비 안내")
	const cart = await createPage(DATA_SOURCE_TEXTBOOK_CART, {
		[PROP_CART_TITLE]: { title: [{ text: { content: `${studentName} 교재비` } }] },
		[PROP_CART_REGISTRATION]: { relation: [{ id: registrationId }] },
		...(textbookConfig ? { "알림톡 설정": { relation: [{ id: textbookConfig.rowId }] } } : {}),
	})
	return { cartId: cart.id, cartCreated: true }
}

// 등록 하나에 대해: 아직 담기지 않은 "진행 중" 진도교재를 모아, 교재(정규교재)당 교재배부를 개별로 생성한다.
// 장바구니(교재비 페이지)가 없으면 ensureCartForRegistration이 이 시점에 자동으로 만든다.
// Notion API 호출은 단순 for루프로 순차 처리한다 (동시 호출을 늘리지 않는다).
async function distributeForRegistration(
	registrationId: string,
	preFetchedRegistration?: any,
): Promise<
	| { status: "no_eligible_books" }
	| { status: "already_billed" }
	| { status: "distributed"; distributionPageIds: string[]; bookCount: number; cartId: string; cartCreated: boolean }
> {
	const registration = preFetchedRegistration ?? (await getPage(registrationId))
	const progressBookIds = relationIds(registration, PROP_REGISTRATION_BOOKS)
	if (progressBookIds.length === 0) return { status: "no_eligible_books" }

	const progressBooks: any[] = []
	for (const id of progressBookIds) {
		progressBooks.push(await getPage(id))
	}
	const eligibleBookIds = new Set<string>()
	for (const book of progressBooks) {
		if (statusName(book, PROP_PROGRESS_STATUS) !== STATUS_ELIGIBLE) continue
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
	const { cartId, cartCreated } = await ensureCartForRegistration(registrationId, registration)

	// 교재배부 1건 = 정규교재 1개. 새로 담을 정규교재가 여러 개라면, 개별 교재배부 페이지를 그 수만큼 따로 만든다.
	const newBookPages: any[] = []
	for (const id of newBookIds) {
		newBookPages.push(await getPage(id))
	}
	const distributions: any[] = []
	for (let idx = 0; idx < newBookIds.length; idx++) {
		const bookId = newBookIds[idx]
		const bookTitle = anyTitleText(newBookPages[idx]) || `${todaySeoulDate()} 교재 배부`
		const dist = await createPage(DATA_SOURCE_TEXTBOOK_DISTRIBUTION, {
			[PROP_DIST_TITLE]: { title: [{ text: { content: bookTitle } }] },
			[PROP_DIST_REGISTRATION]: { relation: [{ id: registrationId }] },
			[PROP_DIST_REGULAR_BOOK]: { relation: [{ id: bookId }] },
			[PROP_DIST_DATE]: { date: { start: todaySeoulDate() } },
			[PROP_DIST_CART]: { relation: [{ id: cartId }] },
		})
		distributions.push(dist)
	}

	return {
		status: "distributed",
		distributionPageIds: distributions.map((d: any) => d.id),
		bookCount: newBookIds.length,
		cartId,
		cartCreated,
	}
}

Deno.serve(async (req: Request) => {
	const url = new URL(req.url)
	// [TEMP DEBUG 수정] 쉐랑시(trailing slash)가 붙어오면 기존 split("/").pop()은 빈 문자열을 맞럈 -
	// filter(Boolean)으로 빈 조각을 거륩내서 언제도 뜻바릑이 담기가 정확히 잡히도록 한다.
	const route = url.pathname.split("/").filter(Boolean).pop()
	const rawBodyText = await req.text()
	let body: unknown = {}
	try {
		body = rawBodyText ? JSON.parse(rawBodyText) : {}
	} catch {
		// 빈 바디 허용하지 않음 - 아래에서 pageId 누락으로 에러 처리
	}
	console.log("sync-textbook-distribution payload:", route, JSON.stringify(body))

	const pageId = extractPageId(body)

	// [TEMP DEBUG 수정] 이전에는 route === "from-class-carts"일 떄만 로그를 둘얈다. 그런데 실제로는
	// 로그가 0건이었다 - route가 기대한 것과 다르게 들어온 것일 수도 있다도 보기 위해, route가 뭐땜대
	// 상관없이 모든 요샕을 대상으로 무조거 남겨 범위를 늘마다 (fire-and-forget, 응답에는 영향 없음).
	logDebugWebhookCall(route, req.method, rawBodyText, pageId).catch(() => {})

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

			runInBackground(() =>
				runWithSafetyTimeout(
					"from-cart",
					async () => {
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
					},
					() =>
						setCartStatus(
							pageId,
							"오류",
							`처리 시간 초과 (${BATCH_TIMEOUT_MS / 1000}초 내 완료되지 않음) - 다시 시도해 주세요`,
						),
				),
			)

			return respondAccepted({ pageId, route })
		} else if (route === "from-class-carts") {
			// 클래스 페이지 자신이 클릭 대상. 이미 처리 중이면 재클릭을 무시한다.
			const classForLock = await getPage(pageId)
			if (checkboxValue(classForLock, PROP_CLASS_CART_RUNNING)) {
				return new Response(JSON.stringify({ ok: true, message: "already_processing", pageId, route }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}
			await setClassCartStatus(pageId, "처리중")

			runInBackground(() =>
				runWithSafetyTimeout(
					"from-class-carts",
					async () => {
						try {
							// 이 클래스에 연결된 등록을 전부 조회한 뒤(쿼리 응답에 수식 계산값도 포함됨),
							// "수강상태"가 활성(🟢 수강 중)인 등록만 대상으로 삼는다. 등록 1명당 추가 조회 없이
							// 이 한 번의 쿼리 결과로 필터링할 수 있다.
							const registrations = await queryAllPages(DS_REGISTRATION, {
								property: PROP_CLASS,
								relation: { contains: pageId },
							})
							const activeRegistrations = registrations.filter(
								(reg: any) => formulaString(reg, PROP_STATUS) === STATUS_ACTIVE,
							)
							// 교재배부(청구)는 전혀 하지 않고, 학생별로 교재비 페이지가 없으면 1건만 생성한다.
							// 각 건이 가벼운 단일 페이지 생성이라 동시성 4 정도로 병렬 처리해도 안전하다.
							const results = await mapWithConcurrency(activeRegistrations, 4, (reg: any) =>
								ensureCartForRegistration(reg.id, reg),
							)
							const createdCount = results.filter((r) => r.cartCreated).length
							await setClassCartStatus(pageId, "완료")
							console.log("[sync-textbook-distribution] (background) from-class-carts finished:", pageId, {
								activeCount: activeRegistrations.length,
								createdCount,
							})
						} catch (err) {
							console.error("[sync-textbook-distribution] (background) from-class-carts ERROR:", err)
							await setClassCartStatus(pageId, "오류", (err as Error)?.message ?? String(err))
						}
					},
					() =>
						setClassCartStatus(
							pageId,
							"오류",
							`처리 시간 초과 (${BATCH_TIMEOUT_MS / 1000}초 내 완료되지 않음) - 다시 시도해 주세요`,
						),
				),
			)

			return respondAccepted({ pageId, route })
		} else {
			return new Response(JSON.stringify({ error: `알 수 없는 경로: ${route}` }), { status: 404 })
		}
	} catch (err) {
		console.error(err)
		return new Response(JSON.stringify({ error: String(err) }), { status: 400 })
	}
})
