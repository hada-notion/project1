// POST /functions/v1/fill-record-units — 학습기록(학원) DB [단원 입력] 버튼(v2.5.127). Notion 웹훅 키(x-admin-key) 필요.
// body: Notion 버튼 웹훅 본문(페이지 id를 찾아 쓴다) 또는 { pageId }.
// 그 학습기록의 지금 범위로 교재(라이브러리) 단원을 찾아 단원 관계("단원" 또는 "선택 단원")를 새로 채운다(덮어쓰기, 토글 아님).
// 범위는 쉼표로 여러 구간을 쓸 수 있다(예: "12-24, 31-35"). 실제 로직은 _shared/selectedUnits.ts·_shared/unitRange.ts.
import { CORS_HEADERS, requireAdminKey } from "../_shared/adminShared.ts"
import { extractPageId } from "../_shared/notionClient.ts"
import { FillUnitsError, fillRecordUnits } from "../_shared/selectedUnits.ts"
import { textbookSources } from "../_shared/textbookSearch.ts"
import { mirrorLater } from "../_shared/classRoomCopy.ts"

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } })

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== "POST") return json({ error: "POST 요청만 지원합니다." }, 405)
  const denied = await requireAdminKey(req)
  if (denied) return denied
  try {
    const body = await req.json().catch(() => ({}))
    const pageId = extractPageId(body)
    if (!pageId) return json({ error: "학습기록 페이지를 찾지 못했습니다(pageId)." }, 400)
    const result = await fillRecordUnits(pageId, await textbookSources())
    mirrorLater([["cr_records", [result.recordId]]]) // 수업 관리 복사본도 맞춘다(뒤에서)
    return json(result)
  } catch (err) {
    if (err instanceof FillUnitsError) return json({ error: err.message }, err.status)
    console.error("[fill-record-units]", (err as Error).message)
    return json({ error: "단원을 채우지 못했습니다. 잠시 후 다시 눌러 주세요." }, 500)
  }
})
