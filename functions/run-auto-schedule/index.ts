// Supabase Edge Function: run-auto-schedule
//
// pg_cron이 주기적으로(예: 10분마다) 호출하는 자동화 파이프라인.
// "알림톡 설정(학원) DB"의 "수강료 안내"/"보고서" 행에 설정된 스케줄(자동 발송 사용,
// 월간 생성일/주간 생성요일, 발송 시각)을 읽어서 조건에 맞으면:
//   1) 대상 클래스의 "수강료 청구기간"/"보고서 기간"을 다음 달(또는 다음 주)로 갱신
//   2) generate-tuition / generate-report 호출 (기간 단위로 idempotent -- 이미 생성된 건은 새로 만들지 않음)
//   3) 생성이 끝날 때까지 대기(폴링)
//   4) "일괄전송 선택" 체크박스가 켜진 건만 send-tuition-notice / send-report 호출 (생성 직후
//      기본값은 켜짐 -- generate-tuition/generate-report 참고. 발송 성공 시 자동으로 꺼짐)
//
// 대상 클래스:
//   - 수강료: "수강료"(숫자) 속성이 채워진 클래스만 대상 (과금 대상으로 opt-in된 클래스라는 신호).
//   - 보고서: "보고서 구분"이 "월간 보고서"/"주간 보고서"로 채워진 클래스만 각각 대상.
//
// 실행자(person) 속성은 자동 생성 시 비어있으므로, send-tuition-notice/send-report의 기존
// getBotUserId() fallback이 자동으로 통합 봇 계정을 "발송자"로 기록한다 (사용자가 원하는 동작).
//
// 안전장치: generate-tuition/generate-report는 기간 단위로 idempotent하므로, 크론이 발송 시각
// 이후 하루 동안 여러 번(예: 10분마다) 실행되어도 두 번째 호출부터는 신규 생성 0건이 된다.
// 발송 대상 여부는 "발송 횟수" 대신 "일괄전송 선택" 체크박스로 판단한다: 생성 직후 기본값은
// 켜져 있고, 발송에 성공하면 이 함수와 send-selected-notifications(수동 버튼) 양쪽 모두 체크를
// 꺼서 같은 건이 중복 발송되지 않게 한다. 단, 발송에 실패하면 체크가 켜진 채로 남으므로 다음
// 크론 실행(예: 10분 뒤)이나 수동 "선택 일괄전송" 버튼에서 자동으로 재시도된다 (발송 횟수
// 방식과 달리 실패 건도 자동 재시도됨 -- 연락처 오류 등으로 계속 실패한다면 전송로그를 보고
// 해당 건의 "일괄전송 선택"을 직접 꺼서 재시도를 멈출 수 있다).
//
// 인증: pg_cron(pg_net)이 x-admin-key 헤더로 호출한다. 바디의 adminKey도 대체로 허용한다
// (다른 어드민 함수들과 동일한 패턴).

import { getCurrentAdminKey, getScheduleConfig } from "../_shared/adminShared.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"
import {
  DS_CLASS,
  DS_REPORT,
  getActiveRegistrationsForClass,
  findTuitionForMonth,
  monthRange,
  weekRange,
  queryAllPages,
  getPage,
  updatePageProperties,
} from "../_shared/generateShared.ts"

const FUNCTIONS_BASE = "https://twczhsxybkcvjkdfdxvs.supabase.co/functions/v1"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const WEEKDAY_KR = ["일", "월", "화", "수", "목", "금", "토"]

// (2026-09-15) send-selected-notifications와 같은 이유로, 클래스/등록 건수가 많으면 한 번의
// 실행(파이프라인 하나)이 Edge Function 실행 시간 제한에 걸릴 수 있다. 제한에 강제로 끊기면 그
// 시점 이후 클래스는 로그도 없이 조용히 처리되지 않은 채로 남는다 ("일괄전송 선택" 체크는 켜진
// 채로). 그래서 시간이 오래 걸릴 것 같으면 스스로 먼저 멈추고 어디까지 처리했는지 로그로 남긴다.
// 못 처리한 클래스는 다음 크론 실행(예: 10분 뒤)에서 자동으로 이어서 처리된다.
const PIPELINE_TIME_BUDGET_MS = 3 * 60 * 1000

