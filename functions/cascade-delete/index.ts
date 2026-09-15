// Supabase Edge Function: cascade-delete (v6)
//
// v6 변경 사항 (2026-09-10, 사용자 피드백 반영):
//   - "삭제 체크" 체크박스는 더 이상 실행에 필수적인 게이트가 아니다. "삭제" 버튼이 웹훅을 직접
//     호출하는 것 자체가 삭제 의도의 트리거이므로, 체크박스가 꺼져 있어도(또는 자동화 체이닝
//     문제로 체크 이후 웹훅이 안 나가도) 정상적으로 캐스케이드 삭제가 진행된다. 체크박스는 하위로
//     캐스케이드되는 페이지들에 계속 표시되지만 이제는 순수하게 시각적 감사 추적용이다.
//   - 별도였던 "삭제 상태" 속성을 없애고, 기존 "동기화 상태" 속성(다른 Edge Function들과 공유)에
//     합쳤다. 동시에 실행되는 경우가 드물어 값 충돌 위험이 낮다고 판단함.
//   - 4개 DB에서 제각각이던 체크박스 이름("삭제체크"/"삭제 체크")을 "삭제 체크"로 통일했다.
//
// v5 변경 사항 (2026-09-10):
//   - Notion "웹훅 보내기" 버튼은 이 함수의 HTTP 응답을 동기적으로 기다리는데, 캐스케이드 삭제가
//     깊거나(수업→출석→학습기록→학습활동 등 여러 단계) 개수가 많으면 응답이 늦어져서 실제로는
//     정상 처리됐는데도 Notion에 "버튼 실행 실패: 웹훅 요청 시간이 초과되었습니다" 알림이 뜰 수 있다.
//     이제 요청을 받으면 (1) 대상 페이지를 즉시 "삭제 상태 = 🔄 삭제 중"으로 표시하고 202 응답을 먼저
//     돌려준 다음, (2) 실제 캐스케이드 삭제는 EdgeRuntime.waitUntil로 백그라운드에서 계속 진행한다.
//     사용자는 각 DB의 새 "삭제 상태" 속성에서 진행 상황(🔄 삭제 중 → ✅ 삭제 완료 / ⚠️ 오류)을 확인할 수 있다.
//   - 안전장치 추가: 이미 "🔄 삭제 중"으로 표시된 페이지에 대해 같은 요청이 중복으로 들어오면
//     (버튼 더블클릭, 웹훅 재시도 등) 중복 캐스케이드를 방지하기 위해 즉시 반환한다.
//   - 재귀 깊이/방문 페이지 안전장치 추가: 동일 페이지를 두 번 이상 방문하지 않도록 visited Set을 사용하고,
//     최대 재귀 깊이를 초과하면 에러를 기록하고 중단한다(무한 루프/순환 참조로부터 보호).
//
// v4 변경 사항 (2026-09-10, 실제 테스트로 발견된 버그 수정):
//   - v3에서는 출석 삭제 시 학습기록이 전혀 캐스케이드되지 않는 버그가 있었음 (실 테스트로 확인).
//     출석 → 학습기록("출석" 관계) 경로를 추가함.
//   - 학습기록은 진도교재의 "진도방식"에 따라 분기: 개별 진도는 삭제, 그룹 진도는 관계만 해제
//     (여러 학생이 공유하는 기록이므로 삭제하면 안 됨).
//
// "삭제" 버튼을 누르면(웹훅을 직접 호출) 또는 "삭제 체크" 체크박스 자동화가 웹훅을 보내면:
//   1. 해당 페이지가 어느 DB인지 파악(parent.data_source_id)
//   2. 그 DB의 하위 관계(다수 가능)를 따라 이 페이지를 가리키는 하위 페이지들을 찾아
//      각 하위 페이지도 이 함수 안에서 직접 재귀적으로 계속 삭제한다 (하위 페이지의 "삭제 체크"도
//      감사 추적용으로 true로 표시해두지만, 새 웹훅을 다시 트리거하는 방식은 아니다)
//   3. 해당 페이지 자신을 휴지통으로 이동(archived)한다
//
// v3 구조 변경 사항 (실제 스키마 확인 완료):
//   수업 삭제 → 출석 삭제 (관계: 출석."수업")
//            → 학습기록 삭제 (관계: 학습기록."수업") ── 출석과 서로 독립적, 수업에서 직접 분기
//   학습기록 삭제 → 학습활동 삭제 (관계: 학습활동."학습기록") ── 여러 학생의 학습활동 모두 삭제
//   출석 삭제 → 학습활동 삭제 (관계: 학습활동."출석") ── 해당 학생것만 삭제
// (하나의 학습활동이 출석과 학습기록 양쪽 경로 모두로 도달될 수 있지만, 이미 archived된 건 건너뛰기 때문에 중복 삭제는 안전함)

