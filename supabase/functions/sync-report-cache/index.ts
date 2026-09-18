// POST /functions/v1/sync-report-cache
// body: { registrationId: string } 또는 { pageId: string }
//   -- 등록/학습기록/학습활동/보고서/정규교재/일정 DB의 Notion 버튼(웹훅 보내기) / "생성 또는 편집 시"
//      자동화에서 호출하는 기본 경로. 즉시 202를 반환하고, 실제 재계산은 백그라운드에서 처리한다.
// body: { registrationId, awaitCompletion: true }  (x-admin-key 필요)
//   -- 내부 전용 동기 경로. 응답을 기다렸다가 결과를 그대로 반환한다.
//      보고서 발송 직전(send-report) 강제 재동기화, 야간 점검(nightly-report-sync-audit)에서 사용.
// body: { mode: "all" }  (x-admin-key 필요)
//   -- 토큰이 있는 모든 등록을 다시 계산하는 수동 전체 재계산. 더 이상 정기 cron으로는 호출되지
//      않고(2026-09-17 제거), 문제 발생 시 수동 점검용으로만 남겨둔다.
//
// (2026-09-17, 리포트 동기화 안정화 3단계)
// 매시간 전체 재계산 cron이 Notion API에 부담을 주고, 다른 버튼/웹훅 작업과 자원을 경쟁하는 문제가
// 있어 제거했다. 대신:
//   1) 등록/학습기록/학습활동/보고서 DB에 "생성 또는 편집 시" 즉시 웹훅을 걸어 편집 시점에 곧바로
//      갱신하고 (이 파일의 기본 경로),
//   2) 보고서 발송 직전 send-report가 awaitCompletion으로 한 번 더 강제 재동기화하고,
//   3) 야간에 그날 전송로그만 훑어서 한 번 더 확인한다 (nightly-report-sync-audit).
// 이 파일은 이제 위 세 가지가 공통으로 쓰는 진입점 역할만 하고, 실제 조립 로직은
// _shared/reportCacheBuilder.ts로 옮겼다 (send-report/nightly-report-sync-audit에서도 재사용).
//
// 웹훅 타임아웃 문제: 등록 1건만 재계산해도 Notion API를 수십 번 호출해야 해서, 이 함수가 항상 전체
// 처리를 끝낼 때까지 기다렸다가 응답하면 Notion의 "웹훅 보내기" 자동화가 응답을 기다리다 타임아웃으로
// 실패 표시를 띄우는 경우가 있었다 (cascade-delete에서 이미 겪었던 문제와 동일). 그래서
// cascade-delete와 동일한 202+백그라운드 패턴(_shared/backgroundTask.ts)을 적용한다.
//
// [NEW, 2026-09-18] 정규교재(학원) DB도 같은 방식으로 이 엔드포인트에 웹훅을 건다. 정규교재
// 페이지(예: "북커버")를 바꿔도, 그동안은 그 교재를 쓰는 학생들의 리포트 캐시가 갱신될 방법이
// 전혀 없었다 (등록/학습기록/학습활동/보고서 DB만 트리거였고, 정규교재는 대상이 아니었음). 정규교재
// 페이지에는 "등록" 관계가 없으므로(그 교재를 쓰는 진도교재 인스턴스들에 간접적으로만 연결되어
// 있음), resolveRegistrationId를 resolveRegistrationIds로 바꿔서 정규교재 페이지 id가 들어오면
// 그 교재를 쓰는 진도교재 인스턴스를 전부 찾고, 각 인스턴스의 "등록" 관계를 모아(그룹 진도
// 인스턴스는 등록이 여러 건일 수 있음) 그 등록들을 모두 재동기화한다.
//
// [NEW, 2026-09-18 밤] 일정(학원) DB도 같은 방식으로 웹훅을 건다. 일정은 등록/학습기록처럼 "등록"
// 관계를 직접 갖지 않고, 대신 학생/클래스/학교/학년 4개의 독립된 관계축으로 대상을 지정한다
// (_shared/reportCacheBuilder.ts의 buildStudentNotices와 동일한 규칙 -- 학교/학년은 비어있으면
// 전체, 채워지면 그 값만 대상이 되는 와일드카드). 그래서 일정 페이지 id가 들어오면:
//   1) "학생" 관계에 걸린 학생이 있으면 그 학생의 등록을 모두 대상에 포함하고,
//   2) "클래스" 관계에 걸린 클래스가 있으면 그 클래스의 등록을 전부 조회해서 대상에 포함하고,
//   3) "학교"/"학년" 관계가 하나라도 채워져 있으면(둘 다 비어있으면 이 축은 아무에게도 전달되지
//      않으므로 건너뛴다) 학생(학원) DB를 그 조건으로 조회해서 대상 학생을 찾고, 그 학생들의
//      등록을 모두 포함한다.
// 세 경로에서 모은 등록 id를 합쳐서(중복 제거) 각각 재동기화한다.

import { requireAdminKey, CORS_HEADERS as ADMIN_CORS } from "../_shared/adminShared.ts"
import { queryAllPages, mapWithConcurrency, extractPageId, relationIds } from "../_shared/notionClient.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"
import { firstRelationId, makePageCache, upsertReportCacheRows, type ReportCacheRow } from "../_shared/reportCacheShared.ts"
import { buildCacheRowForRegistration, syncReportCacheForRegistration } from "../_shared/reportCacheBuilder.ts"

