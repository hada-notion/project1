import { CORS_HEADERS, requireAdminKey } from "../_shared/adminShared.ts"
import { queryAllPages, getPage, updatePageProperties } from "../_shared/notionClient.ts"
import { neisRows, textOf, richText, safeWebsite } from "../_shared/neisSchool.ts"
import { schoolSources, compactId } from "../_shared/schoolNotion.ts"
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } })
Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== "POST") return json({ error: "POST required" }, 405)
  const denied = await requireAdminKey(req)
  if (denied) return denied
  try {
    const body = await req.json()
    const { schools } = await schoolSources()
    if (body.action === "meta") {
      const pages = await queryAllPages(schools)
      return json({ schools: pages.map(p => ({ id: p.id, name: textOf(p, "이름"), address: textOf(p, "주소"), code: textOf(p, "학교 코드") })) })
    }
    if (body.action === "search") {
      const q = String(body.query ?? "").trim()
      if (q.length < 2 || q.length > 80) return json({ error: "학교명은 2~80자로 입력하세요." }, 400)
      const rows = await neisRows("schoolInfo", { SCHUL_NM: q })
      const region = String(body.region ?? "").trim()
      return json({ schools: rows.filter(r => !region || (r.ORG_RDNMA ?? "").includes(region)).map(r => ({ name: r.SCHUL_NM, office: r.ATPT_OFCDC_SC_CODE, code: r.SD_SCHUL_CODE, address: r.ORG_RDNMA, kind: r.SCHUL_KND_SC_NM, website: safeWebsite(r.HMPG_ADRES) })) })
    }
    if (body.action === "link") {
      const id = String(body.pageId ?? "")
      if (!/^[0-9a-f-]{32,36}$/i.test(id)) return json({ error: "학교 페이지 ID 오류" }, 400)
      const page = await getPage(id)
      if (compactId(page.parent?.data_source_id ?? "") !== compactId(schools) || page.archived || page.in_trash) return json({ error: "학교 DB에 속한 활성 페이지가 아닙니다." }, 403)
      const office = String(body.office ?? ""), code = String(body.code ?? "")
      if (!/^[A-Z]\d{2}$/.test(office) || !/^\d{7}$/.test(code)) return json({ error: "학교 코드 형식 오류" }, 400)
      const found = await neisRows("schoolInfo", { ATPT_OFCDC_SC_CODE: office, SD_SCHUL_CODE: code })
      const s = found.find(r => r.ATPT_OFCDC_SC_CODE === office && r.SD_SCHUL_CODE === code)
      if (!s || !["초등학교", "중학교", "고등학교"].includes(s.SCHUL_KND_SC_NM ?? "")) return json({ error: "지원되는 학교를 찾지 못했습니다." }, 400)
      const existing = await queryAllPages(schools, { and: [{ property: "교육청 코드", rich_text: { equals: office } }, { property: "학교 코드", rich_text: { equals: code } }] })
      if (existing.some(p => compactId(p.id) !== compactId(id))) return json({ error: "이미 연결된 학교입니다. 기존 학교를 사용하세요." }, 409)
      const previous = textOf(page, "학교 코드")
      if (previous && (previous !== code || textOf(page, "교육청 코드") !== office)) return json({ error: "기존 학교 재연결은 지원하지 않습니다. 새 학교 페이지를 만들어 연결하세요." }, 409)
      await updatePageProperties(id, {
        "교육청 코드": richText(office), "학교 코드": richText(code), "주소": richText(s.ORG_RDNMA),
        "홈페이지": { url: safeWebsite(s.HMPG_ADRES) }, "학교 구분": { select: { name: s.SCHUL_KND_SC_NM } },
        "학사일정 동기화": { checkbox: false },
      })
      // 사용자 제목/학생 연결 유지. 자동 실행은 사용자가 체크한 뒤 활성화한다.
      return json({ ok: true, name: s.SCHUL_NM, pageId: id, message: "학교가 연결됐습니다. 자동 실행 활성화 후 Notion에서 ‘학사일정 동기화’를 체크하세요." })
    }
    return json({ error: "지원하지 않는 action" }, 400)
  } catch (e) { console.error("[school-api]", e instanceof Error ? e.message : "error"); return json({ error: e instanceof Error ? e.message : "처리 실패" }, 500) }
})
