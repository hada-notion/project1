// 학원 이름 = 이 학원 Notion 최상위 페이지의 제목(원본: "하다 학원관리 v2.0").
// 운영은 그 페이지 제목만 바꾸면 키오스크 등에 표시되는 이름이 따라 바뀐다.
// 등록 DB에서 부모를 따라 올라가 workspace 바로 아래 페이지의 제목을 쓴다. 중간에 접근할 수 없는
// 부모가 있으면(최상위 페이지가 연결에 공유되지 않음) 잘못된 이름 대신 빈 문자열을 돌려준다.
import { NOTION_API } from "./constants.ts"
import { anyTitleText, fetchWithRetry, notionHeaders } from "./notionClient.ts"

type Getter = (kind: "pages" | "databases" | "blocks", id: string) => Promise<any | null>

async function notionGet(kind: "pages" | "databases" | "blocks", id: string): Promise<any | null> {
  const res = await fetchWithRetry(`${NOTION_API}/${kind}/${id}`, { headers: notionHeaders() })
  if (!res.ok) return null
  return res.json()
}

export async function findAcademyName(registrationDbId: string, get: Getter = notionGet): Promise<string> {
  let node: { kind: "pages" | "databases" | "blocks"; id: string } | null = { kind: "databases", id: registrationDbId }
  let lastTitle = ""
  for (let step = 0; node && step < 15; step++) {
    const obj = await get(node.kind, node.id)
    if (!obj) return ""
    if (node.kind === "pages") lastTitle = anyTitleText(obj).trim()
    const p = obj.parent ?? {}
    if (p.type === "workspace") return node.kind === "pages" ? lastTitle : ""
    if (p.type === "page_id") node = { kind: "pages", id: p.page_id }
    else if (p.type === "database_id" || p.type === "data_source_id") node = { kind: "databases", id: p.database_id }
    else if (p.type === "block_id") node = { kind: "blocks", id: p.block_id }
    else return ""
    if (!node.id) return ""
  }
  return ""
}

// 함수 인스턴스 안에서 1시간 동안 재사용한다(키오스크는 5분마다 목록을 새로 받는다).
let cached: { name: string; at: number } | null = null
export async function academyName(registrationDbId: string): Promise<string> {
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.name
  let name = ""
  try { name = await findAcademyName(registrationDbId) } catch (e) { console.error("academy name lookup failed", (e as Error).message) }
  cached = { name, at: Date.now() }
  return name
}
