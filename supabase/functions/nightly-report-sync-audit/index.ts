// POST /functions/v1/nightly-report-sync-audit
// body: {} (x-admin-key 필요, GitHub Actions 매일 새벽 cron 전용)
//
// (2026-09-17, 리포트 동기화 안정화 3단계 중 마지막 단계) 전체 등록을 매번 다시 스캔하는 cron
// 대신, "전송로그(학원) DB"에서 오늘 성공적으로 발송된 보고서만 훑어서 그 등록들만 다시
// 재동기화한다. send-report가 발송 직전에 이미 한 번 강제 재동기화하지만(ensureFreshReportCache),
// 혹시 그 사이 편집이 있었거나 재동기화 자체가 조용히 실패했을 경우를 대비한 안전망이다.
//
// [FIX, 2026-09-19] 위 전송로그 스캔은 "오늘 보고서가 발송된 등록"만 잡아서, 출석 상태만 편집되고
// 보고서는 그날 보내지 않은 등록은 사각지대였다. sync-attendance가 즉시/시간별 배치에서
// report_cache도 함께 갱신하도록 고쳤지만(2026-09-19), Notion 자동화 웹훅이 여러 건을 한꺼번에
// 편집할 때 일부를 누락하는 경우가 있어 마지막 안전망을 하나 더 둔다: "오늘 편집된 출석(학원) DB
// 페이지"를 직접 스캔해서 그 등록들도 재동기화 대상에 포함시킨다. 두 스캔 모두 범위가 "오늘"로
// 고정되어 있어서, 등록 수가 계속 늘어나도 이 함수의 비용은 늘어나지 않는다.

import { requireAdminKey, CORS_HEADERS as ADMIN_CORS, notionQueryDatabaseAll } from "../_shared/adminShared.ts"
import { queryAllPages, mapWithConcurrency } from "../_shared/notionClient.ts"
import { makePageCache, firstRelationId } from "../_shared/reportCacheShared.ts"
import { syncReportCacheForRegistration } from "../_shared/reportCacheBuilder.ts"
import { syncAttendanceForRegistration } from "../_shared/attendanceSyncShared.ts"

const SEND_LOG_DB_ID = Deno.env.get("NOTION_SEND_LOG_DB_ID") ?? ""
// 출석(학원) DB의 데이터소스 ID (sync-attendance/index.ts와 동일한 값).
const DS_ATTENDANCE = "8aaba040-586b-8322-8437-87608a763415"

function todayIsoSeoul(): string {
  // 날짜만 필요 (Notion 날짜 필터는 date-only 문자열도 받는다).
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" })
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: ADMIN_CORS })

  const authError = await requireAdminKey(req)
  if (authError) return authError

  try {
    if (!SEND_LOG_DB_ID) {
      return new Response(JSON.stringify({ error: "NOTION_SEND_LOG_DB_ID Secret이 설정되어 있지 않습니다." }), {
        status: 500,
        headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
      })
    }

    const todayIso = todayIsoSeoul()
    const logs = await notionQueryDatabaseAll(SEND_LOG_DB_ID, {
      filter: {
        and: [
          { property: "발송일시", date: { on_or_after: todayIso } },
          { property: "발송 상태", select: { equals: "성공" } },
        ],
      },
    })

    const registrationIds = new Set<string>()
    logs.forEach((log: any) => {
      const id = log.properties?.["등록"]?.relation?.[0]?.id
      if (id) registrationIds.add(id)
    })

    // [FIX, 2026-09-19] 오늘 편집된 출석 페이지의 등록도 함께 포함한다 (위 주석 참고).
    const attendancePages = await queryAllPages(DS_ATTENDANCE, {
      timestamp: "last_edited_time",
      last_edited_time: { on_or_after: todayIso },
    })
    attendancePages.forEach((page: any) => {
      const id = firstRelationId(page.properties?.["등록"])
      if (id) registrationIds.add(id)
    })

    const ids = Array.from(registrationIds)
    const cachedGetPage = makePageCache()
    let syncedCount = 0
    let errorCount = 0
    await mapWithConcurrency(ids, 3, async (registrationId) => {
      try {
        await syncAttendanceForRegistration(registrationId)
        await syncReportCacheForRegistration(registrationId, cachedGetPage)
        syncedCount++
      } catch (err) {
        errorCount++
        console.error(`nightly-report-sync-audit: ${registrationId} 재동기화 실패:`, (err as Error).message)
      }
    })

    return new Response(
      JSON.stringify({
        checkedLogs: logs.length,
        checkedAttendancePages: attendancePages.length,
        registrations: ids.length,
        synced: syncedCount,
        errors: errorCount,
      }),
      { headers: { ...ADMIN_CORS, "Content-Type": "application/json" } },
    )
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500,
      headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
    })
  }
})
