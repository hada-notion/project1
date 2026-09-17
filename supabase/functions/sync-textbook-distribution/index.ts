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
// (2026-09-17, 웹훅 주소 오류 수정) from-class-carts가 계속 실패했던 진짜 원인은 코드가 아니라
// 이 함수를 가리키는 웹훅 URL에 잘못된 Supabase 프로젝트 참조가 쓰여 있었던 것이었다 (DNS 자체가
// 실패). 웹훅 URL을 올바른 프로젝트 주소로 수정한 뒤에는 요청이 정상적으로 이 함수까지 도달한다.
//
// (2026-09-17, 체크박스 고착 수정 1차) 웹훅 주소를 고친 뒤에도, 실제로는 카트 생성이 전부 성공했는데
// ("교재비 생성 여부" 수식이 "완료"로 표시됨) 마지막에 "교재비 생성중" 체크박스를 다시 꺼주는
// 쓰기 한 번만 조용히 실패해서 체크박스가 영원히 켜진 채로 남는 사례가 실제로 발생했다 (고2 A반).
// 이 체크박스가 켜져 있으면 재클릭도 막혀 있어서(아래 already_processing 분기) 사용자가 스스로
// 풀 방법이 없었다. 아래에서 이 잠금 분기를 무조건 거부가 아니라 "실제 데이터로 다시 계산해서
// 판단"하도록 바꿔서, 이미 다 끝나 있었으면 고착된 체크박스만 정리하고, 아직 누락이 있으면(진짜
// 처리 중이든 멈춘 것이든) 안전하게 새로 이어서 진행하게 했다.
//
// (2026-09-17, 체크박스 고착 수정 2차 -- 진짜 구조적 원인) 1차 수정 이후에도 다른 반(고1 A반,
// 고2 B반)에서 같은 현상이 새로 발생했다. generate-tuition/generate-report(사용자가 "체크박스가
// 금방금방 잘 꺼진다"고 지목한, 클래스 단위로 반 전체 등록을 처리하는 다른 두 함수)와 이 함수를
// 나란히 비교해보니 결정적인 차이를 찾았다: 그 두 함수는 등록 하나하나를 항상 순차(for 루프)로
// 처리하는데, 여기 from-class-carts만 mapWithConcurrency(..., 4, ...)로 등록 4명을 동시에 처리하고
// 있었다. 동시에 여러 Notion API 호출을 날리면 레이트리밋(429)에 걸릴 확률이 커지고, 그 지연이
// 누적되면 백그라운드 작업 전체 실행 시간이 길어져 플랫폼이 격리 인스턴스를 회수해버릴 가능성이
// 커진다 -- 실제로 마지막 "완료" 쓰기까지 도달하지 못하면 로그도 전혀 남기지 못하고 그대로 죽는데,
// 이는 관찰된 증상(오류 텍스트도 없이 체크박스만 영원히 켜진 채로 남음)과 정확히 일치한다.
// 아래에서 동시성을 없애고 다른 두 함수와 동일하게 순차 처리로 통일했다.
// 추가로, 이미 전부 생성되어 있는 클래스에서 버튼을 실수로 다시 눌러도 예전에는 매번 "처리중" ->
// 백그라운드 작업 -> "완료"라는 위험한 경로를 다시 거쳐야 했다. 이제는 만들 게 하나도 남아있지
// 않으면 백그라운드로 넘기지 않고 요청을 받은 그 자리에서 바로 판단해서 응답한다 (켜져 있던
// 체크박스는 그 자리에서 바로 꺼주고, 이미 꺼져 있었으면 아무 쓰기도 없이 즉시 "이미 완료됨"으로
// 응답한다) -- 그만큼 고착될 여지 자체가 줄어든다.
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
// 페이지 하위). 민감 정보가 아니라 데이타소스 ID를 그대로 하드코딩한다. 원인 파악(웹훅 주소 오류로 확인됨) 후
// 정리 예정 -- 당장 동작에는 영향 없으므로 이번 수정에서는 그대로 둔다.
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
// 막거나 실패시키지 않음). 원인 파악(웹훅 주소 오류로 확인됨) 후 정리 예정.
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

// from-class-carts가 대상으로 삼는, 이 클래스의 "활성" 등록만 골라서 반환한다 (수강상태 수식 ==
// STATUS_ACTIVE). 등록 페이지 자체(수식 계산값 포함)를 그대로 반환하므로, 호출부가 추가 조회 없이
// relationIds(reg, PROP_REGISTRATION_CART)로 카트 보유 여부를 바로 판단할 수 있다.
async function getActiveRegistrationsForCarts(classId: string): Promise<any[]> {
	const registrations = await queryAllPages(DS_REGISTRATION, {
		property: PROP_CLASS,
		relation: { contains: classId },
	})
	return registrations.filter((reg: any) => formulaString(reg, PROP_STATUS) === STATUS_ACTIVE)
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
			// 클래스 페이지 자신이 클릭 대상.
			// 먼저 실제 데이터(활성 등록 중 교재비 누락 여부)부터 계산한다. 체크박스 값만 보고 바로
			// 처리중/거부를 판단하지 않고, 항상 실제 상태를 기준으로 판단한다 (2차 수정).
			const classForLock = await getPage(pageId)
			const activeRegistrations = await getActiveRegistrationsForCarts(pageId)
			const missingRegistrations = activeRegistrations.filter(
				(reg: any) => relationIds(reg, PROP_REGISTRATION_CART).length === 0,
			)

			if (missingRegistrations.length === 0) {
				// (2026-09-17, 즉시 완료 단축 경로) 만들 게 하나도 없다 -- 이미 실수로 두 번 눌렀거나,
				// 이전 실행이 실제로는 다 끝났는데 체크박스만 고착된 경우다. 백그라운드로 전혀 넘기지
				// 않고 이 요청 자체에서 바로 응답한다: 켜져 있었으면 그 자리에서 꺼주고, 이미 꺼져
				// 있었으면 아무 쓰기도 하지 않고 즉시 반환한다 (고착될 여지 자체가 없다).
				if (checkboxValue(classForLock, PROP_CLASS_CART_RUNNING)) {
					await setClassCartStatus(pageId, "완료")
					return new Response(
						JSON.stringify({ ok: true, message: "recovered_already_completed", pageId, route }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					)
				}
				return new Response(JSON.stringify({ ok: true, message: "already_completed", pageId, route }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}

			// 아직 누락이 있다: 체크박스가 켜져 있어도(진짜 처리 중이든 멈춘 것이든) 거부하지 않고
			// 안전하게 새로 이어서 진행한다 -- ensureCartForRegistration은 이미 카트가 있는 학생은
			// 건드리지 않는 멱등 작업이라 중복 생성 위험이 없다.
			await setClassCartStatus(pageId, "처리중")

			runInBackground(() =>
				runWithSafetyTimeout(
					"from-class-carts",
					async () => {
						try {
							// (2026-09-17, 2차 수정) generate-tuition/generate-report와 동일하게 순차(for
							// 루프) 처리로 통일한다. 동시성(mapWithConcurrency)을 쓰면 Notion API
							// 레이트리밋에 더 잘 걸리고, 그 지연이 누적되면 마지막 "완료" 쓰기 전에 백그라운드
							// 실행 시간이 플랫폼 한도를 넘어 격리 인스턴스가 회수될 위험이 커진다 -- 이게 이
							// 함수만 유독 체크박스가 잘 안 꺼지던 진짜 원인으로 보인다.
							let createdCount = 0
							for (const reg of activeRegistrations) {
								const result = await ensureCartForRegistration(reg.id, reg)
								if (result.cartCreated) createdCount++
							}
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
