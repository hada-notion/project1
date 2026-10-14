// _shared/textbookSearch.ts
//
// 라이브러리(library.html → textbook-api, v2.5.118). 책을 찾고, 고른 책을 Notion 라이브러리(학원) DB에
// 한 권 만들고 목차에서 고친 단원을 단원목록 DB에 만든다.
//   - 책 정보(v2.5.120): 국립중앙도서관 ISBN 서지정보(NL_CERT_KEY) + 카카오 책 검색(KAKAO_REST_KEY). _shared/bookSources.ts.
//     알라딘 OpenAPI는 2026-10-30 종료로 쓰지 않는다.
//   - DB 위치: 진도교재 DB의 "라이브러리"(옛 이름 "정규교재") 관계 → 라이브러리 DB, 그 "단원목록" 관계 → 단원목록 DB(새 Notion ID 설정 없음).
//   - 북커버: 메뉴얼 7-6 규칙대로 ISBN13으로 만든 교보문고 이미지 주소. 화면에서 열리지 않으면 국립중앙도서관·카카오 표지,
//     그것도 없으면 넣지 않는다(화면이 고른 결과를 cover: "kyobo" | "alt" | "none"으로 보낸다).
//   - 출판사·시리즈: 이미 있는 선택지와 맞을 때만 넣는다(DB 선택지를 새로 만들지 않는다).
//   - 같은 ISBN13이 라이브러리에 있으면 "등록됨"으로 보여 주고 다시 만들지 않는다.

import { NOTION_API, DS_PROGRESS_BOOK } from "./constants.ts"
import { archivePage, fetchWithRetry, notionHeaders, queryAllPages, updatePageProperties } from "./notionClient.ts"
import { cleanUnits, parseToc } from "./textbookToc.ts"
import { libraryKey, libraryProp } from "./libraryProp.ts"
import { type Book, BookSourceError, isIsbn13, lookupIsbn, searchTitle } from "./bookSources.ts"

export { isIsbn13 }
export class TextbookError extends Error {
	constructor(public status: number, message: string) { super(message) }
}

export const coverUrl = (isbn: string) => `https://contents.kyobobook.co.kr/sih/fit-in/458x0/pdt/${isbn}.jpg`
// 출처 오류는 그대로 화면에 보여 준다(키 없음 503, 연결·응답 오류 502).
async function fromSource<T>(job: () => Promise<T>): Promise<T> {
	try { return await job() } catch (err) { if (err instanceof BookSourceError) throw new TextbookError(err.status, err.message); throw err }
}
// 화면에 보내는 책: 교보문고 표지(cover)와 대신 쓸 표지(altCover). 목차 원문은 detail에서만.
const forScreen = ({ toc: _toc, ...b }: Book) => ({ ...b, cover: coverUrl(b.isbn13) })

