// _shared/textbookSearch.ts
//
// 라이브러리(library.html → textbook-api, v2.5.118). 알라딘 Open API로 책을 찾고, 고른 책을 Notion 라이브러리(학원) DB에
// 한 권 만들고 목차에서 고친 단원을 단원목록 DB에 만든다.
//   - 알라딘 키: 함수 Secret ALADIN_TTB_KEY(값은 로그·응답에 쓰지 않는다). 출처 표시는 화면 아래.
//   - DB 위치: 진도교재 DB의 "라이브러리"(옛 이름 "정규교재") 관계 → 라이브러리 DB, 그 "단원목록" 관계 → 단원목록 DB(새 Notion ID 설정 없음).
//   - 북커버: 메뉴얼 7-6 규칙대로 ISBN13으로 만든 교보문고 이미지 주소(화면에서 이미지가 안 열리면 넣지 않음).
//   - 출판사·시리즈: 이미 있는 선택지와 맞을 때만 넣는다(DB 선택지를 새로 만들지 않는다).
//   - 같은 ISBN13이 라이브러리에 있으면 "등록됨"으로 보여 주고 다시 만들지 않는다.

import { NOTION_API, DS_PROGRESS_BOOK } from "./constants.ts"
import { fetchWithRetry, notionHeaders, queryAllPages } from "./notionClient.ts"
import { cleanUnits, parseToc } from "./textbookToc.ts"
import { libraryKey, libraryProp } from "./libraryProp.ts"

export class TextbookError extends Error {
	constructor(public status: number, message: string) { super(message) }
}

const ALADIN = "https://www.aladin.co.kr/ttb/api/"
export const isIsbn13 = (v: unknown): v is string => typeof v === "string" && /^97[89]\d{10}$/.test(v)
export const coverUrl = (isbn: string) => `https://contents.kyobobook.co.kr/sih/fit-in/458x0/pdt/${isbn}.jpg`

