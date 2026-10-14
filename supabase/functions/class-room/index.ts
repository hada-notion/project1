// POST /functions/v1/class-room
// 수업 관리(class_room.html)가 부르는 함수(v2.5.66). 관리자 비밀번호로 로그인한 관리자 세션만 통과한다
// (adminSecurity.ts의 class-room 경로, v2.5.82에 수업용 비밀번호 삭제). 요청 본문의 action에 따라
// 조회(teachers/day/session/books/activities)와 저장(save-*, create-*, update-record, 보강 대기실)을 한다.
// 실제 로직은 _shared/classRoom.ts.
import { CORS_HEADERS, requireAdminKey } from "../_shared/adminShared.ts"
import { ClassRoomError, handleClassRoom } from "../_shared/classRoom.ts"

// (v2.5.108, 속도 측정 0단계) 이 함수 안에서만 Notion API 호출 수를 센다. 공용 Notion 모듈은 건드리지 않는다.
// 같은 함수 인스턴스가 여러 요청을 동시에 처리하면 그 사이 호출이 함께 세어질 수 있다(측정용 근사값).
const notionCount = { calls: 0, waitMs: 0 }
const baseFetch = globalThis.fetch
globalThis.fetch = async (input: Request | URL | string, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!url.startsWith("https://api.notion.com/")) return baseFetch(input, init)
  notionCount.calls++
  const t = Date.now()
  try { return await baseFetch(input, init) } finally { notionCount.waitMs += Date.now() - t }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } })

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })
  if (req.method !== "POST") return json({ error: "POST 요청만 지원합니다." }, 405)
  const startedAt = Date.now()
  const authError = await requireAdminKey(req)
  if (authError) return authError
  try {
    const raw = await req.text()
    if (raw.length > 64_000) return json({ error: "요청이 너무 큽니다." }, 413)
    let body: unknown
    try { body = JSON.parse(raw) } catch { return json({ error: "요청 형식이 올바르지 않습니다." }, 400) }
    // (v2.5.108, 속도 측정 0단계) 응답에 서버 처리 시간과 Notion 호출 수를 함께 싣는다. 화면은 ?timing=1일 때만 보여 준다.
    const calls0 = notionCount.calls, wait0 = notionCount.waitMs
    const result = await handleClassRoom(body)
    const _timing = { ms: Date.now() - startedAt, notion: notionCount.calls - calls0, notionWaitMs: notionCount.waitMs - wait0 }
    return json(result && typeof result === "object" && !Array.isArray(result) ? { ...result, _timing } : { result, _timing })
  } catch (err) {
    if (err instanceof ClassRoomError) return json({ error: err.message }, err.status)
    console.error("[class-room]", (err as Error).message)
    return json({ error: "처리 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요." }, 500)
  }
})
