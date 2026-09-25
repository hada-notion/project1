// POST /functions/v1/get-report-fast
// body: { token: string }
//
// Notion을 직접 조회하지 않고, sync-report-cache가 미리 계산해 둔 report_cache 테이블을
// 그대로 읽어서 응답한다 (빠릅고 Notion 레이트리미트와 무관).
import {
  CORS_HEADERS,
  selectReportCacheByToken,
  selectReportCacheOverviewsByStudentKey,
} from "../_shared/reportCacheShared.ts"

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })

  try {
    const { token } = await req.json()
    if (!token) {
      return new Response(JSON.stringify({ error: "token이 필요합니다." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      })
    }

    const row = await selectReportCacheByToken(token)
    if (!row) {
      return new Response(JSON.stringify({ error: "유효하지 않은 토큰입니다." }), {
        status: 404,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      })
    }

    const overviews = await selectReportCacheOverviewsByStudentKey(row.student_key)
    overviews.sort((a: any, b: any) => String(a?.start_date ?? "").localeCompare(String(b?.start_date ?? "")))

    // 학교 성적은 내부 운영 정보이며 학부모용 리포트 응답에는 포함하지 않는다.
    // 기존 캐시에 grades가 남아 있어도 공개 응답 경계에서 제거한다.
    const { grades: _privateGrades, ...publicStudentFields } = row.student_fields ?? {}
    const payload = {
      ...publicStudentFields,
      token: row.access_token,
      registration_id: row.registration_id,
      registrations: overviews,
    }

    return new Response(JSON.stringify(payload), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
})
