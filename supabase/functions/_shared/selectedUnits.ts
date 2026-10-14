// _shared/selectedUnits.ts
//
// 학습기록 "선택 단원"(v2.5.126): 수업 관리에서 기록을 만들거나 고칠 때 고른 단원(학습기록 → 단원목록 관계).
// 학습기록의 "단원"은 Notion 수식(범위로 계산)이라 그대로 두고, 고른 단원이 있으면 수업 관리·리포트가 그 단원 이름을 먼저 쓴다.
// 이 관계 속성이 없는 학원(아직 Notion에 추가하지 않음)은 지금처럼 "단원" 수식만 쓰고, 단원을 골라도 저장하지 않는다.

import { DS_LEARNING_RECORD, NOTION_API } from "./constants.ts"
import { fetchWithRetry, notionHeaders, getPage, mapWithConcurrency, anyTitleText } from "./notionClient.ts"
import { relationIds, text } from "./reportCacheShared.ts"
import { libraryCopyReady, readUnitsByIds } from "./libraryCopy.ts"

type Page = Record<string, any>
export const SELECTED_UNITS = "선택 단원"
const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{32,36}$/i.test(v)

// 학습기록 DB에 "선택 단원" 관계가 있는지(함수 인스턴스마다 10분 기억).
let enabledCache: { at: number; ok: boolean } | null = null
export async function selectedUnitsEnabled(): Promise<boolean> {
	if (enabledCache && Date.now() - enabledCache.at < 600_000) return enabledCache.ok
	let ok = false
	try {
		const res = await fetchWithRetry(`${NOTION_API}/data_sources/${DS_LEARNING_RECORD}`, { headers: notionHeaders() }, 2)
		ok = res.ok && (await res.json())?.properties?.[SELECTED_UNITS]?.type === "relation"
	} catch { ok = false }
	enabledCache = { at: Date.now(), ok }
	return ok
}
export function resetSelectedUnitsEnabled() { enabledCache = null }

// 보낸 값이 배열이 아니면 null(바꾸지 않음), 배열이면 페이지 id만 60개까지(같은 id는 한 번).
export function cleanUnitIds(v: unknown): string[] | null {
	if (!Array.isArray(v)) return null
	return [...new Set(v.filter(isId))].slice(0, 60)
}

// 기록들의 고른 단원 id → 이름. 라이브러리 복사본에서 먼저, 없으면 Notion 페이지 제목.
export async function unitNamesOf(records: Page[]): Promise<Map<string, string>> {
	const ids = [...new Set(records.flatMap((r) => relationIds(r?.properties?.[SELECTED_UNITS])))]
	const names = new Map<string, string>()
	if (!ids.length) return names
	if (await libraryCopyReady()) {
		try { for (const u of await readUnitsByIds(ids)) names.set(u.id, u.name) } catch (err) { console.error("[selectedUnits] 복사본 읽기 실패(Notion을 읽음):", (err as Error).message) }
	}
	const missing = ids.filter((id) => !names.has(id))
	await mapWithConcurrency(missing, 4, async (id: string) => {
		try { const p = await getPage(id) as Page; if (!p.archived && !p.in_trash) names.set(id, anyTitleText(p)) } catch { /* 지운 단원은 건너뜀 */ }
	})
	return names
}

// 기록 한 건의 단원 글자: 고른 단원이 있으면 그 이름들(" "로 이어 붙임 — 화면은 "1-1." 앞에서 나눈다), 없으면 "단원" 수식.
export function unitTextOf(record: Page, names: Map<string, string>): string {
	const picked = relationIds(record?.properties?.[SELECTED_UNITS]).map((id) => names.get(id)).filter(Boolean)
	return picked.length ? picked.join(" ") : text(record?.properties?.["단원"]).trim()
}
export const unitIdsOf = (record: Page): string[] => relationIds(record?.properties?.[SELECTED_UNITS])
