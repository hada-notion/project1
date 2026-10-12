// 키오스크 "오늘 출석 준비" (v2.5.37).
//
// 매일 새벽(pg_cron → kiosk-prepare)과, 그날 준비가 없을 때 키오스크 목록을 열면(list-students?kiosk=1)
// 오늘 수강 중인 등록과 오늘 출석 페이지를 Notion에서 한 번에 읽어 Supabase 표에 저장한다.
// kiosk-checkin은 이 표로 등록 확인·오늘 출석 찾기·DB ID 조회를 건너뛰고(측정상 약 2초) 바로 기록한다.
// 표에 없거나 기록이 실패하면 kiosk-checkin은 예전 방식(Notion 직접 조회)으로 처리한다.
//
// 저장 범위: 오늘(KST) 것만. 전화번호는 원문 대신 SHA-256 해시로만 저장한다(입력 번호와 같은지 확인용).
// 학부모 리포트 원자료(attendance_records, report_cache)와는 별개다.
import { notionQueryDatabase, getRegistrationDbId, resolveRelatedDatabaseId } from "./adminShared.ts"
import { fetchSupabaseWithRetry } from "./reportCacheShared.ts"
import { buildKioskDirectory, queryAllKioskPages, ACTIVE_KIOSK_STATUS, compactKioskId } from "./kioskIdentity.ts"

const SB_URL = Deno.env.get("SB_URL") ?? ""
const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""

export type KioskTodayRow = {
  registration_id: string
  kst_date: string
  student_name: string
  class_ids: string[]
  phone_hashes: string[]
  attendance_page_id: string | null
  attendance_status: string
  checkin_at: string | null
  checkout_at: string | null
}
export type KioskPrepared = {
  kst_date: string
  prepared_at: string
  source: string
  student_db_id: string
  attendance_db_id: string
  row_count: number
}

export function kstDate(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10)
}

export async function hashPhone(phone: string): Promise<string> {
  const digits = String(phone ?? "").replace(/[^0-9]/g, "")
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hada-kiosk:" + digits))
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("")
}

// 오늘 출석 페이지(여러 개면 가장 이른 것)를 등록별로 하나씩 고른다.
function todayAttendanceByRegistration(attendancePages: any[]): Map<string, any> {
  const out = new Map<string, any>()
  const sorted = [...attendancePages]
    .filter(p => !p.archived && !p.in_trash)
    .sort((a, b) => String(a.properties?.["수업일시"]?.date?.start ?? "").localeCompare(String(b.properties?.["수업일시"]?.date?.start ?? "")))
  for (const page of sorted) {
    for (const rel of page.properties?.["등록"]?.relation ?? []) {
      const key = compactKioskId(rel.id)
      if (!out.has(key)) out.set(key, page)
    }
  }
  return out
}

// Notion 응답만으로 오늘 준비 행을 만든다(네트워크 없음, 테스트 대상).
export async function buildKioskTodayRows(registrations: any[], students: any[], attendancePages: any[], date: string): Promise<KioskTodayRow[]> {
  const directory = buildKioskDirectory(registrations, students)
  const regById = new Map(registrations.map(r => [compactKioskId(r.id), r]))
  const attendance = todayAttendanceByRegistration(attendancePages)
  const rows: KioskTodayRow[] = []
  for (const c of directory) {
    const reg = regById.get(compactKioskId(c.registrationId))
    const page = attendance.get(compactKioskId(c.registrationId)) ?? null
    rows.push({
      registration_id: compactKioskId(c.registrationId),
      kst_date: date,
      student_name: c.studentName,
      class_ids: (reg?.properties?.["클래스"]?.relation ?? []).map((r: any) => r.id),
      phone_hashes: await Promise.all(c.phones.map(hashPhone)),
      attendance_page_id: page ? page.id : null,
      attendance_status: page?.properties?.["출석 상태"]?.select?.name ?? "",
      checkin_at: page?.properties?.["등원스템프"]?.date?.start ?? null,
      checkout_at: page?.properties?.["하원스템프"]?.date?.start ?? null,
    })
  }
  return rows
}

