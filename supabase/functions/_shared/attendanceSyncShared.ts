// 출석(학원) DB 레코드를 Supabase의 attendance_records 테이블에 원자료로 누적해두기 위한 헬퍼.
// (2026-09-16, 리포트 캐시 아키텍처 1단계: 출석 도메인부터 "리포트를 만들 때마다 전체 재계산"
//  대신 "원자료를 증분으로 쌓아두고 조립" 방식으로 전환한다.)
//
// sync-attendance Edge Function이 이 헬퍼로 Notion → attendance_records를 채우고,
// sync-report-cache는 이 헬퍼로 attendance_records만 읽어서 리포트를 조립한다(Notion 미조회).

import { text, dateStartOf, dateEndOf, relationIds, firstRelationId, normalizeStatus } from "./reportCacheShared.ts"

const SB_URL = Deno.env.get("SB_URL") ?? ""
const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""

function requireSupabaseEnv() {
  if (!SB_URL || !SB_SERVICE_ROLE_KEY) {
    throw new Error("SB_URL / SB_SERVICE_ROLE_KEY Secrets가 설정되어 있지 않습니다. Supabase 대시보드 Edge Functions Secrets에 추가하세요.")
  }
}

// "등원시간"/"하원시간" Notion 수식 속성(prop("수업일시").dateStart()/dateEnd().formatDate("HH:mm"))을
// 그대로 읽으면, 해당 날짜 속성의 time_zone이 비어있는 경우 Notion이 수식 안에서 이 값을 UTC 기준으로
// 포맷해버려서 실제 수업 시각(예: 17:00 KST)이 9시간 밀린 "08:00"으로 나오는 버그가 있었다
// (2026-09-17 실측 확인: attendance_records의 check_in/check_out이 다수 비어있거나 어긋나 보이던
// 문제의 실제 원인). "수업일시" 원본 date 속성의 ISO 문자열에는 이미 올바른 오프셋(+09:00)이 그대로
// 들어있으므로, 수식을 거치지 않고 이 문자열에서 시:분만 직접 잘라내 타임존 버그를 우회한다.
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

// Notion "출석" 페이지(raw Notion API page 객체) 하나를 attendance_records 행 하나로 변환한다.
// "등록" 관계가 비어있는 출석(정상적으로는 없어야 하지만 방어적으로 처리)은 null을 반환해 건너뛴다.
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
    teacher_comment: text(page.properties?.["선생님 한마디"]),
    study_log_ids: relationIds(page.properties?.["학습기록"]),
    notion_last_edited_time: page.last_edited_time,
  }
}

export async function upsertAttendanceRows(rows: AttendanceRow[]): Promise<void> {
  if (rows.length === 0) return
  requireSupabaseEnv()
  const payload = rows.map((r) => ({ ...r, synced_at: new Date().toISOString() }))
  const res = await fetch(`${SB_URL}/rest/v1/attendance_records?on_conflict=notion_page_id`, {
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

// sync-report-cache가 등록 1건의 리포트를 조립할 때 사용. sinceIso 이후(수업일시 기준) 출석만 가져온다.
export async function selectAttendanceByRegistrationId(registrationId: string, sinceIso: string): Promise<AttendanceRow[]> {
  requireSupabaseEnv()
  const res = await fetch(
    `${SB_URL}/rest/v1/attendance_records?registration_id=eq.${encodeURIComponent(registrationId)}&class_iso=gte.${encodeURIComponent(sinceIso)}&select=*`,
    { headers: { apikey: SB_SERVICE_ROLE_KEY, Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}` } },
  )
  if (!res.ok) throw new Error(`attendance_records 조회 실패: ${res.status} ${await res.text()}`)
  return res.json()
}

// 정합성 점검(reconcile)에서 "Notion에는 없는데 Supabase에는 남아있는" 행(삭제됨)을 찾기 위해
// 저장된 모든 notion_page_id를 모은다.
export async function selectAllAttendanceIds(): Promise<Set<string>> {
  requireSupabaseEnv()
  const ids = new Set<string>()
  let offset = 0
  const pageSize = 1000
  while (true) {
    const res = await fetch(
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
  // PostgREST의 in.() 필터는 URL 길이 제한이 있어 100개씩 나눠서 삭제한다.
  const chunkSize = 100
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize)
    const list = chunk.map((id) => `"${id}"`).join(",")
    const res = await fetch(`${SB_URL}/rest/v1/attendance_records?notion_page_id=in.(${list})`, {
      method: "DELETE",
      headers: { apikey: SB_SERVICE_ROLE_KEY, Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`, Prefer: "return=minimal" },
    })
    if (!res.ok) throw new Error(`attendance_records 삭제 실패: ${res.status} ${await res.text()}`)
  }
}

export async function getSyncCursor(source: string): Promise<string | null> {
  requireSupabaseEnv()
  const res = await fetch(
    `${SB_URL}/rest/v1/sync_cursors?source=eq.${encodeURIComponent(source)}&select=last_synced_at`,
    { headers: { apikey: SB_SERVICE_ROLE_KEY, Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}` } },
  )
  if (!res.ok) throw new Error(`sync_cursors 조회 실패: ${res.status} ${await res.text()}`)
  const rows = await res.json()
  return rows[0]?.last_synced_at ?? null
}

export async function setSyncCursor(source: string, iso: string): Promise<void> {
  requireSupabaseEnv()
  const res = await fetch(`${SB_URL}/rest/v1/sync_cursors?on_conflict=source`, {
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
