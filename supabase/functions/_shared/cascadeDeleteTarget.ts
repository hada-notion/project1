// _shared/cascadeDeleteTarget.ts
//
// cascade-delete가 처리하는 실제 재귀 삭제 로직을 별도 파일로 분리했다 (2026-09-18, 큐 기반 순차
// 처리 도입, Phase 2). 원래 supabase/functions/cascade-delete/index.ts 안에 있던 코드를 그대로
// 옮긴 것이다 -- process-sync-queue 워커가 HTTP를 다시 거치지 않고 이 함수를 직접 호출해서 순차
// 처리할 수 있게 하기 위함이다. webhook 요청 파싱(resolvePageId 등)은 index.ts에 그대로 둔다.

import { getPage, queryAllPages, updatePageProperties, archivePage, mapWithConcurrency } from "./notionClient.ts"
import { PROP_DELETE_CHECKBOX, PROP_DELETING_RUNNING, PROP_LAST_ERROR } from "./constants.ts"

export const DS_CLASS_SESSION = "3b1ba040-586b-80ec-af20-000b31bb69b7" // 수업(학원) DB
export const DS_ATTENDANCE = "8aaba040-586b-8322-8437-87608a763415" // 출석(학원) DB
export const DS_STUDY_RECORD = "d97ba040-586b-8310-b710-8782e29b5c73" // 학습기록(학원) DB
export const DS_STUDY_ACTIVITY = "ea2ba040-586b-8368-8bb6-070564a5a31c" // 학습활동(학원) DB
export const DS_TEXTBOOK_CART = "d1dba040-586b-8215-af75-8778a3ec57e9" // 교재비(학원) DB
export const DS_TEXTBOOK_DISTRIBUTION = "784ba040-586b-82e3-b5aa-87e11fb8d97a" // 교재배부(학원) DB
export const DS_TEXTBOOK_PAYMENT = "b86ba040-586b-83e3-8d2d-07c61bbece1a" // 교재결제(학원) DB

const PROP_STUDY_RECORD_TEXTBOOK = "진도교재"
const PROP_PROGRESS_TYPE = "진도방식"
const GROUP_PROGRESS_TYPE = "그룹 진도"

export const MAX_CASCADE_DEPTH = 20
export const CASCADE_CHILD_CONCURRENCY = 5
// (2026-09-18) 큐 도입 이전에는 이 상수(STALE_LOCK_MS)로 "응답 없이 멈춘 이전 실행"을 감지해서 막지
// 않고 재시도하게 했다. 큐 기반으로 바뀐 뒤에도 웹훅이 들어온 즉시 판단하는 이 프리체크는 index.ts에
// 그대로 남아있으므로, 그 상수도 그대로 index.ts에서 쓴다 (여기서는 재수출하지 않음).

type CascadeChild = {
  dataSourceId: string
  relationPropOnChild: string
}

type CascadeConfig = {
  titleProp: string
  children?: CascadeChild[]
}

export const CONFIG: Record<string, CascadeConfig> = {
  [DS_CLASS_SESSION]: {
    titleProp: "이름",
    children: [
      { dataSourceId: DS_ATTENDANCE, relationPropOnChild: "수업" },
      { dataSourceId: DS_STUDY_RECORD, relationPropOnChild: "수업" },
    ],
  },
  [DS_ATTENDANCE]: {
    titleProp: "출석",
    children: [
      { dataSourceId: DS_STUDY_ACTIVITY, relationPropOnChild: "출석" },
      { dataSourceId: DS_STUDY_RECORD, relationPropOnChild: "출석" },
    ],
  },
  [DS_STUDY_RECORD]: {
    titleProp: "학습",
    children: [{ dataSourceId: DS_STUDY_ACTIVITY, relationPropOnChild: "학습기록" }],
  },
  [DS_STUDY_ACTIVITY]: { titleProp: "학습활동" },
  [DS_TEXTBOOK_CART]: {
    titleProp: "이름",
    children: [{ dataSourceId: DS_TEXTBOOK_DISTRIBUTION, relationPropOnChild: "교재비" }],
  },
  [DS_TEXTBOOK_DISTRIBUTION]: {
    titleProp: "이름",
    children: [{ dataSourceId: DS_TEXTBOOK_PAYMENT, relationPropOnChild: "교재배부" }],
  },
  [DS_TEXTBOOK_PAYMENT]: { titleProp: "이름" },
}

