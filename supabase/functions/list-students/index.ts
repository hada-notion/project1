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

function todayKst(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date())
}

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
    const registrations = await notionQueryDatabaseAll(registrationDbId, {
      page_size: 100,
    })

    // 출석(학원) DB ID를 하드코딩하지 않고 등록 DB의 "출석" relation 스키마에서 직접 찾습니다. (부록 A 참조)
    const attendanceDbId = await resolveRelatedDatabaseId(registrationDbId, "출석").catch(() =>
      resolveRelatedDatabaseId(registrationDbId, "출석"),
    )

    const today = todayKst()

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
