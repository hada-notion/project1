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
//
// [2026-09-21, PART N: 관리자 키 인증 추가] handleLockedQueueWebhook 호출자 중 sync-exam-scope만
// 관리자 키 인증이 필요해서, requireAdminKey 옵션을 새로 추가했다(기본값 false/undefined = 기존과
// 동일하게 인증 없이 통과). 이 옵션을 켜지 않은 기존 호출자(sync-registration-enroll 등)는 동작이
// 전혀 바뀌지 않는다.
//
// [2026-09-21, PART N-2] handleLockedBackgroundWebhook(generate-report/generate-tuition이 사용)에도
// 같은 이유로 동일한 opt-in requireAdminKey 옵션을 추가했다. 이 옵션을 켜지 않은 기존 동작은 그대로다.
//
// [2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환] "개별(individual) 트리거 버튼은 즉시 동기
// 처리, 일괄(bulk) 트리거만 큐 사용"이라는 원칙에 따라, 등록/시험범위 등 여러 DB의 단건 버튼 웹훅을
// sync_queue에 적재하지 않고 바로 처리하도록 되돌린다. cron(process-sync-queue)이 큐를 매분 도는
// 구조 자체는 버튼 클릭이 트리거하는 작업과 무관한데도, 그동안 모든 버튼이 그 큐를 거치도록
// 되어 있어서 버튼 클릭 후 완료까지 지연/불투명함이 생겼다 (등록(학원) DB "등록" 버튼이 대표적
// 사례). runLockedQueueWebhookForPage/handleLockedQueueWebhook과 거의 동일한 뼈대이지만, sync_queue에
// 적재하는 대신 opts.process(pageId)를 바로 await하고, 그 결과에 따라 "완료"/"오류"를 즉시 반영한
// 뒤 실제 동기 응답(200/500)을 돌려준다. create-learning-record(반 전체 roster 처리라 트리거가
// 어느 DB든 항상 "일괄" 성격)와 sync-textbook-distribution:from-class-carts/sync-class-report-cache
// (명시적으로 여러 페이지를 대상으로 하는 버튼)는 여전히 큐를 그대로 쓴다 — process-sync-queue/index.ts
// 상단 주석 참고.
//
// [2026-09-22, PART N-5: 동기 응답 -> 즉시 응답 + 백그라운드 처리로 전환] PART N-4로 바꾼 뒤 실제로
// 사용해보니, 강하을 학생 등록 페이지의 "종료 처리" 버튼에서 Notion이 "웹훅 요청 시간이
// 초과되었습니다"라는 오류를 띄웠다 (Supabase 로그를 보면 함수 자체는 14초 뒤 정상적으로 끝났고
// "마지막 오류"도 비어 있었다 — 즉 백엔드는 실패하지 않았다). 원인은 notionClient.ts의
// fetchWithRetry가 Notion API 429(레이트리밋)를 만나면 지수 백오프(최대 5회, 최대 9초+ 대기)로
// 재시도하는데, PART N-4로 개별 버튼들을 전부 동기 처리로 바꾸면서 여러 버튼/자동화가 동시에
// 눌리면 Notion API 호출이 몰려 429를 더 자주 만나고, 그 대기 시간이 쌓이면 Notion "웹훅 보내기"
// 버튼 자체가 응답을 기다리는 시간(짧게 잡혀 있는 것으로 보임)을 넘겨버린다. 백엔드는 결국 정상
// 완료하지만, 사용자 화면에는 실패로 보였다.
//
// 해결: 큐(process-sync-queue)로 되돌리지 않고, generate-report/generate-tuition이 쓰는
// handleLockedBackgroundWebhook과 똑같은 방식으로 "락 확인 -> '처리중' 표시 -> 즉시 202 응답,
// 실제 처리(opts.process)는 EdgeRuntime.waitUntil로 백그라운드에서 계속 진행 -> 완료/오류를
// 그때 가서 반영"으로 바꿨다. Notion 버튼은 항상 즉시 응답을 받으므로 시간 초과 문구가 사라지고,
// "처리중"/"완료"/"마지막 오류" 표시는 실제 완료 시점에 맞게 그대로 갱신된다 (Bug 1을 고칠 때와
// 같은 원리 — 응답 시점과 완료 시점을 분리하되, 이번엔 응답이 먼저 오고 완료가 뒤따르는 방향).
// SyncWebhookOptions/handleSyncWebhook의 외부 시그니처는 그대로라 각 호출부(sync-registration-enroll
// 등)는 전혀 수정할 필요가 없다. 공용 헬퍼를 쓰지 않는 커스텀 3곳(cascade-delete/create-assignment/
// fix-attendance)도 같은 패턴으로 각각 개별 수정했다.

