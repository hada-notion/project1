// _shared/bookSources.ts
//
// 라이브러리 교재 정보 출처(v2.5.120). 알라딘 OpenAPI가 2026-10-30에 종료되어(신규 키는 2026-09-04 종료) 다음 두 곳을 쓴다.
//   - 국립중앙도서관 ISBN 서지정보 API(주력): 국내에서 ISBN을 받은 책. 제목·발행처·총서명·쪽수·정가·표지·(일부)목차.
//     키: 함수 Secret NL_CERT_KEY. https://www.nl.go.kr/seoji/SearchApi.do
//   - 카카오 책 검색 API(보조): 수입 원서처럼 국립중앙도서관에 없는 책. 제목·출판사·정가·표지(쪽수·목차 없음).
//     키: 함수 Secret KAKAO_REST_KEY. https://dapi.kakao.com/v3/search/book
// 키는 학원마다 따로 받는다(원본 키를 나눠 쓰지 않음). 둘 중 하나만 있어도 그 출처로 동작한다. 키 값은 로그·응답에 쓰지 않는다.
// 같은 ISBN13은 하나로 합친다(국립중앙도서관 값 우선, 빈 칸만 카카오로 채움).

export class BookSourceError extends Error {
	constructor(public status: number, message: string) { super(message) }
}

export const isIsbn13 = (v: unknown): v is string => typeof v === "string" && /^97[89]\d{10}$/.test(v)
export type Book = {
	isbn13: string; title: string; author: string; publisher: string; pubDate: string; price: number | null
	series: string; pages: number | null; altCover: string; toc: string; sources: string[]
}

const digits = (v: unknown) => { const n = Number(String(v ?? "").replace(/[^\d]/g, "")); return n > 0 ? n : null }
// 표지 주소는 https만(화면·Notion에서 섞인 콘텐츠로 막히지 않게). http면 https로 바꿔 쓴다.
const httpsUrl = (v: unknown) => { const s = String(v ?? "").trim(); return /^https?:\/\/[^\s]+$/i.test(s) ? s.replace(/^http:/i, "https:") : "" }
const ymd = (v: unknown) => { const s = String(v ?? "").replace(/[^\d]/g, ""); return s.length >= 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : "" }

async function getJson(url: string, init: RequestInit, who: string): Promise<any> {
	let res: Response
	try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) }) }
	catch { throw new BookSourceError(502, `${who}에 연결하지 못했습니다. 잠시 후 다시 시도하세요.`) }
	if (!res.ok) throw new BookSourceError(502, `${who} 응답 오류(${res.status})`)
	try { return await res.json() } catch { throw new BookSourceError(502, `${who} 응답을 읽지 못했습니다.`) }
}

// ---------- 국립중앙도서관 ----------
const NL = "https://www.nl.go.kr/seoji/SearchApi.do"
export function nlBook(d: any): Book | null {
	const isbn13 = String(d?.EA_ISBN ?? "").replace(/[^\d]/g, "")
	if (!isIsbn13(isbn13)) return null
	const vol = String(d.VOL ?? "").trim()
	return {
		isbn13,
		title: [String(d.TITLE ?? "").trim(), vol].filter(Boolean).join(" "),
		author: String(d.AUTHOR ?? "").trim(),
		publisher: String(d.PUBLISHER ?? "").trim(),
		pubDate: ymd(d.PUBLISH_PREDATE),
		price: digits(d.PRE_PRICE) ?? digits(d.REAL_PRICE),
		series: String(d.SERIES_TITLE ?? "").trim(),
		pages: digits(d.PAGE),
		altCover: httpsUrl(d.TITLE_URL),
		toc: String(d.BOOK_TB_CNT ?? "").trim(),
		sources: ["국립중앙도서관"],
	}
}
async function nlSearch(params: Record<string, string>): Promise<Book[]> {
	const key = Deno.env.get("NL_CERT_KEY") ?? ""
	if (!key) return []
	const q = new URLSearchParams({ cert_key: key, result_style: "json", page_no: "1", page_size: "20", ...params })
	const data = await getJson(`${NL}?${q}`, {}, "국립중앙도서관")
	if (data?.ERR_CODE || data?.RESULT === "ERROR") throw new BookSourceError(502, `국립중앙도서관 오류: ${String(data.ERR_MESSAGE ?? data.ERR_CODE ?? "").slice(0, 120)}`)
	return ((data?.docs ?? []) as any[]).map(nlBook).filter(Boolean) as Book[]
}