import {
	getPage,
	queryAllPages,
	updatePageProperties,
	archivePage,
	mapWithConcurrency,
} from "../_shared/notionClient.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"
import { PROP_DELETE_CHECKBOX, PROP_DELETING_RUNNING, PROP_LAST_ERROR } from "../_shared/constants.ts"

// (2026-09-11 마이그레이션) 예전엔 공유 select "동기화 상태"의 옵션 값을 그대로 썼지만, 이제
// PROP_DELETING_RUNNING 체크박스 + PROP_LAST_ERROR 텍스트로 각 DB의 "실시간 처리 상태" 수식에 반영한다.

const DS_CLASS_SESSION = "3b1ba040-586b-80ec-af20-000b31bb69b7" // 수업(학원) DB
const DS_ATTENDANCE = "8aaba040-586b-8322-8437-87608a763415" // 출석(학원) DB
const DS_STUDY_RECORD = "d97ba040-586b-8310-b710-8782e29b5c73" // 학습기록(학원) DB
const DS_STUDY_ACTIVITY = "ea2ba040-586b-8368-8bb6-070564a5a31c" // 학습활동(학원) DB

// 학습기록(학원)은 "진도교재"의 "진도방식"에 따라 캐스케이드 삭제 방식이 다르다:
//   개별 진도 → 학습기록도 함께 삭제(기존과 동일하게 재귀 캐스케이드)
//   그룹 진도 → 여러 학생이 공유하는 기록이므로 삭제하지 않고, 연결만 끊는다 (2026-09-10 추가)
const PROP_STUDY_RECORD_TEXTBOOK = "진도교재"
const PROP_PROGRESS_TYPE = "진도방식"
const GROUP_PROGRESS_TYPE = "그룹 진도"

// 안전장치: 순환 참조나 예상치 못한 데이터 구조로 인한 무한 재귀를 막기 위한 최대 깊이.
const MAX_CASCADE_DEPTH = 20

// 같은 깊이의 하위 페이지들을 동시에 몇 개까지 병렬로 처리할지 (Notion API 레이트리밋 감안).
// 순차 처리는 하위 항목이 많은 수업(예: 학생이 많은 반)에서 전체 처리 시간이 길어져 Edge Function
// 실행 시간 제한에 걸려 응답 없이 멈추는 원인이 될 수 있어 병렬화한다 (2026-09-12 fix).
const CASCADE_CHILD_CONCURRENCY = 5

// "삭제 처리중" 체크박스가 켜진 채로 이 시간(ms) 이상 페이지가 갱신되지 않았으면, 실행 중인
// 작업이 죽었다고 (서버 타임아웃/재시작 등) 판단하고 막아두지 않고 다시 진행한다. 사용자가 버튼을
// 다시 누르는 것만으로 항상 복구되도록 하기 위한 안전장치 (2026-09-12 fix).
const STALE_LOCK_MS = 3 * 60 * 1000

type CascadeChild = {
  dataSourceId: string
  // 하위 DB에서 이 페이지를 가리키는 관계형 속성 이름 (하위 측의 속성명)
  relationPropOnChild: string
}

type CascadeConfig = {
  titleProp: string
  // 하나의 부모가 여러 하위 DB를 독립적으로 가질 수 있도록 배열로 변경
  children?: CascadeChild[]
}

