// Supabase Edge Function: cascade-delete (v12)
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
import { isDeletingFlagSet, markDeletingRunning, markDeletingError, cascadeDelete } from "../_shared/cascadeDeleteTarget.ts"
import { resolveAdminKeyFromRequest, getCurrentAdminKey } from "../_shared/adminShared.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"

// "삭제 처리중" 상태가 켜진 채로 이 시간(ms) 이상 페이지가 갱신되지 않았으면, 실행 중인
// 작업이 죽었다고 (서버 타임아웃/재시작 등) 판단하고 막아두지 않고 다시 진행한다.
const STALE_LOCK_MS = 3 * 60 * 1000

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

  // 안전장치: 같은 페이지에 대해 캐스케이드가 이미 진행 중이면(버튼 더블클릭, 웹훅 재시도 등)
  // 새 요청은 다시 실행하지 않고 바로 반환한다.
  let resumeNote: string | undefined
  try {
    const existingPage = await getPage(pageId)
    if (isDeletingFlagSet(existingPage)) {
      const lastEditedMs = existingPage.last_edited_time ? new Date(existingPage.last_edited_time).getTime() : 0
      const ageMs = Date.now() - lastEditedMs
      if (ageMs < STALE_LOCK_MS) {
        return new Response(JSON.stringify({ ok: true, message: "already_processing", pageId }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      resumeNote = `⚠️ 이전 삭제 처리가 응답 없이 멈춰서(약 ${Math.round(ageMs / 1000)}초간 갱신이 없었음) 자동으로 재시작합니다.`
      console.log(
        `cascade-delete: stale "삭제 처리중" lock detected for ${pageId} (age ${Math.round(ageMs / 1000)}s) — retrying instead of blocking`,
      )
    }
  } catch (err) {
    console.error("cascade-delete: failed to pre-check status:", (err as Error).message)
  }

  // (2026-09-22, PART N-5) "삭제 처리중" 표시까지는 응답 전에 동기로 끝내고, 실제 재귀 삭제는
  // 백그라운드에서 계속 진행한다 — Notion의 "웹훅 보내기" 버튼이 깊은/큰 재귀 삭제를 기다리다
  // 시간 초과로 실패 표시를 띄우는 문제를 피하기 위함 (실제 처리는 항상 정상 완료됐었음).
  await markDeletingRunning(pageId)

  runInBackground(async () => {
    const log: string[] = []
    try {
      await cascadeDelete(pageId, log, new Set<string>(), 0, resumeNote)
      console.log("cascade-delete finished:", pageId, "\n", log.join("\n"))
    } catch (err) {
      console.error("cascade-delete failed:", (err as Error).message)
      await markDeletingError(pageId, (err as Error).message)
    }
  })

  return respondAccepted({ pageId })
})