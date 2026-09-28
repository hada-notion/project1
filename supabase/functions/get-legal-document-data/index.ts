// POST /functions/v1/get-legal-document-data
// 법정 서류(수강생 출석부/수강생 대장/교습비등 영수증 원부/현금출납부) 화면(legal_documents.html)이
// 호출하는 조회 전용 함수. 학원법 시행규칙 별표2(장부·서류 비치 의무) 대응.
// action:"meta" -> 필터용 클래스/학생 목록만 반환. 그 외에는 body.docType에 따라 자료를 만든다.
import {
  CORS_HEADERS,
  requireAdminKey,
  notionQueryDatabase,
  notionQueryDatabaseAll,
  notionGetPage,
} from "../_shared/adminShared.ts"
import { DS_REGISTRATION, DS_CLASS, DS_ATTENDANCE, DS_TUITION, DS_PAYMENT } from "../_shared/constants.ts"
import { normalizeStatus } from "../_shared/reportCacheShared.ts"

const PROP_REG_TITLE = "이름" // 등록(학원) DB: 학생 이름이 곧 이 DB의 제목
const PROP_REG_CLASS = "클래스" // relation, limit 1 -> 클래스(학원) DB
const PROP_REG_STUDENT = "학생정보" // relation -> 학생(학원) DB
const PROP_REG_ENROLL_DATE = "등록일"
const PROP_REG_END_DATE = "종료일"
const PROP_REG_ATTENDANCE = "출석" // relation -> 출석(학원) DB

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
function selectName(prop: any): string {
  return prop?.select?.name ?? prop?.status?.name ?? ""
}
function relationIds(prop: any): string[] {
  return (prop?.relation ?? []).map((r: any) => r.id)
}
function firstRelationId(prop: any): string | null {
  return relationIds(prop)[0] ?? null
}
function titleOfPage(page: any): string {
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

// registrationId -> Promise<page> 캐시 (같은 요청 안에서 반복 조회를 줄인다)
function makePageCache() {
  const cache = new Map<string, Promise<any>>()
  return (id: string) => {
    if (!cache.has(id)) cache.set(id, notionGetPage(id).catch(() => null))
    return cache.get(id)!
  }
}

async function fetchClassNameMap(): Promise<Map<string, string>> {
  const rows = await notionQueryDatabaseAll(DS_CLASS, { page_size: 100 })
  const map = new Map<string, string>()
  for (const row of rows) map.set(row.id, plainText(row.properties?.[PROP_CLASS_TITLE]))
  return map
}

function buildRegistrationFilter(body: any): Record<string, unknown> | undefined {
  const and: any[] = []
  if (body.classId) and.push({ property: PROP_REG_CLASS, relation: { contains: body.classId } })
  if (body.studentId) and.push({ property: PROP_REG_STUDENT, relation: { contains: body.studentId } })
  if (body.search) and.push({ property: PROP_REG_TITLE, title: { contains: body.search } })
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
    const rows = await notionQueryDatabaseAll(DS_ATTENDANCE, {
      filter: {
        and: [
          { or: group.map((id) => ({ property: PROP_ATT_REGISTRATION, relation: { contains: id } })) },
          { property: PROP_ATT_DATETIME, date: { on_or_after: periodStart + "T00:00:00+09:00" } },
          { property: PROP_ATT_DATETIME, date: { on_or_before: periodEnd + "T23:59:59+09:00" } },
        ],
      },
      page_size: 100,
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
  return s ? s[0] : "·"
}

async function buildAttendance(body: any) {
  const { periodStart, periodEnd } = body
  if (!periodStart || !periodEnd) throw new Error("periodStart/periodEnd가 필요합니다")
  const filter = buildRegistrationFilter({ ...body, periodStart: undefined, periodEnd: undefined })
  const [registrations, classNameMap] = await Promise.all([
    notionQueryDatabaseAll(DS_REGISTRATION, filter ? { filter, page_size: 100 } : { page_size: 100 }),
    fetchClassNameMap(),
  ])
  const regIds = registrations.map((r: any) => r.id)
  const attendanceRows = await queryAttendanceForRegistrations(regIds, periodStart, periodEnd)

  const byReg = new Map<string, any>()
  for (const reg of registrations) {
    byReg.set(reg.id, {
      registrationId: reg.id,
      studentName: plainText(reg.properties?.[PROP_REG_TITLE]),
      className: classNameMap.get(firstRelationId(reg.properties?.[PROP_REG_CLASS]) ?? "") ?? "",
      days: {} as Record<string, string>,
    })
  }
  for (const row of attendanceRows) {
    const regId = firstRelationId(row.properties?.[PROP_ATT_REGISTRATION])
    if (!regId || !byReg.has(regId)) continue
    const iso = row.properties?.[PROP_ATT_DATETIME]?.date?.start
    if (!iso) continue
    const dateKey = String(iso).slice(0, 10)
    const rawStatus = plainText(row.properties?.[PROP_ATT_STATUS]) || selectName(row.properties?.[PROP_ATT_STATUS])
    byReg.get(regId)!.days[dateKey] = attendanceSymbol(rawStatus)
  }

  const dateList: string[] = []
  for (let d = new Date(periodStart + "T00:00:00+09:00"); d <= new Date(periodEnd + "T00:00:00+09:00"); d.setDate(d.getDate() + 1)) {
    dateList.push(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d))
  }

  const students = [...byReg.values()].sort((a, b) => (a.className + a.studentName).localeCompare(b.className + b.studentName))
  return { periodStart, periodEnd, dateList, students }
}

async function buildStudentRegister(body: any) {
  const filter = buildRegistrationFilter(body)
  const [registrations, classNameMap] = await Promise.all([
    notionQueryDatabaseAll(DS_REGISTRATION, filter ? { filter, page_size: 100 } : { page_size: 100 }),
    fetchClassNameMap(),
  ])
  const getPage = makePageCache()
  const rows = await Promise.all(
    registrations.map(async (reg: any) => {
      const studentId = firstRelationId(reg.properties?.[PROP_REG_STUDENT])
      const studentPage = studentId ? await getPage(studentId) : null
      const sp = studentPage?.properties ?? {}
      return {
        studentName: plainText(reg.properties?.[PROP_REG_TITLE]),
        className: classNameMap.get(firstRelationId(reg.properties?.[PROP_REG_CLASS]) ?? "") ?? "",
        enrollDate: reg.properties?.[PROP_REG_ENROLL_DATE]?.date?.start?.slice(0, 10) ?? "",
        endDate: reg.properties?.[PROP_REG_END_DATE]?.date?.start?.slice(0, 10) ?? "",
        birthDate: sp?.["생년월일"]?.date?.start?.slice(0, 10) ?? "",
        gender: selectName(sp?.["성별"]),
        studentPhone: sp?.["학생 연락처"]?.phone_number ?? "",
        parentPhone: sp?.["어머니 연락처"]?.phone_number ?? sp?.["아버지 연락처"]?.phone_number ?? "",
        registrationId: reg.id,
      }
    }),
  )
  rows.sort((a, b) => (a.className + a.studentName).localeCompare(b.className + b.studentName))
  return { rows }
}

async function collectTuitionIdsForFilter(body: any): Promise<string[] | null> {
  // classId/studentId/search 필터가 있을 때만 등록->수강료 경로로 대상 수강료 id를 좁힌다.
  if (!body.classId && !body.studentId && !body.search) return null
  const filter = buildRegistrationFilter(body)
  const registrations = await notionQueryDatabaseAll(DS_REGISTRATION, filter ? { filter, page_size: 100 } : { page_size: 100 })
  const regIds = registrations.map((r: any) => r.id)
  if (!regIds.length) return []
  const tuitionIds: string[] = []
  for (const group of chunk(regIds, 80)) {
    const rows = await notionQueryDatabaseAll(DS_TUITION, {
      filter: { or: group.map((id) => ({ property: PROP_TUITION_REGISTRATION, relation: { contains: id } })) },
      page_size: 100,
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
    { property: PROP_PAYMENT_DATE, date: { on_or_after: periodStart } },
    { property: PROP_PAYMENT_DATE, date: { on_or_before: periodEnd + "T23:59:59+09:00" } },
    ...extra,
  ]
  const tuitionIds = await collectTuitionIdsForFilter(body)
  if (tuitionIds !== null) {
    if (!tuitionIds.length) return []
    // 수강료 id가 많으면(80개 초과) or 조건 하나로는 다 못 담으므로 그룹별로 조회해 합친다.
    const out: any[] = []
    for (const group of chunk(tuitionIds, 80)) {
      const rows = await notionQueryDatabaseAll(DS_PAYMENT, {
        filter: { and: [...and, { or: group.map((id) => ({ property: PROP_PAYMENT_TUITION, relation: { contains: id } })) }] },
        page_size: 100,
      })
      out.push(...rows)
    }
    return out
  }
  return notionQueryDatabaseAll(DS_PAYMENT, { filter: { and }, page_size: 100 })
}

async function buildReceiptLedger(body: any) {
  const payments = await queryPayments(body, [{ property: PROP_PAYMENT_TYPE, select: { equals: "매출" } }])
  const getPage = makePageCache()
  const rows = await Promise.all(
    payments.map(async (p: any) => {
      const tuitionId = firstRelationId(p.properties?.[PROP_PAYMENT_TUITION])
      const tuitionPage = tuitionId ? await getPage(tuitionId) : null
      const regId = tuitionPage ? firstRelationId(tuitionPage.properties?.[PROP_TUITION_REGISTRATION]) : null
      const regPage = regId ? await getPage(regId) : null
      const studentId = regPage ? firstRelationId(regPage.properties?.[PROP_REG_STUDENT]) : null
      const studentPage = studentId ? await getPage(studentId) : null
      const classId = regPage ? firstRelationId(regPage.properties?.[PROP_REG_CLASS]) : null
      const classPage = classId ? await getPage(classId) : null
      return {
        paymentDate: p.properties?.[PROP_PAYMENT_DATE]?.date?.start?.slice(0, 10) ?? "",
        payerName: regPage ? plainText(regPage.properties?.[PROP_REG_TITLE]) : "",
        registrationNo: regId ? regId.replace(/-/g, "").slice(-8) : "",
        birthDate: studentPage?.properties?.["생년월일"]?.date?.start?.slice(0, 10) ?? "",
        subject: classPage ? plainText(classPage.properties?.[PROP_CLASS_TITLE]) : "",
        amount: p.properties?.[PROP_PAYMENT_AMOUNT]?.number ?? 0,
        etcExpense: 0,
        note: plainText(p.properties?.[PROP_PAYMENT_NOTE]),
      }
    }),
  )
  rows.sort((a, b) => a.paymentDate.localeCompare(b.paymentDate))
  rows.forEach((r: any, i: number) => (r.serialNo = i + 1))
  return { rows }
}

async function buildCashJournal(body: any) {
  const payments = await queryPayments(body, [{ property: PROP_PAYMENT_METHOD, select: { equals: "현금" } }])
  const rows = payments
    .map((p: any) => ({
      date: p.properties?.[PROP_PAYMENT_DATE]?.date?.start?.slice(0, 10) ?? "",
      type: selectName(p.properties?.[PROP_PAYMENT_TYPE]),
      title: plainText(p.properties?.[PROP_PAYMENT_TITLE]),
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

async function buildMeta() {
  const [classes, registrations] = await Promise.all([
    notionQueryDatabaseAll(DS_CLASS, { page_size: 100 }),
    notionQueryDatabaseAll(DS_REGISTRATION, { page_size: 100 }),
  ])
  return {
    classes: classes.map((c: any) => ({ id: c.id, name: plainText(c.properties?.[PROP_CLASS_TITLE]) })),
    students: registrations.map((r: any) => ({
      id: firstRelationId(r.properties?.[PROP_REG_STUDENT]) ?? r.id,
      registrationId: r.id,
      name: plainText(r.properties?.[PROP_REG_TITLE]),
    })),
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })
  const authError = await requireAdminKey(req)
  if (authError) return authError

  try {
    const body = await req.json().catch(() => ({}))
    let result: unknown
    if (body.action === "meta") {
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
