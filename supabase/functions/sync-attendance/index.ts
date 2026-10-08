// POST /functions/v1/sync-attendance — 출석 원자료 예약 동기화 전용.
// body: { mode: "incremental" } — 마지막 동기화 이후 수정분과 영향받은 report_cache 갱신.
// body: { mode: "reconcile" } — 전체 출석을 대조하고 삭제된 원자료까지 반영.
// 두 모드 모두 x-admin-key 필요. Notion 출석 생성·편집 웹훅은 연결하지 않는다.
// 발송 전 최신화는 dailyReportRefresh.ts가 등록 단위로 별도 실행한다.

import { requireAdminKey, CORS_HEADERS as ADMIN_CORS } from "../_shared/adminShared.ts"
import { queryAllPages, mapWithConcurrency } from "../_shared/notionClient.ts"
import { DS_ATTENDANCE } from "../_shared/constants.ts"
import {
  buildAttendanceRow,
  upsertAttendanceRows,
  selectAllAttendanceIds,
  deleteAttendanceRowsByIds,
  getSyncCursor,
  setSyncCursor,
} from "../_shared/attendanceSyncShared.ts"
import { makePageCache } from "../_shared/reportCacheShared.ts"
import { syncReportCacheForRegistration } from "../_shared/reportCacheBuilder.ts"

const SYNC_SOURCE = "attendance"
// 클럭 오차/처리 중 발생한 수정을 놓치지 않기 위해 다음 커서를 이만큼 여유있게 되돌려서 저장한다.
const CURSOR_SAFETY_MARGIN_MS = 2 * 60 * 1000

function isNonNull<T>(v: T | null): v is T {
  return v !== null
}

// 증분 동기화로 반영한 출석의 등록만 골라 report_cache를 재계산한다.
// 실패 시 출석 원자료 반영은 유지하고 로그를 남긴다. 발송 전 최신화는 별도 경로다.
async function refreshReportCacheForRegistrations(registrationIds: Iterable<string>): Promise<void> {
  const ids = Array.from(new Set(registrationIds)).filter(Boolean)
  if (ids.length === 0) return
  try {
    const cachedGetPage = makePageCache()
    await mapWithConcurrency(ids, 4, (id) => syncReportCacheForRegistration(id, cachedGetPage))
  } catch (err) {
    console.error("sync-attendance: report_cache 재동기화 실패:", (err as Error)?.message)
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: ADMIN_CORS })

  try {
    const body = await req.json().catch(() => ({}))

    if (body?.mode === "reconcile") {
      // 예약 동기화(GitHub Actions 매일 cron)만 이 경로를 쓰므로 관리자 키로 보호한다.
      const authError = await requireAdminKey(req)
      if (authError) return authError

      const pages = await queryAllPages(DS_ATTENDANCE, {})
      const rows = pages.map(buildAttendanceRow).filter(isNonNull)
      await upsertAttendanceRows(rows)

      // Notion에서 삭제된 출석(증분 동기화로는 감지할 수 없음)을 여기서 걸러낸다.
      const freshIds = new Set(rows.map((r) => r.notion_page_id))
      const existingIds = await selectAllAttendanceIds()
      const idsToDelete = Array.from(existingIds).filter((id) => !freshIds.has(id))
      await deleteAttendanceRowsByIds(idsToDelete)

      await setSyncCursor(SYNC_SOURCE, new Date().toISOString())

      // 전체 정합성 점검은 출석 원자료만 반영한다. report_cache 전체 재계산은 하지 않는다.
      return new Response(JSON.stringify({ synced: rows.length, deleted: idsToDelete.length }), {
        headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
      })
    }

    if (body?.mode === "incremental") {
      // 예약 동기화(GitHub Actions cron)만 이 경로를 쓰므로 관리자 키로 보호한다.
      const authError = await requireAdminKey(req)
      if (authError) return authError

      const runStartedAt = new Date()
      const cursor = (await getSyncCursor(SYNC_SOURCE)) ?? new Date(runStartedAt.getTime() - 24 * 60 * 60 * 1000).toISOString()

      const pages = await queryAllPages(DS_ATTENDANCE, {
        timestamp: "last_edited_time",
        last_edited_time: { after: cursor },
      })
      const rows = pages.map(buildAttendanceRow).filter(isNonNull)
      await upsertAttendanceRows(rows)

      const newCursor = new Date(runStartedAt.getTime() - CURSOR_SAFETY_MARGIN_MS).toISOString()
      await setSyncCursor(SYNC_SOURCE, newCursor)

      // 이번 배치에서 반영한 출석의 등록만 보고서 캐시까지 갱신한다.
      await refreshReportCacheForRegistrations(rows.map((r) => r.registration_id))

      return new Response(JSON.stringify({ synced: rows.length }), {
        headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
      })
    }

    // 개별 pageId 웹훅은 폐기했다. 예약 실행의 두 mode만 허용한다.
    return new Response(JSON.stringify({ error: "지원하지 않는 mode입니다. incremental 또는 reconcile을 지정하세요." }), {
      status: 400,
      headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
    })
  } catch (err) {
    // 원인 파악을 위해 Supabase Logs에도 그대로 남긴다 (응답 본문에는 이미 담고 있었지만 로그에는 안 보였음).
    console.error("sync-attendance error:", err)
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500,
      headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
    })
  }
})
