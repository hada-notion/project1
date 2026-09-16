// sync-textbook-distribution
//
// 교재비 기능(로드맵 5-37) 1차 구현: 장바구니(교재비) 자동 생성 + 진도교재 일괄 담기(교재배부 생성).
// 결제(교재배부 "결재" 버튼 → 미납/결제완료 전환)는 기존 노션 자동화를 그대로 사용하며 이 함수는 건드리지 않는다.
//
// 담기 대상 판정 규칙:
//   진도교재(학원) DB의 "진행상태"가 정확히 "진행 중"(실제로 지금 쓰고 있는 교재)인 것만 담는다.
//   - "다음 교재"는 아직 시작 전이며, 다음 학기에나 쓰게 될 수도 있는 "진짜 다음" 교재라 아직 청구하지 않는다.
//   - "완료"/"미사용"은 이미 지난 교재라 제외 (이미 예전에 배부(청구)됐을 가능성이 높음).
//   추가로, 이미 이 등록의 기존 교재배부에 실려 있는 정규교재는(재클릭 등으로) 중복으로 다시 담기지 않도록 별도로 거른다.
//
// 교재배부 1건 = 정규교재 1개 (2026-09-16 수정). 새로 담을 정규교재가 여러 개이다면, 한 번의 버튼 호출에서도
// 교재배부 페이지를 교재당 1건씨 여러 개 만든다 (교재배부의 "정규교재" 관계는 1건만 가리쾤맀다는 가정).
//
// 일괄처리 방식: 개별 버튼(교재비 페이지 "진도교재 담기")과 클래스 버튼(클래스 페이지 "교재 일괄 배부")
// 두 트리거 모두 동일한 핵심 로직(distributeForRegistration)을 공유한다. 클래스 버튼은 그 클래스의
// 활성 등록 전체에 대해 개별 로직을 반복 호출하는 것뿐이다 (구현 중복 없이 두 방식을 함께 지원).
//
// (2026-09-16) 교재비(카트) 페이지를 새로 만들 때 "알림톡 설정" 관계(표시 전용)도 함께 채운다.
// send-textbook-notice는 여전히 발송 시점에 "발송 구분" 문자열로 알림톡 설정 DB를 조회하므로,
// 실제 발송 동작에는 영향이 없다 -- Notion 화면에서 이 카트가 어떤 발송 설정과 연결되는지
// 직관적으로 보이도록 하기 위한 것뿐이다 (조회 실패 시 조용히 건너뜀).
//
// (2026-09-17) from-class 락("교재배부 처리중")이 백그라운드 처리 중 Edge Function 런타임이
// 죽거나 타임아웃되면 영원히 true로 남아, 재클릭해도 매번 already_processing만 리턴하고 절대
// 재실행되지 않는 문제가 있었다. "교재배부 시작 시각"을 함께 기록해서, 락이 켜진 지 일정 시간이
// 넘었으면 멈추 것으로 보고 재클릭 시 자동으로 새로 시작하도록 고쳤다 (from-cart/개별 버튼은
// 이번엔 범위에서 제외 -- 필요하면 동일한 방식으로 확장 가능).
//
// (2026-09-17, 2차 수정) 실제로 고1 A반/B반에서 첫 실행 때 "처리중" 체크박스가 완료 후에도
// 자동으로 안 풀리는 문제가 발생했다. 코드상 성공/실패 양쪽 경로 모두 체크박스를 끄도록 되어
// 있으므로, 가장 유력한 원인은 (a) 학생 수가 많을 때 등록마다 순차적으로 여러 번 Notion API를
// 호출하느라 전체 처리 시간이 Edge Function 런타임의 최대 실행 시간을 넘겨서 함수 자체가
// 완료/오류 처리 코드에 도달하기도 전에 강제 종료됐을 가능성이다. 이를 개선하기 위해:
//   1) from-class에서 각 등록 페이지를 두 번(활성 여부 판정용 + distributeForRegistration 내부)
//      중복 조회하던 것을 한 번만 조회하도록 고쳐서 API 호출 수를 줄이고,
//   2) 등록 단위 동시 처리 수를 3 -> 5로 늘려서 전체 처리 시간을 단축하고,
//   3) 배치 작업 전체에 내부 안전 타임아웃(BATCH_TIMEOUT_MS)을 둬서, 혹시라도 예상보다 오래
//      걸리면 (10분씩 기다리지 않고) 곧바로 "처리 시간 초과" 오류로 표시하고 락을 풀어서 바로
//      재클릭해서 다시 시도할 수 있게 했다. 원래 작업 자체는 취소할 수 없어 백그라운드에서 계속
//      흐르지만(자바스크립트 특성상 완전한 취소 불가), 뒤늦게 정상적으로 끝나면 그 결과로 다시
//      상태를 덮어써준다. 중복 생성은 distributeForRegistration의 기존 조회 로직이 막아준다.
//   4) 위 안전장치들에도 불구하고 Edge Function 프로세스 자체가 완전히 죽어버리는 최악의 경우를
//      대비해, "교재배부 시작 시각" 기반 락 자동 해제 기준을 10분 -> 3분으로 단축했다.
//
// (2026-09-17, 3차 수정) 2차 수정 배포 후에도 고1 A반/B반에서 재현됨 -- 재클릭 후 90초 넘게
// 지나도 "처리중"이 자동으로 안 풀리는 사례가 있었다. Edge Function 런타임이 내부 안전 타임아웃
// (setTimeout)조차 실행하지 못할 정도로 완전히 죽어버리는 경우로 추정된다. 자바스크립트 안에서는
// 이런 경우를 감지/복구할 방법이 없으므로, 사용자가 재클릭하는 행동 자체를 "멈춘 것 같다"는 신호로
// 받아들여 그 클릭에서 곧바로 락을 풀고 안내 메시지를 남기도록 바꿨다 (CLICK_UNLOCK_GRACE_MS 참고,
// 같은 클릭에서 바로 재실행하지는 않고 다음 클릭에서 새로 시작한다). 근본적으로 Edge Function이
// 왜 죽는지는 Supabase 함수 로그를 직접 확인해야 알 수 있다.
//
// (2026-09-17, 4차 수정) Supabase 함수 로그를 확인해보니 실제로는 런타임이 죽은 게 아니었다.
// 학생 6명짜리 아주 작은 반(중등 과외)도 그대로 90초 타임아웃에 걸렸다 -- 즉 "처리중"이 실제로
// 정상적으로 90초 넘게 걸리고 있었다는 뜻이다. 원인은 동시성 설정: from-class가 등록 여러 건을
// 동시에(5개씩) 처리하는데, 등록 하나당 내부적으로도(진도교재 조회/정규교재 조회/교재배부 생성)
// 3~4개씩 동시에 Notion API를 호출하고 있어서, 순간적으로 수십 건의 요청이 겹쳐 Notion API
// 레이트리밋(429)에 자주 걸렸을 가능성이 높다. fetchWithRetry는 429를 만나면 지수 백오프(최대
// 5회, 300ms~4.8초씩)로 재시도하는데, 이 대기 시간들이 누적되면 학생 몇 명짜리 반도 손쉽게 90초를
// 넘길 수 있다. 이를 줄이기 위해 각 단계의 동시성 수치를 낮췄고(등록 5->2, 등록 내부 조회/생성
// 3~4->2), 신규 교재비 카트 생성 시마다 매번 다시 조회하던 getScheduleConfig도 60초 캐시를
// 추가해(adminShared.ts) 반복 조회를 줄였다. 동시성을 낮추면 개별 처리는 약간 느려지지만,
// 레이트리밋 백오프가 줄어들어 총 처리 시간은 오히려 짧아질 것으로 기대한다. 그래도 못 미치면
// BATCH_TIMEOUT_MS를 120초로 늘려 여유를 더 뒀다.
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
import { getScheduleConfig } from "../_shared/adminShared.ts"

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

