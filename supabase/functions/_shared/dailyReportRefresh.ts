// 학부모 리포트 최신화 공용 경로.
// 토큰을 보장한 뒤 출석 원본과 완성 보고서 캐시를 순서대로 갱신한다.
// 비활성화된 링크는 동기화가 실행돼도 자동으로 다시 활성화하지 않는다.

import { syncStudentReport } from "./alimtalkShared.ts"
import { notionGetPage, parseTokenValue } from "./adminShared.ts"
import { syncAttendanceForRegistration } from "./attendanceSyncShared.ts"
import { makePageCache } from "./reportCacheShared.ts"
import { syncReportCacheForRegistration } from "./reportCacheBuilder.ts"
import { makePersistentReportPageCache } from "./persistentReportPageCache.ts"

const SITE_BASE_URL = Deno.env.get("SITE_BASE_URL") ?? ""

export async function refreshStudentReport(
  registrationId: string,
  opts?: { sharedRunKey?: string },
): Promise<{ access_token: string; reportUrl: string; cacheRow: NonNullable<Awaited<ReturnType<typeof syncReportCacheForRegistration>>> }> {
  // 기존 링크가 비활성화된 상태라면 disabled: 접두사를 보존한다. 예전에는 여기서 새 토큰을
  // 발급해 비활성화가 자동으로 풀리는 문제가 있었다.
  const page = await notionGetPage(registrationId)
  const currentRaw = (page.properties?.["토큰"]?.rich_text ?? []).map((t: any) => t.plain_text).join("")
  const parsed = parseTokenValue(currentRaw)

  const tokenInfo = parsed.disabled && parsed.accessToken
    ? {
        access_token: parsed.accessToken,
        reportUrl: SITE_BASE_URL + "/student_report.html?token=" + parsed.accessToken,
      }
    : await syncStudentReport(registrationId)

  await syncAttendanceForRegistration(registrationId)

  const cachedGetPage = opts?.sharedRunKey
    ? makePersistentReportPageCache(opts.sharedRunKey)
    : makePageCache()
  const row = await syncReportCacheForRegistration(registrationId, cachedGetPage)
  if (!row) throw new Error("보고서 캐시를 생성하지 못했습니다. 등록의 토큰과 학생정보 관계를 확인하세요.")

  return { ...tokenInfo, cacheRow: row }
}

export const refreshDailyReportForSend = refreshStudentReport