function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: SB_SERVICE_ROLE_KEY, Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", ...extra }
}
async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/${path}`, { ...init, headers: restHeaders((init.headers ?? {}) as Record<string, string>) })
  if (!res.ok) throw new Error(`kiosk today ${init.method ?? "GET"} ${path.split("?")[0]} failed: ${res.status} ${await res.text()}`)
  return res
}

export async function readKioskPrepared(): Promise<KioskPrepared | null> {
  const rows = await (await rest("kiosk_prepared?id=eq.1&select=kst_date,prepared_at,source,student_db_id,attendance_db_id,row_count")).json()
  return rows[0] ?? null
}

export async function readKioskTodayRow(registrationId: string): Promise<KioskTodayRow | null> {
  const id = compactKioskId(registrationId)
  if (!/^[0-9a-f]{32}$/.test(id)) return null
  const rows = await (await rest(`kiosk_today?registration_id=eq.${id}&select=*`)).json()
  return rows[0] ?? null
}

// kiosk-checkin이 출석을 기록한 뒤 같은 날 중복 기록을 막도록 행을 맞춘다.
export async function markKioskTodayStamp(registrationId: string, field: "checkin_at" | "checkout_at", iso: string, status: string): Promise<void> {
  const id = compactKioskId(registrationId)
  await rest(`kiosk_today?registration_id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ [field]: iso, attendance_status: status, updated_at: new Date().toISOString() }),
  })
}

// 오늘 준비를 새로 만든다. source: "cron"(새벽) | "auto"(키오스크를 열 때 준비가 없어서).
// list-students가 이미 읽은 등록·학생 목록이 있으면 넘겨 받아 Notion 조회를 줄인다.
export async function prepareKioskToday(source: string, preloaded?: { registrations: any[]; students: any[] }): Promise<KioskPrepared> {
  const date = kstDate()
  const registrationDbId = getRegistrationDbId()
  const [studentDbId, attendanceDbId] = await Promise.all([
    resolveRelatedDatabaseId(registrationDbId, "학생정보"),
    resolveRelatedDatabaseId(registrationDbId, "출석"),
  ])
  const [students, registrations, attendancePages] = await Promise.all([
    preloaded?.students ?? queryAllKioskPages(body => notionQueryDatabase(studentDbId, body)),
    preloaded?.registrations ?? queryAllKioskPages(body => notionQueryDatabase(registrationDbId, body), {
      filter: { property: "수강상태", formula: { string: { equals: ACTIVE_KIOSK_STATUS } } },
    }),
    queryAllKioskPages(body => notionQueryDatabase(attendanceDbId, body), {
      filter: { and: [
        { property: "수업일시", date: { on_or_after: date + "T00:00:00+09:00" } },
        { property: "수업일시", date: { on_or_before: date + "T23:59:59+09:00" } },
      ] },
    }),
  ])
  const rows = await buildKioskTodayRows(registrations, students, attendancePages, date)
  // 어제 이전 행은 지우고 오늘 행은 덮어쓴다(같은 날 다시 준비해도 그날 찍힌 스템프는 Notion 값으로 다시 맞춰짐).
  await rest(`kiosk_today?kst_date=neq.${date}`, { method: "DELETE", headers: { Prefer: "return=minimal" } })
  if (rows.length) {
    await rest("kiosk_today?on_conflict=registration_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.map(r => ({ ...r, updated_at: new Date().toISOString() }))),
    })
  }
  const prepared: KioskPrepared = {
    kst_date: date,
    prepared_at: new Date().toISOString(),
    source,
    student_db_id: studentDbId,
    attendance_db_id: attendanceDbId,
    row_count: rows.length,
  }
  await rest("kiosk_prepared?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ id: 1, ...prepared }),
  })
  console.log("[kiosk-prepare]", JSON.stringify({ source, kst_date: date, rows: rows.length, withAttendance: rows.filter(r => r.attendance_page_id).length }))
  return prepared
}