const CONFIG: Record<string, CascadeConfig> = {
  [DS_CLASS_SESSION]: {
    titleProp: "이름",
    children: [
      // 수업 → 출석 (출석 DB의 "수업" 관계)
      { dataSourceId: DS_ATTENDANCE, relationPropOnChild: "수업" },
      // 수업 → 학습기록 (학습기록 DB의 "수업" 관계, 출석을 거치지 않는 직접 연결)
      { dataSourceId: DS_STUDY_RECORD, relationPropOnChild: "수업" },
    ],
  },
  [DS_ATTENDANCE]: {
    titleProp: "출석",
    children: [
      // 출석 → 학습활동 (학습활동 DB의 "출석" 관계, 해당 학생것만)
      { dataSourceId: DS_STUDY_ACTIVITY, relationPropOnChild: "출석" },
      // 출석 → 학습기록 (학습기록 DB의 "출석" 관계) — v3에서 누락되어 있던 경로 (2026-09-10 수정).
      // 개별/그룹 진도 여부에 따라 실제로 삭제할지 관계만 끊을지는 아래 cascadeDelete에서 분기한다.
      { dataSourceId: DS_STUDY_RECORD, relationPropOnChild: "출석" },
    ],
  },
  [DS_STUDY_RECORD]: {
    titleProp: "학습",
    children: [
      // 학습기록 → 학습활동 (학습활동 DB의 "학습기록" 관계, 여러 학생 모두)
      { dataSourceId: DS_STUDY_ACTIVITY, relationPropOnChild: "학습기록" },
    ],
  },
  [DS_STUDY_ACTIVITY]: {
    titleProp: "학습활동",
    // 말단(children 없음)
  },
}

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

function titleOf(page: any, titleProp: string): string {
  return page.properties?.[titleProp]?.title?.[0]?.plain_text ?? page.id
}

function isDeletingFlagSet(page: any): boolean {
  return page.properties?.[PROP_DELETING_RUNNING]?.checkbox === true
}

// 대상 DB에 "삭제 처리중"/"마지막 오류" 속성이 없을 수도 있으므로(스키마 반영 지연 등), 실패해도 전체
// 캐스케이드를 막지 않도록 조용히 무시한다.
async function markDeletingRunning(pageId: string): Promise<void> {
  try {
    // 새 삭제 실행이 시작되는 순간(버튼 클릭 직후) 이전 오류를 바로 지워서, 끝날 때까지 오래된 오류
    // 텍스트가 남아있지 않도록 합니다 (2026-09-11 fix).
    await updatePageProperties(pageId, {
      [PROP_DELETING_RUNNING]: { checkbox: true },
      [PROP_LAST_ERROR]: { rich_text: [] },
    })
  } catch (err) {
    console.error(`markDeletingRunning(${pageId}) failed:`, (err as Error).message)
  }
}

async function markDeletingDone(pageId: string): Promise<void> {
  try {
    await updatePageProperties(pageId, {
      [PROP_DELETING_RUNNING]: { checkbox: false },
      [PROP_LAST_ERROR]: { rich_text: [] },
    })
  } catch (err) {
    console.error(`markDeletingDone(${pageId}) failed:`, (err as Error).message)
  }
}

async function markDeletingError(pageId: string, message: string): Promise<void> {
  try {
    await updatePageProperties(pageId, {
      [PROP_DELETING_RUNNING]: { checkbox: false },
      [PROP_LAST_ERROR]: { rich_text: [{ text: { content: message.slice(0, 1900) } }] },
    })
  } catch (err) {
    console.error(`markDeletingError(${pageId}) failed:`, (err as Error).message)
  }
}

// 학습기록의 "진도교재" relation을 따라가 그 교재의 "진도방식"(개별 진도/그룹 진도)을 읽는다.
// 진도교재가 연결되어 있지 않으면 기존 동작과 동일하게 개별(삭제)로 취급한다.
async function getStudyRecordProgressType(studyRecordPage: any): Promise<string | undefined> {
  const textbookId: string | undefined = studyRecordPage.properties?.[PROP_STUDY_RECORD_TEXTBOOK]?.relation?.[0]?.id
  if (!textbookId) return undefined
  const textbookPage = await getPage(textbookId)
  return textbookPage.properties?.[PROP_PROGRESS_TYPE]?.select?.name
}