// KST(UTC+9) 기준 "지금"을 UTC 필드로 읽어도 KST 값이 나오도록 9시간을 더한 Date를 만든다.
// (다른 함수들의 formatSendLogDate/todaySeoulDate와 동일한 트릭.)
function kstNow(): Date {
  return new Date(Date.now() + 9 * 60 * 60 * 1000)
}

function kstParts() {
  const kst = kstNow()
  return {
    dayOfMonth: kst.getUTCDate(),
    weekdayLabel: WEEKDAY_KR[kst.getUTCDay()],
    hhmm: `${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}`,
    dateOnly: kst.toISOString().slice(0, 10),
  }
}

// dateOnly가 속한 달에서 delta만큼 이동한 달의 1일을 반환한다 (delta=1: 다음달, delta=-1: 이전달).
function addMonths(dateOnly: string, delta: number): string {
  const year = Number(dateOnly.slice(0, 4))
  const month = Number(dateOnly.slice(5, 7))
  const zeroBased = month - 1 + delta
  const newYear = year + Math.floor(zeroBased / 12)
  const newMonth = ((zeroBased % 12) + 12) % 12 + 1
  return `${newYear}-${String(newMonth).padStart(2, "0")}-01`
}

// "월간 기준"(이전달/다음달) 방향에 따라 오늘(dateOnly)로부터 생성 대상이 될 달의 1일을 계산한다.
function resolveMonthlyTargetStart(dateOnly: string, direction: "이전달" | "이번달" | "다음달"): string {
  const delta = direction === "이전달" ? -1 : direction === "이번달" ? 0 : 1
  return addMonths(dateOnly, delta)
}

// "주간 기준"(이전주/다음주) 방향에 따라 오늘(dateOnly)에서 ±7일 이동한 날짜를 반환한다.
// 이 날짜가 속한 월~일 구간(weekRange)이 생성 대상 주가 된다.
function shiftWeekAnchor(dateOnly: string, direction: "이전주" | "이번주" | "다음주"): string {
  const deltaDays = direction === "이전주" ? -7 : direction === "이번주" ? 0 : 7
  const base = new Date(dateOnly + "T00:00:00Z")
  base.setUTCDate(base.getUTCDate() + deltaDays)
  return base.toISOString().slice(0, 10)
}

