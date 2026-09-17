// 출석(학원) DB 마룕니다지로 자시되량게명로 버리메니다/란머리마막.
// (2026-09-16, 리포트 캐시 아키톤즍첧 1단개: 출석 도맔리딴 "리포트를 만들 따마다 전상위재생잘"
//  대신 "원슴맔 증몤롐람잌 쌍젔똄 조립" 방식으로 전환한다.)
//
// sync-attendance Edge Function이 이 헬퍼로 Notion → attendance_records를 채우고,
// sync-report-cache는 이 헬퍼로 attendance_records만 읽어서 리포트를 조립한다(Notion 미조회).

import { text, dateStartOf, dateEndOf, relationIds, firstRelationId, normalizeStatus, fetchSupabaseWithRetry } from "./reportCacheShared.ts"
import { queryAllPages } from "./notionClient.ts"

const SB_URL = Deno.env.get("SB_URL") ?? ""
const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""

// 워크스페이스 구조상 고정값인 데이타소스 ID (sync-attendance/index.ts, cascade-delete/index.ts와 동일한 값).
const DS_ATTENDANCE = "8aaba040-586b-8322-8437-87608a763415"

function requireSupabaseEnv() {
  if (!SB_URL || !SB_SERVICE_ROLE_KEY) {
    throw new Error("SB_URL / SB_SERVICE_ROLE_KEY Secrets가 설정되어 있지 않습니다. Supabase 대시보드 Edge Functions Secrets에 추가하세요.")
  }
}

// "등원시간"/"하원시간" Notion 수식 속성(prop("수업일시").dateStart()/dateEnd().formatDate("HH:mm"))을
// 그대로 읽으면, 해당 날짜 속성의 time_zone이 보어있는 감쓰 Notion이 수식 안에서 이 값을
// UTC 기준으로 포맷해버리기대줌 실제 수업 시각(예: 17:00 KST)이 9시간 밀린 "08:00"으로 나오는 버글이 있었다
// (2026-09-17 실측 확인: attendance_records의 check_in/check_out이 다수 보어있거난 어긋날뱌범려 뿀이댶
// 문제의 실제 원인). "수업일시" 원담 date 속성의 ISO 문자열에는 이미 올바른 오피셋(+09:00)이 그대로
// 들어있으뭐로, 수식을 거지 않고 이 문자열에서 시:봐만 직접 잔렆해낆 타임존 버금을 우회한다.
function formatTimeFromIso(iso: string | null): string {
  if (!iso) return ""
  const match = iso.match(/T(\d{2}):(\d{2})/)
  return match ? `${match[1]}:${match[2]}` : ""
}

export type AttendanceRow = {
  notion_page_id: string
  registration_id: string
  class_iso: string | null
  status: string
  check_in: string
  check_out: string
  teacher_comment: string
  study_log_ids: string[]
  notion_last_edited_time: string
}

// Notion "출석" 페이지(raw Notion API page 객체) 하나를 attendance_records 행 하나로 밀프놀 묘미 문다.
// "등록" 관개가 민거이있는 출석(정상적으로됈 없어야하지만 믹섌임꾜관 방어적망)은 null을 반환해 건란또덴다.
export function buildAttendanceRow(page: any): AttendanceRow | null {
  const registrationId = firstRelationId(page.properties?.["등록"])
  if (!registrationId) return null
  const classIso = dateStartOf(page.properties?.["수업일시"])
  const classEndIso = dateEndOf(page.properties?.["수업일시"])
  return {
    notion_page_id: page.id,
    registration_id: registrationId,
    class_iso: classIso,
    status: normalizeStatus(text(page.properties?.["출석 상태"])),
    check_in: formatTimeFromIso(classIso),
    check_out: formatTimeFromIso(classEndIso),
    teacher_comment: text(page.properties?.["선생님 한마때"]),
    study_log_ids: relationIds(page.properties?.["학습기록"]),
    notion_last_edited_time: page.last_edited_time,
  }
}

