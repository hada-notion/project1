// POST /functions/v1/update-admin-key
// body: { newPassword }
// 주의: Deno KV가 해당 Supabase 프로젝트 Edge Runtime에서 지원되지 않는다면 setCurrentAdminKey가 false를 리턴합니다.
// 이 경우에는 뱄로읔호 변경이 저장되지 않으므려(재시작 시 초기화될 수 있으므려),
// `supabase secrets set ADMIN_SECRET=...`로 직접 밀변개하는 경로만 사용하세요.
import { CORS_HEADERS, requireAdminKey, setCurrentAdminKey } from "../_shared/adminShared.ts"

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })

  const authError = await requireAdminKey(req)
  if (authError) return authError

  try {
    const { newPassword } = await req.json()
    if (!newPassword || String(newPassword).length < 4) throw new Error("새 뱄로읔호는 4자 이상이어야 합니다.")

    const saved = await setCurrentAdminKey(String(newPassword))
    if (!saved) {
      return new Response(
        JSON.stringify({ error: "이 Supabase 프로젝트에서는 Deno KV가 지원되지 않아 뱄로읔호를 저장할 수 없습니다. supabase secrets set ADMIN_SECRET=... 로 링접 밀변개해주세요." }),
        { status: 501, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      )
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
})
