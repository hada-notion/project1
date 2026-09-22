# 하다 학원관리 (project1)

Notion 기반 학원관리 시스템의 백엔드(Supabase Edge Functions)·마이그레이션·운영 웹앱(GitHub Pages) 저장소입니다.

**운영 기준 문서는 이 README가 아니라 Notion "메뉴얼"입니다.** 실제 스키마, 버튼·자동화 연결, SOP는
Notion 워크스페이스의 "📘 하다 학원관리 구조·실행 설명서"(메뉴 > 8. 기타 설정 > 메뉴얼)를 항상 최신 기준으로 봅니다.
이 README는 저장소를 처음 여는 사람을 위한 최소한의 지도 역할만 합니다.

## 구성

| 영역 | 위치 |
| --- | --- |
| 운영 데이터 원본 | Notion 워크스페이스 (이 저장소에는 없음) |
| Edge Functions | `supabase/functions/*` (Deno, Supabase CLI로 배포) |
| DB 마이그레이션 | `supabase/migrations/*.sql` (pg_cron, sync_queue 등 포함) |
| 학부모 리포트 웹앱 | `student_report.html`, `student_report_part1.js`, `student_report_part2.js` (GitHub Pages) |
| 출결 키오스크 웹앱 | `attendance_kiosk.html` (GitHub Pages) |
| 배포 워크플로 | `.github/workflows/deploy-supabase-functions.yml` |
| 회귀 가드 스크립트 | `scripts/` |

운영 웹앱 기준 주소: `https://hada-notion.github.io/project1/`

## 배포

`main` 브랜치에 `supabase/functions/**` 또는 `supabase/migrations/**` 변경이 푸시되면
GitHub Actions가 자동으로: 전체 함수 `deno check` → 회귀 가드 스크립트 → `supabase db push`(마이그레이션) →
`supabase functions deploy --no-verify-jwt`(전체 함수) → 배포된 함수 목록/필수 Secrets 검증 → 마이그레이션 상태 출력.

필요한 GitHub Actions Secrets와 Supabase Edge Function Secrets 전체 목록은
[`docs/archive/2026-09-refactoring-and-fix-log.md`의 "10-18. 새 학원 이식 체크리스트"](docs/archive/2026-09-refactoring-and-fix-log.md)를 참고하세요.

## 히스토리 / 과거 작업 로그

이 저장소와 연결된 Notion 시스템의 상세한 리팩토링 이력, 발견된 버그와 수정 내역, 인증 감사 결과 등은
[`docs/archive/`](docs/archive) 아래에 날짜별로 보관합니다. 현재 상태를 파악하려면 로그가 아니라
Notion 메뉴얼과 실제 코드를 먼저 확인하세요.
