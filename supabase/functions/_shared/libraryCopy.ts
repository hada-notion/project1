// _shared/libraryCopy.ts
//
// 라이브러리(교재)·단원목록 복사본(v2.5.125): Notion 라이브러리 DB → Supabase lib_books, 단원목록 DB → lib_units.
// Notion이 원본이다. 읽는 쪽(라이브러리 화면·수업 관리 교재·리포트 교재 카드)은 libraryCopyReady()일 때만 이 표를 쓰고,
// 아니면 지금처럼 Notion을 읽는다. 함수 설정값 LIBRARY_SOURCE=notion이면 복사본을 읽지 않는다(되돌리기용).
//
// 맞추는 방법
//   - reconcileLibrary: 두 DB 전체를 읽어 upsert하고 Notion에 없는 행은 지운다(10분마다, sync-class-room-copy mode=library).
//     처음 성공하면 sync_cursors(lib_books)를 남긴다 — 그때부터 읽기가 복사본으로 간다.
//   - syncBookCopy: 교재 한 권과 그 단원만 다시 읽어 맞춘다(라이브러리 화면에서 등록·편집한 직후).
//   - renameSeriesCopy: 시리즈 이름을 바꾸면 복사본 교재의 시리즈도 바꾼다(Notion이 교재 값을 함께 바꾸므로).
// 이 파일은 textbookSearch.ts를 가져오지 않는다(DB 위치는 부르는 쪽이 넘긴다).

import { queryAllPages, getPage, mapWithConcurrency } from "./notionClient.ts"
import { relationIds, fetchSupabaseWithRetry } from "./reportCacheShared.ts"

type Page = Record<string, any>
type Row = Record<string, unknown>
export type LibrarySources = { books: string; units: string; unitsLink: string }
export type BookCopy = { id: string; title: string; series: string; publisher: string; cover: string; cover_file: boolean; isbn13: string; used: boolean; pages: number | null }
export type UnitCopy = { id: string; book_id: string | null; name: string; start_page: number | null; link_count: number }

export const libraryCopyOff = () => Deno.env.get("LIBRARY_SOURCE") === "notion"
const plainOf = (p: Page, name: string) => {
	const v = p?.properties?.[name]
	return ((v?.title ?? v?.rich_text ?? []) as any[]).map((t) => t.plain_text ?? "").join("").trim()
}
const iso = (v: unknown) => new Date(String(v ?? new Date().toISOString())).toISOString()
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null)

// 단원 페이지에서 라이브러리 관계 말고 다른 관계(예: 시험정보의 시험범위)에 연결된 수. 0이 아니면 지우지 않는다(v2.5.121).
export function unitUses(p: Page, unitsLink: string): number {
	let n = 0
	for (const [k, v] of Object.entries(p?.properties ?? {}) as [string, any][]) if (k !== unitsLink && v?.type === "relation") n += (v.relation ?? []).length + (v.has_more ? 1 : 0)
	return n
}
export function bookRow(p: Page): Row {
	const f = p.properties?.["북커버"]?.files?.[0]
	return {
		id: p.id,
		title: plainOf(p, "교재명"),
		series: String(p.properties?.["시리즈"]?.select?.name ?? ""),
		publisher: String(p.properties?.["출판사"]?.select?.name ?? ""),
		cover: String(f?.external?.url ?? ""),
		cover_file: !!f?.file,
		isbn13: plainOf(p, "ISBN13"),
		used: p.properties?.["사용중"]?.checkbox === true,
		pages: num(p.properties?.["전체 페이지"]?.number),
		notion_edited_at: iso(p.last_edited_time),
	}
}
export function unitRow(p: Page, unitsLink: string): Row {
	return {
		id: p.id,
		book_id: relationIds(p.properties?.[unitsLink])[0] ?? null,
		name: plainOf(p, "단원명"),
		start_page: num(p.properties?.["시작페이지"]?.number),
		link_count: unitUses(p, unitsLink),
		notion_edited_at: iso(p.last_edited_time),
	}
}

