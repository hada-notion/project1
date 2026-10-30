// _shared/selectedUnits.ts
//
// 학습기록의 단원(v2.5.126~127): 학습기록 → 단원목록 관계로 고른 단원.
//   - 관계 속성 이름은 "단원"(최종) 또는 "선택 단원"(v2.5.126에서 처음 추가한 이름)이다. 관계인 쪽을 쓴다.
//   - 고른 단원이 있으면 수업 관리·리포트가 그 단원 이름을 쓰고, 없으면 예전 "단원" 수식(이름을 "단원(수식)"으로 바꿔 둔 경우 포함)을 쓴다.
//   - 관계 속성이 없는 학원은 지금처럼 수식만 쓰고, 단원을 골라도 저장하지 않는다.
//   - [단원 입력] 버튼(fill-record-units, v2.5.127): 그때의 범위로 단원을 새로 채운다(덮어쓰기).

import { DS_LEARNING_RECORD, NOTION_API } from "./constants.ts"
import { fetchWithRetry, notionHeaders, getPage, mapWithConcurrency, anyTitleText, queryAllPages, updatePageProperties } from "./notionClient.ts"
import { relationIds, text } from "./reportCacheShared.ts"
import { libraryCopyReady, readUnits, readUnitsByIds, sortUnits, type LibrarySources } from "./libraryCopy.ts"
import { unitsForRange } from "./unitRange.ts"

type Page = Record<string, any>
export const UNIT_RELATION_NAMES = ["단원", "선택 단원"] as const
const UNIT_FORMULA_NAMES = ["단원", "단원(수식)"] as const
const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{32,36}$/i.test(v)

// 페이지(또는 스키마) 속성 중 관계인 단원 속성 이름
function relationName(props: Record<string, any> | undefined): string | null {
	for (const n of UNIT_RELATION_NAMES) { const v = props?.[n]; if (v && (Array.isArray(v.relation) || v.type === "relation")) return n }
	return null
}

// 학습기록 DB의 단원 관계 속성 이름(없으면 null). 함수 인스턴스마다 10분 기억.
let propCache: { at: number; name: string | null } | null = null
export async function selectedUnitsProp(): Promise<string | null> {
	if (propCache && Date.now() - propCache.at < 600_000) return propCache.name
	let name: string | null = null
	try {
		const res = await fetchWithRetry(`${NOTION_API}/data_sources/${DS_LEARNING_RECORD}`, { headers: notionHeaders() }, 2)
		if (res.ok) name = relationName((await res.json())?.properties)
	} catch { name = null }
	propCache = { at: Date.now(), name }
	return name
}
export const selectedUnitsEnabled = async () => (await selectedUnitsProp()) !== null
export function resetSelectedUnitsEnabled() { propCache = null }

// 보낸 값이 배열이 아니면 null(바꾸지 않음), 배열이면 페이지 id만 60개까지(같은 id는 한 번).
export function cleanUnitIds(v: unknown): string[] | null {
	if (!Array.isArray(v)) return null
	return [...new Set(v.filter(isId))].slice(0, 60)
}

// (v2.8.0 교재 평가) 이 페이지의 단원 관계 속성 이름("단원" 또는 "선택 단원", 없으면 null). 단원 평가가 같은 이름으로 쓴다.
export const unitRelationNameOf = (record: Page): string | null => relationName(record?.properties)
export const unitIdsOf = (record: Page): string[] => { const n = relationName(record?.properties); return n ? relationIds(record.properties[n]) : [] }

// 기록들의 고른 단원 id → 이름. 라이브러리 복사본에서 먼저, 없으면 Notion 페이지 제목.
export async function unitNamesOf(records: Page[]): Promise<Map<string, string>> {
	const ids = [...new Set(records.flatMap(unitIdsOf))]
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

// 기록 한 건의 단원 글자: 고른 단원이 있으면 그 이름들(" "로 이어 붙임 — 화면은 "1-1." 앞에서 나눈다), 없으면 단원 수식.
export function unitTextOf(record: Page, names: Map<string, string>): string {
	const picked = unitIdsOf(record).map((id) => names.get(id)).filter(Boolean)
	if (picked.length) return picked.join(" ")
	// 관계가 아닌 값(수식, 예전 글 속성)이면 그 글자
	for (const n of UNIT_FORMULA_NAMES) { const v = record?.properties?.[n]; if (v && !Array.isArray(v.relation) && v.type !== "relation") return text(v).trim() }
	return ""
}

// ---------- [단원 입력] 버튼(v2.5.127) ----------
export class FillUnitsError extends Error { constructor(public status: number, message: string) { super(message) } }

// 라이브러리 교재의 단원(시작쪽 순). 복사본이 있으면 그것, 없으면 Notion 단원목록.
async function bookUnitsFor(src: LibrarySources, bookId: string): Promise<{ id: string; name: string; page: number | null }[]> {
	if (await libraryCopyReady()) return (await readUnits([bookId])).map((u) => ({ id: u.id, name: u.name, page: u.start_page }))
	const pages = await queryAllPages(src.units, { property: src.unitsLink, relation: { contains: bookId } })
	return sortUnits(pages.map((p: Page) => ({ id: p.id as string, name: anyTitleText(p), start_page: typeof p.properties?.["범위 시작"]?.number === "number" ? p.properties["범위 시작"].number : null })))
		.map((u) => ({ id: u.id, name: u.name, page: u.start_page }))
}

// 학습기록의 범위로 단원을 새로 채운다(덮어쓰기). 범위가 비었거나 맞는 단원이 없으면 비운다.
export async function fillRecordUnits(recordId: string, src: LibrarySources) {
	if (!isId(recordId)) throw new FillUnitsError(400, "학습기록을 찾지 못했습니다(pageId).")
	const prop = await selectedUnitsProp()
	if (!prop) throw new FillUnitsError(409, '학습기록 DB에 단원 관계 속성("단원" 또는 "선택 단원")이 없습니다.')
	const record = await getPage(recordId) as Page
	const range = text(record.properties?.["범위"]).trim()
	const bookId = relationIds(record.properties?.["교재"])[0] ?? null
	if (!bookId) throw new FillUnitsError(409, "이 학습기록에는 교재(라이브러리)가 없어 단원을 찾을 수 없습니다.")
	const units = await bookUnitsFor(src, bookId)
	const picked = unitsForRange(units, range)
	await updatePageProperties(record.id, { [prop]: { relation: picked.map((u) => ({ id: u.id })) } })
	const note = !range ? "범위가 비어 단원을 비웠습니다." : !units.length ? "교재에 단원이 없습니다." : !units.some((u) => u.page !== null) ? "교재 단원에 시작쪽이 없어 범위로 찾을 수 없습니다." : !picked.length ? "범위에 맞는 단원이 없습니다." : ""
	return { ok: true, recordId: record.id as string, range, units: picked.map((u) => u.name), note }
}