function titleOf(page: any, titleProp: string): string {
  return page.properties?.[titleProp]?.title?.[0]?.plain_text ?? page.id
}

// index.ts의 프리체크(이미 처리중인지 판단)에서도 쓰므로 export한다.
export function isDeletingFlagSet(page: any): boolean {
  return page.properties?.[PROP_DELETING_RUNNING]?.checkbox === true
}

export async function markDeletingRunning(pageId: string): Promise<void> {
  try {
    await updatePageProperties(pageId, {
      [PROP_DELETING_RUNNING]: { checkbox: true },
      [PROP_LAST_ERROR]: { rich_text: [] },
    })
  } catch (err) {
    console.error(`markDeletingRunning(${pageId}) failed:`, (err as Error).message)
  }
}

export async function markDeletingDone(pageId: string): Promise<void> {
  try {
    await updatePageProperties(pageId, {
      [PROP_DELETING_RUNNING]: { checkbox: false },
      [PROP_LAST_ERROR]: { rich_text: [] },
    })
  } catch (err) {
    console.error(`markDeletingDone(${pageId}) failed:`, (err as Error).message)
  }
}

export async function markDeletingError(pageId: string, message: string): Promise<void> {
  try {
    await updatePageProperties(pageId, {
      [PROP_DELETING_RUNNING]: { checkbox: false },
      [PROP_LAST_ERROR]: { rich_text: [{ text: { content: message.slice(0, 1900) } }] },
    })
  } catch (err) {
    console.error(`markDeletingError(${pageId}) failed:`, (err as Error).message)
  }
}

async function getStudyRecordProgressType(studyRecordPage: any): Promise<string | undefined> {
  const textbookId: string | undefined = studyRecordPage.properties?.[PROP_STUDY_RECORD_TEXTBOOK]?.relation?.[0]?.id
  if (!textbookId) return undefined
  const textbookPage = await getPage(textbookId)
  return textbookPage.properties?.[PROP_PROGRESS_TYPE]?.select?.name
}

async function disconnectRelation(pageId: string, propName: string, removeId: string): Promise<void> {
  const page = await getPage(pageId)
  const current: string[] = (page.properties?.[propName]?.relation ?? []).map((r: any) => r.id)
  const filtered = current.filter((id: string) => id !== removeId)
  if (filtered.length === current.length) return
  await updatePageProperties(pageId, { [propName]: { relation: filtered.map((id) => ({ id })) } })
}

export async function cascadeDelete(
  pageId: string,
  log: string[],
  visited: Set<string>,
  depth = 0,
  resumeNote?: string,
): Promise<void> {
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

  const dataSourceId: string | undefined = page.parent?.data_source_id
  const config = dataSourceId ? CONFIG[dataSourceId] : undefined
  if (!config) {
    log.push(`⚠️ 알 수 없는 DB임: ${pageId} (dataSourceId=${dataSourceId})`)
  }

  const name = config ? titleOf(page, config.titleProp) : pageId
  const indent = "  ".repeat(depth)

  if (depth === 0 && resumeNote) {
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

  try {
    if (config?.children) {
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

// process-sync-queue 워커가 target: "cascade-delete" 작업을 처리할 때 호출하는 진입점.
export async function processCascadeDeleteQueueItem(payload: { pageId: string; resumeNote?: string }): Promise<void> {
  const log: string[] = []
  try {
    await cascadeDelete(payload.pageId, log, new Set<string>(), 0, payload.resumeNote)
    console.log("cascade-delete (queue) finished:", payload.pageId, "\n", log.join("\n"))
  } catch (err) {
    console.error(
      "cascade-delete (queue) failed:",
      (err as Error).message,
      "\nlog so far:",
      log.join("\n"),
    )
    // cascadeDelete 내부에서 이미 실패한 페이지 자신의 markDeletingError를 호출했지만, 최상위
    // 페이지 자신에서 터진 오류(예: getPage 자체 실패)는 여기서 한번 더 확실히 표시해둔다.
    await markDeletingError(payload.pageId, (err as Error).message)
    throw err
  }
}
