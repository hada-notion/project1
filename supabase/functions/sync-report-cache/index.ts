// POST /functions/v1/sync-report-cache
// body: { registrationId: string } 또는 { pageId: string }
//   -- 등록/학습기록/학습활동/보고서/정규교재/일정 DB의 Notion 버튼(웹훅 보내기) / "생성 또는 편집 시"
//      자동화에서 호출하는 기본 경로. 즉시 202를 반환하고, 실제 재계산은 sync_queue에 적재해서
//      process-sync-queue 워커가 순서대로 처리한다 (2026-09-18, 큐 기반 순차 처리 도입 -- 아래 설명).
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
// 하나하나는 타임아웃 없이 끝나지만 서로 다른 요청들 사이의 순서/조율이 전혀 없었다. 이제는 실제
// 처리를 바로 하지 않고 _shared/syncQueue.ts로 sync_queue 테이블에 작업 1건을 적재하기만 하고
// 202를 반환한다. 적재된 작업은 process-sync-queue 워커가 "쌓인 순서대로 하나씩만" 꺼내서 처리하므로,
// 아무리 많이 동시에 들어와도 실행이 멈추지 않고(대기열에 쌓일 뿐) 유실 없이 전부 순차적으로
// 처리된다. 이 함수가 직접 재계산하던 실제 로직(resolveRegistrationIds 등)은
// _shared/syncReportCacheTarget.ts로 옮겨서, 이 함수의 awaitCompletion/mode:"all" 경로와
// process-sync-queue 워커가 동일한 코드를 공유한다 (정규교재/일정 DB 웹훅에 대한 상세 설명도 그
// 파일로 옮겼다).

import { requireAdminKey, CORS_HEADERS as ADMIN_CORS } from "../_shared/adminShared.ts"
import { queryAllPages, mapWithConcurrency, extractPageId } from "../_shared/notionClient.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { makePageCache, upsertReportCacheRows, type ReportCacheRow } from "../_shared/reportCacheShared.ts"
import { buildCacheRowForRegistration, syncReportCacheForRegistration } from "../_shared/reportCacheBuilder.ts"
import { resolveRegistrationIds, DS_REGISTRATION } from "../_shared/syncReportCacheTarget.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"

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
      const registrationIds = await resolveRegistrationIds(rawId, cachedGetPage)
      const rows = await mapWithConcurrency(registrationIds, 4, (id) => syncReportCacheForRegistration(id, cachedGetPage))
      const synced = rows.filter((r): r is ReportCacheRow => r !== null).length
      return new Response(JSON.stringify({ synced, registrationIds }), {
        headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
      })
    }

    // Notion 버튼(웹훅 보내기) / 각 DB의 "생성 또는 편집 시" 자동화 호출 경로 -- 다른 버튼 웹훅들과
    // 동일하게 별도 인증 없이 신뢰한다. 큐에 적재만 하고 즉시 202를 돌려준다 (실제 처리는
    // process-sync-queue 워커가 쌓인 순서대로 한다).
    await enqueueSync("sync-report-cache", { pageId: rawId })
    wakeSyncQueueWorker()
    return respondAccepted({ pageId: rawId, queued: true })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500,
      headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
    })
  }
})
