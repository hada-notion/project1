// POST /functions/v1/sync-attendance
// body: { pageId: string }        -- 출석 1건만 즉시 반영 (출석(학원) DB 자동화: "레코드가 생성/편집될 때" → 웹훅 보내기)
// body: { mode: "incremental" }   -- 마지막 동기화 이후 수정된 출석만 반영 (GitHub Actions cron, x-admin-key 필요)
// body: { mode: "reconcile" }     -- 전체 출석을 다시 훑어서 삭제분까지 정합성을 맞춤 (GitHub Actions 매일 cron, x-admin-key 필요)
//
// 출석(학원) DB를 읽어서 attendance_records(Supabase)에 원자료로 누적한다. sync-report-cache는
// 더 이상 리포트를 만들 때마다 Notion 출석 DB를 통째로 조회하지 않고, 이 테이블만 읽는다.
// (원자료 아키텍처 1단계 - 로드맵 참고)

import { requireAdminKey, CORS_HEADERS as ADMIN_CORS } from "../_shared/adminShared.ts"
import { getPage, queryAllPages, extractPageId } from "../_shared/notionClient.ts"
import {
  buildAttendanceRow,
  upsertAttendanceRows,
  selectAllAttendanceIds,
  deleteAttendanceRowsByIds,
  getSyncCursor,
  setSyncCursor,
} from "../_shared/attendanceSyncShared.ts"

// 출석(학원) DB의 데이터소스 ID (sync-report-cache/index.ts와 동일한 값).
const DS_ATTENDANCE = "8aaba040-586b-8322-8437-87608a763415"
const SYNC_SOURCE = "attendance"
// 클럭 오차/처리 중 발생한 수정을 놓치지 않기 위해 다음 커서를 이만큼 여유있게 되돌려서 저장한다.
const CURSOR_SAFETY_MARGIN_MS = 2 * 60 * 1000

function isNonNull<T>(v: T | null): v is T {
  return v !== null
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

      return new Response(JSON.stringify({ synced: rows.length }), {
        headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
      })
    }

    // Notion 자동화(레코드 생성/편집 시 웹훅)에서 호출하는 경로 -- 다른 버튼/자동화 웹훅들과
    // 동일하게 별도 인증 없이 신뢰한다.
    const pageId = (typeof body?.pageId === "string" && body.pageId) || extractPageId(body)
    if (!pageId) throw new Error("pageId를 찾을 수 없습니다.")
    const page = await getPage(pageId)
    const row = buildAttendanceRow(page)
    if (!row) {
      return new Response(JSON.stringify({ synced: 0, skipped: 1, reason: "등록 관계가 비어있음" }), {
        headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
      })
    }
    await upsertAttendanceRows([row])

    return new Response(JSON.stringify({ synced: 1 }), {
      headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500,
      headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
    })
  }
})
