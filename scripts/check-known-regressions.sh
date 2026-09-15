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

if [ "$fail" != 0 ]; then
	echo ""
	echo "회귀 가드 실패 -- 위 문제를 고친 뒤 다시 배포하세요."
	exit 1
fi

echo "✅ 회귀 가드 통과"
