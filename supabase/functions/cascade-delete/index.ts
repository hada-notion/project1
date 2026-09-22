// Supabase Edge Function: cascade-delete (v13)
//
// v13 변경 사항 (2026-09-22, Phase 6: 동시성 제어 -- 큐 재도입):
//   - 여러 DB(수업/출석/학습기록 등)에서 "삭제"를 멀티 셀렉트 등으로 동시에 여러 건 누르면, v12
//     방식(즉시 응답 + runInBackground로 각자 바로 실행)에서는 Notion API 호출이 한꺼번에 너무 많이
//     몰릴 수 있고, 화면에는 클릭한 모든 페이지가 "🔄 작업중"으로 보여서 실제 몇 건이 동시에
//     처리되고 있는지 알 수 없었다. sync_queue로 다시 옮기고(target: "cascade-delete",
//     _shared/cascadeDeleteTarget.ts의 processCascadeDeleteQueueItem), process-sync-queue가 정한
//     동시 처리 한도(현재 3)만큼만 실제로 처리하도록 바꿨다. 이 함수는 이제 "이미 처리 중(대기열
//     포함)이면 즉시 반환 -> 아니면 markDeletingQueued로 '⏳ 대기열' 표시 -> sync_queue 적재 -> 즉시
//     202 응답"까지만 하고, 실제 cascadeDelete 호출/완료·오류 반영은 큐 워커가 담당한다. 그래서
//     v8~v12에 있던 STALE_LOCK_MS(3분)/last_edited_time 기반의 "응답 없이 멈춘 실행" 자체 감지
//     로직은 더 이상 필요 없다 -- 큐에 쌓인 뒤로는 sync_queue 자체의 15분 기준
//     recoverStaleSyncQueueItems와 Notion 쪽 15분 워치독(sweepStaleStatus) 두 겹이 이미 "멈춘 작업"
//     회수를 담당하고 있고, "대기열에 오래 있음(=아직 처리를 시작 못함)"은 정상적인 대기이지 멈춤이
//     아니므로 별도 감지가 필요 없다. 마스터플랜: https://app.notion.com/p/903c90386c1d473494c5df6306c53517
//
// v12 변경 사항 (2026-09-22, PART N-5: 동기 응답 -> 즉시 응답 + 백그라운드 처리로 전환):
//   - v11(동기 처리)로 바꾼 뒤, 재귀가 깊은/하위 페이지가 많은 삭제에서 Notion "웹훅 보내기" 버튼이
//     응답을 기다리다 "시간이 초과되었습니다"를 띄우는 사례가 나왔다 (실제로는 백엔드가 나중에
//     정상 완료됨 -- _shared/webhookIngest.ts 상단 PART N-5 주석 참고). "삭제 처리중" 표시까지는
//     응답 전에 동기로 끝내고, 실제 cascadeDelete는 EdgeRuntime.waitUntil로 백그라운드에서 계속
//     진행한 뒤 완료/오류를 반영하도록 바꿨다. 재클릭 시 중복 실행 방지(잠금 확인)와 "응답 없이
//     멈춘 실행" 감지(STALE_LOCK_MS)는 응답 전 단계에서 그대로 유지한다.
//
// v11 변경 사항 (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환):
//   - "삭제" 버튼은 페이지 1건만 대상으로 하는 개별 트리거다 (재귀적으로 하위 페이지까지 지우긴
//     하지만, 그것도 이 페이지 1건의 하위 트리다 — 여러 서로 무관한 페이지를 한 번에 대상으로
//     하는 일괄 버튼이 아니다). sync_queue 적재를 없애고 cascadeDelete를 바로 await한 뒤, 완료
//     (또는 실패) 결과를 그 자리에서 응답했다 (v12에서 백그라운드 처리로 다시 바뀜).
//
// v10 변경 사항 (2026-09-21, PART N: 관리자 키 인증 추가):
//   - 이 함수를 호출하는 Notion 버튼 자동화(수업/출석/학습기록/학습활동/교재비 등 각 DB의
//     "삭제" 웹훅)에 x-admin-key 커스텀 헤더를 미리 추가해둔 뒤, 함수 쪽에도 동일한 검증을
//     추가한다. adminShared.ts의 resolveAdminKeyFromRequest/getCurrentAdminKey를 그대로
//     사용(다른 관리자 함수 6개와 동일한 패턴). 헤더가 없으면 body.adminKey도 확인한다.
//
// v9 변경 사항 (2026-09-20, 리스크 낮은 순서로 진행한 웹훅 코드 정리 1단계):
//   - 자체적으로 들고 있던 extractPageId/deepFindPageObjectId/resolvePageId(페이지 id 추출용
//     함수 3개)를 지우고, _shared/notionClient.ts의 공용 extractPageId로 교체했다.
//
// v8 변경 사항 (2026-09-18, 큐 기반 순차 처리 도입, Phase 2):
//   - 실제 캐스케이드 삭제 로직(cascadeDelete 및 관련 헬퍼)을 _shared/cascadeDeleteTarget.ts로 옮겼다.
//   - 기존의 "응답 없이 멈춘 실행" 감지(STALE_LOCK_MS)와 중복 클릭 방지(이미 처리중이면 즉시 반환) 로직은
//     웹훅 수신 시점 그대로 유지한다.
//
// v5~v7 변경 사항(재귀 깊이/방문 페이지 안전장치, 삭제 체크박스 게이트 제거, 교재비 3단계 캐스케이드 추가 등)은
// _shared/cascadeDeleteTarget.ts 상단 주석에 그대로 옮겨 놓았다.
//
// (2026-09-22, 처리 상태 관리 리팩토링 Phase 3) "삭제 처리중" 체크박스를 상태(select)+처리 시작
// 시각(date)으로 전환했다(cascadeDeleteTarget.ts 참고). isDeletingFlagSet/markDeletingRunning/
// markDeletingError 이름과 시그니처는 그대로라 이 파일은 바뀌지 않는다 — 아래 STALE_LOCK_MS
// 프리체크는 last_edited_time 기반이라(체크박스든 select든 상관없이 페이지가 갱신될 때마다
// 바뀌는 값) 그대로 유지했다. 별도로 status-watchdog에도 이 7개 DB 조합을 타겟으로 추가해서
// (아래 참고) last_edited_time 방식이 놓치는 경우까지 이중으로 커버한다. 마스터플랜:
// https://app.notion.com/p/903c90386c1d473494c5df6306c53517

