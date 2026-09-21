// Supabase Edge Function: cascade-delete (v11)
//
// v11 변경 사항 (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환):
//   - "삭제" 버튼은 페이지 1건만 대상으로 하는 개별 트리거다 (재귀적으로 하위 페이지까지 지우긴
//     하지만, 그것도 이 페이지 1건의 하위 트리다 — 여러 서로 무관한 페이지를 한 번에 대상으로
//     하는 일괄 버튼이 아니다). sync_queue 적재를 없애고 cascadeDelete를 바로 await한 뒤, 완료
//     (또는 실패) 결과를 그 자리에서 응답한다. 재귀가 깊거나 하위 페이지가 많으면 응답이 예전보다
//     오래 걸릴 수 있지만, Notion의 "웹훅 보내기" 버튼은 이미 이 방식(동기 응답)을 다른 버튼들에서도
//     쓰고 있어 문제가 되지 않을 것으로 판단했다. 기존의 "응답 없이 멈춘 실행" 감지(STALE_LOCK_MS)
//     방지 로직은 그대로 유지한다 (재클릭 시 중복 실행 방지 목적은 여전히 유효함).
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
//     (v11에서 큐 적재는 다시 제거했지만, 로직을 별도 파일로 분리한 구조는 그대로 유지한다.)
//   - 기존의 "응답 없이 멈춘 실행" 감지(STALE_LOCK_MS)와 중복 클릭 방지(이미 처리중이면 즉시 반환) 로직은
//     웹훅 수신 시점 그대로 유지한다.
//
// v5~v7 변경 사항(재귀 깊이/방문 페이지 안전장치, 삭제 체크박스 게이트 제거, 교재비 3단계 캐스케이드 추가 등)은
// _shared/cascadeDeleteTarget.ts 상단 주석에 그대로 옮겨 놓았다.

import { getPage, extractPageId } from "../_shared/notionClient.ts"
import { isDeletingFlagSet, markDeletingRunning, markDeletingError, cascadeDelete } from "../_shared/cascadeDeleteTarget.ts"
import { resolveAdminKeyFromRequest, getCurrentAdminKey } from "../_shared/adminShared.ts"

// "삭제 처리중" 체크박스가 켜진 채로 이 시간(ms) 이상 페이지가 갱신되지 않았으면, 실행 중인
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

  // (2026-09-22, PART N-4) 개별 트리거라 큐를 거치지 않고 바로 처리한다. Notion의 "웹훅 보내기"
  // 버튼 액션은 이 응답을 동기적으로 기다리므로, 완료(또는 실패) 결과를 그 자리에서 그대로 돌려준다.
  try {
    await markDeletingRunning(pageId)
    const log: string[] = []
    await cascadeDelete(pageId, log, new Set<string>(), 0, resumeNote)
    console.log("cascade-delete finished:", pageId, "\n", log.join("\n"))
    return new Response(JSON.stringify({ ok: true, pageId }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (err) {
    console.error("cascade-delete failed:", (err as Error).message)
    await markDeletingError(pageId, (err as Error).message)
    return new Response(
      JSON.stringify({ error: "internal_error", message: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
})