import { getPage, extractPageId, checkboxValue } from "./notionClient.ts"
import { runInBackground, respondAccepted } from "./backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "./syncQueue.ts"
import { resolveAdminKeyFromRequest, getCurrentAdminKey } from "./adminShared.ts"
// (2026-09-22, 처리 상태 관리 리팩토링 Phase 3) runSyncWebhookForPage/handleSyncWebhook에
// statusSpec(상태 select 기반)을 선택적으로 지원하기 위해 추가. 마스터플랜:
// https://app.notion.com/p/903c90386c1d473494c5df6306c53517
import { isRunning, markRunning, markDone, markError, type StatusSpec } from "./statusTracking.ts"

// 각 DB 전용 setter(makeSyncStatusSetter/makeClassStatusSetter 결과물)가 실제로 쓰는 리터럴 유니온
// 타입과 정확히 맞춰야 한다 -- 여기를 그냥 string으로 넓혀두면 "이 함수는 '처리중'|'완료'|'오류'만
// 받는데 아무 string이나 넘길 수 있는 타입으로 취급된다"는 반공변성 오류로 deno check가 실패한다.
export type SetSyncStatus = (
  pageId: string,
  phase: "처리중" | "완료" | "오류",
  errorMessage?: string,
) => Promise<void>

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

export type LockedQueueWebhookOptions = {
  // 로그 접두사로 쓰는 함수 이름 (예: "sync-registration-enroll").
  functionName: string
  // 옛 방식(체크박스 잠금 + setStatus 콜백). statusSpec을 주면 이 둘은 완전히 무시된다.
  // (2026-09-22, Phase 3) 클래스(학원) DB "학생 페이지 동기화중" 전환 시 추가.
  lockProp?: string
  // sync_queue에 적재할 target 이름 (process-sync-queue의 HANDLERS 키와 일치해야 한다).
  target: string
  // "처리중"/"오류" 표시에 쓰는 상태 setter. 각 DB/함수 전용 setter를 그대로 넘기면 된다.
  setStatus?: SetSyncStatus
  // 새 방식: 상태(select) + 처리 시작 시각(date) 기반. 주어지면 lockProp/setStatus 대신 이걸 쓴다.
  // 마스터플랜: https://app.notion.com/p/903c90386c1d473494c5df6306c53517
  statusSpec?: StatusSpec
  // 큐에 적재할 payload를 pageId 외의 모양으로 만들어야 할 때(예: { classId: pageId }) 사용.
  // 생략하면 기본값 { pageId }를 그대로 적재한다.
  buildPayload?: (pageId: string) => Record<string, unknown>
  // true면 x-admin-key 헤더(또는 body.adminKey)가 현재 유효한 관리자 키와 일치하지 않으면
  // 401을 반환하고 처리를 중단한다. 생략(기본값 false/undefined)하면 기존과 동일하게 인증을
  // 요구하지 않는다. handleLockedQueueWebhook에서만 검사한다(runLockedQueueWebhookForPage는
  // req를 받지 않으므로 대상이 아니다).
  requireAdminKey?: boolean
}

