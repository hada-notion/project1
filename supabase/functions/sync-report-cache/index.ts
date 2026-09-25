// POST /functions/v1/sync-report-cache
// body: { registrationId: string } 또는 { pageId: string }
//   -- 등록 페이지의 수동 "학생 페이지 동기화" 버튼과 유지 중인 정규교재·일정 자동화가 호출한다.
//   -- 등록 페이지 자체가 대상이면 토큰 보장 -> 출석 원본 -> 학습기록/학습활동 포함 완성 캐시까지
//      전체 최신화한다. 정규교재·일정 자동화는 영향 등록의 캐시만 재계산해 불필요한 출석 전체 조회를 막는다.
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
import { refreshStudentReport } from "../_shared/dailyReportRefresh.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"

function isRegistrationPage(page: any): boolean {
  const props = page?.properties ?? {}
  return props["학생정보"]?.type === "relation" &&
    props["클래스"]?.type === "relation" &&
    props["토큰"]?.type === "rich_text"
}

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

    const sourcePage = await cachedGetPage(rawId)
    const registrationIds = await resolveRegistrationIds(rawId, cachedGetPage)

    if (isRegistrationPage(sourcePage)) {
      const doFullRefresh = async () => {
        // 같은 버튼 안에서 토큰이 없으면 먼저 발급하고, 출석 원본과 학습기록·학습활동을 포함한
        // 완성 캐시까지 갱신한다. 알림톡 발송 함수는 호출하지 않는다.
        await refreshStudentReport(rawId)
      }

      // 웹앱 FAB는 완료 응답을 기다린 뒤 데이터를 다시 읽으므로 동기로 처리한다. Notion 등록 페이지
      // 버튼은 웹훅 응답 제한에 걸리지 않도록 빠른 202를 반환하고 실제 최신화는 백그라운드에서 끝낸다.
      const explicitRegistrationRequest = typeof body?.registrationId === "string"
      if (explicitRegistrationRequest || body?.awaitCompletion === true) {
        await doFullRefresh()
        return new Response(JSON.stringify({ synced: 1, registrationIds: [rawId], fullRefresh: true }), {
          headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
        })
      }

      runInBackground(async () => {
        try {
          await doFullRefresh()
        } catch (err) {
          console.error(`등록 학생 페이지 수동 동기화 실패(${rawId}):`, (err as Error).message)
        }
      })
      return respondAccepted({ registrationIds: [rawId], fullRefresh: true })
    }

    // 정규교재·일정 자동화는 기존처럼 영향받는 등록의 완성 캐시만 다시 만든다. 여기까지 전체 출석
    // 동기화를 확대하면 편집 한 건이 여러 학생의 누적 출석 조회로 fan-out되므로 의도적으로 분리한다.
    const rows = await mapWithConcurrency(registrationIds, 4, (id) => syncReportCacheForRegistration(id, cachedGetPage))
    const synced = rows.filter((r): r is ReportCacheRow => r !== null).length
    return new Response(JSON.stringify({ synced, registrationIds, fullRefresh: false }), {
      headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500,
      headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
    })
  }
})