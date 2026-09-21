// _shared/syncReportCacheTarget.ts
//
// sync-report-cache가 처리하는 실제 로직(webhook body의 페이지 id -> 영향받는 "등록" id들을 찾아
// report_cache를 재계산하는 부분)을 별도 파일로 분리했다 (2026-09-18, 큐 기반 순차 처리 도입).
// 원래 supabase/functions/sync-report-cache/index.ts 안에 있던 코드를 그대로 옮긴 것이다 --
// process-sync-queue 워커가 HTTP를 다시 거치지 않고 이 함수를 직접 호출해서 순차 처리할 수 있게
// 하기 위함이다. sync-report-cache/index.ts의 awaitCompletion/mode:"all" 경로도 이 파일의
// resolveRegistrationIds를 그대로 가져다 쓴다 (동작 변경 없음, 코드 위치만 이동).
//
// [정규교재(학원) DB 웹훅, 2026-09-18] 정규교재 페이지(예: "북커버")를 바꿔도, 그동안은 그 교재를
// 쓰는 학생들의 리포트 캐시가 갱신될 방법이 전혀 없었다 (등록/학습기록/학습활동/보고서 DB만
// 트리거였고, 정규교재는 대상이 아니었음). 정규교재 페이지에는 "등록" 관계가 없으므로(그 교재를 쓰는
// 진도교재 인스턴스들에 간접적으로만 연결되어 있음), resolveRegistrationId를
// resolveRegistrationIds로 바꿔서 정규교재 페이지 id가 들어오면 그 교재를 쓰는 진도교재 인스턴스를
// 전부 찾고, 각 인스턴스의 "등록" 관계를 모아(그룹 진도 인스턴스는 등록이 여러 건일 수 있음) 그
// 등록들을 모두 재동기화한다.
//
// [일정(학원) DB 웹훅, 2026-09-18 밤] 일정은 등록/학습기록처럼 "등록" 관계를 직접 갖지 않고, 대신
// 학생/클래스/학교/학년 4개의 독립된 관계축으로 대상을 지정한다 (_shared/reportCacheBuilder.ts의
// buildStudentNotices와 동일한 규칙 -- 학교/학년은 비어있으면 전체, 채워지면 그 값만 대상이 되는
// 와일드카드). 그래서 일정 페이지 id가 들어오면:
//   1) "학생" 관계에 걸린 학생이 있으면 그 학생의 등록을 모두 대상에 포함하고,
//   2) "클래스" 관계에 걸린 클래스가 있으면 그 클래스의 등록을 전부 조회해서 대상에 포함하고,
//   3) "학교"/"학년" 관계가 하나라도 채워져 있으면(둘 다 비어있으면 이 축은 아무에게도 전달되지
//      않으므로 건너뛴다) 학생(학원) DB를 그 조건으로 조회해서 대상 학생을 찾고, 그 학생들의
//      등록을 모두 포함한다.
// 세 경로에서 모은 등록 id를 합쳐서(중복 제거) 각각 재동기화한다.

import { queryAllPages, mapWithConcurrency, relationIds } from "./notionClient.ts"
import { firstRelationId } from "./reportCacheShared.ts"
import { syncReportCacheForRegistration } from "./reportCacheBuilder.ts"
import { DS_REGISTRATION, DS_STUDENT } from "./constants.ts"
// (2026-09-21, 이식성 리팩토링) 위 2개도 constants.ts로 이동함 — 그 파일 상단 주석 참고.
// sync-report-cache/index.ts가 DS_REGISTRATION을 이 파일에서 가져다 쓰고 있어서(re-export),
// 그 파일은 건드리지 않고 여기서 계속 재수출한다.
export { DS_REGISTRATION }
// 진도교재(학원) DB. sync-registration-textbook/index.ts와 동일한 값 (정규교재 페이지 -> 그 교재를
// 쓰는 진도교재 인스턴스를 찾기 위해 필요).
const DATA_SOURCE_PROGRESS_BOOK = Deno.env.get("DATA_SOURCE_PROGRESS_BOOK_ID")!

// 일정(학원) 페이지 식별: "구분"(select)과 "날짜"(date) 조합은 일정(학원) DB에만 있다. 등록/학습기록/
// 학습활동/보고서/정규교재는 모두 아래에서 "등록" 관계 또는 "북커버" 속성으로 먼저 걸러지므로, 이
// 함수는 그 다음 단계에서만 호출된다.
export function isNoticePage(page: any): boolean {
  const props = page?.properties ?? {}
  return props["구분"]?.type === "select" && props["날짜"] !== undefined
}

