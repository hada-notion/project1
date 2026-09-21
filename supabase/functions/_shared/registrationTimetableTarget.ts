// _shared/registrationTimetableTarget.ts
//
// sync-registration-timetable이 처리하는 실제 등록일/종료일 후처리 로직을 별도 파일로 분리했다
// (2026-09-18, 큐 기반 순차 처리 도입, Phase 3). 웹훅 body 파싱과 매일 cron 전체 스캔 진입점
// (Deno.serve)은 index.ts에 그대로 둔다. 전체 스캔이 호출하는 개별 처리 함수(restoreClassSessionsAndAttendance
// 등)는 웹훅 단건 처리와 공유하므로 여기 함께 둔다.
//
// (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환) processSyncRegistrationTimetableQueueItem
// (process-sync-queue 전용 진입점)은 제거했다. index.ts가 이 파일이 내보내는 개별 함수들을 직접
// 조합해서 호출한다 (원래 그 진입점이 하던 조합과 동일).

import {
  DS_REGISTRATION,
  PROP_CLASS,
  PROP_ENROLL_DATE,
  PROP_END_DATE,
  PROP_STATUS,
  PROP_TIMETABLE,
  PROP_TITLE,
  STATUS_ENDED,
  PROP_SYNC_TIMETABLE_RUNNING,
} from "./constants.ts"
import {
  queryDataSource,
  getPage,
  updatePageProperties,
  relIds,
  titleText,
  mapWithConcurrency,
} from "./notionClient.ts"
import {
  makeSyncStatusSetter,
  archiveAttendanceAfterEndDate,
  disconnectClassSessionsAfterEndDate as disconnectClassSessionsAfterEndDateShared,
  attachSessionsAndAttendance,
  callTextbookCleanup,
} from "./registrationSync.ts"

// 등록 페이지의 "동기화 상태"/"마지막 동기화"를 갱신해서, 노션 화면에서 자동화 진행 상태를
// 바로 확인할 수 있게 한다. 실패해도 본 로직에는 영향이 없도록 조용히 무시한다.
// "동기화 상태"는 이 함수와 sync-registration-textbook이 각각 처리 중인지 표시하는 체크박스
// 두 개를 조합해서 계산한다 (setCombinedSyncStatus) — 둘 중 하나라도 처리 중이면 "처리 중",
// 둘 다 끝나야 "완료"로 표시한다.
export const setTimetableSyncStatus = makeSyncStatusSetter(PROP_SYNC_TIMETABLE_RUNNING)

// 참고: 클래스 기준 시간표 자동 연결은 이제 "등록" 버튼(sync-registration-enroll)에서만
// 처리한다 — 클래스의 시간표가 학생 개개인에게 완전히 똑같이 적용되지 않을 수 있어서,
// 이 함수(등록일/종료일 후처리)에서는 시간표를 자동으로 세팅/덮어쓰지 않는다.
//
// 참고: "생성 오류" 수식(수업 DB)은 이제 클래스.등록 관계를 통해 학생 이름/등록일/종료일을
// 조회하므로, 시간표.등록 관계에 더 이상 의존하지 않는다. 따라서 시간표 관계는
// (실제로 수강 종료된 뒤) disconnectTimetableForEndedRegistrations에서 안전하게 해제할 수 있다.
// 여기서는 종료/무효 등록에 대한 개별 진도교재 정리를 수행한다.
export async function cleanupTextbooksForRegistration(registrationId: string, regName: string | undefined, log: string[]) {
  const result = await callTextbookCleanup(registrationId)
  if (!result.ok) {
    if (result.kind === "http") {
      log.push(`[WARN] [${regName}] textbook cleanup call failed: ${result.status} ${result.body}`)
    } else {
      log.push(`[WARN] [${regName}] textbook cleanup call error: ${result.message}`)
    }
    return
  }
  if (result.deleted.length > 0) {
    log.push(`[CLEANUP] [${regName}] ${result.deleted.length} unused individual textbook(s) archived`)
  }
}

// 종료일이 입력되거나 수정되어 호출되는 핸들러.
// 1) 종료일 이후 날짜의 출석을 즉시 삭제(archive)한다 (과거/미래 상관없이 항상 즉시 실행).
// 2) 종료일 이후 날짜의 수업 페이지들에서도 이 등록을 즉시 roster에서 제거한다.
// 3) 진도교재 정리는 cleanupTextbooksForEndedOrInvalidRegistrations에서 수강상태 수식에 따라 자동 처리된다.
// 4) 시간표 관계 전체 해제는 실제로 수강상태가 "수강 종료"가 된 뒤에만
//    disconnectTimetableForEndedRegistrations(매 실행 시 안전망으로 항상 수행)에서 처리한다.
export async function deleteAttendanceAfterEndDate(registrationId: string, endDateIso: string, regName: string | undefined, log: string[]) {
  const { deletedCount, activityCount, recordCount } = await archiveAttendanceAfterEndDate(registrationId, endDateIso)
  if (deletedCount > 0) {
    const extra =
      activityCount || recordCount
        ? ` (학습활동 ${activityCount}건, 학습기록 ${recordCount}건 함께 삭제)`
        : ""
    log.push(`[ATTENDANCE] [${regName}] ${deletedCount} attendance record(s) after end date deleted${extra}`)
  }
}

