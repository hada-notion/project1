// POST /functions/v1/class-room
// 수업방(class_room.html)이 부르는 함수(v2.5.66). 선생님 공용 수업 세션(수업용 비밀번호, v2.5.65)과
// 관리자 세션만 통과한다(adminSecurity.ts의 class-room 경로). 요청 본문의 action에 따라
// 조회(teachers/day/session/books/activities)와 저장(save-*, create-*, update-record, 보강 대기실)을 한다.
// 실제 로직은 _shared/classRoom.ts.
import { CORS_HEADERS, requireAdminKey } from "../_shared/adminShared.ts"
import { ClassRoomError, handleClassRoom } from "../_shared/classRoom.ts"

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } })

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })
  if (req.method !== "POST") return json({ error: "POST 요청만 지원합니다." }, 405)
  const authError = await requireAdminKey(req)
  if (authError) return authError
  try {
    const raw = await req.text()
    if (raw.length > 64_000) return json({ error: "요청이 너무 큽니다." }, 413)
    let body: unknown
    try { body = JSON.parse(raw) } catch { return json({ error: "요청 형식이 올바르지 않습니다." }, 400) }
    return json(await handleClassRoom(body))
  } catch (err) {
    if (err instanceof ClassRoomError) return json({ error: err.message }, err.status)
    console.error("[class-room]", (err as Error).message)
    return json({ error: "처리 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요." }, 500)
  }
})
