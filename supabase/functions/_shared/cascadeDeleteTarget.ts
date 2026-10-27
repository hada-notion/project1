// _shared/cascadeDeleteTarget.ts
//
// cascade-delete가 처리하는 실제 재귀 삭제 로직을 별도 파일로 분리했다 (2026-09-18, 큐 기반 순차
// 처리 도입, Phase 2). 원래 supabase/functions/cascade-delete/index.ts 안에 있던 코드를 그대로
// 옮긴 것이다. webhook 요청 파싱(resolvePageId 등)은 index.ts에 그대로 둔다.
//
// (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환) processCascadeDeleteQueueItem
// (process-sync-queue 전용 진입점)은 제거했다. index.ts가 cascadeDelete를 직접 호출한다.
//
// (2026-09-22, Phase 6: 동시성 제어) 여러 페이지에서 "삭제"를 동시에(멀티 셀렉트 등으로) 눌렀을 때
// Notion API 호출이 한꺼번에 너무 많이 몰리는 문제와, 실제로는 일부만 동시에 처리되는데도 화면에는
// 클릭한 전부가 "🔄 작업중"으로 보이는 문제를 해결하기 위해 processCascadeDeleteQueueItem을
// 다시 추가했다. index.ts는 이제 markDeletingQueued로 "⏳ 대기열"만 표시하고 sync_queue에 적재하며,
// process-sync-queue가 이 항목을 집어서(최대 process-sync-queue의 CONCURRENCY 개까지 동시에)
// 실제로 처리를 시작할 때 아래 진입점이 호출된다. markRunning/markDone은 cascadeDelete 자신이
// depth===0일 때 이미 호출하므로 여기서 다시 부를 필요는 없다. 마스터플랜:
// https://app.notion.com/p/903c90386c1d473494c5df6306c53517

import { getPage, queryAllPages, updatePageProperties, archivePage, mapWithConcurrency, relIds, fullRelationIds, withFullRelations } from "./notionClient.ts"
import {
	PROP_LAST_ERROR,
	DS_CLASS_SESSION,
	DS_ATTENDANCE,
	DS_LEARNING_RECORD as DS_STUDY_RECORD,
	DS_STUDY_ACTIVITY,
	DS_TEXTBOOK_CART,
	DS_TEXTBOOK_DISTRIBUTION,
	DS_TEXTBOOK_PAYMENT,
} from "./constants.ts"
import { isRunning, markQueued, markRunning, markDone, markError, STATUS_DONE, type StatusSpec } from "./statusTracking.ts"
import { removeLater } from "./classRoomCopy.ts"
import { decideRecordRemoval } from "./learningRecordShare.ts"
// (2026-09-21, 이식성 리팩토링) 위 7개 데이터소스 ID는 이 파일에 직접 하드코딩돼 있었는데, 이제
// constants.ts 한 곳에서 환경변수로 읽어와 공유한다 (constants.ts 상단 주석 참고). export하지 않아도
// 되도록 이 파일 밖에서 이 이름들을 가져다 쓰는 곳이 없는지 확인했다.
//
// (2026-09-22, 처리 상태 관리 리팩토링 Phase 3) "삭제 처리중"(checkbox)을 삭제 상태(select)+삭제
// 처리 시작 시각(date)으로 전환. (일반 이름 "상태"/"처리 시작 시각" 대신 "삭제 " 접두사를 붙인 이유:
// 수업/출석/교재비(카트) DB에는 이미 "생성 상태"/"출석조정 상태"/"학습기록 상태"/"담기 처리중" 같은
// 다른 상태 속성들이 있어서, 접두사 없는 "상태"만 있으면 그 사이에서 무엇을 가리키는지 헷갈림.)
// 이 플래그는 cascade-delete가 처리하는 7개 DB(수업/출석/학습기록/학습활동/
// 교재비(카트)/교재배부/교재결제)가 모두 같은 속성 이름을 공유한다 — 원래 마스터플랜 Phase 0 표에는
// 수업/출석/학습기록/학습활동 4개만 적혀 있었는데, 실제 코드(바로 아래 CONFIG)를 보면 교재비 계열
// 3개 DB도 같은 cascadeDelete/PROP_DELETING_RUNNING을 공유하고 있어 범위를 7개로 확장함(등록/수업 DB
// 그룹에서 "학습기록 상태"를 3개 DB로 확장했던 것과 같은 이유의 범위 확장). 마스터플랜:
// https://app.notion.com/p/903c90386c1d473494c5df6306c53517
export const CASCADE_DELETE_STATUS_SPEC: StatusSpec = {
	statusProp: "삭제 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "삭제 처리 시작 시각",
}