// 종료일 이후 날짜의 수업(학원) 페이지들에서 이 등록을 "등록" 관계(roster)에서 제거한다.
// 종료일이 미래든 과거든 상관없이 즉시 실행해도 안전하다 — 어차피 종료일보다 뒤 날짜의
// 수업만 대상이라, 아직 남아있는 정상 수강 기간(오늘~종료일)의 수업에는 영향이 없다.
// 수업의 "등록" 관계는 여러 학생이 함께 들어있는 roster이므로, 페이지 전체를 덮어쓰지 않고
// 이 등록 id만 골라서 제외한 나머지로 다시 저장한다.
export async function disconnectClassSessionsAfterEndDate(
  registrationId: string,
  endDateIso: string,
  regName: string | undefined,
  log: string[],
) {
  const { disconnectedCount } = await disconnectClassSessionsAfterEndDateShared(registrationId, endDateIso)
  if (disconnectedCount > 0) {
    log.push(`[CLASS-SESSION] [${regName}] ${disconnectedCount} class session(s) after end date disconnected from 등록`)
  }
}

// 수강상태가 실제로 "🔴 수강 종료"가 된 등록에 한해서만 시간표 관계를 전부 해제한다.
// (종료일이 미래인 채로 아직 도달하지 않은 경우는 절대 여기서 건드리지 않는다 —
//  generate-classes가 시간표 관계를 보고 남은 정상 수업들의 출석을 계속 만들어야 하기 때문.)
export async function disconnectTimetableForEndedRegistrations(log: string[]) {
  const data = await queryDataSource(DS_REGISTRATION, {
    filter: {
      and: [
        { property: PROP_STATUS, formula: { string: { equals: STATUS_ENDED } } },
        { property: PROP_TIMETABLE, relation: { is_not_empty: true } },
      ],
    },
    page_size: 100,
  })
  await mapWithConcurrency(data.results, 4, async (reg: any) => {
    const regName = titleText(reg, PROP_TITLE)
    await updatePageProperties(reg.id, { [PROP_TIMETABLE]: { relation: [] } })
    log.push(`[TIMETABLE] [${regName}] timetable relation cleared (수강 종료)`)
  })
}

// 종료일이 뒤로 밀리거나(연장) 삭제되어 등록이 다시 유효해졌을 때, 이미 생성되어 있는
// 수업 페이지 범위(등록일~종료일, 종료일 없으면 등록일 이후 전부) 안에서 이 등록이
// 아직 안 붙어 있는 수업들을 찾아 등록 관계를 복원하고, 누락된 출석을 다시 만든다.
// 새 수업 페이지는 만들지 않는다 (그건 generate-classes가 시간표를 기준으로 반복
// 생성하는 몫). 이미 연결/생성된 건 필터로 걸러지므로 여러 번 실행해도 안전하다.
export async function restoreClassSessionsAndAttendance(reg: any, log: string[]) {
  const regName = titleText(reg, PROP_TITLE)

  const status = reg.properties[PROP_STATUS]?.formula?.string
  if (status === STATUS_ENDED) {
    log.push(`⏭️ [${regName}] 아직 수강 종료 상태라 복원 생략`)
    return
  }

  const enrollDate = reg.properties[PROP_ENROLL_DATE]?.date?.start
  if (!enrollDate) {
    log.push(`⏭️ [${regName}] 등록일이 없어 복원 생략`)
    return
  }

  const timetableIds = relIds(reg.properties[PROP_TIMETABLE])
  if (timetableIds.length === 0) {
    log.push(`⏭️ [${regName}] 연결된 시간표가 없어 복원 생략`)
    return
  }

  const endDate = reg.properties[PROP_END_DATE]?.date?.start
  const classIds = relIds(reg.properties[PROP_CLASS])

  // Notion 관계 필터 검색은 방금 반영된 변경사항(예: 방금 종료일을 지워서 시간표가
  // 막 다시 연결된 경우)을 즉시 인덱싱하지 못하는 지연이 있을 수 있다. 그래서 이 복원
  // 경로에서는 retryOnEmpty를 켜서, 첫 조회 결과가 비어 있으면 짧게 대기 후 한 번 더 조회한다.
  const { sessionsTouched, attendanceCreated, recordsLinked } = await attachSessionsAndAttendance(
    reg,
    timetableIds,
    enrollDate,
    endDate,
    classIds,
    { retryOnEmpty: true },
  )

  if (sessionsTouched > 0 || attendanceCreated > 0) {
    log.push(
      `♻️ [${regName}] 수업 ${sessionsTouched}건 등록 복원, 출석 ${attendanceCreated}건 재생성 (기존 학습기록 연결 ${recordsLinked}건)`,
    )
  }
}

