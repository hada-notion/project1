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
// 교재배부 페이지를 교재당 1건씨 여러 개 만든다 (교재비의 "정규교재" 관계는 1건만 가리쾤맀다는 가정).
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
// (2026-09-17, 1~4차 수정 이력) 반복적으로 "교재배부 처리중"이 90초+가 지나도 자동으로 안 풀리는
// 문제가 반복 재현되었다. 이 과정에서: 등록 건당 중복 조회 제거(1차), 동시성 3->5 증가(2차), 재클릭
// 즉시 락 해제(3차), 안전 타임아웃과 동시성 5->2 축소 + getScheduleConfig 캐시(4차)를 차례로 적용했는데도,
// 여전히 학생 몇 명짜리(중등 과외, 6명)도 타임아웃을 거치는 사례가 나왔다.
//
// (2026-09-17, 5차 수정 -- 근본원인) 같은 "버튼+체크박스 처리중 표시" 패턴을 쓰는 클래스 단위 배치
// 함수 generate-tuition(수강료 생성)/generate-report(보고서 생성)는 한 번도 이런 문제가 없었다.
// 둘을 직접 비교해보니 이 함수만 가지고 있던 두 가지 구조적 차이가 진짜 원인이었다:
//   1) 활성 등록 조회 방식 -- generate-tuition/report는 getActiveRegistrationsForClass로 등록(학원)
//      DB를 "클래스 relation contains classId + 등록일/종료일 날짜 필터"로 단 한 번의 조회(POST
//      /query, 커서 페이지네이션)만으로 필요한 페이지를 다 가져온다. 이 함수는 이전까지 클래스
//      페이지의 "등록" relation 목록(수십 건)을 먼저 가져온 뒤, 활성 여부를 판단하기 위해 등록
//      하나당 GET /pages/{id}를 개별적으로 호출했다 -- 즉 반 하나만 처리해도 이 필터링
//      단계에서만 등록 수만큼 불필요한 API 호출이 생겼다 (고정적으로 거치는 다른 함수들에는
//      아예 없던 단계).
//   2) 동시성 -- generate-tuition/report는 등록 단위로도, 등록 내부에서도 단순 for루프로
//      순차 처리한다 (중복정리용 archivePage만 예외적으로 가끔마 발생하는 드물 경로에서 mapWithConcurrency를
//      쓄다). 이 함수는 등록 단위 동시성(1차에서 5, 4차에서 2)와 등록 내부 조회/생성(4차에서 2)을
//      동시에 둘 다 쓰고 있어서, 순간적으로 다른 함수들보다 훨씬 많은 Notion API 요청이 동시에
//      나갔다.
// 즉 "왜 다른 버튼+체크박스 조합은 다 잘 되는데 이것만 안되느냐"에 대한 답은, 이 함수만 유일하게
// (a) 불필요한 개별 조회를 대량으로 하고 (b) 여러 단계에서 동시에 여러 Notion API를 불러서이다.
// 이번 5차 수정은 1~4차처럼 증상을 더 줄이는 대신, generate-tuition/report와 동일한 구조(단일 필터
// 조회 + 완전 순차 처리)로 근본적으로 맞추는 것이다:
//   - from-class가 이제 클래스 페이지를 따로 읽지 않고, 등록(학원) DB를 "클래스 relation contains
//     pageId + 등록일/종료일 날짜 조건"으로 단 한 번에 조회해서 활성 등록 전체(이미 전체 속성을
//     포함한 페이지)를 한번에 가져온다 -- 이전처럼 등록마다 따로 GET을 다시 보낼 필요가 없다.
//   - 그 결과를 distributeForRegistration에 preFetchedRegistration으로 그대로 넘기며, 등록들을 단순
//     for루프로 순차 처리한다 (mapWithConcurrency 제거).
//   - 각 등록 내부의 진도교재 조회/정규교재 조회/교재배부 생성도 모두 단순 for루프로 바꿔서,
//     이 함수가 만드는 순간 동시 Notion API 호출 수가 generate-tuition/report와 같은 수준이 되도록 했다.
// BATCH_TIMEOUT_MS/CLICK_UNLOCK_GRACE_MS(3차 수정)는 만일의 대비책(defense-in-depth)으로 그대로 남겨둔다 --
// 이제는 처리 자체가 획기적으로 가벼워졌으니 정상 상황에서는 거의 발동할 일이 없을 것으로 기대한다.
//
// (2026-09-17, 6차 수정) _shared/notionClient.ts의 setCombinedSyncStatus가 마지막에 체크박스를 다시
// 꺼주는 쓰기 한 번을 재시도(3회)하고, 그래도 실패하면 최소한 로그를 남기도록 고쳤다 (이전에는
// try/catch{}로 완전히 조용히 무시해서 실패 사실 자체를 알 수 없었다).
//
// (2026-09-17, 7차 수정) 6차 수정 이후에도, 실제 처리(교재비/교재배부 생성)는 다 끝났는데 마지막
// 체크박스 끄기 쓰기가 재시도를 전부 실패해서 "교재배부 처리중"이 계속 켜진 채로 남는 사례가 다시
// 재현됐다 (반 하나 배부가 금방 끝났는데도 체크박스만 그대로). 두 가지로 보강한다:
//   1) notionClient.ts의 updateStatusWithRetry 재시도 횟수를 3->5회로, 대기 시간도 늘려서 일시적인
//      네트워크 문제가 조금 더 오래 가도 견딜 수 있게 한다.
//   2) from-class에서 "처리중"이 CLICK_UNLOCK_GRACE_MS보다 오래 켜져 있는 걸 재클릭으로 감지했을 때,
//      곧바로 "오류"로 풀기 전에 먼저 실제 데이터를 다시 조회해서 -- 그 반의 활성 등록 전체에 아직
//      새로 담을 정규교재가 남아있는지 -- 계산으로 확인한다(isClassDistributionComplete). 이미 다
//      끝나 있었다면(체크박스 끄기 쓰기만 실패한 경우) 그 자리에서 곧바로 "완료"로 정확하게 표시하고,
//      아직 남은 게 있을 때만 "오류"로 풀고 재시도를 안내한다. 체크박스라는 단일 신호에만 의존하지
//      않고 실제 데이터로 완료 여부를 다시 계산해서, 몇 번을 다시 눌러야 하는지와 무관하게 정확한
//      상태를 보여준다.
//
// 라우트:
//   POST /sync-textbook-distribution/from-cart   <- 교재비(학원) DB "진도교재 담기" 버튼 (학생 1명)
//   POST /sync-textbook-distribution/from-class  <- 클래스(학원) DB "교재 일괄 배부" 버튼 (반 전체 활성 등록)

