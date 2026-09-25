// 일일·주간·월간 보고서 발송 직전 최신화 공용 경로.
// Notion의 `동기화 필요` 후보를 지문으로 한 번 더 확인하고, 실제 변경이 있을 때만
// 출석 원본과 완성 보고서 캐시를 갱신한다. 스키마 전환 전에는 기존 전체 최신화로 fail-open 한다.

import { syncStudentReport } from "./alimtalkShared.ts"
import { syncAttendanceForRegistration, buildAttendanceRow, upsertAttendanceRows } from "./attendanceSyncShared.ts"
import { makePageCache } from "./reportCacheShared.ts"
import { syncReportCacheForRegistration } from "./reportCacheBuilder.ts"
import { makePersistentReportPageCache } from "./persistentReportPageCache.ts"
import {
  inspectDirtyReportSources,
  commitDirtyReportSources,
  selectReportCacheByRegistrationId,
} from "./reportDirtySync.ts"

export async function refreshStudentReport(
  registrationId: string,
  opts?: { sharedRunKey?: string; forceFull?: boolean },
): Promise<{ access_token: string; reportUrl: string; cacheRow: NonNullable<Awaited<ReturnType<typeof syncReportCacheForRegistration>>> }> {
  // 토큰이 없는 등록은 같은 버튼 실행 안에서 먼저 발급한다.
  const tokenInfo = await syncStudentReport(registrationId)
  const inspection = await inspectDirtyReportSources(registrationId)

  const cachedGetPage = opts?.sharedRunKey
    ? makePersistentReportPageCache(opts.sharedRunKey)
    : makePageCache()

  // 모든 DB 속성/자동화가 준비된 뒤에는 변경 후보가 없고 기존 캐시가 정상인 경우 재조립을 생략한다.
  // 등록 페이지의 수동 동기화는 forceFull로 이 최적화를 우회한다.
  if (inspection.enabled && !opts?.forceFull && inspection.snapshots.length === 0) {
    const existing = await selectReportCacheByRegistrationId(registrationId)
    if (existing) return { ...tokenInfo, cacheRow: existing as NonNullable<Awaited<ReturnType<typeof syncReportCacheForRegistration>>> }
  }

  // 자동화가 중복 실행됐거나 값을 원래대로 되돌려 지문이 모두 같은 경우에도 캐시는 다시 만들지 않는다.
  if (inspection.enabled && !opts?.forceFull && inspection.snapshots.length > 0 && inspection.changed.length === 0) {
    const existing = await selectReportCacheByRegistrationId(registrationId)
    if (existing) {
      await commitDirtyReportSources(inspection.snapshots)
      return { ...tokenInfo, cacheRow: existing as NonNullable<Awaited<ReturnType<typeof syncReportCacheForRegistration>>> }
    }
  }

  if (inspection.enabled && !opts?.forceFull) {
    // 변경된 출석만 attendance_records에 증분 반영한다. 학습기록·활동·보고서는 현재 캐시 빌더가
    // 최종 재조립하면서 읽고, 6번 작업에서 영구 증분 원본 테이블로 옮긴다.
    const attendanceRows = inspection.changed
      .filter((item) => item.sourceType === "attendance")
      .map((item) => buildAttendanceRow(item.page))
      .filter((row): row is NonNullable<ReturnType<typeof buildAttendanceRow>> => row !== null)
    await upsertAttendanceRows(attendanceRows)
  } else {
    // 속성이 아직 준비되지 않았거나 수동 전체 동기화이면 검증된 기존 경로를 그대로 사용한다.
    await syncAttendanceForRegistration(registrationId)
  }

  const row = await syncReportCacheForRegistration(registrationId, cachedGetPage)
  if (!row) throw new Error("보고서 캐시를 생성하지 못했습니다. 등록의 토큰과 학생정보 관계를 확인하세요.")

  // Supabase 반영과 캐시 재조립이 모두 성공한 뒤에만 지문/마지막 동기화를 확정한다.
  if (inspection.enabled) await commitDirtyReportSources(inspection.snapshots)

  return { ...tokenInfo, cacheRow: row }
}

export const refreshDailyReportForSend = refreshStudentReport
