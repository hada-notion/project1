#!/usr/bin/env bash
# 과거에 실제로 재발했던 속성명/설정 버그가 이번 배포본에도 다시 있는지 확인하는
# 가벼운 grep 기반 회귀 가드. deploy 워크플로우가 Supabase에 배포하기 *전에* 이 스크립트를
# 실행해서, 여기서 하나라도 걸리면 배포를 막는다 (로드맵 3번: "배포 전 자동 검증 절차 없음" 개선).
#
# 여기 있는 검사 항목은 전부 "실제로 한 번 이상 재발했던 버그"에서 나온 것들이다.
# 새로운 재발 패턴을 발견하면 이 파일에 검사를 추가한다.
set -uo pipefail

cd "$(dirname "$0")/.."

fail=0

# 1) (로드맵 5-26) 보고서/수강료 → 알림톡 발송함 연결 속성명이 옷 이름 "배치"로 되돌아갔는지.
#    generate-report/generate-tuition/send-selected-notifications는 이제 전부
#    _shared/generateShared.ts의 PROP_NOTIFICATION_BATCH_RELATION을 통해서만 이 속성명을 참조해야 한다.
BATCH_RELATION_FILES=(
	supabase/functions/generate-report/index.ts
	supabase/functions/generate-tuition/index.ts
	supabase/functions/send-selected-notifications/index.ts
)
for f in "${BATCH_RELATION_FILES[@]}"; do
	if [ -f "$f" ] && grep -nE '"배치"[[:space:]]*:[[:space:]]*\{[[:space:]]*relation' "$f" >/dev/null; then
		echo "❌ $f: \"알림톡 발송함\" 관계 속성명이 옷 이름 \"배치\"로 되돌아갔습니다. PROP_NOTIFICATION_BATCH_RELATION을 사용하세요."
		fail=1
	fi
done

# 2) (로드맵 5-17) create-learning-record / sync-registration-end / sync-registration-textbook
#    세 함수가 동시에 같은 import를 빠뜨리고 있던 적이 있다. notionClient를 쓰는 함수는
#    반드시 _shared/notionClient.ts를 정상적으로 import해야 한다.
IMPORT_CHECK_FILES=(
	supabase/functions/create-learning-record/index.ts
	supabase/functions/sync-registration-end/index.ts
	supabase/functions/sync-registration-textbook/index.ts
)
for f in "${IMPORT_CHECK_FILES[@]}"; do
	if [ -f "$f" ] && grep -q 'notionClient\.' "$f" && ! grep -q 'from "\.\./_shared/notionClient\.ts"' "$f"; then
		echo "❌ $f: notionClient를 참조하지만 정상적으로 import하고 있지 않음"
		fail=1
	fi
done

# 3) 일일보고서는 토큰만 확인하고 바로 발송하던 과거 경로로 돌아가면 안 된다.
#    개별/반별 모두 공용 최신화 경로를 사용하고, 공용 경로는 반드시
#    토큰 보장 -> 출석 원본 -> 완성 캐시 순서여야 한다.
for f in \
  supabase/functions/send-daily-report/index.ts \
  supabase/functions/send-class-daily-reports/index.ts; do
  if ! grep -q 'refreshDailyReportForSend' "$f"; then
    echo "❌ $f: 일일보고서 전송 전 공용 최신화 경로가 빠졌습니다."
    fail=1
  fi
done
REFRESH_FILE=supabase/functions/_shared/dailyReportRefresh.ts
if [ -f "$REFRESH_FILE" ]; then
  token_line=$(grep -n 'await syncStudentReport' "$REFRESH_FILE" | head -1 | cut -d: -f1)
  attendance_line=$(grep -n 'await syncAttendanceForRegistration' "$REFRESH_FILE" | head -1 | cut -d: -f1)
  cache_line=$(grep -n 'await syncReportCacheForRegistration' "$REFRESH_FILE" | head -1 | cut -d: -f1)
  if [ -z "$token_line" ] || [ -z "$attendance_line" ] || [ -z "$cache_line" ] || \
     [ "$token_line" -ge "$attendance_line" ] || [ "$attendance_line" -ge "$cache_line" ]; then
    echo "❌ $REFRESH_FILE: 토큰 -> 출석 원본 -> 보고서 캐시 순서가 깨졌습니다."
    fail=1
  fi
else
  echo "❌ $REFRESH_FILE: 일일보고서 공용 최신화 파일이 없습니다."
  fail=1
fi

# 4) 등록 페이지/웹앱의 수동 학생 페이지 동기화는 전송과 같은 전체 최신화 경로를 사용해야 한다.
SYNC_CACHE_FILE=supabase/functions/sync-report-cache/index.ts
if ! grep -q 'refreshStudentReport' "$SYNC_CACHE_FILE" || ! grep -q 'isRegistrationPage' "$SYNC_CACHE_FILE"; then
  echo "❌ $SYNC_CACHE_FILE: 등록 페이지 수동 전체 최신화 경로가 빠졌습니다."
  fail=1
fi
if grep -q 'Promise.all(ids.map((id) => requestSyncForRegistrationId' student_report_part2.js; then
  echo "❌ student_report_part2.js: 여러 등록의 수동 최신화를 다시 병렬 호출하고 있습니다."
  fail=1
fi

if [ "$fail" != 0 ]; then
  echo ""
  echo "회귀 가드 실패 -- 위 문제를 고친 뒤 다시 배포하세요."
  exit 1
fi
echo "✅ 회귀 가드 통과"