import { PROP_LAST_ERROR, PROP_SYNCED_AT, PROP_ENROLL_DATE, PROP_END_DATE, PROP_CLASS, DS_REGISTRATION } from "../_shared/constants.ts"
import {
	getPage,
	createPage,
	queryAllPages,
	relIds,
	relationIds,
	statusName,
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
// 시도할 수 있게 한다. [2026-09-17, 5차 수정] 처리 자체가 단일 필터 조회 + 순차 처리로 바뀌면서
// 이제는 거의 발동할 일이 없을 만큼 충분한 여유이지만, 만일의 경우를 대비해 120초로 그대로 둔다.
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

// [2026-09-17, NEW] 백그라운드 배치 작업이 예상 밖으로 오래 걸리면 사용자가 "처리중" 표시만 보며 무한정
// 기다리지 않도록, 정해진 시간 안에 못 끝나면 즉시 오류 상태로 바꿔서 알려주고 락도 풀어준다
// (재클릭하면 바로 다시 시도 가능). 원본 작업 자체는 자바스크립트 특성상 취소할 수 없어
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

// 등록 하나에 대해: 아직 담기지 않은 "진행 중" 진도교재를 모아, 교재(정규교재)당 교재배부를 개별로 생성한다.
// 장바구니(교재비 페이지)가 없으면 이 시점에 자동으로 만든다 (하나만 존재, 사용자 설계대로).
// [2026-09-17, 5차 수정] 이전에는 preFetchedRegistration이 있어도 이미 안에서마 여러 굴 mapWithConcurrency로
// 진도교재/정규교재를 동시 조회하고 있었다. generate-tuition/report와 동일하게 단순 for루프로 순차
// 처리하도록 바꿔서, 이 함수 하나가 만드는 순간 동시 Notion API 호출 수를 최소화했다 (파일 상단
// 5차 수정 주석 참고).
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

	// [2026-09-17, 5차 수정] mapWithConcurrency 제거 -> 단순 for루프로 순차 조회 (파일 상단 5차 수정 주석 참고).
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

	// 교재배부 1건 = 정규교재 1개. 새로 담을 정규교재가 여러 개여맞이다면, 개별 교재배부 페이지를 거 수만큼 따로 만든다.
	// [2026-09-17, 5차 수정] mapWithConcurrency 제거 -> 단순 for루프로 순차 조회/생성 (파일 상단 5차 수정 주석 참고).
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

// [2026-09-17, 5차 수정] 클래스 페이지의 "등록" relation 목록을 가져와 개별 getPage로 필터링하던 이전 방식 대신,
// generate-tuition/report(getActiveRegistrationsForClass)와 동일한 방식으로 등록(학원) DB를 단 한 번의 필터 조회(POST
// /query, 커서 페이지네이션 포함)로 놓아 활성 등록의 전체 페이지를 한번에 가져온다 (클래스 페이지 자체도
// 따로 읽을 필요가 없어진다). 필터 조건은 이전 isActiveRegistration과 동일하다: 등록일 <= 오늘 <= 종료일
// (종료일 없으면 계속 활성). queryAllPages가 반환하는 건 이미 전체 속성을 포함한 페이지이므로,
// distributeForRegistration의 preFetchedRegistration으로 그대로 재사용한다 (등록당 별도 GET 없음).
async function getActiveRegistrationsForClassToday(classId: string, todayStr: string): Promise<any[]> {
	return await queryAllPages(DS_REGISTRATION, {
		and: [
			{ property: PROP_CLASS, relation: { contains: classId } },
			{ property: PROP_ENROLL_DATE, date: { on_or_before: todayStr } },
			{
				or: [
					{ property: PROP_END_DATE, date: { is_empty: true } },
					{ property: PROP_END_DATE, date: { on_or_after: todayStr } },
				],
			},
		],
	})
}

// [2026-09-17, 7차 수정] distributeForRegistration과 판정 로직(진행 중인 진도교재 -> 정규교재 추출 ->
// 기존 교재배부와 비교)은 동일하게 맞추되, 아무 것도 만들지 않고 "아직 새로 담을 정규교재가
// 남아있는지"만 계산해서 반환한다 (읽기 전용). 재클릭으로 멈춘 락을 감지했을 때, 실제로 이미 다
// 끝나 있는지 재계산하기 위해 사용한다.
async function hasPendingDistribution(registrationId: string, preFetchedRegistration?: any): Promise<boolean> {
	const registration = preFetchedRegistration ?? (await getPage(registrationId))
	const progressBookIds = relationIds(registration, PROP_REGISTRATION_BOOKS)
	if (progressBookIds.length === 0) return false

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
	if (eligibleBookIds.size === 0) return false

	const existingDistributions = await queryAllPages(DATA_SOURCE_TEXTBOOK_DISTRIBUTION, {
		property: PROP_DIST_REGISTRATION,
		relation: { contains: registrationId },
	})
	const billedBookIds = new Set<string>()
	for (const dist of existingDistributions) {
		for (const id of relIds(dist.properties[PROP_DIST_REGULAR_BOOK])) billedBookIds.add(id)
	}
	return [...eligibleBookIds].some((id) => !billedBookIds.has(id))
}

// [2026-09-17, 7차 수정] 그 반의 활성 등록 전체를 순회하며, 아직 새로 담을 정규교재가 남은 등록이
// 하나도 없으면 "이미 완료"로 판정한다. 재클릭 시 멈춘 락을 그냥 "오류"로 풀기 전에, 실제로는 이미
// 다 끝나 있었던 것인지 먼저 계산으로 확인하기 위해 사용한다.
async function isClassDistributionComplete(classId: string, todayStr: string): Promise<boolean> {
	const activeRegistrations = await getActiveRegistrationsForClassToday(classId, todayStr)
	for (const reg of activeRegistrations) {
		if (await hasPendingDistribution(reg.id, reg)) return false
	}
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
			// 곧바로 락을 풀고 "다시 시도해 주세요" 안내를 남긴다 (2026-09-17, 3차 수정).
			const classForLock = await getPage(pageId)
			const isBatchRunning = checkboxValue(classForLock, PROP_CLASS_TEXTBOOK_BATCH_RUNNING)
			const batchStartedAt = classForLock.properties?.[PROP_CLASS_TEXTBOOK_BATCH_STARTED_AT]?.date?.start ?? null
			const lockAgeMs = batchStartedAt ? Date.now() - new Date(batchStartedAt).getTime() : Infinity
			if (isBatchRunning) {
				if (lockAgeMs < CLICK_UNLOCK_GRACE_MS) {
					// 방금(그레이스 기간 이내) 시작된 정상 실행 중일 가능성이 높으므로 그대로 둔다 (연타 보호).
					return new Response(JSON.stringify({ ok: true, message: "already_processing", pageId, route }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					})
				}
				// [2026-09-17, 7차 수정] 그레이스 기간이 지난 뒤에도 "처리중"이면, 예전처럼 곧바로 "오류"로
				// 풀지 않고 먼저 실제 데이터로 이미 다 끝나 있는지 다시 계산한다. 실제 처리는 다 끝났는데
				// 마지막 체크박스 끄기 쓰기만 실패해서 멈춘 것처럼 보이는 경우, 재클릭 한 번으로 곧바로
				// "완료"까지 정확하게 표시한다.
				const today = todaySeoulDate()
				let alreadyComplete = false
				try {
					alreadyComplete = await isClassDistributionComplete(pageId, today)
				} catch (err) {
					console.error("[sync-textbook-distribution] stale-lock completeness check failed:", err)
				}
				if (alreadyComplete) {
					await setClassStatus(pageId, "완료")
					return new Response(JSON.stringify({ ok: true, message: "recovered_as_completed", pageId, route }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					})
				}
				// 아직 남은 게 있으면, 재클릭 자체를 "멈춘 것 같다"는 신호로 보고 곧바로 락을 풀고
				// 안내를 남긴다. 다음 클릭에서 정상적으로 새로 시작된다.
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
							const today = todaySeoulDate()
							// [2026-09-17, 5차 수정] 단 한 번의 필터 조회로 활성 등록의 전체 페이지를 바로 가져온다
							// (클래스 페이지 재조회/등록별 개별 getPage 모두 불필요 -- 파일 상단 5차 수정 주석 참고).
							const activeRegistrations = await getActiveRegistrationsForClassToday(pageId, today)

							// [2026-09-17, 5차 수정] mapWithConcurrency 제거 -> 단순 for루프로 순차 처리 (generate-tuition/report와
							// 동일한 구조). 이제 반 하나를 처리하는 동안 순간 동시 Notion API 호출이 항상 1건만
							// 나가게 되어 레이트리밋(429) 백오프 누적 자체가 구조적으로 불가능해진다.
							const results: any[] = []
							for (const reg of activeRegistrations) {
								try {
									results.push(await distributeForRegistration(reg.id, reg))
								} catch (err) {
									results.push({
										status: "error" as const,
										message: (err as Error)?.message ?? String(err),
										registrationId: reg.id,
									})
								}
							}
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
