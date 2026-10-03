// 학교 DB ‘학사일정 가져오기’ 버튼 전용. 정기 스캔/다른 학교 실행 없음.
import { CORS_HEADERS, requireAdminKey, getCurrentAdminKey } from "../_shared/adminShared.ts"
import { queryAllPages, getPage, updatePageProperties } from "../_shared/notionClient.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"
import { neisRows, textOf, eventGrades, eventKey, ownedProperties, richText, type NeisRow } from "../_shared/neisSchool.ts"
import { academicRange, sameOwnedEvent, buttonSchoolId } from "../_shared/neisManual.ts"
import { schoolNotion, schoolSources, compactId } from "../_shared/schoolNotion.ts"
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } })
async function db(path: string, method = "GET", body?: unknown) {
  const url = Deno.env.get("SB_URL"), key = Deno.env.get("SB_SERVICE_ROLE_KEY")
  if (!url || !key) throw new Error("Supabase 서버 설정 필요")
  const response = await fetch(url + "/rest/v1/" + path, { method, headers: { apikey:key, Authorization:`Bearer ${key}`, "Content-Type":"application/json", Prefer:"return=representation" }, body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(12000) })
  if (!response.ok) throw new Error("학사일정 작업 DB 오류 " + response.status)
  const text = await response.text(); return text ? JSON.parse(text) : null
}
async function checkedSchool(id: string) {
  const sources = await schoolSources()
  const page = await getPage(id)
  if (page.archived || page.in_trash || compactId(page.parent?.data_source_id ?? "") !== compactId(sources.schools)) throw new Error("학교 DB의 활성 페이지가 아닙니다.")
  return { page, sources }
}
async function markSchool(pageId: string, status: string, progress: string, error = "", done = false) {
  const properties: Record<string, unknown> = {
    "학사일정 처리 상태": {select:{name:status}},
    "학사일정 처리 현황": richText(progress), "학사일정 오류": richText(error),
  }
  if (done) properties["학사일정 마지막 동기화"] = { date:{start:new Date().toISOString()} }
  await updatePageProperties(pageId, properties)
}
async function kick(runId: string) {
  const response = await fetch(`${Deno.env.get("SB_URL")}/functions/v1/sync-school-calendar`, {
    method:"POST", headers:{"Content-Type":"application/json","x-admin-key":await getCurrentAdminKey()},
    body:JSON.stringify({action:"continue",runId}), signal:AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error("후속 처리 요청 실패 " + response.status)
}
async function startSchool(pageId: string, range: ReturnType<typeof academicRange>) {
  let ownedId: string | undefined
  let run: any
  try {
    const { page } = await checkedSchool(pageId); ownedId = page.id
    const office = textOf(page,"교육청 코드"), code = textOf(page,"학교 코드")
    if (!/^[A-Z]\d{2}$/.test(office) || !/^\d{7}$/.test(code)) throw new Error("학교 검색에서 학교 코드부터 연결하세요.")
    run = (await db("rpc/begin_neis_manual_run","POST",{p_school:page.id,p_office:office,p_code:code,p_year:range.year,p_from:range.from,p_to:range.to}))[0]
    if (!run) throw new Error("작업 생성 실패")
    if (run.status === "processing" && run.lease_until && new Date(run.lease_until).getTime() > Date.now()) return
    await markSchool(page.id,"🔄 작업중",run.row_cursor > 0 ? `${range.year}학년도 · ${run.row_cursor}/${run.snapshot?.length ?? "?"}건` : `${range.year}학년도 · 조회/처리 준비`)
    await kick(run.id)
  } catch(e) {
    const message = e instanceof Error ? e.message : "접수 실패"
    if (run) await db(`neis_manual_runs?id=eq.${run.id}&status=eq.pending`,"PATCH",{status:"failed",last_error:message}).catch(()=>{})
    if (ownedId) await markSchool(ownedId,"⚠️ 오류","다시 버튼을 눌러 재시도하세요.",message).catch(()=>{})
    console.error("[sync-school-calendar/start]",message)
  }
}
async function processRun(runId: string) {
  const startedAt = Date.now()
  let run: any, ownedId: string | undefined
  try {
    run = (await db("rpc/claim_neis_manual_run","POST",{p_run_id:runId}))?.[0]
    if (!run) return // 중복 후속 요청은 임대를 얻지 못하므로 아무것도 쓰지 않는다.
    const path = `neis_manual_runs?id=eq.${run.id}&lease_token=eq.${run.lease_token}`
    const { page, sources } = await checkedSchool(run.school_page_id); ownedId=page.id
    if (textOf(page,"교육청 코드")!==run.office_code || textOf(page,"학교 코드")!==run.school_code) throw new Error("작업 중 학교 코드가 변경됐습니다.")
    let rows: NeisRow[] = run.snapshot
    if (!rows) {
      rows = await neisRows("SchoolSchedule",{ATPT_OFCDC_SC_CODE:run.office_code,SD_SCHUL_CODE:run.school_code,AA_FROM_YMD:run.from_date,AA_TO_YMD:run.to_date})
      if (rows.some(row => row.ATPT_OFCDC_SC_CODE!==run.office_code || row.SD_SCHUL_CODE!==run.school_code || !row.AA_YMD || row.AA_YMD<run.from_date || row.AA_YMD>run.to_date)) throw new Error("원본 학교/기간 불일치")
      await db(path,"PATCH",{snapshot:rows})
    }
    const existing = await queryAllPages(sources.events,{and:[{property:"학교",relation:{contains:page.id}},{property:"NEIS 동기화키",rich_text:{is_not_empty:true}}]})
    const byKey = new Map<string,any>()
    for(const p of existing){const key=textOf(p,"NEIS 동기화키");if(byKey.has(key))throw new Error("NEIS 동기화키 중복: 수동 확인 필요");byKey.set(key,p)}
    const grades = await queryAllPages(sources.grades)
    let cursor=run.row_cursor
    const end=Math.min(cursor+4,rows.length)
    for(;cursor<end && Date.now()-startedAt<55000;cursor++){
      const row=rows[cursor], key=await eventKey(row,page.id)
      const gradeIds=eventGrades(row).flatMap(n=>{
        const matches=grades.filter(p=>p.properties?.["학교구분"]?.select?.name?.endsWith(row.SCHUL_CRSE_SC_NM) && new RegExp(`(?:^|\\D)${n}(?:학년)?$`).test(textOf(p,"이름")))
        if(matches.length>1)throw new Error("학년 중복: "+n)
        return matches.map(p=>p.id)
      })
      const properties=ownedProperties(row,page.id,key,gradeIds), previous=byKey.get(key)
      if(previous){if(!sameOwnedEvent(previous,row,page.id,key,gradeIds))await updatePageProperties(previous.id,properties)}
      else{const p=await schoolNotion("/pages","POST",{parent:{data_source_id:sources.events},properties});byKey.set(key,p)}
      await db(path,"PATCH",{row_cursor:cursor+1,updated_at:new Date().toISOString()})
      await new Promise(resolve=>setTimeout(resolve,400))
    }
    const done=cursor>=rows.length
    await markSchool(page.id,done?"✅ 완료":"🔄 작업중",`${run.academic_year}학년도 · ${cursor}/${rows.length}건`,"",done)
    await db(path,"PATCH",{status:done?"done":"pending",attempts:0,lease_until:null,last_error:null,updated_at:new Date().toISOString()})
    if(!done){
      try{await kick(run.id)}catch{
        // 후속 요청의 응답이 유실됐지만 실제 실행됐다면 새 임대를 덮어쓰지 않는다.
        const changed=await db(path+"&status=eq.pending","PATCH",{status:"failed",last_error:"후속 처리 요청 실패"})
        if(changed?.length && ownedId)await markSchool(ownedId,"⚠️ 오류","다시 버튼을 눌러 이어서 처리하세요.","후속 처리 요청 실패")
      }
    } // 버튼에서 시작한 작업만 이어달리기. Cron/정기 수집 없음.
  } catch(e) {
    const message=e instanceof Error?e.message:"처리 실패"
    if(run){
      const retry=run.attempts<3
      const changed=await db(`neis_manual_runs?id=eq.${run.id}&lease_token=eq.${run.lease_token}&status=eq.processing`,"PATCH",{status:retry?"pending":"failed",lease_until:null,last_error:message}).catch(()=>null)
      if(!changed?.length)return // 임대를 잃었다면 다른 실행의 상태를 수정하지 않는다.
      if(retry){try{await new Promise(r=>setTimeout(r,1500));await kick(run.id);return}catch{
        const stopped=await db(`neis_manual_runs?id=eq.${run.id}&lease_token=eq.${run.lease_token}&status=eq.pending`,"PATCH",{status:"failed",last_error:message}).catch(()=>null)
        if(!stopped?.length)return
      }}
      if(ownedId)await markSchool(ownedId,"⚠️ 오류","다시 버튼을 눌러 이어서 처리하세요.",message).catch(()=>{})
    }
    console.error("[sync-school-calendar/process]",message)
  }
}
Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response(null,{headers:CORS_HEADERS})
  if(req.method!=="POST")return json({error:"POST required"},405)
  const denied=await requireAdminKey(req);if(denied)return denied
  try{
    if(!Deno.env.get("NEIS_API_KEY"))return json({error:"NEIS_API_KEY 설정 필요"},503)
    const body=await req.json()
    if(body.action==="continue"){
      if(!/^[0-9a-f-]{36}$/i.test(String(body.runId??"")))return json({error:"runId 형식 오류"},400)
      runInBackground(()=>processRun(body.runId));return respondAccepted({runId:body.runId})
    }
    const pageId=buttonSchoolId(body)
    if(!pageId)return json({error:"학교 페이지 ID가 필요합니다."},400)
    if(body.action==="status"){
      const {page}=await checkedSchool(pageId)
      const runs=await db(`neis_manual_runs?school_page_id=eq.${page.id}&select=id,academic_year,from_date,to_date,status,row_cursor,attempts,last_error,updated_at`)
      return json({runs})
    }
    if(body.action && body.action!=="start")return json({error:"지원하지 않는 action"},400)
    const range=academicRange(new Date(),body.academicYear)
    runInBackground(()=>startSchool(pageId,range))
    return respondAccepted({pageId,academicYear:range.year,from:range.from,to:range.to})
  }catch(e){return json({error:e instanceof Error?e.message:"요청 실패"},400)}
})