// 클래스(학원) DB 속성
const PROP_CLASS_REGISTRATION = "등록" // relation -> 등록(학원) DB
const PROP_CLASS_TEXTBOOK_BATCH_RUNNING = "교재배부 처리중"
// [2026-09-17] "교재배부 처리중"이 언제 true로 켜졌는지 기록. from-class 재클릭 시 이 시각을 보고
// 그레이스 기간(CLICK_UNLOCK_GRACE_MS)이 지났으면 이전 실행이 응답 없이 멈춘 것으로 보고 그 자리에서
// 즉시 락을 풀어준다 (2026-09-17, 3차 수정: 아래 CLICK_UNLOCK_GRACE_MS 설명 참고).
const PROP_CLASS_TEXTBOOK_BATCH_STARTED_AT = "교재배부 시작 시각"
// [2026-09-17, 3차 수정] BATCH_TIMEOUT_MS(내부 안전 타임아웃)조차 못 미더울 만큼 Edge Function
// 런타임이 응답 없이 죽는 사례가 재현되어(반 하나 배부에 90초+ 지나도 "처리중"이 안 풀림), 자동
// 복구만 마냥 기다리게 하지 않기로 했다. "처리중"이 이 시간보다 오래 켜져 있는 상태에서 사용자가
// 버튼을 다시 누르면 -- 그 자체가 "멈춘 것 같다"는 신호이므로 -- 그 클릭에서 곧바로 락을 풀고
// "다시 시도해 주세요" 안내를 남긴다(같은 클릭에서 바로 재실행하지는 않는다; 아래 from-class 핸들러
// 참고). 정상 실행은 보통 수십 초 내에 끝나므로 15초면 "방금 시작된 정상 실행"과 "재클릭 필요"
// 상황을 무리 없이 구분한다.
const CLICK_UNLOCK_GRACE_MS = 15 * 1000
// [2026-09-17, NEW] 배치 작업(from-class/from-cart) 전체가 이 시간 안에 못 끝나면, 무한정
// 기다리게 하지 않고 곧바로 "처리 시간 초과" 오류로 표시하고 락을 풀어서 바로 재클릭해서 다시
// 시도할 수 있게 한다. 학급 하나(수십 명)를 처리해도 보통 수십 초 내에 끝나므로 90초면 정상
// 실행을 오탐지하지 않으면서도 충분히 여유 있는 기준이다.
// [2026-09-17, 4차 수정] 아래 동시성을 낮춰서 레이트리밋 백오프가 줄어들 것으로 기대하지만,
// 혹시 여유가 더 필요할 경우를 대비해 90초 -> 120초로 늘렸다.
const BATCH_TIMEOUT_MS = 120 * 1000