// 일정 페이지 하나로부텀, 그 일정이 실제로 노출되는 학생들의 등록 id를 모두 찾는다.
// _shared/reportCacheBuilder.ts의 buildStudentNotices()가 학생 1명 기준으로 계산하는 규칙을
// 반대 방향(일정 1건 -> 영향받는 학생들)으로 뒤집은 것이다.
export async function resolveRegistrationIdsForNotice(
  noticePage: any,
  cachedGetPage: (id: string) => Promise<any>,
): Promise<string[]> {
  const studentIds = relationIds(noticePage, "학생")
  const classIds = relationIds(noticePage, "클래스")
  const noticeSchoolIds = relationIds(noticePage, "학교")
  const noticeGradeIds = relationIds(noticePage, "학년")

  const registrationIdSet = new Set<string>()

  // 1) 학생에 직접 걸린 경우 -- 그 학생의 등록을 모두 대상에 포함한다.
  await Promise.all(
    studentIds.map(async (sid: string) => {
      const student = await cachedGetPage(sid)
      relationIds(student, "등록").forEach((rid: string) => registrationIdSet.add(rid))
    }),
  )

  // 2) 클래스에 걸린 경우 -- 그 클래스에 속한 등록을 전부 조회해서 대상에 포함한다.
  await Promise.all(
    classIds.map(async (cid: string) => {
      const regs = await queryAllPages(DS_REGISTRATION, { property: "클래스", relation: { contains: cid } })
      regs.forEach((r: any) => registrationIdSet.add(r.id))
    }),
  )

  // 3) 학교/학년 와일드카드 -- 둘 중 하나라도 채워져 있으면 학생(학원) DB를 그 조거으로 조회한다.
  // (둘 다 비어있으면 이 일정은 학교/학년 관계 자체가 없는 것이므로 이 축은 아무에게도 전달되지
  // 않는다 -- buildStudentNotices와 동일한 전제.)
  if (noticeSchoolIds.length || noticeGradeIds.length) {
    const filters: Record<string, unknown>[] = []
    if (noticeSchoolIds.length) {
      filters.push(
        noticeSchoolIds.length === 1
          ? { property: "학교", relation: { contains: noticeSchoolIds[0] } }
          : { or: noticeSchoolIds.map((id: string) => ({ property: "학교", relation: { contains: id } })) },
      )
    }
    if (noticeGradeIds.length) {
      filters.push(
        noticeGradeIds.length === 1
          ? { property: "학년", relation: { contains: noticeGradeIds[0] } }
          : { or: noticeGradeIds.map((id: string) => ({ property: "학년", relation: { contains: id } })) },
      )
    }
    const studentFilter = filters.length > 1 ? { and: filters } : filters[0]
    const students = await queryAllPages(DS_STUDENT, studentFilter)
    students.forEach((s: any) => relationIds(s, "등록").forEach((rid: string) => registrationIdSet.add(rid)))
  }

  return Array.from(registrationIdSet)
}

// webhook body(등록/학습기록/학습활동/보고서/정규교재/일정 페이지 id)로부텀 실제 리포트 캐시 대상인
// "등록" 페이지 id들을 알아낸다.
// - 등록 페이지 자신: "등록"/"북커버" 속성이 모두 없으므로(자기 자신이 등록이므로) 그대로 pageId
//   하나를 반환한다.
// - 학습기록/학습활동/보고서 페이지: "등록" 관계를 따라간다 (한 건).
// - 정규교재 페이지: "등록" 관계가 없고 "북커버" 속성으로 식별한다. 이 정규교재를 쓰는 진도교재
//   인스턴스를 전부 찾아 각 인스턴스의 "등록" 관계를 모두 모아 반환한다 (그룹 진도 인스턴스는 등록이
//   여러 건일 수 있음).
// - 일정 페이지: "등록"/"북커버" 속성이 모두 없고 "구분"(select)+"날짜"(date) 조합으로 식별한다.
//   resolveRegistrationIdsForNotice로 영향받는 등록들을 모두 찾아 반환한다.
export async function resolveRegistrationIds(pageId: string, cachedGetPage: (id: string) => Promise<any>): Promise<string[]> {
  const page = await cachedGetPage(pageId)
  const props = page.properties ?? {}

  const relatedRegistrationId = firstRelationId(props["등록"])
  if (relatedRegistrationId) return [relatedRegistrationId]

  if (props["북커버"] !== undefined) {
    const instances = await queryAllPages(DATA_SOURCE_PROGRESS_BOOK, {
      property: "정규교재",
      relation: { contains: pageId },
    })
    return Array.from(new Set(instances.flatMap((inst: any) => relationIds(inst, "등록"))))
  }

  if (isNoticePage(page)) {
    return resolveRegistrationIdsForNotice(page, cachedGetPage)
  }

  return [pageId]
}

// process-sync-queue 워커가 target: "sync-report-cache" 작업을 처리할 때 호출하는 진입점.
// sync-report-cache/index.ts의 예전 웹훅 경로(runInBackground 블록)와 완전히 동일한 처리를 한다.
export async function processSyncReportCacheQueueItem(
  payload: { pageId: string },
  cachedGetPage: (id: string) => Promise<any>,
): Promise<void> {
  const registrationIds = await resolveRegistrationIds(payload.pageId, cachedGetPage)
  await mapWithConcurrency(registrationIds, 4, (id) => syncReportCacheForRegistration(id, cachedGetPage))
}
