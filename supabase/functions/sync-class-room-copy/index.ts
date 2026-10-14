// POST /functions/v1/sync-class-room-copy — 수업 관리 복사본 동기화(v2.5.113). 관리자 키(x-admin-key) 필요.
// body:
//   { mode: "reconcile", table: "cr_sessions", fromDays?: 120, toDays?: 60 } — 표 하나를 기간 전체 대조(처음 채우기·매일 밤).
//       함수 한 번 실행 시간 한도 안에 끝나도록 표 하나씩 부른다.
//   { mode: "incremental", table?: "cr_…" } — 마지막 동기화 이후 Notion에서 바뀐 것만(표를 안 주면 네 표 모두).
//   { mode: "class", sessionId } — 그 수업이 속한 반의 앞뒤 수업과 출석·기록·학습활동만.
// Notion은 읽기만 한다. 실제 로직은 _shared/classRoomCopy.ts. 수업 관리(class-room)는 아직 이 표를 읽지 않는다.
import { CORS_HEADERS, requireAdminKey } from "../_shared/adminShared.ts"
import { COPY_TABLES, isCopyTable, reconcileTable, incrementalTable, syncClassOfSession } from "../_shared/classRoomCopy.ts"

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } })
const isId = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{32,36}$/i.test(v)
const days = (v: unknown, fallback: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 400 ? v as number : fallback)

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })
  if (req.method !== "POST") return json({ error: "POST 요청만 지원합니다." }, 405)
  const authError = await requireAdminKey(req)
  if (authError) return authError
  const startedAt = Date.now()
  try {
    const body = await req.json().catch(() => ({}))
    if (body?.mode === "reconcile") {
      if (!isCopyTable(body.table)) return json({ error: `table은 ${COPY_TABLES.join(", ")} 중 하나여야 합니다.` }, 400)
      const result = await reconcileTable(body.table, days(body.fromDays, 120), days(body.toDays, 60))
      return json({ ok: true, mode: "reconcile", results: [result], ms: Date.now() - startedAt })
    }
    if (body?.mode === "incremental") {
      if (body.table !== undefined && !isCopyTable(body.table)) return json({ error: "table 값이 올바르지 않습니다." }, 400)
      const tables = body.table ? [body.table] : [...COPY_TABLES]
      const results = []
      for (const t of tables) results.push(await incrementalTable(t))
      return json({ ok: true, mode: "incremental", results, ms: Date.now() - startedAt })
    }
    if (body?.mode === "class") {
      if (!isId(body.sessionId)) return json({ error: "sessionId 형식이 올바르지 않습니다." }, 400)
      return json({ ok: true, mode: "class", results: await syncClassOfSession(body.sessionId), ms: Date.now() - startedAt })
    }
    return json({ error: 'mode는 "reconcile", "incremental", "class" 중 하나여야 합니다.' }, 400)
  } catch (err) {
    console.error("[sync-class-room-copy]", (err as Error).message)
    return json({ error: (err as Error).message, ms: Date.now() - startedAt }, 500)
  }
})