// 교재비 DB는 이 함수 혼자만 처리 상태를 쓰므로 otherFlagProps가 필요 없다.
const setCartStatus = makeSyncStatusSetter(PROP_CART_RUNNING, [])
// 클래스 DB는 수강료/보고서/교재 생성과 "실시간 처리 상태"를 공유하므로, 다른 3개 플래그를 함께 넘겨서
// "하나라도 처리중이면 전체를 처리중으로" 판단하는 기존 조합 방식을 그대로 따른다.
const setClassStatus = makeSyncStatusSetter(
	PROP_CLASS_TEXTBOOK_BATCH_RUNNING,
	["수강료 생성중", "보고서 생성중", "교재 생성중"],
	PROP_CLASS_TEXTBOOK_BATCH_STARTED_AT,
)

// [2026-09-17, NEW] 백그라운드 배치 작업이 예상 밖으로 오래 걸리면(외부 API 응답 지연, 등록/학생
// 수가 아주 많은 경우 등) 사용자가 "처리중" 표시만 보며 무한정 기다리지 않도록, 정해진 시간 안에
// 못 끝나면 즉시 오류 상태로 바꿔서 알려주고 락도 풀어준다(재클릭하면 바로 다시 시도 가능).
// 원본 작업 자체는 자바스크립트 특성상 취소할 수 없어 백그라운드에서 계속 흐르지만, 그 작업이
// 뒤늦게 스스로 완료/오류 상태를 기록하므로(각 라우트의 기존 try/catch), 이 함수는 시간 초과
// 시점에만 개입해서 사용자에게 먼저 알려주는 역할만 한다.
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