const PROP_STUDY_RECORD_TEXTBOOK = "진도교재"
const PROP_PROGRESS_TYPE = "진도방식"
const GROUP_PROGRESS_TYPE = "그룹 진도"

export const MAX_CASCADE_DEPTH = 20
export const CASCADE_CHILD_CONCURRENCY = 5
// (2026-09-18) 큐 도입 이전에는 이 상수(STALE_LOCK_MS)로 "응답 없이 멈춘 이전 실행"을 감지해서 막지
// 않고 재시도하게 했다. (2026-09-22, PART N-4) 큐를 다시 없앤 뒤에도 웹훅이 들어온 즉시 판단하는 이
// 프리체크는 index.ts에 그대로 남아있으므로, 그 상수도 그대로 index.ts에서 쓴다 (여기서는 재수출하지 않음).

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
  return isRunning(page, CASCADE_DELETE_STATUS_SPEC)
}

export async function markDeletingQueued(pageId: string): Promise<void> {
  try {
    await markQueued(pageId, CASCADE_DELETE_STATUS_SPEC)
  } catch (err) {
    console.error(`markDeletingQueued(${pageId}) failed:`, (err as Error).message)
  }
}

export async function markDeletingRunning(pageId: string): Promise<void> {
  try {
    await markRunning(pageId, CASCADE_DELETE_STATUS_SPEC)
  } catch (err) {
    console.error(`markDeletingRunning(${pageId}) failed:`, (err as Error).message)
  }
}

export async function markDeletingDone(pageId: string): Promise<void> {
  try {
    await markDone(pageId, CASCADE_DELETE_STATUS_SPEC)
  } catch (err) {
    console.error(`markDeletingDone(${pageId}) failed:`, (err as Error).message)
  }
}

