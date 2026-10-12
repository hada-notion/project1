// Supabase Edge Function: kiosk-prepare (v2.5.37)
//
// 키오스크 "오늘 출석 준비"를 만든다(_shared/kioskToday.ts). 매일 04:00 KST pg_cron이 내부 키로 호출한다
// (마이그레이션 20261013030000_kiosk_today.sql). 그날 준비가 없을 때 키오스크를 열면 list-students가
// 같은 준비를 뒤에서 자동으로 한다. 응답에는 개수와 시각만 담는다.
import { CORS_HEADERS, requireAdminKey } from "../_shared/adminShared.ts"
import { prepareKioskToday } from "../_shared/kioskToday.ts"

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })
  if (req.method !== "POST") return new Response("Use POST", { status: 405, headers: CORS_HEADERS })
  const authError = await requireAdminKey(req)
  if (authError) return authError
  try {
    const body = await req.json().catch(() => ({}))
    const source = body?.source === "cron" ? "cron" : "manual"
    const prepared = await prepareKioskToday(source)
    return new Response(JSON.stringify({ ok: true, kstDate: prepared.kst_date, preparedAt: prepared.prepared_at, rows: prepared.row_count }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  } catch (err) {
    console.error("kiosk-prepare error:", (err as Error).message)
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
})
