// POST /functions/v1/get-legal-document-data
// 법정 서류(수강생 출석부/수강생 대장/교습비등 영수증 원부/현금출납부) 화면(legal_documents.html)이
// 호출하는 관리자용 함수. 등록번호/영수증 번호는 조회 시 최초 발급되어 영구 유지된다. 학원법 시행규칙 별표2(장부·서류 비치 의무) 대응.
// action:"classes" -> 클래스만, action:"students" + classId -> 해당 반 학생만 반환.
// action:"meta"는 이전 화면 호환용. 그 외에는 body.docType에 따라 자료를 만든다.
//
// [FIX, 2026-09-28] 처음 작성할 때 adminShared.ts의 notionQueryDatabase/notionQueryDatabaseAll/
// notionGetPage(구버전 NOTION_VERSION="2022-06-28", /v1/databases/{id}/query 엔드포인트)를 썼는데,
// DS_CLASS 등 constants.ts의 DS_* 상수들은 모두 "데이터소스" ID(collection:// URL의 ID)라서
// 신버전 엔드포인트(/v1/data_sources/{id}/query, NOTION_VERSION="2025-09-03")로만 조회할 수 있다.
// 실제 서비스에서 "이 반이 이미 잘 연결돼 있다"는 걸 사용자가 Notion에서 직접 확인해줬는데도
// 404("Could not find database")가 난 이유가 바로 이 버전 불일치였다. sync-attendance 등 이미
// 동작 중인 함수들이 쓰는 notionClient.ts(queryAllPages/queryDataSource/getPage)로 전부 바꾼다.
import { CORS_HEADERS, requireAdminKey } from "../_shared/adminShared.ts"
import { getPage, queryAllPages, relationIds, selectName } from "../_shared/notionClient.ts"
import { DS_REGISTRATION, DS_CLASS, DS_ATTENDANCE, DS_TUITION, DS_PAYMENT } from "../_shared/constants.ts"
import { ensureStudentRegistrationNumber, reserveLegalNumber } from "../_shared/legalDocumentNumbers.ts"
import { mapWithConcurrency } from "../_shared/notionClient.ts"
import { normalizeStatus } from "../_shared/reportCacheShared.ts"

const PROP_REG_TITLE = "이름" // 등록(학원) DB: 학생 이름이 곧 이 DB의 제목
const PROP_REG_CLASS = "클래스" // relation, limit 1 -> 클래스(학원) DB
const PROP_REG_STUDENT = "학생정보" // relation -> 학생(학원) DB
const PROP_REG_ENROLL_DATE = "등록일"
const PROP_REG_END_DATE = "종료일"

const PROP_CLASS_TITLE = "클래스명"

const PROP_ATT_REGISTRATION = "등록"
const PROP_ATT_DATETIME = "수업일시"
const PROP_ATT_STATUS = "출석 상태"

const PROP_TUITION_REGISTRATION = "등록"

const PROP_PAYMENT_TITLE = "결제"
const PROP_PAYMENT_DATE = "결제일"
const PROP_PAYMENT_AMOUNT = "결제 금액"
const PROP_PAYMENT_METHOD = "결제 수단"
const PROP_PAYMENT_TYPE = "구분"
const PROP_PAYMENT_NOTE = "비고"
const PROP_PAYMENT_TUITION = "수강료"

function plainText(prop: any): string {
  if (!prop) return ""
  const arr = prop.title ?? prop.rich_text ?? []
  return arr.map((t: any) => t.plain_text).join("")
}
function titleOf(page: any, propName: string): string {
  return plainText(page?.properties?.[propName])
}
function firstRelationId(page: any, propName: string): string | null {
  return relationIds(page, propName)[0] ?? null
}
function anyTitle(page: any): string {
  const props = page?.properties ?? {}
  for (const key in props) {
    if (props[key]?.type === "title") return plainText(props[key])
  }
  return ""
}
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// pageId -> Promise<page> 캐시 (같은 요청 안에서 반복 조회를 줄인다)
function makePageCache() {
  const cache = new Map<string, Promise<any>>()
  return (id: string) => {
    if (!cache.has(id)) cache.set(id, getPage(id))
    return cache.get(id)!
  }
}

