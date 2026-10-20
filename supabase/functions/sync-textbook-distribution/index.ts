import { authorizeKey, securityEnabled } from "../_shared/adminSecurity.ts"
// sync-textbook-distribution
//
// 교재비 기능(로드맵 5-37): 진도교재 담기(교재배부 생성) + 필요 시 교재비(카트) 자동 생성.
// 결제(교재배부 "결제" 버튼 → 미납/결제완료 전환)는 기존 Notion 자동화를 그대로 사용하며 이 함수는 관여하지 않는다.
//
// (아래 2026-09-16 ~ 2026-09-21 사이의 배경 설명은 이전과 동일하게 유지 — from-class-carts 라우트의
// 히스토리, 웹훅 주소 오류/체크박스 고착 수정 경위, 관리자 키 인증 도입 등.)
//
// (2026-09-16) 교재비(카트) 페이지를 새로 만들 때 "알림톡 설정" 관계(표시 전용)도 함께 채운다.
//
// (2026-09-17) from-class(반 전체 일괄 배부)는 구조적 한계로 포기했고, 그 대신 반 전체 "교재비"
// 일괄 생성만 하는 from-class-carts를 다시 도입했다. 실제 교재 배부(청구)는 여전히 교재비 페이지의
// "진도교재 담기" 버튼(from-cart)으로 학생별로 개별 진행한다.
//
// (2026-09-18, 큐 기반 순차 처리 도입, Phase 2) 실제 담기/생성 로직은 _shared/textbookDistributionTarget.ts로
// 옮겼다.
//
// (2026-09-20, 웹훅 코드 정리 3단계) from-cart 라우트의 "잠금 확인 -> 처리중 표시 -> 큐 적재 -> 202
// 응답" 부분만 _shared/webhookIngest.ts의 runLockedQueueWebhookForPage로 옮겼다. from-class-carts
// 라우트는 실행 전에 실제 데이터(활성 등록 중 교재비 누락 여부)부터 계산해서 즉시완료/이어서진행을
// 판단하는 고유 로직이 있어 공용 헬퍼로 단순화하지 않고 그대로 뒀다.
//
// (2026-09-21, PART N-2) 두 라우트 모두에 관리자 키 인증을 추가한다. 교재비(학원) DB "진도교재 담기"
// (from-cart)와 클래스(학원) DB "교재비 생성"(from-class-carts) 버튼 자동화에 이미 x-admin-key
// 헤더를 추가해두었다. route 분기 전에 공통으로 한 번만 검사한다.
//
// (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환) from-cart는 교재비 페이지 1건만 대상으로
// 하는 개별 트리거라 sync_queue를 거칠 필요가 없다. runLockedQueueWebhookForPage(큐 적재) 대신
// runSyncWebhookForPage를 써서 버튼 클릭과 동시에 끝나도록 한다. from-class-carts는 반 전체(여러
// 등록)를 대상으로 하는 명시적인 일괄 버튼이라 계속 큐를 쓴다 (변경 없음).
//
// 라우트 (v2.7.11부터 이것 하나):
//   POST /sync-textbook-distribution/from-cart/queue   <- 교재비(학원) DB "진도교재 담기" 버튼 (수식 "담기 계획"대로 큐가 교재배부만 만든다)

import { extractPageId, describeBody } from "../_shared/notionClient.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
import { resolveAdminKeyFromRequest, getCurrentAdminKey } from "../_shared/adminShared.ts"
import { CART_PLAN_PROP, cartPlanText } from "../_shared/cartPlan.ts"

Deno.serve(async (req: Request) => {
	const url = new URL(req.url)
	// (2026-09-17) 트레일링 슬래시가 붙어오면 기존 split("/").pop()은 빈 문자열을 반환했다 --
	// filter(Boolean)으로 빈 조각을 걸러내서 트레일링 슬래시가 있어도 라우트가 정확히 잡히도록 한다.
	const route = url.pathname.split("/").filter(Boolean).pop()
	const rawBodyText = await req.text()
	let body: unknown = {}
	try {
		body = rawBodyText ? JSON.parse(rawBodyText) : {}
	} catch {
		// 빈 바디 허용하지 않음 - 아래에서 pageId 누락으로 에러 처리
	}
	console.log("sync-textbook-distribution request:", route, describeBody(body))

	const adminKey = resolveAdminKeyFromRequest(req, body)
	const currentAdminKey = securityEnabled() ? "" : await getCurrentAdminKey()
	if (!adminKey || !await authorizeKey(req, adminKey, currentAdminKey)) {
		return new Response(JSON.stringify({ error: "unauthorized" }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		})
	}

	const pageId = extractPageId(body)

	if (!pageId) {
		return new Response(JSON.stringify({ error: "pageId를 찾을 수 없음" }), { status: 400 })
	}

	try {
		// (v2.6.26) 교재비 [진도교재 담기] → /from-cart/queue. 큐에 넣고 바로 202. 본문의 수식 "담기 계획"대로
		// process-sync-queue가 교재배부만 만든다(_shared/cartPlan.ts). 본문에 값이 없으면 큐가 교재비를 한 번 읽는다.
		if (route === "queue" && url.pathname.split("/").filter(Boolean).slice(-2)[0] === "from-cart") {
			const plan = cartPlanText((body as any)?.data?.properties?.[CART_PLAN_PROP]) || null
			await enqueueSync("cart-plan", { cartId: pageId, plan })
			wakeSyncQueueWorker()
			return respondAccepted({ pageId, route: "from-cart/queue", plan: !!plan })
		}
		// (v2.7.11) 예전 /from-cart(바로 처리)·/from-class-carts(반 전체 교재비) 경로는 지웠다. 버튼이 v2.7부터
		// 큐 경로와 Notion 자동화만 쓴다.
		return new Response(JSON.stringify({ error: `알 수 없는 경로: ${route}` }), { status: 404 })
	} catch (err) {
		console.error(err)
		return new Response(JSON.stringify({ error: String(err) }), { status: 400 })
	}
})