// pageId를 이미 알고 있는 상태에서: 잠금 확인 -> "처리중" 표시 -> 큐 적재 -> 202 응답.
// 처리 중 예외가 나면 setStatus(pageId, "오류", message)를 호출하고 500을 반환한다 (기존 각 함수의
// catch 블록과 동일한 동작).
//
// (2026-09-22, PART N-4) 이제 남아있는 호출자는 sync-textbook-distribution의 from-class-carts처럼
// 명시적으로 "일괄" 성격인 버튼뿐이다. 개별 버튼들은 아래 runSyncWebhookForPage로 옮겨졌다.
export async function runLockedQueueWebhookForPage(
  pageId: string,
  opts: LockedQueueWebhookOptions,
): Promise<Response> {
  try {
    const pageForLock = await getPage(pageId)
    const currentlyRunning = opts.statusSpec
      ? isRunning(pageForLock, opts.statusSpec)
      : checkboxValue(pageForLock, opts.lockProp!)
    if (currentlyRunning) {
      return jsonResponse({ ok: true, message: "already_processing", pageId }, 200)
    }

    if (opts.statusSpec) await markRunning(pageId, opts.statusSpec)
    else await opts.setStatus!(pageId, "처리중")

    const payload = opts.buildPayload ? opts.buildPayload(pageId) : { pageId }
    await enqueueSync(opts.target, payload)
    wakeSyncQueueWorker()

    return respondAccepted({ pageId })
  } catch (err) {
    console.error(`[${opts.functionName}] ERROR:`, (err as Error).message, (err as Error).stack)
    if (pageId) {
      if (opts.statusSpec) await markError(pageId, opts.statusSpec, (err as Error).message)
      else await opts.setStatus!(pageId, "오류", (err as Error).message)
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

  if (opts.requireAdminKey) {
    const adminKey = resolveAdminKeyFromRequest(req, body)
    const currentAdminKey = await getCurrentAdminKey()
    if (!adminKey || adminKey !== currentAdminKey) {
      return jsonResponse({ error: "unauthorized" }, 401)
    }
  }

  const pageId = extractPageId(body)
  if (!pageId) {
    return jsonResponse({ error: "pageId를 찾을 수 없음" }, 400)
  }

  return runLockedQueueWebhookForPage(pageId, opts)
}

// (2026-09-22, PART N-4/N-5: 개별 트리거 버튼 동기화 전환 -> 즉시 응답 + 백그라운드 처리) 위
// runLockedQueueWebhookForPage와 뼈대는 똑같지만, sync_queue에 적재하지 않는다. "처리중" 표시까지는
// 응답 전에 동기로 끝내고, 실제 처리(opts.process)는 handleLockedBackgroundWebhook과 동일하게
// EdgeRuntime.waitUntil로 백그라운드에서 진행한 뒤 "완료"/"오류"를 반영한다. Notion의 "웹훅 보내기"
// 버튼 액션은 이 202 응답을 받는 즉시 성공으로 처리하고, 실제 진행 상황은 각 페이지의 "처리중"
// 체크박스/"실시간 처리 상태" 수식으로 확인한다.
export type SyncWebhookOptions = {
  // 로그 접두사로 쓰는 함수 이름 (예: "sync-registration-enroll").
  functionName: string
  // 옛 방식(체크박스 잠금 + setStatus 콜백). statusSpec을 주면 이 둘은 완전히 무시된다.
  // (2026-09-22, Phase 3) 마이그레이션 대상마다 하나씩 statusSpec으로 옮기는 중이라, 당분간 두
  // 방식이 공존한다 — 아직 옮기지 않은 호출부는 lockProp/setStatus를 그대로 쓴다.
  lockProp?: string
  // "처리중"/"완료"/"오류" 표시에 쓰는 상태 setter. 각 DB/함수 전용 setter를 그대로 넘기면 된다.
  setStatus?: SetSyncStatus
  // 새 방식: 상태(select) + 처리 시작 시각(date) 기반. 주어지면 lockProp/setStatus 대신 이걸 쓴다.
  // 마스터플랜: https://app.notion.com/p/903c90386c1d473494c5df6306c53517
  statusSpec?: StatusSpec
  // 실제 처리 로직. 예외를 던지면 자동으로 "오류" 상태로 이어진다 (백그라운드에서 실행되므로 HTTP
  // 응답 코드에는 더 이상 영향을 주지 않는다).
  process: (pageId: string) => Promise<void>
  // true면 x-admin-key 헤더(또는 body.adminKey)가 현재 유효한 관리자 키와 일치하지 않으면
  // 401을 반환하고 처리를 중단한다.
  requireAdminKey?: boolean
}

export async function runSyncWebhookForPage(
  pageId: string,
  opts: SyncWebhookOptions,
): Promise<Response> {
  const pageForLock = await getPage(pageId)
  const currentlyRunning = opts.statusSpec
    ? isRunning(pageForLock, opts.statusSpec)
    : checkboxValue(pageForLock, opts.lockProp!)
  if (currentlyRunning) {
    return jsonResponse({ ok: true, message: "already_processing", pageId }, 200)
  }

  if (opts.statusSpec) await markRunning(pageId, opts.statusSpec)
  else await opts.setStatus!(pageId, "처리중")

  runInBackground(async () => {
    try {
      await opts.process(pageId)
      if (opts.statusSpec) await markDone(pageId, opts.statusSpec)
      else await opts.setStatus!(pageId, "완료")
      console.log(`[${opts.functionName}] finished:`, pageId)
    } catch (err) {
      console.error(`[${opts.functionName}] ERROR:`, (err as Error).message, (err as Error).stack)
      if (opts.statusSpec) await markError(pageId, opts.statusSpec, (err as Error).message)
      else await opts.setStatus!(pageId, "오류", (err as Error).message)
    }
  })

  return respondAccepted({ pageId })
}

// POST 확인 + body 파싱 + pageId 추출까지 포함한 완전한 버전 (handleLockedQueueWebhook과 같은 모양).
export async function handleSyncWebhook(
  req: Request,
  opts: SyncWebhookOptions,
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

  if (opts.requireAdminKey) {
    const adminKey = resolveAdminKeyFromRequest(req, body)
    const currentAdminKey = await getCurrentAdminKey()
    if (!adminKey || adminKey !== currentAdminKey) {
      return jsonResponse({ error: "unauthorized" }, 401)
    }
  }

  const pageId = extractPageId(body)
  if (!pageId) {
    return jsonResponse({ error: "pageId를 찾을 수 없음" }, 400)
  }

  return runSyncWebhookForPage(pageId, opts)
}

// (2026-09-20, 웹훅 코드 정리 6단계) generate-report/generate-tuition처럼 큐를 거치지 않고 즉시
// 백그라운드에서 처리하는 "버튼 웹훅" 계열도, 큐 계열(runLockedQueueWebhookForPage)과 뼈대가
// 거의 같다: POST 확인 -> body 파싱 -> pageId 추출 -> 이미 처리 중이면 즉시 반환(락) ->
// "처리중" 표시 -> 백그라운드 실행(성공하면 "완료", 실패하면 "오류") -> 즉시 202 응답.
// generate-classes는 단건/일괄/전체자동 등 진입점이 여러 개라 이 헬퍼를 그대로 적용하지 않았다.
//
// [2026-09-22, PART N-5] 위 runSyncWebhookForPage가 이제 이 함수와 완전히 동일한 모양(즉시 응답 +
// 백그라운드 처리)이 됐다 -- 다만 process(pageId)가 log: string[]를 따로 받지 않는 더 단순한
// 시그니처라 이 함수와 통합하지 않고 그대로 별도로 둔다.
export type LockedBackgroundWebhookOptions = {
  // 로그 접두사로 쓰는 함수 이름 (예: "generate-report").
  functionName: string
  // 옛 방식(체크박스 잠금 + setStatus 콜백). statusSpec을 주면 이 둘은 완전히 무시된다.
  // (2026-09-22, Phase 3) 클래스(학원) DB "보고서 생성중"/"수강료 생성중" 전환 시 추가.
  lockProp?: string
  // "처리중"/"완료"/"오류" 표시에 쓰는 상태 setter. 각 DB/함수 전용 setter를 그대로 넘기면 된다.
  setStatus?: SetSyncStatus
  // 새 방식: 상태(select) + 처리 시작 시각(date) 기반. 주어지면 lockProp/setStatus 대신 이걸 쓴다.
  // 마스터플랜: https://app.notion.com/p/903c90386c1d473494c5df6306c53517
  statusSpec?: StatusSpec
  // pageId를 찾지 못했을 때의 오류 메시지 (기존 함수마다 "classId를 찾지 못함" 등 문구가 달랐다).
  missingIdError: string
  // 응답 JSON에 pageId를 담을 필드 이름 (기존 함수들은 "classId"를 그대로 썼다). 기본값 "pageId".
  idField?: string
  // true면 x-admin-key 헤더(또는 body.adminKey)가 현재 유효한 관리자 키와 일치하지 않으면
  // 401을 반환하고 처리를 중단한다. 생략(기본값 false/undefined)하면 기존과 동일하게 인증을
  // 요구하지 않는다. (2026-09-21, PART N-2)
  requireAdminKey?: boolean
}

export async function handleLockedBackgroundWebhook(
  req: Request,
  opts: LockedBackgroundWebhookOptions,
  run: (id: string, log: string[]) => Promise<void>,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Use POST", { status: 405 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    body = undefined
  }

  if (opts.requireAdminKey) {
    const adminKey = resolveAdminKeyFromRequest(req, (body as Record<string, unknown>) ?? {})
    const currentAdminKey = await getCurrentAdminKey()
    if (!adminKey || adminKey !== currentAdminKey) {
      return jsonResponse({ error: "unauthorized" }, 401)
    }
  }

  const id = body ? extractPageId(body) : null
  const idField = opts.idField ?? "pageId"
  if (!id) {
    return jsonResponse({ ok: false, error: opts.missingIdError, rawBody: body }, 400)
  }

  const pageForLock = await getPage(id)
  const currentlyRunning = opts.statusSpec
    ? isRunning(pageForLock, opts.statusSpec)
    : checkboxValue(pageForLock, opts.lockProp!)
  if (currentlyRunning) {
    return jsonResponse({ ok: true, message: "already_processing", [idField]: id }, 200)
  }

  const log: string[] = []
  if (opts.statusSpec) await markRunning(id, opts.statusSpec)
  else await opts.setStatus!(id, "처리중")

  runInBackground(async () => {
    try {
      await run(id, log)
      console.log(`${opts.functionName} finished:`, id, "\n", log.join("\n"))
      if (opts.statusSpec) await markDone(id, opts.statusSpec)
      else await opts.setStatus!(id, "완료")
    } catch (err) {
      console.error(
        `${opts.functionName} failed:`,
        (err as Error).message,
        "\nlog so far:",
        log.join("\n"),
        "\nstack:",
        (err as Error).stack,
      )
      if (opts.statusSpec) await markError(id, opts.statusSpec, (err as Error).message)
      else await opts.setStatus!(id, "오류", (err as Error).message)
    }
  })

  return respondAccepted({ [idField]: id })
}