export async function markDeletingError(pageId: string, message: string): Promise<void> {
  try {
    await markError(pageId, CASCADE_DELETE_STATUS_SPEC, message)
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

// (v2.6.32) 조회 결과도 관계를 25개까지만 준다. 잘렸으면 끝까지 읽은 뒤 고쳐 쓴다(fullRelationIds).
async function disconnectRelation(kid: any, propName: string, removeId: string): Promise<void> {
  const pageId = kid.id
  const current: string[] = await fullRelationIds(kid, propName)
  const filtered = current.filter((id: string) => id !== removeId)
  if (filtered.length === current.length) return
  await updatePageProperties(pageId, { [propName]: { relation: filtered.map((id) => ({ id })) } })
}

// (v2.8.0) 보강 출석(`기존 결석`이 있는 출석)을 지우면 보강 수업 명단(`등록`)에서도 이 학생을 뺀다. 명단에 남으면 다음
// 출석 조정·[보강 배정]이 지운 출석을 다시 만든다. 수업째 지우는 중이거나, 보강 수업이 아니거나, 같은 수업에 이 학생의 다른
// 출석이 남아 있으면 건드리지 않는다.
async function dropFromMakeupRoster(att: any, visited: Set<string>, log: string[], indent: string, name: string): Promise<void> {
  const sessionId = relIds(att.properties?.["수업"])[0]
  const regId = relIds(att.properties?.["등록"])[0]
  if (!sessionId || !regId) return
  const deleting = new Set([...visited].map((v) => v.replace(/-/g, "")))
  if (deleting.has(sessionId.replace(/-/g, ""))) return
  const session = await getPage(sessionId)
  if (session?.archived || session?.in_trash || session?.properties?.["보강"]?.checkbox !== true) return
  const others = await queryAllPages(DS_ATTENDANCE, { and: [{ property: "수업", relation: { contains: sessionId } }, { property: "등록", relation: { contains: regId } }] })
  const self = String(att.id).replace(/-/g, "")
  if (others.some((o: any) => String(o.id).replace(/-/g, "") !== self && !o.archived && !o.in_trash)) return
  await disconnectRelation(session, "등록", regId)
  log.push(`${indent}🔗 [${name}] 보강 출석이라 보강 수업 명단에서도 이 학생을 뺌: ${sessionId}`)
}

// (v2.6.31) 누른 페이지(depth 0)만 읽고 상태를 표시한다. 하위 페이지는 조회 결과(kidPage)를 그대로 쓰고,
// "삭제 체크"를 켜지 않으며(켜면 7개 DB의 삭제 체크 자동화가 하위마다 웹훅을 또 보내 같은 페이지를 다시
// 읽고 큐에 넣었다), 상태 표시 없이 휴지통으로만 보낸다. 누른 페이지는 ✅ 완료 쓰기와 휴지통 보내기를 한 번에.
// 중간에 실패하면 큐가 누른 페이지부터 다시 하고, 이미 휴지통에 간 하위는 조회에서 빠져 남은 것만 이어서 지운다.
export async function cascadeDelete(
  pageId: string,
  log: string[],
  visited: Set<string>,
  depth = 0,
  resumeNote?: string,
  kidPage?: any,
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

  const page = kidPage ?? await getPage(pageId)
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

  if (depth > 0) {
    // 하위 페이지: 상태 표시 없음
  } else if (resumeNote) {
    // markRunning은 상태/시작시각을 갱신하며 마지막 오류를 비우므로, 재시작 사실을 보여주는
    // resumeNote는 그 다음에 별도로 마지막 오류 칸에 덧붙인다("작업중"이면서 정보성 메세지가
    // 함께 보이는 상태 — 기존 checkbox 방식과 동일한 최종 결과).
    await markDeletingRunning(pageId)
    try {
      await updatePageProperties(pageId, {
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
              // (v2.6.16) 출석을 지울 때: 다른 학생도 쓰는 기록(그룹 진도·주제로 만든 반 전체 기록)은 남기고
              // 이 출석과 이 학생만 기록에서 뺀다. 이 학생만의 기록(개별 진도)은 아래에서 함께 지운다.
              if (dataSourceId === DS_ATTENDANCE) {
                // 수업째 지우는 중이면 그 수업의 기록은 수업 쪽에서 처리한다(여기서 연결을 끊으면 쓸데없는 쓰기·경합).
                const deleting = new Set([...visited].map((v) => v.replace(/-/g, "")))
                if (relIds(kid.properties?.["수업"]).some((id: string) => deleting.has(id.replace(/-/g, "")))) return
                // (v2.6.32) 반 전체 기록의 출석·등록이 25개를 넘으면 끝까지 읽고 판단·고쳐 쓴다.
                const full = await withFullRelations(kid, ["출석", "등록"])
                const decision = decideRecordRemoval(full, [pageId], relIds(page.properties?.["등록"]), progressType)
                if (decision.action === "detach") {
                  await updatePageProperties(kid.id, decision.properties)
                  log.push(`${indent}🔗 [${name}] 다른 학생도 쓰는 학습기록이라 이 출석·학생 연결만 해제함: ${kid.id}`)
                  return
                }
              } else if (progressType === GROUP_PROGRESS_TYPE) {
                // (v2.7.10) 학습기록은 수업 기준이라 이 수업에만 달린 그룹 진도 기록은 아래에서 함께 지운다.
                // 다른 수업에도 연결된 옛 기록만 이 수업 연결을 끊고 남긴다.
                const sessions = await fullRelationIds(kid, child.relationPropOnChild)
                const self = pageId.replace(/-/g, "")
                if (sessions.some((id: string) => id.replace(/-/g, "") !== self)) {
                  await disconnectRelation(kid, child.relationPropOnChild, pageId)
                  log.push(`${indent}🔗 [${name}] 다른 수업에도 연결된 그룹 진도 학습기록이라 관계만 해제함 (${child.relationPropOnChild}): ${kid.id}`)
                  return
                }
              }
            }

            await cascadeDelete(kid.id, log, visited, depth + 1, undefined, kid)
          })
        }),
      )
    }

    // (v2.8.0) 보강 수업을 지우면 결석 출석의 `보강 수업`(양방향, 수업 쪽 `보강 대상`)이 휴지통 수업을 계속 가리켜
    // 결석 현황에 "배정 전"으로 남는다. 휴지통에 보내면서 수업 쪽 관계를 비워 결석이 "미배정"으로 돌아가게 한다.
    const makeupTargets = dataSourceId === DS_CLASS_SESSION && relIds(page.properties?.["보강 대상"]).length ? { "보강 대상": { relation: [] } } : {}
    // (v2.8.0) 보강 출석을 지우면 원래 결석의 `보강 출석`(양방향, 출석 쪽 `기존 결석`)이 휴지통 출석을 계속 가리켜 결석이
    // 보강 대기에서 빠진 채 남는다. 휴지통에 보내면서 관계를 비워 원래 결석이 다시 뜨게 하고, 보강 수업 명단에서도 뺀다.
    const isMakeupAttendance = dataSourceId === DS_ATTENDANCE && relIds(page.properties?.["기존 결석"]).length > 0
    if (isMakeupAttendance) await dropFromMakeupRoster(page, visited, log, indent, name)
    const makeupLink = isMakeupAttendance ? { "기존 결석": { relation: [] } } : {}
    if (depth === 0) {
      await archivePage(pageId, {
        [CASCADE_DELETE_STATUS_SPEC.statusProp]: { select: { name: STATUS_DONE } },
        [CASCADE_DELETE_STATUS_SPEC.errorProp]: { rich_text: [] },
        ...makeupTargets,
        ...makeupLink,
      })
    } else {
      await archivePage(pageId, isMakeupAttendance ? makeupLink : undefined)
    }
    removeLater([pageId]) // 수업 관리 복사본에서도 지운다(v2.5.115, 수업·출석·학습기록·학습활동이면)
    log.push(`${indent}🗑️ [${name}] 삭제되어 휴지통으로 이동됨`)
  } catch (err) {
    if (depth === 0) await markDeletingError(pageId, (err as Error).message)
    throw err
  }
}

// process-sync-queue 워커가 target: "cascade-delete" 작업을 처리할 때 호출하는 진입점
// (2026-09-22, Phase 6 재도입 — 위 주석 참고). markRunning/markDone/markError는 cascadeDelete가
// depth===0 호출에 대해 이미 처리하므로 여기서 다시 호출하지 않는다. 실패하면 그대로 다시
// throw해서 process-sync-queue가 재시도 여부(최대 3회)를 판단하게 한다.
export async function processCascadeDeleteQueueItem(payload: { pageId: string }): Promise<void> {
  const log: string[] = []
  try {
    await cascadeDelete(payload.pageId, log, new Set<string>(), 0)
    console.log("cascade-delete (queue) finished:", payload.pageId, "\n", log.join("\n"))
  } catch (err) {
    console.error(
      "cascade-delete (queue) failed:",
      (err as Error).message,
      "\nlog so far:",
      log.join("\n"),
    )
    throw err
  }
}