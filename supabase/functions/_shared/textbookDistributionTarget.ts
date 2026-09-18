// _shared/textbookDistributionTarget.ts
//
// sync-textbook-distribution가 처리하는 실제 장바건지/교재배부 생성 로직을 별도 파일로 분리했다
// (2026-09-18, 큐 기반 순차 처리 도입, Phase 2). 원래 index.ts 안에 있던 코드를 그대로 옮긴 것이다.
// webhook payload 파싱/람다 route 분기/디버깅 로깅(logDebugWebhookCall)은 index.ts에 그대로 둔다.
//
// (2026-09-18) 기존 runWithSafetyTimeout(개별 Edge Function 실행이 응답 없이 실패할 수 있으니 정해진
// 시간 안에 스스로 오류 처리하는 안전장식)는 큐 숿으로 이전하지 앞눈다. 큐에 쓸이건 작업은 sync_queue
// 헉에 영속적으로 농이있어서(함수 실행이 중단되어도 다시 집어지지 않습), 응답을 바로 되맔면서
// 실패로 감지해 되늄렱해야하는 근거 자신이 사라졌다.

import { PROP_LAST_ERROR, PROP_SYNCED_AT, DS_REGISTRATION, PROP_CLASS, PROP_STATUS } from "./constants.ts"
import {
	getPage,
	createPage,
	queryAllPages,
	relIds,
	relationIds,
	statusName,
	formulaString,
	anyTitleText,
	todaySeoulDate,
} from "./notionClient.ts"
import { makeSyncStatusSetter } from "./registrationSync.ts"
import { makeClassStatusSetter } from "./generateShared.ts"
import { getScheduleConfig } from "./adminShared.ts"

const DATA_SOURCE_TEXTBOOK_CART = Deno.env.get("DATA_SOURCE_TEXTBOOK_CART_ID")! // 교재비(학원) DB
const DATA_SOURCE_TEXTBOOK_DISTRIBUTION = Deno.env.get("DATA_SOURCE_TEXTBOOK_DISTRIBUTION_ID")! // 교재배부(학원) DB

export const PROP_CART_TITLE = "이름"
export const PROP_CART_REGISTRATION = "등록"
export const PROP_CART_RUNNING = "담기 처리중"

const PROP_DIST_TITLE = "이름"
const PROP_DIST_REGISTRATION = "등록"
const PROP_DIST_REGULAR_BOOK = "정규교재"
const PROP_DIST_DATE = "배부일"
const PROP_DIST_CART = "교재비"

const PROP_PROGRESS_STATUS = "진행상태"
const PROP_REGULAR_BOOK_ON_PROGRESS = "정규교재"
const STATUS_ELIGIBLE = "진행 중"

const PROP_REGISTRATION_BOOKS = "진도교재"
const PROP_REGISTRATION_CART = "교재비"
const STATUS_ACTIVE = "🟢 수강 중"

export const PROP_CLASS_CART_RUNNING = "교재비 생성중"

export const setCartStatus = makeSyncStatusSetter(PROP_CART_RUNNING, [])
export const setClassCartStatus = makeClassStatusSetter(PROP_CLASS_CART_RUNNING)

// 등록 하나에 대해 교재비(장바구니) 페이지를 확보한다: 이밀 있으맔 재사용, 없으맔 생성한다.
export async function ensureCartForRegistration(
	registrationId: string,
	preFetchedRegistration?: any,
): Promise<{ cartId: string; cartCreated: boolean }> {
	const registration = preFetchedRegistration ?? (await getPage(registrationId))
	const existingCartIds = relationIds(registration, PROP_REGISTRATION_CART)
	if (existingCartIds.length > 0) {
		return { cartId: existingCartIds[0], cartCreated: false }
	}
	const studentName = anyTitleText(registration) || "학생"
	const textbookConfig = await getScheduleConfig("교재비 안내")
	const cart = await createPage(DATA_SOURCE_TEXTBOOK_CART, {
		[PROP_CART_TITLE]: { title: [{ text: { content: `${studentName} 교재비` } }] },
		[PROP_CART_REGISTRATION]: { relation: [{ id: registrationId }] },
		...(textbookConfig ? { "알림톡 설정": { relation: [{ id: textbookConfig.rowId }] } } : {}),
	})
	return { cartId: cart.id, cartCreated: true }
}

// 등록 하나에 대해: 아직 담기지 않은 "진행 중" 진도교재를 모아, 교재(정규교재)당 교재배부를 개뱌로 생성한다.
export async function distributeForRegistration(
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

	const { cartId, cartCreated } = await ensureCartForRegistration(registrationId, registration)

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

export async function getActiveRegistrationsForCarts(classId: string): Promise<any[]> {
	const registrations = await queryAllPages(DS_REGISTRATION, {
		property: PROP_CLASS,
		relation: { contains: classId },
	})
	return registrations.filter((reg: any) => formulaString(reg, PROP_STATUS) === STATUS_ACTIVE)
}

// process-sync-queue 워커가 target: "sync-textbook-distribution:from-cart" 작업을 처리할 때 호출하는 진입점.
export async function processFromCartQueueItem(payload: { cartId: string }): Promise<void> {
	try {
		const cart = await getPage(payload.cartId)
		const registrationIds = relationIds(cart, PROP_CART_REGISTRATION)
		if (registrationIds.length === 0) throw new Error("교재비 페이지에 연결된 등록이 없음")
		const result = await distributeForRegistration(registrationIds[0])
		await setCartStatus(payload.cartId, "완료")
		console.log("[sync-textbook-distribution] (queue) from-cart finished:", payload.cartId, result)
	} catch (err) {
		console.error("[sync-textbook-distribution] (queue) from-cart ERROR:", err)
		await setCartStatus(payload.cartId, "오류", (err as Error)?.message ?? String(err))
		throw err
	}
}

// process-sync-queue 워커가 target: "sync-textbook-distribution:from-class-carts" 작업을 처리할 때 호출하는 진입점.
// 대상 등록 목록은 대기열에 쉬는 동안 바눐을 수 있으니 index.ts의 사전 확인에서 재사용하지 않고 실행 시점에 다시 조회한다.
export async function processFromClassCartsQueueItem(payload: { classId: string }): Promise<void> {
	try {
		const activeRegistrations = await getActiveRegistrationsForCarts(payload.classId)
		let createdCount = 0
		for (const reg of activeRegistrations) {
			const result = await ensureCartForRegistration(reg.id, reg)
			if (result.cartCreated) createdCount++
		}
		await setClassCartStatus(payload.classId, "완료")
		console.log("[sync-textbook-distribution] (queue) from-class-carts finished:", payload.classId, {
			activeCount: activeRegistrations.length,
			createdCount,
		})
	} catch (err) {
		console.error("[sync-textbook-distribution] (queue) from-class-carts ERROR:", err)
		await setClassCartStatus(payload.classId, "오류", (err as Error)?.message ?? String(err))
		throw err
	}
}
