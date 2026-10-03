// 학교별 행사 종류를 필터링하지 않는다. 모든 원본 행을 보존한다.
export type NeisRow = Record<string, string | null>
const gradeFields = ["ONE_GRADE_EVENT_YN", "TW_GRADE_EVENT_YN", "THREE_GRADE_EVENT_YN", "FR_GRADE_EVENT_YN", "FIV_GRADE_EVENT_YN", "SIX_GRADE_EVENT_YN"]
export function eventGrades(row: NeisRow): number[] {
  return gradeFields.flatMap((field, i) => row[field] === "Y" ? [i + 1] : [])
}
export function safeWebsite(raw: string | null): string | null {
  if (!raw?.trim()) return null
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw)
    return ["https:", "http:"].includes(url.protocol) ? url.href : null
  } catch { return null }
}
export async function eventKey(row: NeisRow, schoolPageId: string): Promise<string> {
  // API에 행사 고유 ID가 없으므로 날짜/행사명 변경은 다른 키가 된다. 기존 일정은 삭제하지 않는다.
  const value = JSON.stringify([schoolPageId.replaceAll("-", ""), row.ATPT_OFCDC_SC_CODE, row.SD_SCHUL_CODE, row.AY, row.AA_YMD, row.DGHT_CRSE_SC_NM, row.SCHUL_CRSE_SC_NM, row.EVENT_NM, eventGrades(row)])
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return "neis:" + Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("")
}
export function richText(value: string | null): { rich_text: { text: { content: string } }[] } {
  const text = value ?? ""
  return { rich_text: Array.from({ length: Math.ceil(text.length / 1900) }, (_, i) => ({ text: { content: text.slice(i * 1900, (i + 1) * 1900) } })) }
}
export function textOf(page: any, name: string): string {
  const p = page.properties?.[name]
  return (p?.rich_text ?? p?.title ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? "").join("")
}
export async function neisRows(service: "schoolInfo" | "SchoolSchedule", params: Record<string, string>): Promise<NeisRow[]> {
  const key = Deno.env.get("NEIS_API_KEY")
  if (!key) throw new Error("NEIS_API_KEY를 Supabase Secrets에 먼저 설정하세요.")
  const rows: NeisRow[] = []
  for (let pIndex = 1; pIndex <= 100; pIndex++) {
    const url = new URL("https://open.neis.go.kr/hub/" + service)
    Object.entries({ ...params, KEY: key, Type: "json", pSize: "100", pIndex: String(pIndex) }).forEach(([k, v]) => url.searchParams.set(k, v))
    // URL에는 인증키가 포함되어 있으므로 기존 fetchWithRetry의 URL 로그를 사용하지 않는다.
    let res: Response
    try { res = await fetch(url, { signal: AbortSignal.timeout(12000) }) }
    catch { throw new Error("나이스 연결 실패/시간 초과. 다음 실행에서 다시 조회합니다.") }
    if (!res.ok) throw new Error("나이스 HTTP " + res.status)
    const json = await res.json()
    if (json.RESULT) {
      if (json.RESULT.CODE === "INFO-200") return rows
      throw new Error("나이스 응답 오류: " + json.RESULT.CODE)
    }
    const data = json[service]
    const head = data?.find((x: any) => x.head)?.head
    const status = head?.find((x: any) => x.RESULT)?.RESULT?.CODE
    if (status !== "INFO-000") throw new Error("나이스 응답 형식/상태 오류")
    const part = data?.find((x: any) => x.row)?.row
    const total = head?.find((x: any) => x.list_total_count)?.list_total_count
    if (!Array.isArray(part) || !Number.isInteger(total)) throw new Error("나이스 목록 형식 오류")
    rows.push(...part)
    if (rows.length >= total) return rows
    if (part.length === 0) throw new Error("나이스 페이지 누락")
  }
  throw new Error("나이스 페이지 상한 초과: 부분 결과를 동기화하지 않습니다.")
}
export function ownedProperties(row: NeisRow, pageId: string, key: string, gradeIds: string[]) {
  const d = row.AA_YMD ?? ""
  if (!/^\d{8}$/.test(d) || !row.EVENT_NM) throw new Error("학사일자/행사명 누락")
  return {
    "이름": { title: [{ text: { content: row.EVENT_NM.slice(0, 1900) } }] },
    "날짜": { date: { start: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, end: null } },
    "구분": { select: { name: "🏫 학사 일정" } },
    "학교": { relation: [{ id: pageId }] }, "학년": { relation: gradeIds.map(id => ({ id })) },
    "대상 학년": richText(eventGrades(row).map(n => `${n}학년`).join(", ") || "미지정"),
    "수업공제일명": richText(row.SBTR_DD_SC_NM), "원본 행사내용": richText(row.EVENT_CNTNT),
    "NEIS 동기화키": richText(key),
    // 숨김/메모/태그/담당자/진행상태/본문은 동기화 소유가 아니므로 절대 덮어쓰지 않는다.
  }
}
