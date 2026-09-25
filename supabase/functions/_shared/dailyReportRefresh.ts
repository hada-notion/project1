// 일일보고서 발송 직전 최신화 공용 경로.
// 반드시 토큰을 먼저 보장한 뒤 출석 원본과 완성 보고서 캐시를 순서대로 갱신한다.

import { syncStudentReport } from "./alimtalkShared.ts"
import { syncAttendanceForRegistration } from "./attendanceSyncShared.ts"
import { makePageCache } from "./reportCacheShared.ts"
import { syncReportCacheForRegistration } from "./reportCacheBuilder.ts"
import { makePersistentReportPageCache } from "./persistentReportPageCache.ts"

export async function refreshDailyReportForSend(
  registrationId: string,
  opts?: { sharedRunKey?: string },
): Promise<{ access_token: string; reportUrl: string }> {
  // 토큰이 없는 등록은 같은 전송 버튼 실행 안에서 먼저 발급한다. 캐시 빌더는 토큰이 없으면
  // 행을 만들지 않으므로 이 순서를 바꾸면 안 된다.
  const tokenInfo = await syncStudentReport(registrationId)

  // 출석 원본을 먼저 최신화해야 reportCacheBuilder가 attendance_records의 최신 행을 읽는다.
  await syncAttendanceForRegistration(registrationId)

  // 반별 체인은 호출이 학생마다 분리되므로 Supabase 실행 캐시를 사용해 그룹 공통 학습기록/교재
  // 페이지를 공유한다. 개별 전송은 한 호출 안의 메모리 캐시만 사용한다.
  const cachedGetPage = opts?.sharedRunKey
    ? makePersistentReportPageCache(opts.sharedRunKey)
    : makePageCache()
  const row = await syncReportCacheForRegistration(registrationId, cachedGetPage)
  if (!row) throw new Error("보고서 캐시를 생성하지 못했습니다. 등록의 토큰과 학생정보 관계를 확인하세요.")

  return tokenInfo
}
