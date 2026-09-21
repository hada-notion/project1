// POST /functions/v1/sync-report-cache
// body: { registrationId: string } 또는 { pageId: string }
//   -- 등록/학습기록/학습활동/보고서/정규교재/일정 DB의 Notion 버튼(웹훅 보내기) / "생성 또는 편집 시"
//      자동화에서 호출하는 기본 경로. (2026-09-22, PART N-4) 즉시 재계산해서 결과를 그대로
//      반환한다 -- 예전에는 202를 반환하고 sync_queue에 적재해 process-sync-queue 워커가
//      처리했지만(2026-09-18, 큐 기반 순차 처리 도입), 개별(단건) 트리거는 즉시 동기 처리로
//      되돌린다는 원칙에 따라 되돌렸다 (아래 설명 참고).
// body: { registrationId, awaitCompletion: true }  (x-admin-key 필요)
//   -- 내부 전용 동기 경로. 응답을 기다렸다가 결과를 그대로 반환한다.
//      보고서 발송 직전(send-report) 강제 재동기화, 야간 점검(nightly-report-sync-audit)에서 사용.
// body: { mode: "all" }  (x-admin-key 필요)
//   -- 토큰이 있는 모든 등록을 다시 계산하는 수동 전체 재계산. 더 이상 정기 cron으로는 호출되지
//      않고(2026-09-17 제거), 문제 발생 시 수동 점검용으로만 남겨둔다.
//
// (2026-09-17, 리포트 동기화 안정화 3단계)
// 매시간 전체 재계산 cron이 Notion API에 부담을 주고, 다른 버튼/웹훅 작업과 자원을 경쟁하는 문제가
// 있어 제거했다. 대신:
//   1) 등록/학습기록/학습활동/보고서 DB에 "생성 또는 편집 시" 즉시 웹훅을 걸어 편집 시점에 곧바로
//      갱신하고 (이 파일의 기본 경로),
//   2) 보고서 발송 직전 send-report가 awaitCompletion으로 한 번 더 강제 재동기화하고,
//   3) 야간에 그날 전송로그만 훑어서 한 번 더 확인한다 (nightly-report-sync-audit).
// 이 파일은 이제 위 세 가지가 공통으로 쓰는 진입점 역할만 하고, 실제 조립 로직은
// _shared/reportCacheBuilder.ts로 옮겼다 (send-report/nightly-report-sync-audit에서도 재사용).
//
// [큐 기반 순차 처리 도입, 2026-09-18] 등록/학습기록/학습활동/보고서/정규교재/일정 DB 6개가 동시에
// 편집되면 웹훅이 한꺼번에 몰릴 수 있다. 예전에는 각 요청이 받는 즉시 EdgeRuntime.waitUntil로
// "따로따로" 백그라운드 처리를 했는데(2026-09-10 도입, _shared/backgroundTask.ts), 이 방식은 요청
// 하나하나는 타임아웃 없이 끝나지만 서로 다른 요청들 사이의 순서/조율이 전혀 없었다. 그래서 한동안
// sync_queue에 적재만 하고 202를 반환하는 방식으로 바꿨었다 (실제 처리 로직은
// _shared/syncReportCacheTarget.ts로 옮겨서, awaitCompletion/mode:"all" 경로와 공유).
//
// [2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환] 그런데 이 함수를 트리거하는 automation은
// "등록/학습기록/학습활동/보고서/정규교재/일정 DB의 한 페이지가 편집됨" 이라는 개별(단건) 이벤트이고,
// 실제 재계산 대상(resolveRegistrationIds)도 대부분 등록 1건 또는 소수의 등록이다 (정규교재/일정처럼
// 여러 등록에 걸쳐 있는 경우도 있지만, 이미 awaitCompletion 경로가 큐 없이 동기로 이 정도 규모를
// 처리해왔다). "개별 트리거는 즉시 동기 처리, 일괄 트리거만 큐 사용"이라는 원칙에 맞춰 기본 경로도
// awaitCompletion 경로와 동일하게 즉시 동기 처리로 되돌렸다. mode:"all"(수동 전체 재계산)은 원래도
// 큐를 쓰지 않고 그 자리에서 전체를 처리하던 경로라 변경하지 않았다.

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