// ---------- Notion DB 위치·선택지 ----------
type Sources = { books: string; units: string; unitsLink: string; publishers: string[]; series: string[] }
let sourcesCache: Sources | null = null
async function dataSource(id: string): Promise<any> {
	const res = await fetchWithRetry(`${NOTION_API}/data_sources/${id}`, { headers: notionHeaders() }, 2)
	if (!res.ok) throw new Error(`Notion DB 정보를 읽지 못했습니다(${res.status})`)
	return res.json()
}
// fresh: 캐시를 버리고 다시 읽는다(시리즈 선택지가 바뀌었을 때, v2.5.122)
export async function textbookSources(fresh = false): Promise<Sources> {
	if (sourcesCache && !fresh) return sourcesCache
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
// 시리즈: 교재명(또는 출처의 총서명)이 선택지 이름으로 시작하면 가장 긴 선택지
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
// 검색: ISBN13(하이픈·띄어쓰기 허용)이면 그 책 한 권, 아니면 교재명으로 국립중앙도서관·카카오를 함께 찾아
// 하나의 목록으로(같은 ISBN13은 한 번만, 국립중앙도서관 값 우선).
export const isbnQuery = (q: string) => { const d = q.replace(/[-s]/g, ""); return isIsbn13(d) ? d : null }
export async function searchBooks(query: unknown) {
	const q = String(query ?? "").trim()
	if (q.length < 1 || q.length > 80) throw new TextbookError(400, "교재명은 1~80자로 입력하세요.") // "쎈"처럼 한 글자 시리즈(v2.5.122)
	const isbn = isbnQuery(q)
	const books = await fromSource(async () => isbn ? [await lookupIsbn(isbn)].filter(Boolean) as Book[] : await searchTitle(q))
	const done = await registeredIsbns(books.map((b) => b.isbn13))
	return { books: books.map((b) => ({ ...forScreen(b), registered: done.has(b.isbn13) })) }
}

async function lookup(isbn13: string): Promise<Book> {
	if (!isIsbn13(isbn13)) throw new TextbookError(400, "ISBN13 형식이 올바르지 않습니다.")
	const book = await fromSource(() => lookupIsbn(isbn13))
	if (!book) throw new TextbookError(404, "국립중앙도서관·카카오에서 이 교재를 찾지 못했습니다.")
	return book
}

// 목차: 국립중앙도서관에 목차가 있으면 나눠서 단원 후보로. 없으면 tocEmpty(화면이 교보문고 링크와 붙여넣기를 보여 줌).
export async function bookDetail(isbn13: unknown) {
	const book = await lookup(String(isbn13 ?? ""))
	const { publishers, series } = await textbookSources()
	return { book: forScreen(book), publisher: matchPublisher(book.publisher, publishers), series: matchSeries(book.title, book.series, series), toc: parseToc(book.toc), tocEmpty: !book.toc.trim() }
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
	const book = await lookup(isbn13)
	const name = String(body?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || book.title
	// cover: "kyobo"(기본) | "alt"(국립중앙도서관·카카오 표지) | "none". 옛 화면의 noCover도 받는다.
	const choice = body?.noCover ? "none" : String(body?.cover ?? "kyobo")
	const cover = choice === "none" ? "" : choice === "alt" ? book.altCover : coverUrl(isbn13)
	return await createLibraryBook({ name, isbn13, price: book.price, pages: book.pages, cover, publisher: book.publisher, seriesHint: book.series, units: body?.units, seriesPick: await pickOption(body?.series, "series"), publisherPick: await pickOption(body?.publisher, "publishers") })
}

type NewBook = { name: string; isbn13?: string; price?: number | null; pages?: number | null; cover?: string; publisher?: string; seriesHint?: string; units: unknown; seriesPick?: string | null; publisherPick?: string | null }
// 라이브러리 교재 1권 + 단원목록. 같은 ISBN13이 있으면 409. 출판사·시리즈는 화면에서 고른 값(…Pick), 없으면 기존 선택지와 맞을 때만.
async function createLibraryBook(b: NewBook) {
	const units = cleanUnits(b.units)
	const src = await textbookSources()
	if (b.isbn13 && (await registeredIsbns([b.isbn13])).has(b.isbn13)) throw new TextbookError(409, "이미 라이브러리에 있는 교재입니다(같은 ISBN13).")
	const publisher = b.publisherPick !== undefined ? b.publisherPick : matchPublisher(b.publisher ?? "", src.publishers)
	const series = b.seriesPick !== undefined ? b.seriesPick : matchSeries(b.name, b.seriesHint ?? "", src.series)
	const fileName = (b.isbn13 || "cover") + (/\.(png|gif|webp)(\?|$)/i.exec(b.cover ?? "")?.[0]?.replace(/\?$/, "") ?? ".jpg")
	const props: Record<string, unknown> = {
		"교재명": title(b.name),
		"사용중": { checkbox: true },
		...(b.isbn13 ? { "ISBN13": { rich_text: [{ text: { content: b.isbn13 } }] } } : {}),
		...(b.price ? { "가격": { number: b.price } } : {}),
		...(b.pages ? { "전체 페이지": { number: b.pages } } : {}),
		...(b.cover ? { "북커버": { files: [{ type: "external", name: fileName, external: { url: b.cover } }] } } : {}),
		...(publisher ? { "출판사": { select: { name: publisher } } } : {}),
		...(series ? { "시리즈": { select: { name: series } } } : {}),
	}
	const name = b.name
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
	return { ok: true, pageId, name, units: created, publisher, series, cover: !!b.cover }
}

// ---------- 직접 추가(v2.5.119) ----------
// 검색에 없는 교재(학원 자체 교재 등). ISBN·표지·가격은 있을 때만. 표지는 https 주소만.
export async function registerCustom(body: any) {
	const name = String(body?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
	if (!name) throw new TextbookError(400, "교재명을 입력하세요.")
	const isbn13 = String(body?.isbn13 ?? "").replace(/[-\s]/g, "")
	if (isbn13 && !isIsbn13(isbn13)) throw new TextbookError(400, "ISBN13은 978 또는 979로 시작하는 13자리 숫자입니다.")
	const cover = String(body?.cover ?? "").trim()
	if (cover && (!/^https:\/\/[^\s]+$/i.test(cover) || cover.length > 1000)) throw new TextbookError(400, "표지 주소는 https로 시작하는 이미지 주소여야 합니다.")
	const price = Number(body?.price)
	return await createLibraryBook({ name, isbn13: isbn13 || undefined, price: price > 0 && price < 10_000_000 ? Math.round(price) : null, cover, units: body?.units, seriesPick: await pickOption(body?.series, "series"), publisherPick: await pickOption(body?.publisher, "publishers") })
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
	return { books, seriesOrder: src.series, publishers: src.publishers }
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

// 한 교재의 단원목록(시작쪽 순, 쪽이 없으면 이름 순으로 뒤에). uses: 다른 곳(시험범위 등)에 연결된 수(v2.5.121)
export async function bookUnits(bookId: unknown) {
	const { id, src } = await bookPageOf(bookId)
	const pages = await queryAllPages(src.units, { property: src.unitsLink, relation: { contains: id } })
	const units = pages.map((p: any) => {
		const n = p.properties?.["시작페이지"]?.number
		return { id: p.id as string, name: plainOf(p, "단원명"), page: typeof n === "number" ? n : null, uses: unitUses(p, src.unitsLink) }
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

// ---------- 단원 편집·북커버 수정(v2.5.121) ----------
// 단원 페이지에서 라이브러리 관계 말고 다른 관계(예: 시험정보 DB의 시험범위)에 연결된 수. 0이 아니면 지우지 않는다.
function unitUses(p: any, unitsLink: string): number {
	let n = 0
	for (const [k, v] of Object.entries(p?.properties ?? {}) as [string, any][]) if (k !== unitsLink && v?.type === "relation") n += (v.relation ?? []).length + (v.has_more ? 1 : 0)
	return n
}
const unitPageNum = (v: unknown) => { const n = Number(v); return v === null || v === "" || v === undefined ? null : Number.isInteger(n) && n >= 1 && n <= 2000 ? n : NaN }

// 한 교재의 단원을 한 번에 고친다: update [{ id, name, page }] · remove [id] · add [{ name, page }].
// 고치거나 지우는 단원은 이 교재의 단원이어야 한다. 다른 곳에 연결된 단원은 지우지 않고 blocked로 돌려준다.
// 지우기는 Notion 휴지통(30일 안에 복구 가능). 같은 이름의 단원은 새로 만들지 않는다.
export async function editUnits(body: any) {
	const { id, src } = await bookPageOf(body?.bookId)
	const update = Array.isArray(body?.update) ? body.update : [], remove = Array.isArray(body?.remove) ? body.remove.map(String) : []
	const add = cleanUnits(body?.add)
	if (update.length + remove.length + add.length === 0) throw new TextbookError(400, "바꿀 내용이 없습니다.")
	if (update.length + remove.length + add.length > 300) throw new TextbookError(400, "한 번에 300개까지 고칠 수 있습니다.")
	const pages = await queryAllPages(src.units, { property: src.unitsLink, relation: { contains: id } })
	const mine = new Map(pages.map((p: any) => [compact(p.id), p]))
	const own = (uid: unknown) => mine.get(compact(String(uid ?? "")))
	const fixes = update.map((u: any) => {
		const p = own(u?.id)
		if (!p) throw new TextbookError(400, "이 교재의 단원이 아닌 항목이 있습니다.")
		const name = String(u?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 100), page = unitPageNum(u?.page)
		if (!name) throw new TextbookError(400, "단원명이 비어 있는 줄이 있습니다.")
		if (Number.isNaN(page)) throw new TextbookError(400, "시작쪽은 1~2000 사이 숫자입니다.")
		return { p, name, page }
	})
	const drops = remove.map((uid: string) => { const p = own(uid); if (!p) throw new TextbookError(400, "이 교재의 단원이 아닌 항목이 있습니다."); return p })
	const blocked = drops.filter((p: any) => unitUses(p, src.unitsLink) > 0).map((p: any) => plainOf(p, "단원명"))
	const dropIds = new Set(drops.filter((p: any) => unitUses(p, src.unitsLink) === 0).map((p: any) => compact(p.id)))
	const names = new Set(pages.filter((p: any) => !dropIds.has(compact(p.id))).map((p: any) => plainOf(p, "단원명")))
	for (const f of fixes) names.add(f.name)
	const fresh = add.filter((u) => !names.has(u.name) && names.add(u.name))
	const done = { updated: 0, removed: 0, added: 0 }
	try {
		for (const f of fixes) {
			if (dropIds.has(compact(f.p.id))) continue
			if (f.name === plainOf(f.p, "단원명") && f.page === (f.p.properties?.["시작페이지"]?.number ?? null)) continue
			await updatePageProperties(f.p.id, { "단원명": title(f.name), "시작페이지": { number: f.page } })
			done.updated++
		}
		for (const p of drops) if (dropIds.has(compact(p.id))) { await archivePage(p.id); done.removed++ }
		for (const u of fresh) {
			await createOnce(src.units, { "단원명": title(u.name), [src.unitsLink]: { relation: [{ id }] }, ...(u.page ? { "시작페이지": { number: u.page } } : {}) })
			done.added++
		}
	} catch (err) {
		console.error("[textbook-api] 단원 편집 중단:", (err as Error).message)
		return { ok: false, ...done, blocked, skipped: add.length - fresh.length, error: `저장하다 멈췄습니다(수정 ${done.updated} · 삭제 ${done.removed} · 추가 ${done.added}). 다시 열어 확인해 주세요.` }
	}
	return { ok: true, ...done, blocked, skipped: add.length - fresh.length }
}

// 북커버 바꾸기(v2.5.121): https 이미지 주소, 빈 값이면 지운다. v2.5.122부터 updateBook으로.
export const setCover = (body: any) => updateBook({ bookId: body?.bookId, cover: String(body?.cover ?? "") })

// ---------- 시리즈·출판사 고르기, 시리즈 관리(v2.5.122) ----------
// 화면에서 고른 값: undefined면 자동 맞춤(matchSeries·matchPublisher), ""면 비움, 이름이면 지금 선택지에 있어야 한다.
// 선택지는 [시리즈 관리]에서 바뀔 수 있어 캐시에 없으면 한 번 새로 읽는다. 출판사 선택지는 새로 만들지 않는다.
async function pickOption(v: unknown, kind: "series" | "publishers"): Promise<string | null | undefined> {
	if (v === undefined || v === null) return undefined
	const name = String(v).trim()
	if (!name) return null
	let src = await textbookSources()
	if (!src[kind].includes(name)) src = await textbookSources(true)
	if (!src[kind].includes(name)) throw new TextbookError(400, `${kind === "series" ? "시리즈" : "출판사"} 선택지에 없는 이름입니다: ${name.slice(0, 40)}`)
	return name
}

// 교재 정보 고치기: cover(https 주소, ""면 지움)·series·publisher(""면 비움). 보낸 것만 바꾼다.
export async function updateBook(body: any) {
	const { id } = await bookPageOf(body?.bookId)
	const props: Record<string, unknown> = {}
	if (body?.cover !== undefined) {
		const cover = String(body.cover ?? "").trim()
		if (cover && (!/^https:\/\/[^\s]+$/i.test(cover) || cover.length > 1000)) throw new TextbookError(400, "표지 주소는 https로 시작하는 이미지 주소여야 합니다.")
		const fileName = "cover" + (/\.(png|gif|webp)(\?|$)/i.exec(cover)?.[0]?.replace(/\?$/, "") ?? ".jpg")
		props["북커버"] = { files: cover ? [{ type: "external", name: fileName, external: { url: cover } }] : [] }
	}
	const series = await pickOption(body?.series, "series"), publisher = await pickOption(body?.publisher, "publishers")
	if (series !== undefined) props["시리즈"] = { select: series ? { name: series } : null }
	if (publisher !== undefined) props["출판사"] = { select: publisher ? { name: publisher } : null }
	if (!Object.keys(props).length) throw new TextbookError(400, "바꿀 내용이 없습니다.")
	await updatePageProperties(id, props)
	return { ok: true, cover: body?.cover !== undefined ? String(body.cover ?? "").trim() : undefined, series, publisher }
}

type SeriesOption = { id: string; name: string; color?: string }
// Notion 선택지 중 같은 id가 두 번 나오는 것(원본에서 "완자"와 "EBS 수능특강"이 같은 id, v2.5.123)이 있으면
// 목록 전체를 보내는 변경이 "duplicates not allowed"로 거부된다. 첫 번째만 선택지로 쓰고 나머지는 duplicates로 따로 돌려준다.
async function seriesSchema(): Promise<{ src: Sources; options: SeriesOption[]; duplicates: SeriesOption[] }> {
	const src = await textbookSources()
	const prop = (await dataSource(src.books)).properties?.["시리즈"]
	if (prop?.type !== "select") throw new TextbookError(503, '라이브러리 DB의 "시리즈"가 선택 속성이 아닙니다.')
	const seen = new Set<string>(), options: SeriesOption[] = [], duplicates: SeriesOption[] = []
	for (const o of prop.select?.options ?? []) {
		const opt = { id: String(o.id), name: String(o.name), color: o.color }
		if (seen.has(opt.id)) duplicates.push(opt); else { seen.add(opt.id); options.push(opt) }
	}
	return { src, options, duplicates }
}
// 시리즈 선택지 목록(Notion 선택지 순서 = 라이브러리 묶음 순서)
export async function seriesList() {
	const { options, duplicates } = await seriesSchema()
	return { series: options.map((o) => ({ id: o.id, name: o.name })), duplicates: duplicates.map((o) => o.name) }
}
const seriesName = (v: unknown) => {
	const s = String(v ?? "").replace(/\s+/g, " ").trim()
	if (!s || s.length > 100) throw new TextbookError(400, "시리즈 이름은 1~100자로 입력하세요.")
	if (s.includes(",")) throw new TextbookError(400, "시리즈 이름에는 쉼표(,)를 쓸 수 없습니다.")
	return s
}
// 시리즈 선택지 바꾸기: op add { name } · rename { id, name } · order { order: [id…] } · remove { id }(교재가 0권일 때만).
// Notion은 선택지 전체 목록을 받으므로 매번 지금 목록을 새로 읽어 고친 뒤 보낸다(기존 선택지는 id로 유지 → 교재의 값도 유지).
export async function editSeries(body: any) {
	const { src, options, duplicates } = await seriesSchema()
	// id가 겹친 선택지는 이번 변경에서 뺀다(그 이름은 Notion 선택지에서 사라진다). 그 이름을 쓰는 교재가 있으면 멈춘다.
	for (const d of duplicates) {
		const used = await queryAllPages(src.books, { property: "시리즈", select: { equals: d.name } })
		if (used.length) throw new TextbookError(409, `Notion 시리즈 선택지 "${d.name}"가 다른 선택지와 같은 id를 쓰고 있습니다. Notion에서 "${d.name}" 선택지를 지우고 다시 만든 뒤 교재 ${used.length}권에 다시 지정해 주세요.`)
	}
	const keep = (o: SeriesOption) => ({ id: o.id, name: o.name })
	const find = (id: unknown) => { const o = options.find((x) => x.id === String(id ?? "")); if (!o) throw new TextbookError(404, "시리즈를 찾지 못했습니다. 새로고침 후 다시 하세요."); return o }
	const taken = (name: string, except = "") => options.some((o) => o.id !== except && norm(o.name) === norm(name))
	let next: Record<string, unknown>[]
	switch (String(body?.op ?? "")) {
		case "add": {
			const name = seriesName(body?.name)
			if (taken(name)) throw new TextbookError(409, "이미 있는 시리즈입니다.")
			next = [...options.map(keep), { name, color: "default" }]
			break
		}
		case "rename": {
			const o = find(body?.id), name = seriesName(body?.name)
			if (taken(name, o.id)) throw new TextbookError(409, "이미 있는 시리즈 이름입니다.")
			next = options.map((x) => x.id === o.id ? { id: x.id, name } : keep(x))
			break
		}
		case "order": {
			const order = Array.isArray(body?.order) ? body.order.map(String) : []
			if (order.length !== options.length || new Set(order).size !== order.length || !order.every((i: string) => options.some((o) => o.id === i)))
				throw new TextbookError(409, "시리즈 목록이 그사이 바뀌었습니다. 새로고침 후 다시 하세요.")
			next = order.map((i: string) => keep(options.find((o) => o.id === i)!))
			break
		}
		case "remove": {
			const o = find(body?.id)
			const used = await queryAllPages(src.books, { property: "시리즈", select: { equals: o.name } })
			if (used.length) throw new TextbookError(409, `교재 ${used.length}권이 이 시리즈를 쓰고 있어 지울 수 없습니다.`)
			next = options.filter((x) => x.id !== o.id).map(keep)
			break
		}
		default: throw new TextbookError(400, "지원하지 않는 시리즈 작업입니다.")
	}
	const res = await fetchWithRetry(`${NOTION_API}/data_sources/${src.books}`, {
		method: "PATCH", headers: notionHeaders(), body: JSON.stringify({ properties: { "시리즈": { select: { options: next } } } }),
	}, 2)
	if (!res.ok) {
		const text = await res.text()
		console.error("[textbook-api] 시리즈 변경 거부:", res.status, text.slice(0, 300))
		let why = ""
		try { why = String(JSON.parse(text)?.message ?? "").slice(0, 160) } catch { /* 본문 없음 */ }
		throw new TextbookError(502, `Notion이 시리즈 변경을 받지 않았습니다(${res.status}${why ? ": " + why : ""}). Notion 라이브러리 DB의 "시리즈" 속성에서 직접 고쳐 주세요.`)
	}
	sourcesCache = null
	return { ok: true, cleaned: duplicates.map((o) => o.name), ...(await seriesList()) }
}