export async function upsertAttendanceRows(rows: AttendanceRow[]): Promise<void> {
  if (rows.length === 0) return
  requireSupabaseEnv()
  const payload = rows.map((r) => ({ ...r, synced_at: new Date().toISOString() }))
  const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/attendance_records?on_conflict=notion_page_id`, {
    method: "POST",
    headers: {
      apikey: SB_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw new Error(`attendance_records upsert 실패: ${res.status} ${await res.text()}`)
  }
}

// 등록 1건의 출석만 Notion에서 다시 조회해서 attendance_records에 반영한다. 보고서 발송 직전
// 재동기화(send-report)와 야간 점검(nightly-report-sync-audit)에서 사용한다. 대상이 등록 수 1건으로
// 한정되어 있어, 등록 수가 간계솟 덤어난띄람똄땄땄때 이 함수 자실에 보이덴 자가 커지지 않다.
export async function syncAttendanceForRegistration(registrationId: string): Promise<number> {
  const pages = await queryAllPages(DS_ATTENDANCE, {
    property: "등록",
    relation: { contains: registrationId },
  })
  const rows: AttendanceRow[] = []
  for (const page of pages) {
    const row = buildAttendanceRow(page)
    if (row) rows.push(row)
  }
  await upsertAttendanceRows(rows)
  return rows.length
}

// sync-report-cache가 등록 1건의 리포트를 조립할 띄 사용. sinceIso 이후(수업일시 기준) 출석만 가져온다.
export async function selectAttendanceByRegistrationId(registrationId: string, sinceIso: string): Promise<AttendanceRow[]> {
  requireSupabaseEnv()
  const res = await fetchSupabaseWithRetry(
    `${SB_URL}/rest/v1/attendance_records?registration_id=eq.${encodeURIComponent(registrationId)}&class_iso=gte.${encodeURIComponent(sinceIso)}&select=*`,
    { headers: { apikey: SB_SERVICE_ROLE_KEY, Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}` } },
  )
  if (!res.ok) throw new Error(`attendance_records 조회 실패: ${res.status} ${await res.text()}`)
  return res.json()
}

// 정합성 점검(reconcile)에서 "Notion에는 없는데 Supabase에는 남아있는" 행(삭제될)을 찾기 위해
// 저장된 모든 notion_page_id를 모은다.
export async function selectAllAttendanceIds(): Promise<Set<string>> {
  requireSupabaseEnv()
  const ids = new Set<string>()
  let offset = 0
  const pageSize = 1000
  while (true) {
    const res = await fetchSupabaseWithRetry(
      `${SB_URL}/rest/v1/attendance_records?select=notion_page_id&limit=${pageSize}&offset=${offset}`,
      { headers: { apikey: SB_SERVICE_ROLE_KEY, Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}` } },
    )
    if (!res.ok) throw new Error(`attendance_records id 목록 조회 실패: ${res.status} ${await res.text()}`)
    const rows: { notion_page_id: string }[] = await res.json()
    rows.forEach((r) => ids.add(r.notion_page_id))
    if (rows.length < pageSize) break
    offset += pageSize
  }
  return ids
}

export async function deleteAttendanceRowsByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  requireSupabaseEnv()
  // PostgREST의 in.() 필타는 URL 길이 제한이 있어 100개씩 나넠서 삭제한다.
  const chunkSize = 100
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize)
    const list = chunk.map((id) => `"${id}"`).join(",")
    const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/attendance_records?notion_page_id=in.(${list})`, {
      method: "DELETE",
      headers: { apikey: SB_SERVICE_ROLE_KEY, Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`, Prefer: "return=minimal" },
    })
    if (!res.ok) throw new Error(`attendance_records 삭제 실패: ${res.status} ${await res.text()}`)
  }
}

export async function getSyncCursor(source: string): Promise<string | null> {
  requireSupabaseEnv()
  const res = await fetchSupabaseWithRetry(
    `${SB_URL}/rest/v1/sync_cursors?source=eq.${encodeURIComponent(source)}&select=last_synced_at`,
    { headers: { apikey: SB_SERVICE_ROLE_KEY, Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}` } },
  )
  if (!res.ok) throw new Error(`sync_cursors 조회 실패: ${res.status} ${await res.text()}`)
  const rows = await res.json()
  return rows[0]?.last_synced_at ?? null
}

export async function setSyncCursor(source: string, iso: string): Promise<void> {
  requireSupabaseEnv()
  const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/sync_cursors?on_conflict=source`, {
    method: "POST",
    headers: {
      apikey: SB_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([{ source, last_synced_at: iso }]),
  })
  if (!res.ok) throw new Error(`sync_cursors 저장 실패: ${res.status} ${await res.text()}`)
}
