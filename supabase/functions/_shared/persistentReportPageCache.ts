// 반별 일일보고서 체인 전용 공용 페이지 캐시.
// Edge Function 호출이 학생마다 새로 시작되어도 같은 runKey를 사용하면, 앞 학생이 이미 읽은
// 그룹 공통 학습기록/교재/클래스 페이지를 Supabase에서 재사용한다.

import { getPage } from "./notionClient.ts"
import { fetchSupabaseWithRetry } from "./reportCacheShared.ts"

const SB_URL = Deno.env.get("SB_URL") ?? ""
const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""

function requireEnv() {
  if (!SB_URL || !SB_SERVICE_ROLE_KEY) {
    throw new Error("SB_URL / SB_SERVICE_ROLE_KEY Secrets가 설정되어 있지 않습니다.")
  }
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SB_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
    ...extra,
  }
}

export function makePersistentReportPageCache(runKey: string) {
  requireEnv()
  const local = new Map<string, Promise<any>>()

  return function cachedGetPage(pageId: string): Promise<any> {
    let pending = local.get(pageId)
    if (pending) return pending

    pending = (async () => {
      const query = new URLSearchParams({
        run_key: `eq.${runKey}`,
        notion_page_id: `eq.${pageId}`,
        select: "page_json",
        limit: "1",
      })
      const cachedRes = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/report_source_cache?${query.toString()}`, {
        headers: headers(),
      })
      if (!cachedRes.ok) {
        throw new Error(`report_source_cache 조회 실패: ${cachedRes.status} ${await cachedRes.text()}`)
      }
      const rows = await cachedRes.json()
      if (rows[0]?.page_json) return rows[0].page_json

      const page = await getPage(pageId)
      const saveRes = await fetchSupabaseWithRetry(
        `${SB_URL}/rest/v1/report_source_cache?on_conflict=run_key,notion_page_id`,
        {
          method: "POST",
          headers: headers({
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates,return=minimal",
          }),
          body: JSON.stringify([{ run_key: runKey, notion_page_id: pageId, page_json: page, cached_at: new Date().toISOString() }]),
        },
      )
      if (!saveRes.ok) {
        throw new Error(`report_source_cache 저장 실패: ${saveRes.status} ${await saveRes.text()}`)
      }
      return page
    })()

    local.set(pageId, pending)
    return pending
  }
}

export async function clearPersistentReportPageCache(runKey: string): Promise<void> {
  if (!runKey || !SB_URL || !SB_SERVICE_ROLE_KEY) return
  const res = await fetchSupabaseWithRetry(
    `${SB_URL}/rest/v1/report_source_cache?run_key=eq.${encodeURIComponent(runKey)}`,
    { method: "DELETE", headers: headers({ Prefer: "return=minimal" }) },
  )
  if (!res.ok) throw new Error(`report_source_cache 실행 캐시 삭제 실패: ${res.status} ${await res.text()}`)
}

export async function cleanupExpiredReportPageCache(): Promise<void> {
  if (!SB_URL || !SB_SERVICE_ROLE_KEY) return
  const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
  const res = await fetchSupabaseWithRetry(
    `${SB_URL}/rest/v1/report_source_cache?cached_at=lt.${encodeURIComponent(cutoff)}`,
    { method: "DELETE", headers: headers({ Prefer: "return=minimal" }) },
  )
  if (!res.ok) throw new Error(`report_source_cache 만료 캐시 정리 실패: ${res.status} ${await res.text()}`)
}