// [CHANGED, 2026-09-28] 서류를 조회할 때마다 클래스(학원) DB 전체를 훑는 게 느려서(사용자 체감
// 로딩 지연 원인), 실제로 등장하는 등록 건들에 연결된 클래스만 getPage로 골라 가져오도록 바꿨다.
// 클래스 전체 목록은 화면 초기 로딩(action:"classes")에서만 필요하다.
type LegalClass = { classId: string; className: string; subject: string }
function legalClass(page: any): LegalClass {
 return {classId: page?.id ?? "", className: plainText(page?.properties?.["신고 교습과정명"]),
 subject: (page?.properties?.["과목"]?.multi_select ?? []).map((v: any)=>v.name).join(", ")}
}
function seoulDate(value: string): string {
 if (!value) return ""
 if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
 const d=new Date(value)
 if (!Number.isFinite(d.getTime())) throw new Error("잘못된 날짜 데이터입니다")
 return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul"}).format(d)
}
function period(body: any) {
 if (!/^\d{4}-\d{2}-\d{2}$/.test(body.periodStart ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(body.periodEnd ?? "") || body.periodStart > body.periodEnd) throw new Error("올바른 조회 시작일/종료일을 선택하세요")
 for (const key of ["periodStart","periodEnd"]) if (new Date(body[key]+"T00:00:00Z").toISOString().slice(0,10)!==body[key]) throw new Error("존재하지 않는 날짜입니다")
 if ((Date.parse(body.periodEnd)-Date.parse(body.periodStart))/86400000>366) throw new Error("조회기간은 최대 367일입니다")
}
async function legalRows(body: any, getCachedPage: (id:string)=>Promise<any>) {
 const regs=await queryAllPages(DS_REGISTRATION,buildRegistrationFilter({...body,search:undefined}))
 const rows=await mapWithConcurrency(regs,3,async(reg:any)=>{
  const sid=firstRelationId(reg,PROP_REG_STUDENT), cid=firstRelationId(reg,PROP_REG_CLASS)
  const student=sid ? await getCachedPage(sid) : null
  const cp=cid ? await getCachedPage(cid) : null
  const sp=student?.properties ?? {}
  const guardian=sp["우선 연락 대상"]?.select?.name
  const guardianKey=guardian==="아버지"?"아버지 연락처":guardian==="기타 보호자"?"기타 보호자 연락처":"어머니 연락처"
  return {registrationId:reg.id,studentId:sid,studentName:titleOf(student,"학생이름"),
    ...legalClass(cp),
    registrationNo: sid && reg.properties?.[PROP_REG_ENROLL_DATE]?.date?.start ? await ensureStudentRegistrationNumber(sid,student) : null,
    address:plainText(sp["주소"]),phone:sp["학생 연락처"]?.phone_number || sp[guardianKey]?.phone_number || "",
    enrollDate:seoulDate(reg.properties?.[PROP_REG_ENROLL_DATE]?.date?.start ?? ""),
    endDate:seoulDate(reg.properties?.[PROP_REG_END_DATE]?.date?.start ?? "")}
 })
 return rows.filter((r)=>!body.search || r.studentName.includes(body.search)).sort((a,b)=>(a.className+a.studentName+a.registrationId).localeCompare(b.className+b.studentName+b.registrationId,"ko"))
}
function missingWarnings(rows:any[], register=false):string[] {
 const out:string[]=[]
 for (const [key,label] of [["className","신고 교습과정명"],["subject","교습과목"],["studentName","학생 이름"],["registrationNo","등록번호"],...(register?[["address","주소"],["phone","전화번호"]]:[])]) {
  const n=rows.filter(r=>!r[key]).length
  if(n)out.push(`${label} 미입력 ${n}건 — 실제 값을 입력한 뒤 다시 조회하세요.`)
 }
 return out
}

function buildRegistrationFilter(body: any): Record<string, unknown> | undefined {
  const and: any[] = []
  if (body.classId) and.push({ property: PROP_REG_CLASS, relation: { contains: body.classId } })
  if (body.studentId) and.push({ property: PROP_REG_STUDENT, relation: { contains: body.studentId } })
  if (body.periodStart && body.periodEnd) {
    and.push({ property: PROP_REG_ENROLL_DATE, date: { on_or_before: body.periodEnd } })
    and.push({
      or: [
        { property: PROP_REG_END_DATE, date: { is_empty: true } },
        { property: PROP_REG_END_DATE, date: { on_or_after: body.periodStart } },
      ],
    })
  }
  if (!and.length) return undefined
  return { and }
}

async function queryAttendanceForRegistrations(regIds: string[], periodStart: string, periodEnd: string) {
  if (!regIds.length) return [] as any[]
  const out: any[] = []
  for (const group of chunk(regIds, 80)) {
    const rows = await queryAllPages(DS_ATTENDANCE, {
      and: [
        { or: group.map((id) => ({ property: PROP_ATT_REGISTRATION, relation: { contains: id } })) },
        { property: PROP_ATT_DATETIME, date: { on_or_after: periodStart + "T00:00:00+09:00" } },
        { property: PROP_ATT_DATETIME, date: { on_or_before: periodEnd + "T23:59:59+09:00" } },
      ],
    })
    out.push(...rows)
  }
  return out
}

function attendanceSymbol(rawStatus: string): string {
  const s = normalizeStatus(rawStatus)
  if (s === "출석") return "○"
  if (s === "결석") return "×"
  if (s === "보강") return "△"
  return "·"
}

async function buildAttendance(body: any) {
 period(body)
 const {periodStart,periodEnd}=body
 const getCachedPage=makePageCache()
 const rows=await legalRows(body,getCachedPage)
 const attendanceRows=await queryAttendanceForRegistrations(rows.map(r=>r.registrationId),periodStart,periodEnd)
 const byReg=new Map(rows.map(r=>[r.registrationId,{...r,days:{} as Record<string,string>, sessions:[] as any[]}]))
 const seen=new Set<string>()
 for(const row of attendanceRows){
  if(seen.has(row.id))continue;seen.add(row.id)
  const dest=byReg.get(firstRelationId(row,PROP_ATT_REGISTRATION) ?? "")
  const iso=row.properties?.[PROP_ATT_DATETIME]?.date?.start
  if(!dest || !iso)continue
  const day=seoulDate(iso)
  if(day<dest.enrollDate || (dest.endDate && day>dest.endDate))continue
  const raw=plainText(row.properties?.[PROP_ATT_STATUS]) || selectName(row,PROP_ATT_STATUS) || row.properties?.[PROP_ATT_STATUS]?.formula?.string || ""
  const symbol=attendanceSymbol(raw)
  dest.sessions.push({id:row.id,date:day,time:new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Seoul",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(iso)),iso,symbol,status:raw || "미체크"})
 }
 for(const dest of byReg.values()){
  dest.sessions.sort((a,b)=>Date.parse(a.iso)-Date.parse(b.iso)||a.id.localeCompare(b.id))
  for(const session of dest.sessions)dest.days[session.date]=dest.days[session.date] ? dest.days[session.date]+" / "+session.symbol : session.symbol
 }
 const dateList:string[]=[]
 for(let d=Date.parse(periodStart+"T00:00:00Z");d<=Date.parse(periodEnd+"T00:00:00Z");d+=86400000)dateList.push(new Date(d).toISOString().slice(0,10))
 return {periodStart,periodEnd,dateList,students:[...byReg.values()],warnings:missingWarnings(rows)}
}
async function buildStudentRegister(body: any) {
 period(body)
 const rows=await legalRows(body,makePageCache())
 const groups=new Map<string,any>()
 for(const r of rows){
  if(!groups.has(r.classId))groups.set(r.classId,{classId:r.classId,className:r.className,subject:r.subject,rows:[]})
  groups.get(r.classId).rows.push(r)
 }
 return {rows,groups:[...groups.values()],warnings:missingWarnings(rows,true)}
}

async function collectTuitionIdsForFilter(body: any): Promise<string[] | null> {
  // classId/studentId/search 필터가 있을 때만 등록->수강료 경로로 대상 수강료 id를 좁힌다.
  if (!body.classId && !body.studentId && !body.search) return null
  const registrations = await legalRows({...body,periodStart:undefined,periodEnd:undefined},makePageCache())
  const regIds = registrations.map((r: any) => r.registrationId)
  if (!regIds.length) return []
  const tuitionIds: string[] = []
  for (const group of chunk(regIds, 80)) {
    const rows = await queryAllPages(DS_TUITION, {
      or: group.map((id) => ({ property: PROP_TUITION_REGISTRATION, relation: { contains: id } })),
    })
    tuitionIds.push(...rows.map((r: any) => r.id))
  }
  return tuitionIds
}

async function queryPayments(body: any, extra: any[]): Promise<any[]> {
  if (!DS_PAYMENT) throw new Error("DATA_SOURCE_PAYMENT_ID Secret이 설정되지 않았습니다 (결제(학원) DB)")
  const { periodStart, periodEnd } = body
  if (!periodStart || !periodEnd) throw new Error("periodStart/periodEnd가 필요합니다")
  const and: any[] = [
    { property: PROP_PAYMENT_DATE, date: { on_or_after: periodStart + "T00:00:00+09:00" } },
    { property: PROP_PAYMENT_DATE, date: { on_or_before: periodEnd + "T23:59:59+09:00" } },
    ...extra,
  ]
  const tuitionIds = await collectTuitionIdsForFilter(body)
  if (tuitionIds !== null) {
    if (!tuitionIds.length) return []
    const out: any[] = []
    for (const group of chunk(tuitionIds, 80)) {
      const rows = await queryAllPages(DS_PAYMENT, {
        and: [...and, { or: group.map((id) => ({ property: PROP_PAYMENT_TUITION, relation: { contains: id } })) }],
      })
      out.push(...rows)
    }
    return [...new Map(out.map(p=>[p.id,p])).values()]
  }
  return queryAllPages(DS_PAYMENT, { and })
}

async function buildReceiptLedger(body: any) {
 period(body)
 const payments=await queryPayments(body,[{property:PROP_PAYMENT_TYPE,select:{equals:"매출"}}])
 payments.sort((a,b)=>String(a.properties?.[PROP_PAYMENT_DATE]?.date?.start ?? "").localeCompare(String(b.properties?.[PROP_PAYMENT_DATE]?.date?.start ?? ""))||a.id.localeCompare(b.id))
 const getCachedPage=makePageCache(), warnings=new Set<string>()
 const rows=[] as any[]
 for(const p of payments){
  const tids=relationIds(p,PROP_PAYMENT_TUITION)
  const tuition=tids.length===1 ? await getCachedPage(tids[0]) : null
  const rids=tuition ? relationIds(tuition,PROP_TUITION_REGISTRATION) : []
  const reg=rids.length===1 ? await getCachedPage(rids[0]) : null
  const sid=reg ? firstRelationId(reg,PROP_REG_STUDENT) : null
  const student=sid ? await getCachedPage(sid) : null
  const cid=reg ? firstRelationId(reg,PROP_REG_CLASS) : null
  const cp=cid ? await getCachedPage(cid) : null
  const course=legalClass(cp)
  const paid=p.properties?.[PROP_PAYMENT_AMOUNT]?.number ?? null
  const billing=tuition?.properties?.["청구기간"]?.date
  if(tids.length!==1 || rids.length!==1)warnings.add("복수/미연결 수강료 결제: 학생·과목·기간별 금액 배분을 확인해야 합니다. 임의로 첫 등록을 선택하지 않았습니다.")
  // No other-expense or refund-state field exists in this DB. Never turn unknown into zero.
  const etc=p.properties?.["기타경비"]?.number ?? null
  const amount=etc !== null && paid !== null && etc >= 0 && etc <= paid ? paid-etc : null
  if(etc!==null && (paid===null || etc<0 || etc>paid))warnings.add("기타경비가 결제금액 범위를 벗어납니다. 교습비를 계산하지 않았습니다.")
  if(etc===null)warnings.add("기타경비 구분 데이터가 없어 교습비/기타경비는 미확인으로 표시합니다. 결제금액을 임의로 교습비 전액/기타경비 0원으로 처리하지 않습니다.")
  if(paid===null || paid<0 || /환불|취소/.test(plainText(p.properties?.[PROP_PAYMENT_NOTE])))warnings.add("금액 미입력·음수·환불/취소 메모가 포함된 결제는 원거래와 대조해야 합니다.")
  const no=sid && reg?.properties?.[PROP_REG_ENROLL_DATE]?.date?.start ? await ensureStudentRegistrationNumber(sid,student) : null
  const birth=seoulDate(student?.properties?.["생년월일"]?.date?.start ?? "")
  if(!billing?.start)warnings.add("청구기간 미입력 결제가 있습니다. 납부일을 교습기간으로 대체하지 않았습니다.")
  if(!birth)warnings.add("생년월일 미입력 결제가 있습니다.")
  rows.push({paymentId:p.id,serialNo:await reserveLegalNumber("receipt",p.id),paymentDate:seoulDate(p.properties?.[PROP_PAYMENT_DATE]?.date?.start ?? ""),payerName:titleOf(student,"학생이름"),registrationNo:no,birthDate:birth,subject:course.subject,className:course.className,
   billingStart:seoulDate(billing?.start ?? ""),billingEnd:seoulDate(billing?.end || billing?.start || ""),billingMonth:billing?.start?.slice(0,7) ?? "",amount,etcExpense:etc,paidAmount:paid,note:plainText(p.properties?.[PROP_PAYMENT_NOTE])})
 }
 warnings.add("환불·취소 전용 상태/원거래 연결 및 발행자/서명 정보는 아직 없습니다. 원부·영수증 출력은 대조·보완용 초안이며 확정 발급 전 확인이 필요합니다.")
 missingWarnings(rows.map(r=>({...r,studentName:r.payerName}))).forEach(v=>warnings.add(v))
 return {rows,warnings:[...warnings]}
}

async function buildCashJournal(body: any) {
  const payments = await queryPayments(body, [{ property: PROP_PAYMENT_METHOD, select: { equals: "현금" } }])
  const rows = payments
    .map((p: any) => ({
      date: p.properties?.[PROP_PAYMENT_DATE]?.date?.start?.slice(0, 10) ?? "",
      type: selectName(p, PROP_PAYMENT_TYPE) ?? "",
      title: titleOf(p, PROP_PAYMENT_TITLE),
      note: plainText(p.properties?.[PROP_PAYMENT_NOTE]),
      amount: p.properties?.[PROP_PAYMENT_AMOUNT]?.number ?? 0,
    }))
    .sort((a: any, b: any) => a.date.localeCompare(b.date))
  let balance = 0
  for (const r of rows as any[]) {
    balance += r.type === "지출" ? -r.amount : r.amount
    r.balance = balance
  }
  return { rows }
}

async function buildClasses() {
  const classes = await queryAllPages(DS_CLASS)
  return {
    classes: classes.map((c: any) => ({ id: c.id, name: titleOf(c, PROP_CLASS_TITLE) }))
      .sort((a, b) => a.name.localeCompare(b.name, "ko")),
  }
}

async function buildClassStudents(classId: unknown) {
  if (typeof classId !== "string" || !/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(classId)) {
    throw new Error("올바른 classId가 필요합니다")
  }
  // 서버에서 선택한 클래스만 필터링한다. 전체 등록 DB와 학생 DB를 불러오지 않는다.
  // 관계 속성의 첫 25건 제한에 의존하지 않고 queryAllPages로 해당 반 전체를 가져온다.
  const registrations = await queryAllPages(DS_REGISTRATION, {
    property: PROP_REG_CLASS, relation: { contains: classId },
  })
  const ids=[...new Set(registrations.map(r=>firstRelationId(r,PROP_REG_STUDENT)).filter((id):id is string=>!!id))]
  const students=await mapWithConcurrency(ids,3,async(id)=>({id,name:titleOf(await getPage(id),"학생이름")}))
  return {students:students.sort((a,b)=>a.name.localeCompare(b.name,"ko"))}
}

async function buildMeta() {
 const classes=await buildClasses()
 const regs=await queryAllPages(DS_REGISTRATION)
 const ids=[...new Set(regs.map(r=>firstRelationId(r,PROP_REG_STUDENT)).filter((id):id is string=>!!id))]
 const students=await mapWithConcurrency(ids,3,async id=>({id,name:titleOf(await getPage(id),"학생이름")}))
 return {...classes,students}
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })
  const authError = await requireAdminKey(req)
  if (authError) return authError

  try {
    const body = await req.json().catch(() => ({}))
    let result: unknown
    if (body.action === "classes") {
      result = await buildClasses()
    } else if (body.action === "students") {
      result = await buildClassStudents(body.classId)
    } else if (body.action === "meta") {
      result = await buildMeta()
    } else {
      switch (body.docType) {
        case "attendance":
          result = await buildAttendance(body)
          break
        case "student-register":
          result = await buildStudentRegister(body)
          break
        case "receipt-ledger":
          result = await buildReceiptLedger(body)
          break
        case "cash-journal":
          result = await buildCashJournal(body)
          break
        default:
          return new Response(JSON.stringify({ error: "알 수 없는 docType입니다" }), {
            status: 400,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          })
      }
    }
    return new Response(JSON.stringify(result), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
})
