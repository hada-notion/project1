// 메뉴(학원) DB의 데이터소스 id를 찾는다 (v2.7.14).
// 메뉴 DB는 다른 함수들이 DS.xxx 형태로 쿼리하지 않아 전용 Secret이 없다. 예전 status-watchdog은 원본
// 데이터소스 id를 코드에 직접 적어 두어, 운영 학원에서는 이 대상이 매번 "찾을 수 없음"으로 실패하고
// 메뉴 [다음주 수업 일괄 생성]이 "작업중"으로 멈춰도 회수되지 않았다.
// 순서: Secret DATA_SOURCE_MENU_ID가 있으면 그 값 → 없으면 이 학원 인테그레이션이 볼 수 있는 데이터소스 중
// 이름이 정확히 "메뉴(학원) DB"이고 휴지통에 없는 것이 하나뿐일 때 그 id. 0개거나 여러 개면 null(건너뜀).
import { NOTION_API } from "./constants.ts"
import { fetchWithRetry, notionHeaders } from "./notionClient.ts"

export const MENU_DS_TITLE = "메뉴(학원) DB"

function titleOf(item: any): string {
	const parts = Array.isArray(item?.title) ? item.title : []
	return parts.map((t: any) => t?.plain_text ?? "").join("").trim()
}

// 검색 결과에서 메뉴 데이터소스 id를 고른다. 같은 이름이 둘 이상이면 어느 쪽인지 알 수 없으므로 null.
export function pickMenuDataSourceId(results: any[]): string | null {
	const hits = (results ?? []).filter((item) =>
		item?.object === "data_source" &&
		item?.in_trash !== true &&
		item?.archived !== true &&
		titleOf(item) === MENU_DS_TITLE
	)
	return hits.length === 1 ? String(hits[0].id) : null
}

let cached: string | null | undefined

export async function resolveMenuDataSourceId(): Promise<string | null> {
	const fromEnv = (Deno.env.get("DATA_SOURCE_MENU_ID") ?? "").trim()
	if (fromEnv) return fromEnv
	if (cached !== undefined) return cached
	const res = await fetchWithRetry(`${NOTION_API}/search`, {
		method: "POST",
		headers: notionHeaders(),
		body: JSON.stringify({
			query: MENU_DS_TITLE,
			filter: { property: "object", value: "data_source" },
			page_size: 20,
		}),
	})
	if (!res.ok) throw new Error(`search ${MENU_DS_TITLE} failed: ${res.status} ${await res.text()}`)
	const data = await res.json()
	cached = pickMenuDataSourceId(data?.results ?? [])
	return cached
}
