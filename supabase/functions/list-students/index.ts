// GET /functions/v1/list-students
import {
  CORS_HEADERS,
  getRegistrationDbId,
  notionQueryDatabaseAll,
  requireAdminKey,
  resolveRelatedDatabaseId,
  notionQueryDatabase,
  parseTokenValue,
} from "../_shared/adminShared.ts"

import { buildKioskDirectory, queryAllKioskPages, ACTIVE_KIOSK_STATUS } from "../_shared/kioskIdentity.ts"
import { academyName } from "../_shared/academyName.ts"
import { kstDate, prepareKioskToday, readKioskPrepared } from "../_shared/kioskToday.ts"

import { runAfterResponse } from "../_shared/afterResponse.ts"

function plainText(prop: any): string {
  if (!prop) return ""
  const arr = prop.title ?? prop.rich_text ?? []
  return arr.map((t: any) => t.plain_text).join("")
}

function selectName(prop: any): string {
  return prop?.select?.name ?? prop?.status?.name ?? ""
}

function relationIds(prop: any): string[] {
  return (prop?.relation ?? []).map((r: any) => r.id)
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })

  const authError = await requireAdminKey(req)
  if (authError) return authError

  try {
    const registrationDbId = getRegistrationDbId()
    // 키오스크 전용 최소 목록: 출석 이력·보고서 토큰·보호자 이름은 포함하지 않는다.
    if (new URL(req.url).searchParams.get("kiosk") === "1") {
      const studentDbId = await resolveRelatedDatabaseId(registrationDbId, "학생정보")
      const students = await queryAllKioskPages(body => notionQueryDatabase(studentDbId, body))
      const registrations = await queryAllKioskPages(body => notionQueryDatabase(registrationDbId, body), {
        filter: { property: "수강상태", formula: { string: { equals: ACTIVE_KIOSK_STATUS } } },
      })
      // academyName: 키오스크 아래에 작게 표시하는 학원 이름(Notion 최상위 페이지 제목).
      const name = await academyName(registrationDbId)
      // 출석 동기화(오늘 출석 준비, v2.5.37): 새벽 준비가 없으면 방금 읽은 목록으로 뒤에서 자동 준비한다(화면은 기다리지 않음).
      // kioskPrepared.at은 키오스크 아래에 "출석 동기화 HH:mm"으로 연하게 표시된다.
      // [v2.5.39] &sync=1: 키오스크 설정의 "지금 동기화"(관리자 비밀번호 확인 후). 응답 전에 다시 준비한다.
      // 1분 안에 이미 준비했으면 다시 하지 않는다(연속 클릭으로 Notion 조회가 몰리지 않게).
      const forceSync = new URL(req.url).searchParams.get("sync") === "1"
      let kioskPrepared: { at: string | null; today: boolean; preparing: boolean; synced?: boolean; syncError?: string } = { at: null, today: false, preparing: false }
      try {
        let prepared = await readKioskPrepared()
        if (forceSync) {
          const recentlyPrepared = prepared?.prepared_at && Date.now() - Date.parse(prepared.prepared_at) < 60_000
          if (!recentlyPrepared) prepared = await prepareKioskToday("manual", { registrations, students })
          kioskPrepared.synced = !recentlyPrepared
        }
        const today = prepared?.kst_date === kstDate()
        kioskPrepared = { ...kioskPrepared, at: prepared?.prepared_at ?? null, today, preparing: !today }
        if (!today) {
          runAfterResponse(prepareKioskToday("auto", { registrations, students }).catch(err => console.error("kiosk auto prepare error:", (err as Error).message)))
        }
      } catch (err) {
        console.error("kiosk prepared error:", (err as Error).message)
        if (forceSync) kioskPrepared.syncError = "출석 동기화에 실패했습니다. 잠시 후 다시 시도해주세요."
      }
      return new Response(JSON.stringify({ candidates: buildKioskDirectory(registrations, students), academyName: name, kioskPrepared, generatedAt: new Date().toISOString() }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
      })
    }
    const registrations = await notionQueryDatabaseAll(registrationDbId, {
      page_size: 100,
    })

    // 출석(학원) DB ID를 하드코딩하지 않고 등록 DB의 "출석" relation 스키마에서 직접 찾습니다. (부록 A 참조)
    const attendanceDbId = await resolveRelatedDatabaseId(registrationDbId, "출석").catch(() =>
      resolveRelatedDatabaseId(registrationDbId, "출석"),
    )

    const today = kstDate()

    const students = await Promise.all(
      registrations.map(async (reg: any) => {
        const props = reg.properties ?? {}
        const studentTitle = plainText(props["학생"] ?? props["이름"] ?? props["Name"] ?? props["제목"])
        const registrationId = reg.id
        const status = selectName(props["수강상태"] ?? props["상태"])
        const teacherName = plainText(props["강사"] ?? props["선생님"])
        const school = plainText(props["학교"])
        const grade = plainText(props["학년"] ?? props["학단"] ?? props["학막"])
        const tokenRaw = plainText(props["토큰"])
        const { accessToken, disabled } = parseTokenValue(tokenRaw)

        const attendanceIds = relationIds(props["출석"] ?? props["샜석"])

        let hasClassToday = false
        let attendanceId: string | null = null
        let lastClassDate: string | null = null

        if (attendanceIds.length) {
          const attendanceRows = await notionQueryDatabase(attendanceDbId, {
            filter: {
              or: attendanceIds.map((id: string) => ({ property: "등록", relation: { contains: id } })),
            },
            page_size: 100,
          }).catch(() => ({ results: [] }))

          for (const row of attendanceRows.results ?? []) {
            const rowDate = row.properties?.["수업일시"]?.date?.start
            if (!rowDate) continue
            const dateOnly = String(rowDate).slice(0, 10)
            if (!lastClassDate || dateOnly > lastClassDate) lastClassDate = dateOnly
            if (dateOnly === today) {
              hasClassToday = true
              attendanceId = row.id
            }
          }
        }

        return {
          registrationId,
          studentName: studentTitle,
          title: studentTitle,
          school,
          grade,
          teacherName,
          status,
          accessToken: disabled ? null : accessToken,
          linkDisabled: disabled,
          hasClassToday,
          attendanceId,
          lastClassDate,
          updatedAt: reg.last_edited_time,
        }
      }),
    )

    return new Response(JSON.stringify({ students }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
})
