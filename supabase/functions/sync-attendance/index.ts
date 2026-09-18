// POST /functions/v1/sync-attendance
// body: { pageId: string }        -- 출석 1건만 즉시 반영 (출석(학원) DB 자동화: "레코드가 생성/편집될 때" → 웹훅 보내기)
// body: { mode: "incremental" }   -- 마지막 동기화 이후 수정된 출석만 반영 (GitHub Actions cron, x-admin-key 필요)
// body: { mode: "reconcile" }     -- 전체 출석을 다시 훑어서 삭제분까지 정합성을 맞춤 (GitHub Actions 매일 cron, x-admin-key 필요)
//
// 출석(학원) DB를 읽어서 attendance_records(Supabase)에 원자료로 누적한다. sync-report-cache는
// 더 이상 리포트를 만들 때마다 Notion 출석 DB를 통째로 조회하지 않고, 이 테이블만 읽는다.
// (원자료 아키텍처 1단계 - 로드맵 참고)
//
// [FIX, 2026-09-19] sync-report-cache의 웹훅 대상 DB 목록(등록/학습기록/학습활동/보고서/정규교재/일정)에
// 출석(학원) DB가 원래 빠져 있었다. 그래서 출석 상태만 바꾸는 편집은 attendance_records에는 즉시
// 반영되지만, report_cache(학부모 리포트 웹앱이 실제로 읽는 캐시)는 그날 보고서가 따로 발송되지
// 않는 한 갱신될 계기가 전혀 없었다 (2026-09-19 실측 확인: 여러 건을 한꺼번에 편집하면 Notion
// 자동화가 일부 페이지의 웹훅을 누락하기도 해서, attendance_records만 시간별 배치로 자가 복구되고
// report_cache는 그대로 낡아 있는 사례가 발생함). 이제 아래 pageId 경로와 incremental 경로 모두,
// 영향받은 등록의 report_cache 재계산 작업을 sync_queue에 함께 적재한다. reconcile은 매일 전체를
// 훑기 때문에 여기서까지 하면 등록 수만큼 매일 report_cache를 전부 재계산하게 되어 2026-09-17에
// 없앤 "매시간 전체 재계산" 문제가 되살아나므로 일부러 제외한다 -- reconcile이 놓칠 수 있는 부분은
// nightly-report-sync-audit이 별도로 커버한다.

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
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"

// 출석(학원) DB의 데이터소스 ID (sync-report-cache/index.ts와 동일한 값).
const DS_ATTENDANCE = "8aaba040-586b-8322-8437-87608a763415"
const SYNC_SOURCE = "attendance"
// 클럭 오차/처리 중 발생한 수정을 놓치지 않기 위해 다음 커서를 이만큼 여유있게 되돌려서 저장한다.
const CURSOR_SAFETY_MARGIN_MS = 2 * 60 * 1000

function isNonNull<T>(v: T | null): v is T {
  return v !== null
}

// 영향받은 등록들의 report_cache 재계산을 큐에 적재한다 (sync-report-cache의 기본 웹훅 경로와 동일한
// 방식: enqueueSync + wakeSyncQueueWorker). 여기서 실패해도 출석 원자료 반영 자체는 이미 끝났으므로
// throw하지 않고 로그만 남긴다 -- report_cache는 nightly-report-sync-audit이 최종 안전망이다.
async function enqueueReportCacheRefresh(registrationIds: Iterable<string>): Promise<void> {
  const ids = Array.from(new Set(registrationIds)).filter(Boolean)
  if (ids.length === 0) return
  try {
    await Promise.all(ids.map((id) => enqueueSync("sync-report-cache", { pageId: id })))
    wakeSyncQueueWorker()
  } catch (err) {
    console.error("sync-attendance: report_cache 재동기화 큐 적재 실패:", (err as Error)?.message)
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

      // report_cache는 여기서 일부러 건드리지 않는다 (위 [FIX, 2026-09-19] 주석 참고).
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

      // [FIX, 2026-09-19] 이 배치가 새로 반영한 출석들의 등록만 골라 report_cache도 함께 갱신한다.
      // Notion 자동화 웹훅이 (특히 여러 건을 한꺼번에 편집할 때) 일부 페이지를 누락해도, 이 시간별
      // 배치가 늦지 않게 attendance_records와 report_cache를 함께 자가 복구해준다.
      await enqueueReportCacheRefresh(rows.map((r) => r.registration_id))

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

    // [FIX, 2026-09-19] 출석 편집도 등록/학습기록 편집과 동일하게 즉시 report_cache 재계산을
    // 큐에 적재한다 (기존에는 attendance_records만 갱신되고 report_cache는 그대로 낡아 있었음).
    await enqueueReportCacheRefresh([row.registration_id])

    return new Response(JSON.stringify({ synced: 1 }), {
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
