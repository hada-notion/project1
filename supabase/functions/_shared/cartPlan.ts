// _shared/cartPlan.ts
//
// (v2.6.26) 교재비 [진도교재 담기]를 큐로, 서버는 교재배부 만들기만. 무엇을 담을지는 교재비 수식 "담기 계획"이 계산한다:
//   {"v":1,"r":"등록","items":[{"l":"라이브러리 교재","t":"교재명"}]}
//   = 등록의 진도교재 중 "진행 중"인 교재의 라이브러리 교재 가운데 이 교재비에 아직 배부되지 않은 것.
// 서버가 하던 등록 읽기·진도교재 한 권씩 읽기·라이브러리 교재 한 권씩 읽기(제목)가 없어지고 배부 만들기만 남는다.
// 두 번 만들기 막기: 만들기 전에 이 등록의 교재배부를 한 번 조회해 이미 배부된 라이브러리 교재는 건너뛴다
// (예전 서버 규칙과 같다 — 다른 교재비에 배부된 것도 건너뜀). 버튼을 두 번 눌러도, 큐가 다시 시도해도 한 권씩만.
import { createPage, getPage, mapWithConcurrency, queryAllPages, todaySeoulDate, updatePageProperties } from "./notionClient.ts"
import { LIBRARY_PROP, libraryIds, libraryPropOf } from "./libraryProp.ts"
import { PROP_LAST_ERROR, PROP_SYNCED_AT } from "./constants.ts"
import { CART_STATUS_SPEC, distributeFromCartPage } from "./textbookDistributionTarget.ts"
import { markError } from "./statusTracking.ts"

export const CART_PLAN_PROP = "담기 계획"
const DS_DISTRIBUTION = () => Deno.env.get("DATA_SOURCE_TEXTBOOK_DISTRIBUTION_ID")!

export type CartPlan = { reg: string; items: { lib: string; title: string }[] }

const ID = /^[0-9a-f]{32}$/
const cleanId = (v: unknown): string | null => {
	const s = String(v ?? "").replace(/-/g, "").toLowerCase()
	return ID.test(s) ? s : null
}
const key = (id: string) => id.replace(/-/g, "").toLowerCase()

// 수식 값이 아니면(속성이 없거나 JSON이 아니면) null. 형식이 틀리면 Error(만들지 않고 ⚠️ 오류).
export function cartPlanFromText(text: unknown): CartPlan | null {
	if (typeof text !== "string" || !text.trim()) return null
	let raw: any
	try { raw = JSON.parse(text) } catch { return null }
	if (!raw || raw.v !== 1) return null
	const reg = cleanId(raw.r)
	if (!reg) throw new Error("교재비에 연결된 등록이 없습니다.")
	if (!Array.isArray(raw.items)) throw new Error("담기 계획에 items가 없습니다.")
	const items: CartPlan["items"] = []
	for (const it of raw.items) {
		const lib = cleanId(it?.l)
		if (!lib) throw new Error("담기 계획의 라이브러리 교재 값이 올바르지 않습니다.")
		items.push({ lib, title: String(it?.t ?? "").trim() || `${todaySeoulDate()} 교재 배부` })
	}
	return { reg, items }
}

export const cartPlanText = (p: any): string => (p?.type === "formula" || p?.formula ? String(p.formula?.string ?? "") : "")

export const cartPlanDeps = {
	getPage,
	createPage,
	queryAllPages,
	update: updatePageProperties,
	libraryProp: libraryPropOf,
	markError: (id: string, message: string) => markError(id, CART_STATUS_SPEC, message),
	legacy: distributeFromCartPage,
	today: todaySeoulDate,
}

export async function processCartPlanQueueItem(payload: { cartId: string; plan?: string | null }): Promise<void> {
	const deps = cartPlanDeps
	const cartId = payload.cartId
	let plan: CartPlan | null
	try {
		let text = payload.plan ?? ""
		if (!text || !cartPlanFromText(text)) {
			// 본문에 값이 없거나 읽을 수 없으면 교재비를 한 번 읽어 수식 값을 다시 받는다.
			const cart = await deps.getPage(cartId)
			if (cart?.archived || cart?.in_trash) return
			text = cartPlanText(cart?.properties?.[CART_PLAN_PROP])
		}
		plan = cartPlanFromText(text)
	} catch (err) {
		await deps.markError(cartId, (err as Error).message).catch(() => {})
		return
	}
	// 수식을 아직 안 넣은 운영 → 예전 방식(서버가 등록·진도교재를 읽어 담는다).
	if (!plan) {
		try {
			await deps.legacy(cartId)
			await deps.update(cartId, { [CART_STATUS_SPEC.statusProp]: { select: { name: "✅ 완료" } }, [PROP_LAST_ERROR]: { rich_text: [] } })
		} catch (err) {
			await deps.markError(cartId, (err as Error).message).catch(() => {})
			throw err
		}
		return
	}

	try {
		let made = 0
		if (plan.items.length) {
			const existing = await deps.queryAllPages(DS_DISTRIBUTION(), { property: "등록", relation: { contains: plan.reg } })
			const billed = new Set(existing.flatMap((d: any) => libraryIds(d)).map(key))
			const todo = plan.items.filter((it) => !billed.has(it.lib))
			if (todo.length) {
				const libProp = await deps.libraryProp(DS_DISTRIBUTION()).catch(() => LIBRARY_PROP)
				await mapWithConcurrency(todo, 3, (it) => deps.createPage(DS_DISTRIBUTION(), {
					이름: { title: [{ text: { content: it.title } }] },
					등록: { relation: [{ id: plan!.reg }] },
					[libProp]: { relation: [{ id: it.lib }] },
					배부일: { date: { start: deps.today() } },
					교재비: { relation: [{ id: cartId }] },
				}))
				made = todo.length
			}
		}
		await deps.update(cartId, {
			[CART_STATUS_SPEC.statusProp]: { select: { name: "✅ 완료" } },
			[PROP_LAST_ERROR]: { rich_text: [] },
			[PROP_SYNCED_AT]: { date: { start: new Date().toISOString() } },
		})
		console.log(`[cart-plan] ${cartId}: 배부 ${made}권, 계획 ${plan.items.length}권`)
	} catch (err) {
		// 큐가 다시 시도한다. 다시 할 때도 위 조회로 이미 만든 교재는 건너뛴다.
		await deps.markError(cartId, (err as Error).message).catch(() => {})
		throw err
	}
}