import { getPage, extractPageId } from "../_shared/notionClient.ts"
import { isDeletingFlagSet, markDeletingQueued, markDeletingError } from "../_shared/cascadeDeleteTarget.ts"
import { resolveAdminKeyFromRequest, getCurrentAdminKey } from "../_shared/adminShared.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Use POST", { status: 405 })
  }
  const rawText = await req.text()

  console.log("cascade-delete raw body:", rawText)

  let body: any = {}
  try {
    body = rawText ? JSON.parse(rawText) : {}
  } catch {
    body = {}
  }

  const adminKey = resolveAdminKeyFromRequest(req, body)
  const currentAdminKey = await getCurrentAdminKey()
  if (!adminKey || adminKey !== currentAdminKey) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  }

  const pageId = extractPageId(body)
  if (!pageId) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "페이지 id를 payload에서 찾지 못했습니다. Supabase 함수 로그의 raw body를 확인하세요.",
        receivedBodyPreview: rawText.slice(0, 500),
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }

  // 안전장치: 같은 페이지에 대해 캐스케이드가 이미 접수되어 있으면(대기열이든 실제 처리 중이든,
  // 버튼 더블클릭/웹훅 재시도 등) 새 요청은 다시 적재하지 않고 바로 반환한다. (2026-09-22, Phase 6)
  // 큐로 옮기면서 "응답 없이 멈춘 실행"은 더 이상 여기서 last_edited_time으로 직접 감지하지 않는다
  // -- sync_queue의 recoverStaleSyncQueueItems(15분)와 Notion 쪽 워치독(sweepStaleStatus, 15분)이
  // 이미 그 역할을 한다 (위 v13 주석 참고).
  try {
    const existingPage = await getPage(pageId)
    if (isDeletingFlagSet(existingPage)) {
      return new Response(JSON.stringify({ ok: true, message: "already_processing", pageId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
  } catch (err) {
    console.error("cascade-delete: failed to pre-check status:", (err as Error).message)
  }

  try {
    // (2026-09-22, Phase 6) 실제 markRunning은 process-sync-queue가 이 항목을 집어서 처리를
    // 시작할 때(cascadeDelete 자신이 depth===0에서) 호출한다 — 여기서는 "⏳ 대기열"만 표시한다.
    await markDeletingQueued(pageId)
    await enqueueSync("cascade-delete", { pageId })
    wakeSyncQueueWorker()
    return respondAccepted({ pageId })
  } catch (err) {
    console.error("cascade-delete: failed to enqueue:", (err as Error).message)
    await markDeletingError(pageId, (err as Error).message)
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message, pageId }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
})