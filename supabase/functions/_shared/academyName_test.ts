import { findAcademyName } from "./academyName.ts"
function assert(v: unknown, m = "assertion failed") { if (!v) throw new Error(m) }
const title = (t: string) => ({ properties: { 이름: { type: "title", title: [{ plain_text: t }] } } })
// 등록 DB → (블록) → 공개 DB 페이지 → 메뉴 DB → 제목 없는 페이지 → 최상위 페이지 → workspace
const tree: Record<string, any> = {
  "databases/reg": { parent: { type: "block_id", block_id: "blk" } },
  "blocks/blk": { parent: { type: "page_id", page_id: "public" } },
  "pages/public": { ...title("공개 DB"), parent: { type: "data_source_id", data_source_id: "ds", database_id: "menu" } },
  "databases/menu": { parent: { type: "page_id", page_id: "blank" } },
  "pages/blank": { ...title(""), parent: { type: "page_id", page_id: "root" } },
  "pages/root": { ...title(" 하다 학원관리 v2.0 "), parent: { type: "workspace", workspace: true } },
}
const get = (kind: string, id: string) => Promise.resolve(tree[`${kind}/${id}`] ?? null)
Deno.test("academy name is the title of the top-level page above the registration DB", async () => {
  assert(await findAcademyName("reg", get) === "하다 학원관리 v2.0")
})
Deno.test("academy name is empty when a parent is not shared, instead of a wrong middle page", async () => {
  const partial = (kind: string, id: string) => Promise.resolve(id === "root" ? null : tree[`${kind}/${id}`] ?? null)
  assert(await findAcademyName("reg", partial) === "")
})
Deno.test("academy name lookup stops on unexpected parents and loops", async () => {
  const loop = (kind: string, id: string) => Promise.resolve(kind === "databases" ? { parent: { type: "page_id", page_id: "p" } } : { ...title("x"), parent: { type: "database_id", database_id: "d" } })
  assert(await findAcademyName("reg", loop) === "")
  assert(await findAcademyName("reg", () => Promise.resolve({ parent: { type: "unknown" } })) === "")
})
