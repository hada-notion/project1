// _shared/webhookIngest.ts
//
// (2026-09-20, 웹훅 코드 정리 3단계) 등록(학원)/시험범위(학원)/클래스(학원) 등 여러 DB의 버튼 웹훅이
// 거의 똑같은 순서로 동작한다: pageId 추출 -> 이미 처리 중이면 즉시 반환(락) -> "처리중" 표시 ->
// sync_queue에 적재 -> 202 응답, 실패하면 "오류" 표시 + 500 응답. 이 반복되는 뼈대를 여기 한 곳으로
// 모았다. 각 웹훅 함수(sync-registration-enroll 등)는 이제 자신만의 target 이름 / 잠금 속성 /
// 상태 setter만 넘기고, 실제 흐름은 이 파일이 담당한다.
//
// 함수마다 조금씩 다른 부분(요청 body 모양, cron 전체 스캔 겸용 여부, payload 필드 이름)이 있어서
// 두 단계로 나눴다:
//   - runLockedQueueWebhookForPage: pageId를 이미 알고 있을 때의 잠금 확인부터 응답까지.
//     sync-registration-timetable/sync-registration-class-session처럼 pageId가 없으면 cron 전체
//     스캔으로 분기해야 하는 함수는 이 쪽을 직접 쓴다.
//   - handleLockedQueueWebhook: 위에 요청 파싱(POST 확인, body 파싱, pageId 추출)까지 더한 완전한
//     버전. 항상 pageId가 필요한 단순 버튼 웹훅(등록/종료 처리/응시학생 등록 등)은 이 쪽만 부르면 된다.
//
// 기존 함수들이 각자 갖고 있던 log: string[] (한 번도 채워지지 않던 죽은 코드)는 정리하면서 빠졌다.
// 그 외 응답 형태(already_processing / accepted / 오류 메시지)는 기존과 동일하게 유지했다.

import { getPage, extractPageId, checkboxValue } from "./notionClient.ts"
import { respondAccepted } from "./backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "./syncQueue.ts"

export type SetSyncStatus = (pageId: string, phase: string, errorMessage?: string) => Promise<void>

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

export type LockedQueueWebhookOptions = {
  // 로그 접두사로 쓰는 함수 이름 (예: "sync-registration-enroll").
  functionName: string
  // 이 속성(체크박스)이 이미 true면 재클릭으로 보고 즉시 already_processing을 반환한다.
  lockProp: string
  // sync_queue에 적재할 target 이름 (process-sync-queue의 HANDLERS 키와 일치해야 한다).
  target: string
  // "처리중"/"오류" 표시에 쓰는 상태 setter. 각 DB/함수 전용 setter를 그대로 넘기면 된다.
  setStatus: SetSyncStatus
  // 큐에 적재할 payload를 pageId 외의 모양으로 만들어야 할 때(예: { classId: pageId }) 사용.
  // 생략하면 기본값 { pageId }를 그대로 적재한다.
  buildPayload?: (pageId: string) => Record<string, unknown>
}

// pageId를 이미 알고 있는 상태에서: 잠금 확인 -> "처리중" 표시 -> 큐 적재 -> 202 응답.
// 처리 중 예외가 나면 setStatus(pageId, "오류", message)를 호출하고 500을 반환한다 (기존 각 함수의
// catch 블록과 동일한 동작).
export async function runLockedQueueWebhookForPage(
  pageId: string,
  opts: LockedQueueWebhookOptions,
): Promise<Response> {
  try {
    const pageForLock = await getPage(pageId)
    if (checkboxValue(pageForLock, opts.lockProp)) {
      return jsonResponse({ ok: true, message: "already_processing", pageId }, 200)
    }

    await opts.setStatus(pageId, "처리중")

    const payload = opts.buildPayload ? opts.buildPayload(pageId) : { pageId }
    await enqueueSync(opts.target, payload)
    wakeSyncQueueWorker()

    return respondAccepted({ pageId })
  } catch (err) {
    console.error(`[${opts.functionName}] ERROR:`, (err as Error).message, (err as Error).stack)
    if (pageId) {
      await opts.setStatus(pageId, "오류", (err as Error).message)
    }
    return jsonResponse({ ok: false, error: (err as Error).message }, 500)
  }
}

// POST 확인 + body 파싱 + pageId 추출까지 포함한 완전한 버전. pageId가 없으면 즉시 400을 반환한다
// (cron 전체 스캔 겸용이 필요 없는, 항상 pageId가 있어야 하는 단순 버튼 웹훅용).
export async function handleLockedQueueWebhook(
  req: Request,
  opts: LockedQueueWebhookOptions,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Use POST", { status: 405 })
  }
  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  console.log(`[${opts.functionName}] received body:`, JSON.stringify(body))

  const pageId = extractPageId(body)
  if (!pageId) {
    return jsonResponse({ error: "pageId를 찾을 수 없음" }, 400)
  }

  return runLockedQueueWebhookForPage(pageId, opts)
}