// ---------- 카카오 ----------
const KAKAO = "https://dapi.kakao.com/v3/search/book"
// 카카오 표지는 작은 썸네일 주소 안에 원본 주소(fname)가 들어 있다. 원본이 있으면 그쪽(더 큼).
export function kakaoCover(thumbnail: unknown): string {
	const t = String(thumbnail ?? "")
	try { const f = new URL(t).searchParams.get("fname"); if (f) return httpsUrl(f) } catch { /* 썸네일 그대로 */ }
	return httpsUrl(t)
}
export function kakaoBook(d: any): Book | null {
	const isbn13 = String(d?.isbn ?? "").split(/\s+/).find((x) => isIsbn13(x)) ?? ""
	if (!isbn13) return null
	return {
		isbn13,
		title: String(d.title ?? "").trim(),
		author: ((d.authors ?? []) as string[]).join(", "),
		publisher: String(d.publisher ?? "").trim(),
		pubDate: String(d.datetime ?? "").slice(0, 10),
		price: digits(d.price),
		series: "",
		pages: null,
		altCover: kakaoCover(d.thumbnail),
		toc: "",
		sources: ["카카오"],
	}
}
async function kakaoSearch(query: string, target: "title" | "isbn"): Promise<Book[]> {
	const key = Deno.env.get("KAKAO_REST_KEY") ?? ""
	if (!key) return []
	const q = new URLSearchParams({ query, target, size: "20" })
	const data = await getJson(`${KAKAO}?${q}`, { headers: { Authorization: `KakaoAK ${key}` } }, "카카오")
	return ((data?.documents ?? []) as any[]).map(kakaoBook).filter(Boolean) as Book[]
}

// ---------- 합치기 ----------
export function mergeBooks(lists: Book[][]): Book[] {
	const out = new Map<string, Book>()
	for (const b of lists.flat()) {
		const a = out.get(b.isbn13)
		if (!a) { out.set(b.isbn13, { ...b }); continue }
		for (const k of ["title", "author", "publisher", "pubDate", "series", "altCover", "toc"] as const) if (!a[k] && b[k]) a[k] = b[k]
		if (a.price == null) a.price = b.price
		if (a.pages == null) a.pages = b.pages
		a.sources = [...new Set([...a.sources, ...b.sources])]
	}
	return [...out.values()]
}
function requireAnyKey() {
	if (!Deno.env.get("NL_CERT_KEY") && !Deno.env.get("KAKAO_REST_KEY"))
		throw new BookSourceError(503, "책 검색 키가 없습니다. Supabase Secrets에 NL_CERT_KEY(국립중앙도서관) 또는 KAKAO_REST_KEY(카카오)를 넣어 주세요.")
}
// 한쪽 출처가 실패해도 다른 쪽 결과는 보여 준다. 둘 다 실패하면 첫 오류.
async function settle(jobs: Promise<Book[]>[]): Promise<Book[][]> {
	const res = await Promise.allSettled(jobs)
	const ok = res.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<Book[]>).value)
	if (!ok.length) throw (res[0] as PromiseRejectedResult).reason
	for (const r of res) if (r.status === "rejected") console.warn("[bookSources] 한쪽 출처 실패:", (r.reason as Error)?.message)
	return ok
}
export async function searchTitle(query: string): Promise<Book[]> {
	requireAnyKey()
	return mergeBooks(await settle([nlSearch({ title: query }), kakaoSearch(query, "title")]))
}
export async function lookupIsbn(isbn13: string): Promise<Book | null> {
	requireAnyKey()
	return mergeBooks(await settle([nlSearch({ isbn: isbn13 }), kakaoSearch(isbn13, "isbn")])).find((b) => b.isbn13 === isbn13) ?? null
}
