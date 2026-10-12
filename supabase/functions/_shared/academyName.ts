// 학원 이름 = Notion 연결(integration)이 걸린 학원 루트 페이지의 제목(원본: "하다 학원관리 v2.0").
// 운영은 그 페이지 제목만 바꾸면 키오스크 등에 표시되는 이름이 따라 바뀐다.
// 등록 DB에서 부모를 따라 올라가며, 더 위 부모를 읽을 수 없거나 workspace에 닿으면 그때까지 올라온
// 가장 위 페이지의 제목을 쓴다(연결은 루트에 걸고 아래로 상속되므로 읽히는 가장 위 페이지가 루트다).
// 이름을 못 찾으면 멈춘 단계를 함수 로그에 남긴다(값은 Notion 내부 ID뿐, 비밀값 없음).
import { NOTION_API } from "./constants.ts"
import { anyTitleText, fetchWithRetry, notionHeaders } from "./notionClient.ts"

type Kind = "pages" | "databases" | "data_sources" | "blocks"
type Getter = (kind: Kind, id: string) => Promise<any | null>
export type AcademyNameResult = { name: string; stoppedAt?: string }

async function notionGet(kind: Kind, id: string): Promise<any | null> {
  const res = await fetchWithRetry(`${NOTION_API}/${kind}/${id}`, { headers: notionHeaders() })
  if (!res.ok) return null
  return res.json()
}

export async function findAcademyName(registrationDbId: string, get: Getter = notionGet): Promise<AcademyNameResult> {
  let node: { kind: Kind; id: string } | null = { kind: "databases", id: registrationDbId }
  let lastTitle = "", reachedPage = false
  for (let step = 0; node && step < 15; step++) {
    let obj = await get(node.kind, node.id)
    // The configured registration ID may be a data source ID rather than a database ID.
    if (!obj && step === 0) { node = { kind: "data_sources", id: registrationDbId }; obj = await get(node.kind, node.id) }
    // The parent above the connected root is not readable: the highest page reached is the root.
    if (!obj) return step > 0 && reachedPage ? { name: lastTitle, stoppedAt: lastTitle ? undefined : `${node.kind}:${node.id}:not-accessible` } : { name: "", stoppedAt: `${node.kind}:${node.id}:not-accessible` }
    if (node.kind === "pages") { lastTitle = anyTitleText(obj).trim(); reachedPage = true }
    const p = obj.parent ?? {}
    if (p.type === "workspace") return node.kind === "pages" ? { name: lastTitle } : { name: "", stoppedAt: `${node.kind}:${node.id}:top-is-not-a-page` }
    if (p.type === "page_id") node = { kind: "pages", id: p.page_id }
    else if (p.type === "database_id" || p.type === "data_source_id") node = { kind: "databases", id: p.database_id }
    else if (p.type === "block_id") node = { kind: "blocks", id: p.block_id }
    else return { name: "", stoppedAt: `${node.kind}:${node.id}:parent-${p.type ?? "missing"}` }
    if (!node.id) return { name: "", stoppedAt: "parent-without-id" }
  }
  return { name: "", stoppedAt: "too-deep" }
}

// 함수 인스턴스 안에서 이름을 찾으면 1시간, 못 찾으면 5분 동안 재사용한다(키오스크는 5분마다 목록을 받는다).
let cached: { name: string; at: number } | null = null
export async function academyName(registrationDbId: string): Promise<string> {
  if (cached && Date.now() - cached.at < (cached.name ? 60 : 5) * 60 * 1000) return cached.name
  let name = ""
  try {
    const result = await findAcademyName(registrationDbId)
    name = result.name
    if (!name) console.warn("academy name not found; stopped at", result.stoppedAt)
  } catch (e) { console.error("academy name lookup failed", (e as Error).message) }
  cached = { name, at: Date.now() }
  return name
}
