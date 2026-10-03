import { CORS_HEADERS, requireAdminKey } from "../_shared/adminShared.ts"
import { queryAllPages, getPage, updatePageProperties } from "../_shared/notionClient.ts"
import { neisRows, textOf, eventGrades, eventKey, ownedProperties, type NeisRow } from "../_shared/neisSchool.ts"
import { schoolNotion, schoolSources } from "../_shared/schoolNotion.ts"
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } })
async function db(path: string, method: string, body?: unknown, prefer = "return=representation") {
  const url = Deno.env.get("SB_URL"), key = Deno.env.get("SB_SERVICE_ROLE_KEY")
  if (!url || !key) throw new Error("Supabase 서버 설정 필요")
  const r = await fetch(url + "/rest/v1/" + path, { method, headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: prefer }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000) })
  if (!r.ok) throw new Error("학사일정 작업 DB 오류 " + r.status)
  const t = await r.text(); return t ? JSON.parse(t) : null
}
function monthWindows() {
  const seoul = new Date(Date.now() + 9 * 3600000)
  const year = seoul.getUTCFullYear(), month = seoul.getUTCMonth()
  return [0, 1, 2].map(n => {
    const start = new Date(Date.UTC(year, month + n, 1)), end = new Date(Date.UTC(year, month + n + 1, 0))
    const fmt = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "")
    return { from_date: fmt(start), to_date: fmt(end) }
  })
}
async function enqueue(schools: string) {
  const pages = await queryAllPages(schools, { property: "학사일정 동기화", checkbox: { equals: true } })
  let added = 0
  for (const p of pages) {
    const office = textOf(p, "교육청 코드"), code = textOf(p, "학교 코드")
    if (!office || !code) continue
    for (const w of monthWindows()) {
      const rows = await db(`neis_school_jobs?school_page_id=eq.${p.id}&from_date=eq.${w.from_date}&to_date=eq.${w.to_date}`, "GET")
      const previous = rows[0]
      if (previous && ["pending", "processing"].includes(previous.status)) continue
      // 활성 처리와 경합하면 status 조건으로 덮어쓰지 않는다.
      if (previous) await db(`neis_school_jobs?id=eq.${previous.id}&status=in.(done,failed)`, "PATCH", { status: "pending", snapshot: null, row_cursor: 0, attempts: 0, last_error: null, updated_at: new Date().toISOString() })
      else await db("neis_school_jobs?on_conflict=school_page_id,from_date,to_date", "POST", { school_page_id: p.id, office_code: office, school_code: code, ...w }, "resolution=ignore-duplicates,return=minimal")
      added++
    }
  }
  return { enqueued: added, window: "이번 달부터 3개월" }
}
Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== "POST") return json({ error: "POST required" }, 405)
  const denied = await requireAdminKey(req); if (denied) return denied
  let job: any
  try {
    if (!Deno.env.get("NEIS_API_KEY")) return json({ error: "NEIS_API_KEY 설정 필요" }, 503)
    const body = await req.json()
    const sources = await schoolSources()
    if (body.action === "enqueue") return json(await enqueue(sources.schools))
    if (body.action !== "process") return json({ error: "action은 enqueue/process" }, 400)
    job = (await db("rpc/claim_neis_school_job", "POST", {}))?.[0]
    if (!job) return json({ idle: true })
    const path = `neis_school_jobs?id=eq.${job.id}&lease_token=eq.${job.lease_token}`
    const school = await getPage(job.school_page_id)
    if (school.archived || school.in_trash || !school.properties?.["학사일정 동기화"]?.checkbox || textOf(school, "교육청 코드") !== job.office_code || textOf(school, "학교 코드") !== job.school_code) {
      await db(path, "PATCH", { status: "done", lease_until: null, last_error: "비활성/학교 코드 변경으로 중단" })
      return json({ skipped: true })
    }
    let snapshot: NeisRow[] = job.snapshot
    if (!snapshot) {
      snapshot = await neisRows("SchoolSchedule", { ATPT_OFCDC_SC_CODE: job.office_code, SD_SCHUL_CODE: job.school_code, AA_FROM_YMD: job.from_date, AA_TO_YMD: job.to_date })
      if (snapshot.some(r => r.SD_SCHUL_CODE !== job.school_code || r.ATPT_OFCDC_SC_CODE !== job.office_code || !r.AA_YMD || r.AA_YMD < job.from_date || r.AA_YMD > job.to_date)) throw new Error("학교/조회 기간과 불일치하는 원본 응답")
      await db(path, "PATCH", { snapshot })
    }
    const existing = await queryAllPages(sources.events, { and: [{ property: "학교", relation: { contains: job.school_page_id } }, { property: "NEIS 동기화키", rich_text: { is_not_empty: true } }] })
    const byKey = new Map<string, any>()
    for (const page of existing) {
      const key = textOf(page, "NEIS 동기화키")
      if (byKey.has(key)) throw new Error("기존 NEIS 동기화키 중복: 수동 확인 필요")
      byKey.set(key, page)
    }
    const grades = await queryAllPages(sources.grades)
    let cursor = job.row_cursor
    const end = Math.min(cursor + 6, snapshot.length)
    for (; cursor < end; cursor++) {
      const row = snapshot[cursor]
      const key = await eventKey(row, job.school_page_id)
      const gradeIds = eventGrades(row).flatMap(n => {
        const matches = grades.filter(p => p.properties?.["학교구분"]?.select?.name?.endsWith(row.SCHUL_CRSE_SC_NM) && new RegExp(`(?:^|\\D)${n}(?:학년)?$`).test(textOf(p, "이름")))
        if (matches.length > 1) throw new Error("학년 중복: " + n)
        return matches.map(p => p.id)
      })
      const properties = ownedProperties(row, job.school_page_id, key, gradeIds)
      const previous = byKey.get(key)
      if (previous) {
        // 변경된 속성만 PATCH. 수동 숨김/메모는 그대로 둔다.
        const date = properties["날짜"].date.start
        const same = textOf(previous, "이름") === row.EVENT_NM && previous.properties?.["날짜"]?.date?.start === date && textOf(previous, "원본 행사내용") === (row.EVENT_CNTNT ?? "") && textOf(previous, "수업공제일명") === (row.SBTR_DD_SC_NM ?? "") && textOf(previous, "대상 학년") === (eventGrades(row).map(n => `${n}학년`).join(", ") || "미지정") && JSON.stringify((previous.properties?.["학년"]?.relation ?? []).map((r: any) => r.id).sort()) === JSON.stringify([...gradeIds].sort())
        if (!same) await updatePageProperties(previous.id, properties)
      } else {
        // 생성 응답이 유실돼도 다음 시도는 Notion 키를 조회해 복구. blind retry 금지.
        const page = await schoolNotion("/pages", "POST", { parent: { data_source_id: sources.events }, properties })
        byKey.set(key, page)
      }
      await db(path, "PATCH", { row_cursor: cursor + 1, updated_at: new Date().toISOString() })
      await new Promise(r => setTimeout(r, 400))
    }
    const finished = cursor >= snapshot.length
    await db(path, "PATCH", { status: finished ? "done" : "pending", attempts: 0, lease_until: null, updated_at: new Date().toISOString(), last_error: null })
    return json({ jobId: job.id, processed: cursor, total: snapshot.length, done: finished })
  } catch (e) {
    const message = e instanceof Error ? e.message : "동기화 실패"
    if (job) try { await db(`neis_school_jobs?id=eq.${job.id}&lease_token=eq.${job.lease_token}`, "PATCH", { status: job.attempts >= 5 ? "failed" : "pending", lease_until: null, last_error: message }) } catch { /* lease 만료 후 복구 */ }
    console.error("[sync-school-schedules]", message)
    return json({ error: message }, 500)
  }
})
