import { NOTION_API, DS_SCHEDULE_EVENT } from "./constants.ts"
import { fetchWithRetry, notionHeaders } from "./notionClient.ts"
export async function schoolNotion(path: string, method = "GET", body?: unknown): Promise<any> {
  if (!DS_SCHEDULE_EVENT) throw new Error("DATA_SOURCE_SCHEDULE_EVENT_ID 설정 필요")
  const init = { method, headers: notionHeaders(), body: body === undefined ? undefined : JSON.stringify(body) }
  // 생성 POST는 응답 유실 시 중복을 만들지 않도록 자동 재시도하지 않는다.
  const res = path === "/pages" && method === "POST"
    ? await fetch(NOTION_API + path, { ...init, signal: AbortSignal.timeout(12000) })
    : await fetchWithRetry(NOTION_API + path, init, 2)
  if (!res.ok) throw new Error("Notion API 오류 " + res.status)
  return res.json()
}
export async function schoolSources() {
  const db = await schoolNotion("/data_sources/" + DS_SCHEDULE_EVENT)
  const schools = db.properties?.["학교"]?.relation?.data_source_id
  const grades = db.properties?.["학년"]?.relation?.data_source_id
  if (!schools || !grades) throw new Error("일정 DB 학교/학년 관계 연결 확인 필요")
  return { schools, grades, events: DS_SCHEDULE_EVENT }
}
export function compactId(id: string): string { return id.replaceAll("-", "").toLowerCase() }