// 그룹 진도 학습기록은 삭제하지 않고, 이번에 삭제되는 상위 페이지(출석/수업)와의 관계만 제거한다.
async function disconnectRelation(pageId: string, propName: string, removeId: string): Promise<void> {
  const page = await getPage(pageId)
  const current: string[] = (page.properties?.[propName]?.relation ?? []).map((r: any) => r.id)
  const filtered = current.filter((id: string) => id !== removeId)
  if (filtered.length === current.length) return
  await updatePageProperties(pageId, { [propName]: { relation: filtered.map((id) => ({ id })) } })
}

async function cascadeDelete(
  pageId: string,
  log: string[],
  visited: Set<string>,
  depth = 0,
  // 직전 실행이 응답 없이 멈춰서 이 실행(대상 페이지)이 자동으로 재시도되고 있다는 것을 사용자가
  // 확인할 수 있는 간단한 말(옵션함). 캐스케이드의 최상위 호출(depth 0)에만 적용된다. (2026-09-12 fix)
  resumeNote?: string,
): Promise<void> {
  // 안전장치: 순환 참조/예상치 못한 재귀로 인한 무한 루프 방지.
  if (depth > MAX_CASCADE_DEPTH) {
    log.push(`⚠️ 최대 재귀 깊이(${MAX_CASCADE_DEPTH})를 초과하여 중단함: ${pageId}`)
    return
  }
  if (visited.has(pageId)) {
    log.push(`⏭️ 이번 실행에서 이미 방문한 페이지, 중복 처리 방지: ${pageId}`)
    return
  }
  visited.add(pageId)

  const page = await getPage(pageId)
  if (page.archived || page.in_trash) {
    log.push(`⏭️ 이미 삭제되어 있음: ${pageId}`)
    return
  }
  // 참고(v6): 이전에는 "삭제 체크" 체크박스가 켜져 있는지 확인해서 꺼져 있으면 중단했지만, 이제 이
  // 함수가 호출된다는 것 자체(버튼의 웹훅 직접 호출, 또는 체크박스 자동화의 웹훅)가 삭제 의도의
  // 증거이므로 체크박스 상태를 게이트로 쓰지 않는다.

  const dataSourceId: string | undefined = page.parent?.data_source_id
  const config = dataSourceId ? CONFIG[dataSourceId] : undefined
  if (!config) {
    log.push(`⚠️ 알 수 없는 DB임: ${pageId} (dataSourceId=${dataSourceId})`)
  }

  const name = config ? titleOf(page, config.titleProp) : pageId
  const indent = "  ".repeat(depth)

  if (depth === 0 && resumeNote) {
    // 이전 실행이 응답 없이 멈춰서 이미 실행(대상 페이지)이 자동으로 재시도되는 거란을 "마지막
    // 오류"에 간단하 적어둔다. 이본 재실함이 묵막히 성간하면 markDeletingDone에서 자동으로 지우지고,
    // 다시 실패하말면 실제 오류 뒤계 뒤엮우로 됬이 쓰인다 (2026-09-12 fix).
    try {
      await updatePageProperties(pageId, {
        [PROP_DELETING_RUNNING]: { checkbox: true },
        [PROP_LAST_ERROR]: { rich_text: [{ text: { content: resumeNote.slice(0, 1900) } }] },
      })
    } catch (err) {
      console.error(`markDeletingResumed(${pageId}) failed:`, (err as Error).message)
    }
  } else {
    await markDeletingRunning(pageId)
  }

  // 이 페이지(또는 그 하위 어디선가)에서 오류가 나면, 이 페이지 자신의 "삭제 처리중"도 반드시
  // 꺼줘야 한다. 예전에는 최상위 호출(Deno.serve)의 catch에서만 markDeletingError를 불러서,
  // 재귀 중간에 있던 페이지들은 오류가 나도 자기 자신의 플래그를 절대 못 끄고 영원히 "삭제
  // 처리중"에 멈춰있었다 (버튼을 다시 눌러도 이미 처리중이라고 판단해 아무 것도 안 하는 원인이
  // 됐음 - 2026-09-12 fix). 각 단계마다 자기 몫을 try/catch로 감싸서, 실패해도 즉시 상태를
  // 오류로 표시하고 다시 던져서 상위 호출이 계속 알 수 있게 한다.
  try {
    if (config?.children) {
      // 서로 다른 하위 DB(예: 출석 vs 학습�����록)는 물��, 같은 하위 DB 안의 여러 페이지도
      // 동시에(병렬로) 처리한다. 예전에는 하나씩 순서대로 처리해서 학생이 많은 반일수록 전체
      // 처리 시간이 늘어나 Edge Function 실행 시간 제한에 걸려 응답 없이 멈추는 경우가 있었다
      // (2026-09-12 fix).
      await Promise.all(
        config.children.map(async (child) => {
          const kids = await queryAllPages(child.dataSourceId, {
            property: child.relationPropOnChild,
            relation: { contains: pageId },
          })
          await mapWithConcurrency(kids, CASCADE_CHILD_CONCURRENCY, async (kid) => {
            if (kid.archived || kid.in_trash) return

            if (child.dataSourceId === DS_STUDY_RECORD) {
              const progressType = await getStudyRecordProgressType(kid)
              if (progressType === GROUP_PROGRESS_TYPE) {
                // 그룹 진도: 다른 학생들도 같은 학습기록을 쓰고 있으므로 삭제하지 않고 관��만 끊는다.
                await disconnectRelation(kid.id, child.relationPropOnChild, pageId)
                log.push(`${indent}🔗 [${name}] 그룹 진도 학습기록이라 관계만 해제함 (${child.relationPropOnChild}): ${kid.id}`)
                return
              }
            }

            await updatePageProperties(kid.id, { [PROP_DELETE_CHECKBOX]: { checkbox: true } })
            log.push(`${indent}☑️ [${name}] 하위 페이지 삭제 표시 (${child.relationPropOnChild}): ${kid.id}`)
            await cascadeDelete(kid.id, log, visited, depth + 1)
          })
        }),
      )
    }

    await archivePage(pageId)
    await markDeletingDone(pageId)
    log.push(`${indent}🗑️ [${name}] 삭제되어 휴지통으로 이동됨`)
  } catch (err) {
    await markDeletingError(pageId, (err as Error).message)
    throw err
  }
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
        error: "페���지 id를 payload에서 찾지 못했습니다. Supabase 함수 로그의 raw body를 확인하세요.",
        receivedBodyPreview: rawText.slice(0, 500),
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }

  // 안전장치: 같은 페이지에 대해 캐스케이드가 이미 진행 중이면(버튼 더블클릭, 웹훅 재시도 등)
  // 새 요청은 중복 실행하지 않고 바로 반환한다.
  // 직전 실행이 응답 없이 멈춰서 이번 요청이 자동으로 재시작하는 경우, 그 사실을 담아 대상 페이지의
  // "마지막 오류"에 남길 간단한 안내 문구 (2026-09-12 fix).
  let resumeNote: string | undefined
  try {
    const existingPage = await getPage(pageId)
    if (isDeletingFlagSet(existingPage)) {
      // "삭제 처리중"이 켜진 지 얼마나 됐는지 페이지의 last_edited_time으로 확인한다. 정상적으로
      // 진행 중인 짧은 시간(STALE_LOCK_MS 이내)이면 중복 실행을 막기 위해 여기서 반환하지만,
      // 그보다 오래 갱신이 없으면 이전 실행이 서버 타임아웃/재시작 등으로 죽어서 응답 없이
      // 멈춘 것으로 보고, 막지 않고 그대로 재시도를 진행한다. 사용자가 버튼을 다시 누르는 것만
      // 으로 항상 복구되도록 하기 위한 안전장치 (2026-09-12 fix).
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
  // 백그라운드에서 계속 진행한다. 진행 상황은 각 DB의 "동기화 상태" 속성으로 확인 가능하다.
  runInBackground(async () => {
    const log: string[] = []
    try {
      await cascadeDelete(pageId, log, new Set<string>(), 0, resumeNote)
      console.log("cascade-delete finished:", pageId, "\n", log.join("\n"))
    } catch (err) {
      console.error(
        "cascade-delete failed:",
        (err as Error).message,
        "\nlog so far:",
        log.join("\n"),
        "\nstack:",
        (err as Error).stack,
      )
      await markDeletingError(pageId, (err as Error).message)
    }
  })

  return respondAccepted({ pageId })
})
