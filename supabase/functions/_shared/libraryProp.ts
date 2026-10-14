// _shared/libraryProp.ts
//
// 라이브러리 관계 속성 이름(v2.5.118). Notion "정규교재(학원) DB"를 "라이브러리(학원) DB"로 바꾸면서 다른 DB(진도교재·
// 교재배부·단원목록)의 관계 속성 이름도 "정규교재" → "라이브러리"로 바꾼다. 학원마다 Notion 이름을 바꾸는 시점이 코드
// 배포와 다르므로, 읽을 때는 새 이름을 먼저 보고 없으면 옛 이름을 본다. 쓰거나 검색 조건에 넣을 때는 그 DB에 실제로
// 있는 이름을 쓴다(DB 정보에서 한 번 읽어 둔다).
import { NOTION_API } from "./constants.ts"
import { fetchWithRetry, notionHeaders } from "./notionClient.ts"

export const LIBRARY_PROP = "라이브러리"
export const OLD_LIBRARY_PROP = "정규교재"
const NAMES = [LIBRARY_PROP, OLD_LIBRARY_PROP]

type Props = Record<string, any> | undefined
const propsOf = (pageOrProps: any): Props => (pageOrProps?.properties ?? pageOrProps) as Props

// 페이지(또는 properties)에 있는 라이브러리 관계 속성 이름. 둘 다 없으면 null.
export function libraryKey(pageOrProps: any): string | null {
	const props = propsOf(pageOrProps)
	return NAMES.find((n) => props?.[n] !== undefined) ?? null
}
// 라이브러리 관계 속성 값(없으면 undefined)
export function libraryProp(pageOrProps: any): any {
	const key = libraryKey(pageOrProps)
	return key ? propsOf(pageOrProps)?.[key] : undefined
}
// 연결된 라이브러리 페이지 id
export function libraryIds(pageOrProps: any): string[] {
	return ((libraryProp(pageOrProps)?.relation ?? []) as any[]).map((r) => r.id as string)
}

// DB(data source)에 있는 라이브러리 관계 속성 이름. 인스턴스 안에서 DB마다 한 번만 읽는다.
const cache = new Map<string, string>()
export async function libraryPropOf(dataSourceId: string): Promise<string> {
	const hit = cache.get(dataSourceId)
	if (hit) return hit
	const res = await fetchWithRetry(`${NOTION_API}/data_sources/${dataSourceId}`, { headers: notionHeaders() }, 2)
	if (!res.ok) throw new Error(`Notion DB 정보를 읽지 못했습니다(${res.status})`)
	const name = libraryKey((await res.json()).properties)
	if (!name) throw new Error(`DB에 "${LIBRARY_PROP}"(옛 이름 "${OLD_LIBRARY_PROP}") 관계 속성이 없습니다.`)
	cache.set(dataSourceId, name)
	return name
}
// 테스트용
export function clearLibraryPropCache() { cache.clear() }