// 안전망: 종료일 변경 웹훅이 놓쳤거나 아직 연결되지 않은 경우를 대비해, 매 실행(webhook
// 단건 호출 + 매일 cron 전체 스캔) 때마다 등록일이 있고 종료되지 않은 모든 등록을 훑어서
// 복원 누락분을 보정한다. 이미 복원된 건 관계 필터로 걸러지므로 매번 실행해도 안전하다.
export async function restoreAllPendingClassSessions(log: string[]) {
  const data = await queryDataSource(DS_REGISTRATION, {
    filter: {
      and: [
        { property: PROP_ENROLL_DATE, date: { is_not_empty: true } },
        { property: PROP_TIMETABLE, relation: { is_not_empty: true } },
        { property: PROP_STATUS, formula: { string: { does_not_equal: STATUS_ENDED } } },
      ],
    },
    page_size: 100,
  })
  await mapWithConcurrency(data.results, 4, (reg: any) => restoreClassSessionsAndAttendance(reg, log))
}

export async function handleEndDateChange(pageId: string, log: string[]) {
  const reg = await getPage(pageId)
  const regName = titleText(reg, PROP_TITLE)
  const endDate = reg.properties[PROP_END_DATE]?.date?.start
  if (!endDate) {
    log.push(`[SKIP] [${regName}] no end date, skipping attendance cleanup`)
    return
  }
  await deleteAttendanceAfterEndDate(pageId, endDate, regName, log)
  await disconnectClassSessionsAfterEndDate(pageId, endDate, regName, log)
}

// 단건(웹훅) 경로용 빠른 처리: 방금 다시 읽은 등록 페이지 하나만 보고 즉시 판단한다.
// 전체 스캔(queryDataSource 필터) 없이 처리하므로 훨씬 빠르고, Notion의 formula 필터
// 인덱싱 지연(수강상태 계산은 끝났지만 필터 검색엔 아직 안 잡히는 경우)에도 영향받지 않는다.
export async function disconnectTimetableIfEndedSingle(reg: any, log: string[]) {
  const regName = titleText(reg, PROP_TITLE)
  const status = reg.properties[PROP_STATUS]?.formula?.string
  const timetableIds = relIds(reg.properties[PROP_TIMETABLE])
  if (status === STATUS_ENDED && timetableIds.length > 0) {
    await updatePageProperties(reg.id, { [PROP_TIMETABLE]: { relation: [] } })
    log.push(`[TIMETABLE] [${regName}] timetable relation cleared (수강 종료, 단건 처리)`)
  }
}

// 단건(웹훅) 경로용 빠른 처리: 이미 읽은 등록 상태를 그대로 써서 개별 진도교재 정리 필요 여부를 판단한다.
export async function cleanupTextbooksIfNeededSingle(reg: any, log: string[]) {
  const regName = titleText(reg, PROP_TITLE)
  const status = reg.properties[PROP_STATUS]?.formula?.string
  const enrollDate = reg.properties[PROP_ENROLL_DATE]?.date
  if (status === STATUS_ENDED || !enrollDate) {
    await cleanupTextbooksForRegistration(reg.id, regName, log)
  }
}

// 안전망: 종료일 편집 웹훅이 아직 연결되지 않았거나 놓친 경우를 대비해,
// 매 실행(webhook 단건 호출 + 매일 cron 전체 스캔) 때마다 종료일이 있는 모든 등록을 훑어서
// 종료일 이후 출석을 정리한다. 이미 정리된 건 0건 삭제로 아무 영향 없음(idempotent).
export async function cleanupAttendanceForAllEndedRegistrations(log: string[]) {
  const data = await queryDataSource(DS_REGISTRATION, {
    filter: { property: PROP_END_DATE, date: { is_not_empty: true } },
    page_size: 100,
  })
  await mapWithConcurrency(data.results, 4, async (reg: any) => {
    const regName = titleText(reg, PROP_TITLE)
    const endDate = reg.properties[PROP_END_DATE]?.date?.start
    if (endDate) {
      await deleteAttendanceAfterEndDate(reg.id, endDate, regName, log)
      await disconnectClassSessionsAfterEndDate(reg.id, endDate, regName, log)
    }
  })
}

export async function cleanupTextbooksForEndedOrInvalidRegistrations(log: string[]) {
  const data = await queryDataSource(DS_REGISTRATION, {
    filter: {
      or: [
        { property: PROP_STATUS, formula: { string: { equals: STATUS_ENDED } } },
        { property: PROP_ENROLL_DATE, date: { is_empty: true } },
      ],
    },
    page_size: 100,
  })
  await mapWithConcurrency(data.results, 4, (reg: any) => {
    const regName = titleText(reg, PROP_TITLE)
    return cleanupTextbooksForRegistration(reg.id, regName, log)
  })
}