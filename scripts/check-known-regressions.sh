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

# 5) 주간/월간 보고서는 전체 최신화와 선생님 코멘트 검증 성공 후에만 발송해야 한다.
SEND_REPORT_FILE=supabase/functions/send-report/index.ts
if ! grep -q 'refreshStudentReport' "$SEND_REPORT_FILE"; then
  echo "❌ $SEND_REPORT_FILE: 주간/월간 전송 전 전체 최신화가 빠졌습니다."
  fail=1
fi
if ! grep -q '선생님 코멘트가 최신 보고서 캐시에 포함되지 않았습니다' "$SEND_REPORT_FILE"; then
  echo "❌ $SEND_REPORT_FILE: 선생님 코멘트 포함 검증이 빠졌습니다."
  fail=1
fi
if [ "$(grep -c 'clearBulkSelectFlag(reportId)' "$SEND_REPORT_FILE")" -lt 2 ]; then
  echo "❌ $SEND_REPORT_FILE: 일괄전송 실패 건의 선택 해제가 빠져 무한 반복 위험이 있습니다."
  fail=1
fi
if ! grep -q 'id: rp.id' supabase/functions/_shared/reportCacheBuilder.ts; then
  echo "❌ reportCacheBuilder.ts: 캐시에 보고서 ID가 없어 현재 코멘트 포함 여부를 검증할 수 없습니다."
  fail=1
fi

# 6) 학습활동의 "구분"은 롤업 속성이다. rollup을 텍스트로 해석하지 못하면 과제/평가가
#    모두 빈 분류로 탈락해 HTML에 "해당 없음"으로 표시된다.
if ! grep -q 'case "rollup"' supabase/functions/_shared/reportCacheShared.ts; then
  echo "❌ reportCacheShared.ts: 롤업 텍스트 해석이 없어 과제/평가 분류가 누락됩니다."
  fail=1
fi

# 7) 등록 페이지 수동 동기화는 그룹 공통 학습기록/학습활동을 공유하는 학생 캐시에도
#    순차 전파해야 한다. 그렇지 않으면 한 학생만 최신 범위·내용을 보고 나머지는 과거 캐시를 본다.
if ! grep -q 'resolveSharedLearningRegistrationIds' "$SYNC_CACHE_FILE"; then
  echo "❌ $SYNC_CACHE_FILE: 공유 학습기록의 관련 학생 캐시 전파가 빠졌습니다."
  fail=1
fi

# 8) 학생 화면에는 "[과제] 학생명 날짜" 같은 학습활동 페이지명을 노출하지 않는다.
#    과제·평가는 연결된 학습기록의 교재/범위/단원/내용으로 조립해야 한다.
if grep -q 'content: text(props\\[\"학습활동\"\\])' supabase/functions/_shared/reportCacheBuilder.ts; then
  echo "❌ reportCacheBuilder.ts: 내부 학습활동 페이지명이 학생 화면 데이터로 다시 노출됩니다."
  fail=1
fi
if ! grep -q 'renderLogMetaRows' student_report_part1.js || ! grep -q '💯 ' student_report_part1.js; then
  echo "❌ 학생 리포트: 디자인 문서의 단원·내용 줄 분리/100점 💯 규칙이 빠졌습니다."
  fail=1
fi
if grep -q '내용: \\${note}' student_report_part1.js; then
  echo "❌ 학생 리포트: 내용 원문 앞에 불필요한 '• 내용:' 라벨이 다시 추가됐습니다."
  fail=1
fi
if ! grep -q 'reportWeekLabel' student_report_part2.js || ! grep -q 'openReportPeriodPicker' student_report_part2.js || ! grep -q 'report-period-modal' student_report.html; then
  echo "❌ 학생 리포트: 일간·주간·월간 달력형 기간 선택기 또는 M월 N주차 표기가 빠졌습니다."
  fail=1
fi

# 9) 학교 성적은 내부 운영 전용이다. 학부모용 화면·캐시 생성·공개 응답에 노출하지 않는다.
if grep -Eq 'grades-section|renderGradesPage|buildGradeTableHtml|buildGradeChartHtml' student_report.html student_report_part1.js student_report_part2.js; then
  echo "❌ 학생 리포트: 학부모 화면에 학교 성적 UI가 다시 추가됐습니다."
  fail=1
fi
if grep -q 'sp\["성적"\]' supabase/functions/_shared/reportCacheBuilder.ts; then
  echo "❌ reportCacheBuilder.ts: 학부모 캐시에 학교 성적을 다시 수집하고 있습니다."
  fail=1
fi
if ! grep -q '_privateGrades' supabase/functions/get-report-fast/index.ts; then
  echo "❌ get-report-fast: 기존 캐시의 학교 성적을 공개 응답에서 제거하는 보호 장치가 없습니다."
  fail=1
fi

# 10) 전역 새로고침 버튼은 기기별 이모지 대신 지정된 이미지 아이콘을 사용한다.
if grep -q '>🔄</button>' student_report.html || ! grep -q 'global-sync-fab.*aria-label="새로고침".*<img' student_report.html; then
  echo "❌ 학생 리포트: 전역 새로고침 버튼의 이미지 아이콘 또는 접근성 라벨이 빠졌습니다."
  fail=1
fi

# 11) 브랜드 색상은 개별 하드코딩 대신 공용 팔레트 변수로 관리한다.
if ! grep -q -- '--brand-primary: #e6d8c4' student_report.html || ! grep -q -- '--brand-soft: #f5efe7' student_report.html || ! grep -q 'background: var(--brand-primary)' student_report.html; then
  echo "❌ 학생 리포트: 공용 브랜드 팔레트 또는 주요 컴포넌트 연결이 빠졌습니다."
  fail=1
fi

# 12) 헤더는 44px 클릭 영역을 유지하고, 메뉴 30px·뒤로가기 28px 선형 SVG와 투명 배경을 사용한다.
if grep -Eq '>←</button>|>☰</button>' student_report_part1.js student_report_part2.js || ! grep -q '.header-icon { width: 30px; height: 30px' student_report.html || ! grep -q '.reg-back-btn .header-icon, .back-btn-plain .header-icon { width: 28px; height: 28px; }' student_report.html || ! grep -q '.reg-back-btn {.*background: transparent' student_report.html || ! grep -q '.hamburger-btn {' student_report.html; then
  echo "❌ 학생 리포트: 헤더 선형 아이콘·클릭 영역 또는 투명 배경 규칙이 빠졌습니다."
  fail=1
fi

# 13) 접힌 상세 헤더는 모바일 앱 수준인 56px 높이로 유지한다.
if ! grep -q '.reg-header-bar { min-height: 56px; padding: 6px 10px; box-sizing: border-box; }' student_report.html; then
  echo "❌ 학생 리포트: 접힌 상세 헤더의 56px 높이 규칙이 빠졌습니다."
  fail=1
fi

if [ "$fail" != 0 ]; then
  echo ""
  echo "회귀 가드 실패 -- 위 문제를 고친 뒤 다시 배포하세요."
  exit 1
fi
echo "✅ 회귀 가드 통과"