// 등록 하나에 대해: 아직 담기지 않은 "진행 중" 진도교재를 모아, 교재(정규교재)당 교재배부를 개별로 생성한다.
// 장바구니(교재비 페이지)가 없으면 이 시점에 자동으로 만든다 (하나만 존재, 사용자 설계대로).
// [2026-09-17] preFetchedRegistration: from-class에서 활성 등록 판정을 위해 이미 조회해둔 등록
// 페이지가 있으면 그대로 재사용해서, 등록마다 중복으로 getPage를 호출하지 않도록 한다 (전체 처리
// 시간 단축 목적, 위 파일 상단 2차 수정 주석 참고).
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

	// [2026-09-17, 4차 수정] 4 -> 2: 등록 단위 동시 처리(from-class)와 겹쳐서 순간적으로 너무 많은
	// Notion API 요청이 동시에 나가 레이트리밋(429) 백오프가 누적되는 원인이 됐다 (파일 상단 4차
	// 수정 주석 참고).
	const progressBooks = await mapWithConcurrency(progressBookIds, 2, (id) => getPage(id))
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
	const existingCartIds = relationIds(registration, PROP_REGISTRATION_CART)
	let cartId: string
	let cartCreated = false
	if (existingCartIds.length > 0) {
		cartId = existingCartIds[0]
	} else {
		const studentName = anyTitleText(registration) || "학생"
		// [NEW] 표시용: 이 카트의 발송 설정이 알림톡 설정(학원) DB의 어느 행인지 한눈에 보여준다
		// (실제 발송 동작에는 영향 없음, 위 파일 상단 주석 참고).
		// [2026-09-17, 4차 수정] getScheduleConfig에 60초 캐시가 추가돼서(adminShared.ts), 같은
		// 배치 안에서 여러 학생의 신규 카트를 만들 때도 실제 Notion 조회는 한 번만 일어난다.
		const textbookConfig = await getScheduleConfig("교재비 안내")
		const cart = await createPage(DATA_SOURCE_TEXTBOOK_CART, {
			[PROP_CART_TITLE]: { title: [{ text: { content: `${studentName} 교재비` } }] },
			[PROP_CART_REGISTRATION]: { relation: [{ id: registrationId }] },
			...(textbookConfig ? { "알림톡 설정": { relation: [{ id: textbookConfig.rowId }] } } : {}),
		})
		cartId = cart.id
		cartCreated = true
	}

	// 교재배부 1건 = 정규교재 1개. 새로 담을 정규교재가 여러 개여맞이다면, 개별 교재배부 페이지를 거 수만큼 따로 만든다
	// (이마트: 이마트 이마트 이마트) -
	// 새로 담을 정규교재 건수만큼 모든 건 배부 1건씨 개별로 생성한다.
	// [2026-09-17, 4차 수정] 아래 두 mapWithConcurrency도 4/3 -> 2로 낮췄다 (파일 상단 4차 수정 주석 참고).
	const newBookPages = await mapWithConcurrency(newBookIds, 2, (id) => getPage(id))
	const distributions = await mapWithConcurrency(newBookIds, 2, async (bookId, idx) => {
		const bookTitle = anyTitleText(newBookPages[idx]) || `${todaySeoulDate()} 교재 배부`
		return await createPage(DATA_SOURCE_TEXTBOOK_DISTRIBUTION, {
			[PROP_DIST_TITLE]: { title: [{ text: { content: bookTitle } }] },
			[PROP_DIST_REGISTRATION]: { relation: [{ id: registrationId }] },
			[PROP_DIST_REGULAR_BOOK]: { relation: [{ id: bookId }] },
			[PROP_DIST_DATE]: { date: { start: todaySeoulDate() } },
			[PROP_DIST_CART]: { relation: [{ id: cartId }] },
		})
	})

	return {
		status: "distributed",
		distributionPageIds: distributions.map((d: any) => d.id),
		bookCount: newBookIds.length,
		cartId,
		cartCreated,
	}
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
		} else if (route === "from-class") {
			// 클래스 페이지 자신이 클릭 대상. 이미 처리 중이면 재클릭을 무시하되, 처리 시작 시각이
			// CLICK_UNLOCK_GRACE_MS보다 오래됐다면 이전 실행이 응답 없이 멈춘 것으로 보고 그 클릭에서
			// 곧바로 락을 풀고 "다시 시도해 주세요" 안내를 남긴다 (2026-09-17, 3차 수정: 같은 클릭에서
			// 바로 재실행하지는 않는다 -- 혹시 원래 실행이 실제로는 아직 살아있는 경우, 두 실행이 동시에
			// 같은 등록들을 만지면 상태 표시가 꼬일 수 있어서 다음 클릭에서 새로 시작하도록 한다).
			const classForLock = await getPage(pageId)
			const isBatchRunning = checkboxValue(classForLock, PROP_CLASS_TEXTBOOK_BATCH_RUNNING)
			const batchStartedAt = dateStart(classForLock, PROP_CLASS_TEXTBOOK_BATCH_STARTED_AT)
			const lockAgeMs = batchStartedAt ? Date.now() - new Date(batchStartedAt).getTime() : Infinity
			if (isBatchRunning) {
				if (lockAgeMs < CLICK_UNLOCK_GRACE_MS) {
					// 방금(그레이스 기간 이내) 시작된 정상 실행 중일 가능성이 높으므로 그대로 둔다 (연타 보호).
					return new Response(JSON.stringify({ ok: true, message: "already_processing", pageId, route }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					})
				}
				// 그레이스 기간이 지난 뒤에도 "처리중"이면, 재클릭 자체를 "멈춘 것 같다"는 신호로 보고
				// 곧바로 락을 풀고 안내를 남긴다. 다음 클릭에서 정상적으로 새로 시작된다.
				await setClassStatus(
					pageId,
					"오류",
					"이전 실행이 응답 없이 멈췄을 수 있습니다. 처리 중 표시를 해제했습니다 - 다시 눌러서 재시도해 주세요.",
				)
				return new Response(JSON.stringify({ ok: true, message: "unlocked_please_retry", pageId, route }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}
			await setClassStatus(pageId, "처리중")

			runInBackground(() =>
				runWithSafetyTimeout(
					"from-class",
					async () => {
						try {
							const classPage = await getPage(pageId)
							const registrationIds = relationIds(classPage, PROP_CLASS_REGISTRATION)
							const today = todaySeoulDate()
							// [2026-09-17] 이 시점에 이미 등록 페이지 전체를 조회하므로, 아래에서
							// distributeForRegistration을 호출할 때 같은 페이지를 다시 조회하지 않고
							// 그대로 재사용한다 (API 호출 수 절반으로 감소, 전체 처리 시간 단축).
							// [2026-09-17, 4차 수정] 4 -> 3로 소폭 낮춤 (파일 상단 4차 수정 주석 참고).
							const registrations = await mapWithConcurrency(registrationIds, 3, (id) => getPage(id))
							const activeRegistrations = registrations.filter((r) => isActiveRegistration(r, today))

							// [2026-09-17, 4차 수정] 5 -> 2로 낮춤: 등록별로 내부에서도 여러 건의 Notion API
							// 호출이 동시에 나가고 있어서, 기존 5는 순간적으로 너무 많은 동시 요청을 만들어
							// 레이트리밋(429) 백오프가 누적되는 원인이 됐다 (파일 상단 4차 수정 주석 참고).
							const results = await mapWithConcurrency(activeRegistrations, 2, async (reg: any) => {
								try {
									return await distributeForRegistration(reg.id, reg)
								} catch (err) {
									return {
										status: "error" as const,
										message: (err as Error)?.message ?? String(err),
										registrationId: reg.id,
									}
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
								total: activeRegistrations.length,
								distributed: distributedCount,
								errors: errorCount,
							})
						} catch (err) {
							console.error("[sync-textbook-distribution] (background) from-class ERROR:", err)
							await setClassStatus(pageId, "오류", (err as Error)?.message ?? String(err))
						}
					},
					() =>
						setClassStatus(
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