// ---------- Supabase ----------
const SB_URL = () => Deno.env.get("SB_URL") ?? ""
const SB_KEY = () => Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
const hasSupabase = () => !!SB_URL() && !!SB_KEY()
function sbHeaders(extra: Record<string, string> = {}) {
	if (!hasSupabase()) throw new Error("SB_URL / SB_SERVICE_ROLE_KEY Secrets가 설정되어 있지 않습니다.")
	return { apikey: SB_KEY(), Authorization: `Bearer ${SB_KEY()}`, "Content-Type": "application/json", ...extra }
}
type Table = "lib_books" | "lib_units"
async function upsert(table: Table, rows: Row[]): Promise<void> {
	const now = new Date().toISOString()
	for (let i = 0; i < rows.length; i += 500) {
		const res = await fetchSupabaseWithRetry(`${SB_URL()}/rest/v1/${table}?on_conflict=id`, {
			method: "POST", headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
			body: JSON.stringify(rows.slice(i, i + 500).map((r) => ({ ...r, synced_at: now }))),
		})
		if (!res.ok) throw new Error(`${table} upsert 실패: ${res.status} ${await res.text()}`)
	}
}
async function remove(table: Table, ids: string[]): Promise<void> {
	for (let i = 0; i < ids.length; i += 100) {
		const list = ids.slice(i, i + 100).map((id) => `"${id}"`).join(",")
		const res = await fetchSupabaseWithRetry(`${SB_URL()}/rest/v1/${table}?id=in.(${list})`, { method: "DELETE", headers: sbHeaders({ Prefer: "return=minimal" }) })
		if (!res.ok) throw new Error(`${table} 삭제 실패: ${res.status} ${await res.text()}`)
	}
}
async function select<T>(table: Table, query: string): Promise<T[]> {
	const rows: T[] = []
	for (let offset = 0; ; offset += 1000) {
		const res = await fetchSupabaseWithRetry(`${SB_URL()}/rest/v1/${table}?${query}&limit=1000&offset=${offset}`, { headers: sbHeaders() })
		if (!res.ok) throw new Error(`${table} 읽기 실패: ${res.status} ${await res.text()}`)
		const part: T[] = await res.json()
		rows.push(...part)
		if (part.length < 1000) return rows
	}
}
const inList = (ids: string[]) => `(${ids.map((id) => `"${id}"`).join(",")})`

// 처음 전체 대조가 끝났는지(sync_cursors lib_books). 함수 인스턴스마다 1분 기억한다.
let readyCache: { at: number; ok: boolean } | null = null
export async function libraryCopyReady(): Promise<boolean> {
	if (libraryCopyOff() || !hasSupabase()) return false
	if (readyCache && Date.now() - readyCache.at < 60_000) return readyCache.ok
	try {
		// 재시도하지 않는다(한 번, 3초) — 안 되면 이번에는 Notion을 읽는다.
		const res = await fetch(`${SB_URL()}/rest/v1/sync_cursors?source=eq.lib_books&select=last_synced_at`, { headers: sbHeaders(), signal: AbortSignal.timeout(3000) })
		const ok = res.ok && !!(await res.json())[0]?.last_synced_at
		readyCache = { at: Date.now(), ok }
		return ok
	} catch (err) {
		console.error("[libraryCopy] 준비 확인 실패(Notion을 읽음):", (err as Error).message)
		return false
	}
}
export function resetLibraryCopyReady() { readyCache = null }

// ---------- 맞추기 ----------
export async function reconcileLibrary(src: LibrarySources) {
	const startedAt = new Date().toISOString()
	const [books, units] = [await queryAllPages(src.books), await queryAllPages(src.units)]
	const bookRows = books.map(bookRow), unitRows = units.map((p: Page) => unitRow(p, src.unitsLink))
	await upsert("lib_books", bookRows)
	await upsert("lib_units", unitRows)
	const fresh = (rows: Row[]) => new Set(rows.map((r) => r.id as string))
	const staleBooks = (await select<{ id: string }>("lib_books", "select=id&order=id")).map((r) => r.id).filter((id) => !fresh(bookRows).has(id))
	const freshUnits = fresh(unitRows)
	const staleUnits = (await select<{ id: string }>("lib_units", "select=id&order=id")).map((r) => r.id).filter((id) => !freshUnits.has(id))
	await remove("lib_books", staleBooks)
	await remove("lib_units", staleUnits)
	const res = await fetchSupabaseWithRetry(`${SB_URL()}/rest/v1/sync_cursors?on_conflict=source`, {
		method: "POST", headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify([{ source: "lib_books", last_synced_at: startedAt }]),
	})
	if (!res.ok) throw new Error(`sync_cursors 저장 실패: ${res.status}`)
	return { books: bookRows.length, units: unitRows.length, deleted: staleBooks.length + staleUnits.length }
}

