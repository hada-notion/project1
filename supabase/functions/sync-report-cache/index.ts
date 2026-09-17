// POST /functions/v1/sync-report-cache
// body: { registrationId: string } 또는 { pageId: string }
//   -- 등록/학습기록/학습활동/보고서 DB의 Notion 버튼(웹훅 보내기) / "생성 또는 편집 시" 자동화에서
//      호출하는 기본 경로. 즉시 202를 반환하고, 실제 재계산은 백그라운드에서 처리한다.
// body: { registrationId, awaitCompletion: true }  (x-admin-key 필요)
//   -- 내부 전용 동기 경로. 응답을 기다렸다가 결과를 그대로 반환한다.
//      보고서 발송 직전(send-report) 강제 재동기화, 야간 점검(nightly-report-sync-audit)에서 사용.
// body: { mode: "all" }  (x-admin-key 필요)
//   -- 토큰이 있는 모든 등록을 다시 계산하는 수동 전체 재계산. 더 이상 정기 cron으로는 호출되지
//      않고(2026-09-17 제거), 문제 발생 시 수동 점검용으로만 남겨둔다.
//
// (2026-09-17, 리포트 동기화 안정화 3단계)
// 매시간 전체 재계산 cron이 Notion API에 부담을 주고, 다른 버튼/웹훅 작업과 자원을 경�쟁하는 문제가
// 있어 제거했다. 대신:
//   1) 등록/학습기록/학습활동/보고서 DB에 "생성 또는 편집 시" 즉시 웹훅을 걸어 편집 시점에 곧바로
//      갱신하고 (이 파일의 기본 경로),
//   2) 보고서 발송 직전 send-report가 awaitCompletion으로 한 번 더 강제 재동기화하고,
//   3) 야간에 그날 전송로그만 훑어서 한 번 더 확인한다 (nightly-report-sync-audit).
// 이 파일은 이제 위 세 가지가 공통으로 쓰는 진입점 역할만 하고, 실제 조립 로직은
// _shared/reportCacheBuilder.ts로 옮겼다 (send-report/nightly-report-sync-audit에서도 재사용).
//
// 웹훅 타임아웃 문제: 등록 1건만 재계산해도 Notion API를 수십 번 호출해야 해서, 이 함수가 항상 전체
// 처리를 끝낼 때까지 기다렸다가 응답하면 Notion의 "웹훅 보내기" 자동화가 응답을 기다리다 타임아웃으로
// 실패 표시를 띄우는 경우가 있었다 (cascade-delete에서 이미 겪었던 문제와 동일). 그래서
// cascade-delete와 동일한 202+백그라운드 패턴(_shared/backgroundTask.ts)을 적용한다.

import { requireAdminKey, CORS_HEADERS as ADMIN_CORS } from "../_shared/adminShared.ts"
import { queryAllPages, mapWithConcurrency, extractPageId } from "../_shared/notionClient.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"
import { firstRelationId, makePageCache, upsertReportCacheRows, type ReportCacheRow } from "../_shared/reportCacheShared.ts"
import { buildCacheRowForRegistration, syncReportCacheForRegistration } from "../_shared/reportCacheBuilder.ts"

// 워크스페이스 구조상 고정값인 데이터소스 ID.
const DS_REGISTRATION = "16dba040-586b-838a-ae3c-876c0e9cd474"

// webhook body(등록/학습기록/학습활동/보고서 페이지 id)로부터 실제 리포트 캐시 대상인 "등록" 페이지
// id를 알아낸다. 등록 페이지 자신에는 "등록" 관계 속성이 없으므로(자기 자신이 등록이므로) 그대로
// pageId를 반환하고, 학습기록/학습활동/보고서 페이지는 "등록" 관계를 따라간다.
async function resolveRegistrationId(pageId: string, cachedGetPage: (id: string) => Promise<any>): Promise<string> {
  const page = await cachedGetPage(pageId)
  const relatedRegistrationId = firstRelationId(page.properties?.["등록"])
  return relatedRegistrationId ?? pageId
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
      const registrationId = await resolveRegistrationId(rawId, cachedGetPage)
      const row = await syncReportCacheForRegistration(registrationId, cachedGetPage)
      return new Response(JSON.stringify({ synced: row ? 1 : 0, registrationId }), {
        headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
      })
    }

    // Notion 버튼(웹훅 보내기) / 각 DB의 "생성 또는 편집 시" 자동화 호출 경로 -- 다른 버튼 웹훅들과
    // 동일하게 별도 인증 없이 신뢰하고, 즉시 202를 돌려준 뒤 백그라운드에서 처리한다.
    runInBackground(async () => {
      try {
        const registrationId = await resolveRegistrationId(rawId, cachedGetPage)
        await syncReportCacheForRegistration(registrationId, cachedGetPage)
      } catch (err) {
        console.error("sync-report-cache 백그라운드 처리 실패:", (err as Error).message)
      }
    })
    return respondAccepted({ pageId: rawId })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500,
      headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
    })
  }
})