async function aladin(path: string, params: Record<string, string>): Promise<any> {
	const key = Deno.env.get("ALADIN_TTB_KEY") ?? ""
	if (!key) throw new TextbookError(503, "알라딘 키(ALADIN_TTB_KEY)가 설정되지 않았습니다. Supabase Secrets에 넣어 주세요.")
	const q = new URLSearchParams({ ttbkey: key, output: "js", Version: "20131101", ...params })
	let res: Response
	try { res = await fetch(`${ALADIN}${path}?${q}`, { signal: AbortSignal.timeout(10000) }) }
	catch { throw new TextbookError(502, "알라딘에 연결하지 못했습니다. 잠시 후 다시 시도하세요.") }
	if (!res.ok) throw new TextbookError(502, `알라딘 응답 오류(${res.status})`)
	// 알라딘 js 응답은 끝에 ";"가 붙거나 \' 같은 JSON 밖 이스케이프가 섞일 수 있다
	const text = (await res.text()).trim().replace(/;\s*$/, "")
	let data: any
	try { data = JSON.parse(text) } catch { try { data = JSON.parse(text.replace(/\\'/g, "'")) } catch { throw new TextbookError(502, "알라딘 응답을 읽지 못했습니다.") } }
	if (data?.errorCode) throw new TextbookError(502, `알라딘 오류: ${String(data.errorMessage ?? data.errorCode).slice(0, 120)}`)
	return data
}

export type Book = { isbn13: string; title: string; author: string; publisher: string; pubDate: string; price: number | null; cover: string; series: string; pages: number | null }
function toBook(it: any): Book | null {
	const isbn13 = String(it?.isbn13 ?? "")
	if (!isIsbn13(isbn13)) return null
	const price = Number(it.priceStandard), pages = Number(it.subInfo?.itemPage)
	return {
		isbn13,
		title: String(it.title ?? "").trim(),
		author: String(it.author ?? "").trim(),
		publisher: String(it.publisher ?? "").trim(),
		pubDate: String(it.pubDate ?? "").slice(0, 10),
		price: price > 0 ? price : null,
		cover: coverUrl(isbn13),
		series: String(it.seriesInfo?.seriesName ?? "").trim(),
		pages: pages > 0 ? pages : null,
	}
}

// ---------- Notion DB 위치·선택지 ----------
type Sources = { books: string; units: string; unitsLink: string; publishers: string[]; series: string[] }
let sourcesCache: Sources | null = null
async function dataSource(id: string): Promise<any> {
	const res = await fetchWithRetry(`${NOTION_API}/data_sources/${id}`, { headers: notionHeaders() }, 2)
	if (!res.ok) throw new Error(`Notion DB 정보를 읽지 못했습니다(${res.status})`)
	return res.json()
}
export async function textbookSources(): Promise<Sources> {
	if (sourcesCache) return sourcesCache
	if (!DS_PROGRESS_BOOK) throw new TextbookError(503, "DATA_SOURCE_PROGRESS_BOOK_ID 설정이 필요합니다.")
	const books = libraryProp((await dataSource(DS_PROGRESS_BOOK)).properties)?.relation?.data_source_id
	if (!books) throw new TextbookError(503, '진도교재 DB의 "라이브러리"(옛 이름 "정규교재") 관계를 찾지 못했습니다.')
	const schema = (await dataSource(books)).properties ?? {}
	const units = schema["단원목록"]?.relation?.data_source_id
	if (!units) throw new TextbookError(503, '라이브러리 DB의 "단원목록" 관계를 찾지 못했습니다.')
	const unitsLink = libraryKey((await dataSource(units)).properties)
	if (!unitsLink) throw new TextbookError(503, '단원목록 DB의 "라이브러리"(옛 이름 "정규교재") 관계를 찾지 못했습니다.')
	const names = (p: any) => (p?.select?.options ?? []).map((o: any) => String(o.name))
	sourcesCache = { books, units, unitsLink, publishers: names(schema["출판사"]), series: names(schema["시리즈"]) }
	return sourcesCache
}

const norm = (s: string) => s.replace(/\(주\)|㈜|주식회사|\s/g, "").toLowerCase()
// 출판사: 이름이 같으면 그 선택지, 아니면 한쪽이 다른 쪽을 포함하는 선택지가 하나뿐일 때만
export function matchPublisher(name: string, options: string[]): string | null {
	const n = norm(name)
	if (!n) return null
	const exact = options.find((o) => norm(o) === n)
	if (exact) return exact
	const part = options.filter((o) => norm(o).includes(n) || n.includes(norm(o)))
	return part.length === 1 ? part[0] : null
}
// 시리즈: 교재명(또는 알라딘 시리즈명)이 선택지 이름으로 시작하면 가장 긴 선택지
export function matchSeries(title: string, seriesName: string, options: string[]): string | null {
	const t = norm(title), s = norm(seriesName)
	return [...options].sort((a, b) => norm(b).length - norm(a).length).find((o) => norm(o) && (t.startsWith(norm(o)) || s.startsWith(norm(o)))) ?? null
}

async function registeredIsbns(isbns: string[]): Promise<Set<string>> {
	if (!isbns.length) return new Set()
	const { books } = await textbookSources()
	const pages = await queryAllPages(books, { or: isbns.map((i) => ({ property: "ISBN13", rich_text: { equals: i } })) })
	return new Set(pages.map((p: any) => (p.properties?.ISBN13?.rich_text ?? []).map((t: any) => t.plain_text).join("").trim()))
}

// ---------- 동작 ----------
export async function searchBooks(query: unknown) {
	const q = String(query ?? "").trim()
	if (q.length < 2 || q.length > 80) throw new TextbookError(400, "교재명은 2~80자로 입력하세요.")
	const data = await aladin("ItemSearch.aspx", { Query: q, QueryType: "Keyword", SearchTarget: "Book", MaxResults: "20", start: "1", Cover: "Big" })
	const books = (data.item ?? []).map(toBook).filter(Boolean) as Book[]
	const done = await registeredIsbns(books.map((b) => b.isbn13))
	return { books: books.map((b) => ({ ...b, registered: done.has(b.isbn13) })) }
}

async function lookup(isbn13: string): Promise<{ book: Book; toc: string }> {
	if (!isIsbn13(isbn13)) throw new TextbookError(400, "ISBN13 형식이 올바르지 않습니다.")
	const data = await aladin("ItemLookUp.aspx", { ItemId: isbn13, ItemIdType: "ISBN13", OptResult: "Toc", Cover: "Big" })
	const it = data.item?.[0]
	const book = toBook(it)
	if (!book || book.isbn13 !== isbn13) throw new TextbookError(404, "알라딘에서 이 교재를 찾지 못했습니다.")
	return { book, toc: String(it.subInfo?.toc ?? "") }
}

export async function bookDetail(isbn13: unknown) {
	const { book, toc } = await lookup(String(isbn13 ?? ""))
	const { publishers, series } = await textbookSources()
	return { book, publisher: matchPublisher(book.publisher, publishers), series: matchSeries(book.title, book.series, series), toc: parseToc(toc), tocEmpty: !toc.trim() }
}

export function parsePasted(text: unknown) {
	const t = String(text ?? "")
	if (t.length > 20000) throw new TextbookError(400, "목차가 너무 깁니다(2만 자까지).")
	return { toc: parseToc(t) }
}

// 생성 POST는 응답이 끊겨도 중복 페이지가 생기지 않도록 자동 재시도하지 않는다(schoolNotion.ts와 같은 원칙).
async function createOnce(dataSourceId: string, properties: Record<string, unknown>): Promise<string> {
	const res = await fetch(`${NOTION_API}/pages`, {
		method: "POST", headers: notionHeaders(), signal: AbortSignal.timeout(15000),
		body: JSON.stringify({ parent: { data_source_id: dataSourceId }, properties }),
	})
	if (!res.ok) throw new Error(`Notion 페이지를 만들지 못했습니다(${res.status})`)
	return (await res.json()).id as string
}
const title = (s: string) => ({ title: [{ text: { content: s.slice(0, 2000) } }] })

export async function registerBook(body: any) {
	const isbn13 = String(body?.isbn13 ?? "")
	const units = cleanUnits(body?.units)
	const { book } = await lookup(isbn13)
	const name = String(body?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || book.title
	const src = await textbookSources()
	if ((await registeredIsbns([isbn13])).has(isbn13)) throw new TextbookError(409, "이미 라이브러리에 있는 교재입니다(같은 ISBN13).")
	const publisher = matchPublisher(book.publisher, src.publishers), series = matchSeries(name, book.series, src.series)
	const props: Record<string, unknown> = {
		"교재명": title(name),
		"ISBN13": { rich_text: [{ text: { content: isbn13 } }] },
		"사용중": { checkbox: true },
		...(book.price ? { "가격": { number: book.price } } : {}),
		...(book.pages ? { "전체 페이지": { number: book.pages } } : {}),
		...(body?.noCover ? {} : { "북커버": { files: [{ type: "external", name: `${isbn13}.jpg`, external: { url: coverUrl(isbn13) } }] } }),
		...(publisher ? { "출판사": { select: { name: publisher } } } : {}),
		...(series ? { "시리즈": { select: { name: series } } } : {}),
	}
	const pageId = await createOnce(src.books, props)
	let created = 0
	try {
		for (const u of units) {
			await createOnce(src.units, { "단원명": title(u.name), [src.unitsLink]: { relation: [{ id: pageId }] }, ...(u.page ? { "시작페이지": { number: u.page } } : {}) })
			created++
		}
	} catch (err) {
		console.error("[textbook-api] 단원 만들기 중단:", (err as Error).message)
		return { ok: false, pageId, name, units: created, failed: units.length - created, error: `단원 ${units.length}개 중 ${created}개만 만들었습니다. 나머지는 Notion에서 직접 추가하세요.` }
	}
	return { ok: true, pageId, name, units: created, publisher, series, cover: !body?.noCover }
}

// ---------- 라이브러리 열기(v2.5.118) ----------
const plainOf = (p: any, name: string) => {
	const v = p?.properties?.[name]
	return ((v?.title ?? v?.rich_text ?? []) as any[]).map((t) => t.plain_text ?? "").join("").trim()
}
const fileUrlOf = (p: any, name: string) => {
	const f = p?.properties?.[name]?.files?.[0]
	return String(f?.external?.url ?? f?.file?.url ?? "")
}
const compact = (id: string) => String(id).replaceAll("-", "").toLowerCase()

// 라이브러리 전체. 시리즈 선택지 순서를 함께 준다(화면이 시리즈별로 묶는다).
export async function libraryBooks() {
	const src = await textbookSources()
	const pages = await queryAllPages(src.books)
	const books = pages.map((p: any) => {
		const units = p.properties?.["단원목록"]
		return {
			id: p.id as string,
			title: plainOf(p, "교재명"),
			series: String(p.properties?.["시리즈"]?.select?.name ?? ""),
			publisher: String(p.properties?.["출판사"]?.select?.name ?? ""),
			cover: fileUrlOf(p, "북커버"),
			used: p.properties?.["사용중"]?.checkbox === true,
			isbn13: plainOf(p, "ISBN13"),
			units: (units?.relation ?? []).length,
			unitsMore: units?.has_more === true,
		}
	}).sort((a: any, b: any) => a.title.localeCompare(b.title, "ko", { numeric: true }))
	return { books, seriesOrder: src.series }
}

async function bookPageOf(bookId: unknown) {
	const id = String(bookId ?? "")
	if (!/^[0-9a-f-]{32,36}$/i.test(id)) throw new TextbookError(400, "교재 형식이 올바르지 않습니다.")
	const src = await textbookSources()
	const res = await fetchWithRetry(`${NOTION_API}/pages/${id}`, { headers: notionHeaders() }, 2)
	if (!res.ok) throw new TextbookError(404, "교재를 찾지 못했습니다.")
	const page = await res.json()
	if (compact(page.parent?.data_source_id ?? "") !== compact(src.books) || page.archived || page.in_trash) throw new TextbookError(403, "라이브러리에 있는 교재가 아닙니다.")
	return { id: page.id as string, src }
}

// 한 교재의 단원목록(시작쪽 순, 쪽이 없으면 이름 순으로 뒤에)
export async function bookUnits(bookId: unknown) {
	const { id, src } = await bookPageOf(bookId)
	const pages = await queryAllPages(src.units, { property: src.unitsLink, relation: { contains: id } })
	const units = pages.map((p: any) => {
		const n = p.properties?.["시작페이지"]?.number
		return { id: p.id as string, name: plainOf(p, "단원명"), page: typeof n === "number" ? n : null }
	}).sort((a: any, b: any) => (a.page ?? Infinity) - (b.page ?? Infinity) || a.name.localeCompare(b.name, "ko", { numeric: true }))
	return { bookId: id, units }
}

// 이미 있는 교재에 단원 추가. 같은 이름의 단원은 다시 만들지 않는다. 기존 단원은 고치거나 지우지 않는다.
export async function addUnits(body: any) {
	const { id, src } = await bookPageOf(body?.bookId)
	const units = cleanUnits(body?.units)
	if (!units.length) throw new TextbookError(400, "추가할 단원이 없습니다.")
	const existing = new Set((await queryAllPages(src.units, { property: src.unitsLink, relation: { contains: id } })).map((p: any) => plainOf(p, "단원명")))
	const fresh = units.filter((u) => !existing.has(u.name))
	let created = 0
	try {
		for (const u of fresh) {
			await createOnce(src.units, { "단원명": title(u.name), [src.unitsLink]: { relation: [{ id }] }, ...(u.page ? { "시작페이지": { number: u.page } } : {}) })
			created++
		}
	} catch (err) {
		console.error("[textbook-api] 단원 추가 중단:", (err as Error).message)
		return { ok: false, created, skipped: units.length - fresh.length, error: `단원 ${fresh.length}개 중 ${created}개만 추가했습니다. 다시 시도하면 이미 만든 단원은 건너뜁니다.` }
	}
	return { ok: true, created, skipped: units.length - fresh.length }
}