// 교재 한 권과 그 단원(라이브러리 화면에서 쓴 직후). 실패해도 Notion 쓰기는 이미 끝났으므로 로그만 남긴다 — 10분 대조가 맞춘다.
export async function syncBookCopy(src: LibrarySources, bookId: string): Promise<void> {
	// 처음 대조 전에는 쓰지 않는다(대조가 전부 채운다).
	if (!(await libraryCopyReady())) return
	try {
		const page = await getPage(bookId) as Page
		const old = (await select<{ id: string }>("lib_units", `select=id&book_id=eq.${encodeURIComponent(bookId)}`)).map((r) => r.id)
		if (page.archived || page.in_trash) {
			await remove("lib_books", [bookId])
			await remove("lib_units", old)
			return
		}
		const units = await queryAllPages(src.units, { property: src.unitsLink, relation: { contains: bookId } })
		await upsert("lib_books", [bookRow(page)])
		await upsert("lib_units", units.map((p: Page) => unitRow(p, src.unitsLink)))
		const keep = new Set(units.map((p: Page) => p.id as string))
		await remove("lib_units", old.filter((id) => !keep.has(id)))
	} catch (err) {
		console.error("[libraryCopy] 교재 복사본 맞추기 실패(10분 대조가 맞춤):", (err as Error).message)
	}
}
export async function renameSeriesCopy(oldName: string, newName: string): Promise<void> {
	if (!oldName || oldName === newName || !(await libraryCopyReady())) return
	try {
		const res = await fetchSupabaseWithRetry(`${SB_URL()}/rest/v1/lib_books?series=eq.${encodeURIComponent(oldName)}`, {
			method: "PATCH", headers: sbHeaders({ Prefer: "return=minimal" }), body: JSON.stringify({ series: newName }),
		})
		if (!res.ok) throw new Error(`${res.status}`)
	} catch (err) {
		console.error("[libraryCopy] 시리즈 이름 맞추기 실패(10분 대조가 맞춤):", (err as Error).message)
	}
}

// ---------- 읽기 ----------
// Notion에 올린 표지(cover_file)는 주소가 만료되므로 Notion에서 지금 주소를 받아 채운다(그런 교재만).
async function freshCovers(books: BookCopy[]): Promise<BookCopy[]> {
	const need = books.filter((b) => b.cover_file)
	if (!need.length) return books
	const urls = new Map<string, string>()
	await mapWithConcurrency(need, 4, async (b: BookCopy) => {
		try { const f = ((await getPage(b.id)) as Page).properties?.["북커버"]?.files?.[0]; urls.set(b.id, String(f?.file?.url ?? f?.external?.url ?? "")) } catch { urls.set(b.id, "") }
	})
	return books.map((b) => (b.cover_file ? { ...b, cover: urls.get(b.id) ?? "" } : b))
}
export async function readBooks(ids?: string[]): Promise<BookCopy[]> {
	if (ids && !ids.length) return []
	const rows: BookCopy[] = []
	if (!ids) rows.push(...await select<BookCopy>("lib_books", "select=*&order=id"))
	else for (let i = 0; i < ids.length; i += 100) rows.push(...await select<BookCopy>("lib_books", `select=*&id=in.${inList(ids.slice(i, i + 100))}`))
	return await freshCovers(rows)
}
// 교재들의 단원(시작쪽 순, 쪽이 없으면 이름 순으로 뒤에). ids를 안 주면 전체.
export async function readUnits(bookIds?: string[]): Promise<UnitCopy[]> {
	if (bookIds && !bookIds.length) return []
	const rows: UnitCopy[] = []
	if (!bookIds) rows.push(...await select<UnitCopy>("lib_units", "select=*&order=id"))
	else for (let i = 0; i < bookIds.length; i += 100) rows.push(...await select<UnitCopy>("lib_units", `select=*&book_id=in.${inList(bookIds.slice(i, i + 100))}`))
	return sortUnits(rows)
}
export function sortUnits<T extends { name: string; start_page?: number | null }>(rows: T[]): T[] {
	return [...rows].sort((a, b) => (a.start_page ?? Infinity) - (b.start_page ?? Infinity) || a.name.localeCompare(b.name, "ko", { numeric: true }))
}
