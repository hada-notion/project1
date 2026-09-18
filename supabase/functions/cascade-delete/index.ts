// Supabase Edge Function: cascade-delete (v8)
//
// v8 변경 사항 (2026-09-18, 큐 기반 순차 처리 도입, Phase 2):
//   - 실제 캐스케이드 삭제 로직(cascadeDelete 및 관련 헬퍼)을 _shared/cascadeDeleteTarget.ts로 옮겼다.
//     여러 DB(수업/출석/학습기록/학습활동/교재비/교재배부/교재결제)에서 동시에 "삭제" 버튼이 눌려도,
//     이제는 각 요청이 즉시 백그라운드로 실행되는 대신 sync_queue에 한 건씩 적재되고, process-sync-queue
//     워커가 큐에 쌓인 순서대로 하나씩 처리한다 -- 동시 실행으로 인한 Notion API 레이트리밋/유실 위험이
//     없어지고, 어떤 요청도 조용히 드롭되지 않는다.
//   - 기존의 "응답 없이 멈춘 실행" 감지(STALE_LOCK_MS)와 중복 클릭 방지(이미 처리중이면 즉시 반환) 로직은
//     웹훅 수신 시점 그대로 유지한다. 다만 이제 "처리중" 표시는 큐에 적재하기 직전에 바로 켜서, 큐가
//     밀려 있어도 재클릭 방지가 즉시 동작하도록 한다.
//
// v5~v7 변경 사항(재귀 깊이/방문 페이지 안전장치, 삭제 체크박스 게이트 제거, 교재비 3단계 캐스케이드 추가 등)은
// _shared/cascadeDeleteTarget.ts 상단 주석에 그대로 옮겨 놓았다.

import { getPage } from "../_shared/notionClient.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { PROP_DELETING_RUNNING } from "../_shared/constants.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
import { isDeletingFlagSet, markDeletingRunning, markDeletingError } from "../_shared/cascadeDeleteTarget.ts"

// "삭제 처리중" 체크박스가 켜진 채로 이 시간(ms) 이상 페이지가 갱신되지 않았으면, 실행 중인
// 작업이 죽었다고 (서버 타임아웃/재시작 등) 판단하고 막아두지 않고 다시 진행한다.
const STALE_LOCK_MS = 3 * 60 * 1000

function extractPageId(input: unknown): string | null {
  if (typeof input !== "string") return null
  const dashed = input.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/)
  if (dashed) return dashed[0]
  const bare = input.match(/[0-9a-fA-F]{32}/)
  if (bare) return bare[0]
  return null
}

function deepFindPageObjectId(node: unknown, depth = 0): string | null {
  if (depth > 8 || node === null || typeof node !== "object") return null
  const obj = node as Record<string, unknown>
  if (obj.object === "page" && typeof obj.id === "string") {
    const id = extractPageId(obj.id)
    if (id) return id
  }
  for (const key of Object.keys(obj)) {
    const value = obj[key]
    if (value && typeof value === "object") {
      const found = deepFindPageObjectId(value, depth + 1)
      if (found) return found
    }
  }
  return null
}

function resolvePageId(body: any): string | null {
  const flatCandidates = [
    body?.pageId,
    body?.pageUrl,
    body?.page_url,
    body?.page_id,
    body?.url,
    body?.id,
    body?.data?.id,
    body?.data?.url,
    body?.data?.page?.id,
    body?.data?.page?.url,
    body?.page?.id,
    body?.page?.url,
    body?.entity?.id,
    body?.entity?.url,
  ]
  for (const candidate of flatCandidates) {
    const id = extractPageId(candidate)
    if (id) return id
  }

  const deep = deepFindPageObjectId(body)
  if (deep) return deep

  return extractPageId(JSON.stringify(body))
}

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

  const pageId = resolvePageId(body)
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
  // 새 요청은 중복 적재하지 않고 바로 반환한다.
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

  // Notion 웹훅이 더 이상 기다리지 않도록 즉시 202 응답을 돌려주고, 실제 캐스케이드 삭제는
  // sync_queue에 적재해 process-sync-queue 워커가 순서대로 처리하게 한다. 큐가 밀려 있어도
  // 재클릭 방지가 즉시 동작하도록, 적재 직전에 바로 "삭제 처리중"을 켠다.
  try {
    await markDeletingRunning(pageId)
    await enqueueSync("cascade-delete", { pageId, resumeNote })
    wakeSyncQueueWorker()
  } catch (err) {
    console.error("cascade-delete: enqueue failed:", (err as Error).message)
    await markDeletingError(pageId, (err as Error).message)
    return new Response(
      JSON.stringify({ error: "internal_error", message: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }

  return respondAccepted({ pageId })
})