async function callFn(path: string, body: Record<string, unknown>, adminKey: string): Promise<Response> {
  return fetch(`${FUNCTIONS_BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
    body: JSON.stringify(body),
  })
}

// classId의 처리중 체크박스("수강료 생성중"/"보고서 생성중")가 꺼질 때까지 대기한다.
async function waitUntilDone(pageId: string, runningProp: string, timeoutMs = 90000, intervalMs = 3000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const page = await getPage(pageId)
    if (page.properties?.[runningProp]?.checkbox !== true) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

// generate-report/index.ts의 findReportForPeriod와 동일한 로직 (그 파일에서 export되지 않아 여기서 다시 구현).
async function findReportForPeriod(registrationId: string, reportType: string, periodStart: string): Promise<string[]> {
  const results = await queryAllPages(DS_REPORT, {
    and: [
      { property: "등록", relation: { contains: registrationId } },
      { property: "보고서 구분", select: { equals: reportType } },
      { property: "보고서 기간", date: { equals: periodStart } },
    ],
  })
  return results.map((p: any) => p.id)
}

function classTitle(classPage: any): string {
  return classPage.properties?.["클래스명"]?.title?.[0]?.plain_text ?? classPage.id
}

// ---------------- 수강료 자동 생성 + 발송 ----------------
async function runTuitionPipeline(adminKey: string, log: string[]): Promise<void> {
  const config = await getScheduleConfig("수강료 안내")
  if (!config) {
    log.push("[수강료] 설정 행을 찾지 못함 (알림톡 설정 DB에 '수강료 안내' 행이 있는지 확인 필요)")
    return
  }
  if (!config.autoEnabled) {
    log.push("[수강료] 자동 발송 사용이 꺼져 있어 건너뜀")
    return
  }
  const { dayOfMonth, hhmm, dateOnly } = kstParts()
  if (config.monthDay == null || dayOfMonth !== config.monthDay) {
    log.push(`[수강료] 오늘(${dayOfMonth}일)은 설정된 생성일(${config.monthDay ?? "미설정"}일)이 아니라서 건너뜀`)
    return
  }
  if (!config.sendTime || hhmm < config.sendTime) {
    log.push(`[수강료] 아직 발송 시각(${config.sendTime || "미설정"}) 전이라 건너뜀 (현재 ${hhmm})`)
    return
  }

  const targetMonthStart = resolveMonthlyTargetStart(dateOnly, config.monthlyDirection)
  const { end: targetMonthEnd } = monthRange(targetMonthStart)

  const classes = await queryAllPages(DS_CLASS, { property: "수강료", number: { is_not_empty: true } })
  log.push(`[수강료] 대상 클래스 ${classes.length}건, 목표월 ${targetMonthStart.slice(0, 7)} (${config.monthlyDirection} 기준)`)

  const tuitionPipelineStartedAt = Date.now()
  for (let classIndex = 0; classIndex < classes.length; classIndex++) {
    if (Date.now() - tuitionPipelineStartedAt > PIPELINE_TIME_BUDGET_MS) {
      log.push(
        `[수강료] 처리 시간 제한(${Math.round(PIPELINE_TIME_BUDGET_MS / 1000)}초)에 도달해 나머지 ${classes.length - classIndex}개 클래스는 이번 실행에서 처리하지 못함 (다음 크론 실행에서 자동으로 이어서 처리됨)`,
      )
      break
    }
    const classPage = classes[classIndex]
    const classId = classPage.id
    const className = classTitle(classPage)
    try {
      const currentPeriodStart: string | undefined = classPage.properties?.["수강료 청구기간"]?.date?.start
      if (!currentPeriodStart || currentPeriodStart.slice(0, 7) < targetMonthStart.slice(0, 7)) {
        await updatePageProperties(classId, {
          "수강료 청구기간": { date: { start: targetMonthStart, end: null } },
        })
      }

      const res = await callFn("generate-tuition", { id: classId }, adminKey)
      if (!res.ok) {
        log.push(`[수강료][${className}] generate-tuition 호출 실패: ${res.status}`)
        continue
      }
      await waitUntilDone(classId, "수강료 생성중")

      const registrations = await getActiveRegistrationsForClass(classId, targetMonthStart, targetMonthEnd)
      for (const reg of registrations) {
        const tuitionIds = await findTuitionForMonth(reg.id, targetMonthStart, targetMonthEnd)
        for (const tuitionId of tuitionIds) {
          const tuitionPage = await getPage(tuitionId)
          const selected = tuitionPage.properties?.["일괄전송 선택"]?.checkbox === true
          if (!selected) continue // 이미 발송 성공으로 체크 해제된 건 -> 자동 재발송하지 않음 (실패 건은 체크가 남아있어 다음 주기에 재시도됨)

          // [2026-09] 안내멘트는 이제 수강료(학원) DB에 직접 입력하지 않고, "알림톡 설정" DB의 안내멘트를 롤업으로 그대로 가져와 표시한다.
          // 따라서 여기서 개별 건에 값을 채워 넣는 로직은 더 이상 필요 없음(수강료 건의 "안내멘트"는 읽기 전용 롤업).

          const sendRes = await callFn("send-tuition-notice", { tuitionId, adminKey }, adminKey)
          log.push(
            `[수강료][${className}] ${reg.studentLabel} 발송 ${sendRes.ok ? "성공" : "실패(" + sendRes.status + ")"}`,
          )
          if (sendRes.ok) {
            // send-selected-notifications(수동 일괄전송)와 동일한 패턴: 발송 성공 시 "일괄전송 선택"을 꺼서
            // 다음 자동 실행이나 수동 일괄전송에서 같은 건이 중복 발송되지 않게 한다.
            await updatePageProperties(tuitionId, { "일괄전송 선택": { checkbox: false } })
          }
        }
      }
    } catch (err) {
      log.push(`[수강료][${className}] 오류: ${(err as Error).message}`)
    }
  }
}

// ---------------- 보고서 자동 생성 + 발송 (월간/주간 공통 파이프라인) ----------------
async function runReportPipeline(
  adminKey: string,
  reportType: "월간 보고서" | "주간 보고서",
  periodStart: string,
  periodEnd: string,
  log: string[],
): Promise<void> {
  const classes = await queryAllPages(DS_CLASS, { property: "보고서 구분", select: { equals: reportType } })
  log.push(`[보고서-${reportType}] 대상 클래스 ${classes.length}건, 기간 ${periodStart}~${periodEnd}`)

  const reportPipelineStartedAt = Date.now()
  for (let classIndex = 0; classIndex < classes.length; classIndex++) {
    if (Date.now() - reportPipelineStartedAt > PIPELINE_TIME_BUDGET_MS) {
      log.push(
        `[보고서-${reportType}] 처리 시간 제한(${Math.round(PIPELINE_TIME_BUDGET_MS / 1000)}초)에 도달해 나머지 ${classes.length - classIndex}개 클래스는 이번 실행에서 처리하지 못함 (다음 크론 실행에서 자동으로 이어서 처리됨)`,
      )
      break
    }
    const classPage = classes[classIndex]
    const classId = classPage.id
    const className = classTitle(classPage)
    try {
      const currentPeriodStart: string | undefined = classPage.properties?.["보고서 기간"]?.date?.start
      if (!currentPeriodStart || currentPeriodStart.slice(0, 10) < periodStart) {
        await updatePageProperties(classId, {
          "보고서 기간": { date: { start: periodStart, end: periodEnd !== periodStart ? periodEnd : null } },
        })
      }

      const res = await callFn("generate-report", { id: classId }, adminKey)
      if (!res.ok) {
        log.push(`[보고서-${reportType}][${className}] generate-report 호출 실패: ${res.status}`)
        continue
      }
      await waitUntilDone(classId, "보고서 생성중")

      const registrations = await getActiveRegistrationsForClass(classId, periodStart, periodEnd)
      for (const reg of registrations) {
        const reportIds = await findReportForPeriod(reg.id, reportType, periodStart)
        for (const reportId of reportIds) {
          const reportPage = await getPage(reportId)
          const selected = reportPage.properties?.["일괄전송 선택"]?.checkbox === true
          if (!selected) continue // 이미 발송 성공으로 체크 해제된 건 -> 자동 재발송하지 않음 (실패 건은 체크가 남아있어 다음 주기에 재시도됨)

          const sendRes = await callFn("send-report", { reportId, adminKey }, adminKey)
          log.push(
            `[보고서-${reportType}][${className}] ${reg.studentLabel} 발송 ${sendRes.ok ? "성공" : "실패(" + sendRes.status + ")"}`,
          )
          if (sendRes.ok) {
            await updatePageProperties(reportId, { "일괄전송 선택": { checkbox: false } })
          }
        }
      }
    } catch (err) {
      log.push(`[보고서-${reportType}][${className}] 오류: ${(err as Error).message}`)
    }
  }
}

async function runReportAutoSchedule(adminKey: string, log: string[]): Promise<void> {
  const config = await getScheduleConfig("보고서")
  if (!config) {
    log.push("[보고서] 설정 행을 찾지 못함 (알림톡 설정 DB에 '보고서' 행이 있는지 확인 필요)")
    return
  }
  if (!config.autoEnabled) {
    log.push("[보고서] 자동 발송 사용이 꺼져 있어 건너뜀")
    return
  }
  const { dayOfMonth, weekdayLabel, hhmm, dateOnly } = kstParts()
  if (!config.sendTime || hhmm < config.sendTime) {
    log.push(`[보고서] 아직 발송 시각(${config.sendTime || "미설정"}) 전이라 건너뜀 (현재 ${hhmm})`)
    return
  }

  // 월간 보고서: 매달 설정된 생성일에 "월간 기준"(이전달/다음달) 방향의 달을 생성.
  if (config.monthDay != null && dayOfMonth === config.monthDay) {
    const targetMonthStart = resolveMonthlyTargetStart(dateOnly, config.monthlyDirection)
    const { end: targetMonthEnd } = monthRange(targetMonthStart)
    await runReportPipeline(adminKey, "월간 보고서", targetMonthStart, targetMonthEnd, log)
  } else {
    log.push(`[보고서-월간] 오늘(${dayOfMonth}일)은 설정된 생성일(${config.monthDay ?? "미설정"}일)이 아니라서 건너뜀`)
  }

  // 주간 보고서: 설정된 요일에 "주간 기준"(이전주/다음주) 방향의 주(월~일)를 생성.
  if (config.weekdays.includes(weekdayLabel)) {
    const anchorDateOnly = shiftWeekAnchor(dateOnly, config.weeklyDirection)
    const { start, end } = weekRange(anchorDateOnly)
    await runReportPipeline(adminKey, "주간 보고서", start, end, log)
  } else {
    log.push(`[보고서-주간] 오늘(${weekdayLabel}요일)은 설정된 생성요일(${config.weekdays.join(", ") || "미설정"})이 아니라서 건너뜀`)
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  let body: any = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const adminKey = req.headers.get("x-admin-key") ?? body?.adminKey ?? null
  const currentAdminKey = await getCurrentAdminKey()
  if (!adminKey || adminKey !== currentAdminKey) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }

  // pg_cron(pg_net)도 Notion 버튼 웹훅과 마찬가지로 응답을 오래 기다리게 하고 싶지 않으므로,
  // 즉시 202를 반환하고 실제 파이프라인은 백그라운드에서 계속 실행한다.
  //
  // [2026-09] 수강료+보고서를 한 번의 실행에서 순서대로 다 처리하면, 클래스/등록 건수가 많을 때
  // Edge Function의 실행 시간 제한(WallClockTime)에 걸려 뒤에 있는 파���프라인(특히 보고서)이
  // 아예 실행되지 못하고 통째로 잘리는 문제가 있었다 (증상: 수강료는 생성/발송되는데 보고서는
  // 로그도 없이 조용히 아무 일도 안 일어남). 이를 막기 위해 pg_cron이 body에 pipeline을
  // "tuition" 또는 "report"로 지정해서 각각 별도의 실행(=별도의 시간 예산)으로 호출하도록 분리한다.
  // pipeline을 생략하면(수동 테스트 등) 기존처럼 둘 다 순서대로 실행한다.
  const pipeline = body?.pipeline as "tuition" | "report" | undefined

  const log: string[] = []
  runInBackground(async () => {
    try {
      if (!pipeline || pipeline === "tuition") {
        await runTuitionPipeline(adminKey, log)
      }
      if (!pipeline || pipeline === "report") {
        await runReportAutoSchedule(adminKey, log)
      }
      console.log("run-auto-schedule finished:\n" + log.join("\n"))
    } catch (err) {
      console.error(
        "run-auto-schedule failed:",
        (err as Error).message,
        "\nlog so far:\n" + log.join("\n"),
        "\nstack:",
        (err as Error).stack,
      )
    }
  })

  return respondAccepted({ message: "자동 스케줄 확인을 시작했습니다. 결과는 각 함수 Logs 탭에서 확인하세요." })
})