// 워크스페이스 구조상 고정값인 데이터소스 ID.
const DS_REGISTRATION = "16dba040-586b-838a-ae3c-876c0e9cd474"
// 진도교재(학원) DB. sync-registration-textbook/index.ts와 동일한 값 (정규교재 페이지 -> 그 교재를
// 쓰는 진도교재 인스턴스를 찾기 위해 필요).
const DATA_SOURCE_PROGRESS_BOOK = Deno.env.get("DATA_SOURCE_PROGRESS_BOOK_ID")!
// 학생(학원) DB. _shared/constants.ts의 DS_STUDENT와 동일한 값 (일정 웹훅의 학교/학년 와일드카드
// 대상을 찾기 위해 필요 -- 이 파일은 다른 함수 폴더처럼 자기 것만 쓰는 값이라 공용 모듈에서
// 가져오지 않고 그대로 복사해 둔다).
const DS_STUDENT = "bdeba040-586b-827d-8ef6-871aff52cce9"

// 일정(학원) 페이지 식별: "구분"(select)과 "날짜"(date) 조합은 일정(학원) DB에만 있다. 등록/학습기록/
// 학습활동/보고서/정규교재는 모두 아래에서 "등록" 관계 또는 "북커버" 속성으로 먼저 걸러지므로, 이
// 함수는 그 다음 단계에서만 호출된다.
function isNoticePage(page: any): boolean {
  const props = page?.properties ?? {}
  return props["구분"]?.type === "select" && props["날짜"] !== undefined
}

// 일정 페이지 하나로부터, 그 일정이 실제로 노출되는 학생들의 등록 id를 모두 찾는다.
// _shared/reportCacheBuilder.ts의 buildStudentNotices()가 학생 1명 기준으로 계산하는 규칙을
// 반대 방향(일정 1건 -> 영향받는 학생들)으로 뒤집은 것이다.
async function resolveRegistrationIdsForNotice(
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

  // 3) 학교/학년 와일드카드 -- 둘 중 하나라도 채워져 있으면 학생(학원) DB를 그 조건으로 조회한다.
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

// webhook body(등록/학습기록/학습활동/보고서/정규교재/일정 페이지 id)로부터 실제 리포트 캐시 대상인
// "등록" 페이지 id들을 알아낸다.
// - 등록 페이지 자신: "등록"/"북커버" 속성이 모두 없으므로(자기 자신이 등록이므로) 그대로 pageId
//   하나를 반환한다.
// - 학습기록/학습활동/보고서 페이지: "등록" 관계를 따라간다 (한 건).
// - 정규교재 페이지: "등록" 관계가 없고 "북커버" 속성으로 식별한다. 이 정규교재를 쓰는 진도교재
//   인스턴스를 전부 찾아 각 인스턴스의 "등록" 관계를 모두 모아 반환한다 (그룹 진도 인스턴스는 등록이
//   여러 건일 수 있음).
// - [NEW, 2026-09-18 밤] 일정 페이지: "등록"/"북커버" 속성이 모두 없고 "구분"(select)+"날짜"(date)
//   조합으로 식별한다. resolveRegistrationIdsForNotice로 영향받는 등록들을 모두 찾아 반환한다.
async function resolveRegistrationIds(pageId: string, cachedGetPage: (id: string) => Promise<any>): Promise<string[]> {
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: ADMIN_CORS })

  try {
    const body = await req.json().catch(() => ({}))
    const cachedGetPage = makePageCache()

    if (body?.mode === "all") {
      const authError = await requireAdminKey(req)
      if (authError) return authError
      const registrations = await queryAllPages(DS_REGISTRATION, {
        property: "토큰",
        rich_text: { is_not_empty: true },
      })
      const rows = await mapWithConcurrency(registrations, 4, (reg) => buildCacheRowForRegistration(reg, cachedGetPage))
      const validRows = rows.filter((r): r is ReportCacheRow => r !== null)
      await upsertReportCacheRows(validRows)
      return new Response(JSON.stringify({ synced: validRows.length, skipped: rows.length - validRows.length }), {
        headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
      })
    }

    const rawId = (typeof body?.registrationId === "string" && body.registrationId) || extractPageId(body)
    if (!rawId) throw new Error("registrationId를 찾을 수 없습니다.")

    if (body?.awaitCompletion === true) {
      const authError = await requireAdminKey(req)
      if (authError) return authError
      const registrationIds = await resolveRegistrationIds(rawId, cachedGetPage)
      const rows = await mapWithConcurrency(registrationIds, 4, (id) => syncReportCacheForRegistration(id, cachedGetPage))
      const synced = rows.filter((r): r is ReportCacheRow => r !== null).length
      return new Response(JSON.stringify({ synced, registrationIds }), {
        headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
      })
    }

    // Notion 버튼(웹훅 보내기) / 각 DB의 "생성 또는 편집 시" 자동화 호출 경로 -- 다른 버튼 웹훅들과
    // 동일하게 별도 인증 없이 신뢰하고, 즉시 202를 돌려준 뒤 백그라운드에서 처리한다.
    runInBackground(async () => {
      try {
        const registrationIds = await resolveRegistrationIds(rawId, cachedGetPage)
        await mapWithConcurrency(registrationIds, 4, (id) => syncReportCacheForRegistration(id, cachedGetPage))
      } catch (err) {
        console.error("sync-report-cache 백그라운드 처리 실패:", (err as Error).message)
      }
    })
    return respondAccepted({ pageId: rawId })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500,
      headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
    })
  }
})
