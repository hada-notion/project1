// POST /functions/v1/sync-report-cache
// body: { registrationId: string } 또는 { pageId: string }
//   -- 등록 페이지의 수동 "학생 페이지 동기화" 버튼과 유지 중인 정규교재·일정 자동화가 호출한다.
//      단건/소수 등록을 즉시 재계산하고 결과를 반환한다.
// body: { registrationId, awaitCompletion: true }  (x-admin-key 필요)
//   -- 보고서 발송 직전(send-report)과 야간 점검(nightly-report-sync-audit)이 사용하는 내부 경로다.
// body: { mode: "all" }  (x-admin-key 필요)
//   -- 토큰이 있는 모든 등록을 다시 계산하는 수동 점검용 경로다. 정기 cron에서는 호출하지 않는다.
//
// [현재 상태, 2026-09-25] 등록·학습기록·학습활동·보고서 DB의 실시간 캐시 웹훅은 수업 생성 중
// Notion API 호출량을 줄이기 위해 제거했다. 정규교재는 변경 시 여러 학생에게 영향을 주고 편집 시점이
// 일정하지 않아 자동화를 유지하며, 일정 자동화도 유지한다. 시간당 출석 증분 동기화, 보고서 발송 직전
// 강제 재계산, 야간 점검, 수동 동기화가 나머지 안전망이다.
// 실제 캐시 조립 로직은 _shared/reportCacheBuilder.ts에 있다.

import { requireAdminKey, CORS_HEADERS as ADMIN_CORS } from "../_shared/adminShared.ts"
import { queryAllPages, mapWithConcurrency, extractPageId } from "../_shared/notionClient.ts"
import { makePageCache } from "../_shared/reportCacheShared.ts"
import { upsertReportCacheRows, type ReportCacheRow } from "../_shared/reportCacheShared.ts"
import { buildCacheRowForRegistration, syncReportCacheForRegistration } from "../_shared/reportCacheBuilder.ts"
import { resolveRegistrationIds, DS_REGISTRATION } from "../_shared/syncReportCacheTarget.ts"

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: ADMIN_CORS })

  try {
    const body = await req.json().catch(() => ({}))
    const cachedGetPage = makePageCache()

    if (body?.mode === "all") {
      const authError = await requireAdminKey(req)
      if (authError) return authError
      const registrations = await queryAllPages(DS_REGISTRATION, {
        property: "토큰",
        rich_text: { is_not_empty: true },
      })
      const rows = await mapWithConcurrency(registrations, 4, (reg) => buildCacheRowForRegistration(reg, cachedGetPage))
      const validRows = rows.filter((r): r is ReportCacheRow => r !== null)
      await upsertReportCacheRows(validRows)
      return new Response(JSON.stringify({ synced: validRows.length, skipped: rows.length - validRows.length }), {
        headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
      })
    }

    const rawId = (typeof body?.registrationId === "string" && body.registrationId) || extractPageId(body)
    if (!rawId) throw new Error("registrationId를 찾을 수 없습니다.")

    if (body?.awaitCompletion === true) {
      const authError = await requireAdminKey(req)
      if (authError) return authError
    }

    // Notion 버튼(웹훅 보내기) / 각 DB의 "생성 또는 편집 시" 자동화 호출 경로 -- 다른 버튼 웹훅들과
    // 동일하게 별도 인증 없이 신뢰한다. (2026-09-22, PART N-4) 개별 트리거라 큐를 거치지 않고 그
    // 자리에서 바로 재계산하고, 완료된 결과를 그대로 응답한다 (awaitCompletion 경로와 동일한 처리).
    const registrationIds = await resolveRegistrationIds(rawId, cachedGetPage)
    const rows = await mapWithConcurrency(registrationIds, 4, (id) => syncReportCacheForRegistration(id, cachedGetPage))
    const synced = rows.filter((r): r is ReportCacheRow => r !== null).length
    return new Response(JSON.stringify({ synced, registrationIds }), {
      headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500,
      headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
    })
  }
})