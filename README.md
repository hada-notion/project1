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
| 학부모 리포트 웹앱 | `student_report.html`, `student_report_part1.js`, `student_report_part2.js` (GitHub Pages, 디자인 기준 화면) |
| 출결 키오스크 웹앱 | `attendance_kiosk.html` → `list-students?kiosk=1`, `kiosk-checkin` (키오스크 전용 30일 로그인) |
| 관리 화면 3개 | `admin_settings.html`·`admin_settings.js`(관리자 비밀번호·웹훅 키 교체·체크리스트 → `admin-security`), `legal_documents.html`(법정 서류 → `get-legal-document-data`), `school_search.html`(학교 검색 → `school-api`). 상단 메뉴로 같은 탭에서 오가고 로그인을 공유(`admin_auth.js`) |
| 공용 화면 스타일·메뉴 | `assets/hada-tokens.css`, `assets/hada-ui.css`, `assets/hada-shortcuts.js`. 규칙은 [`docs/DESIGN.md`](docs/DESIGN.md) |
| 예약 실행(pg_cron) | 큐 워커(매분), 상태 워치독(15분), 동기화 실패 점검(30분), 과제 마감 백필(10분), 키오스크 오늘 출석 준비(매일 04:00 KST, `kiosk-prepare`). 모두 Vault `sync_queue_admin_key`로 인증 |
| 워크플로 | `deploy-supabase-functions.yml`(함수·마이그레이션 자동 배포), `web-checks.yml`(화면·문서 PR 검사), `sync-attendance-incremental.yml`·`sync-attendance-reconcile.yml`(출석 전체 동기화, 수동 실행만) |
| 검사 | `scripts/check-known-regressions.sh`(회귀 가드), `tests/design-lint.cjs`(디자인 규칙·공용 파일 버전), `tests/admin-security-sql.cjs`, 함수별 `*_test.ts` |
| 이식 도구 | `scripts/setup-new-academy.py`(원본 주소 초기 치환), `scripts/reset-admin-password.py`(관리자 비밀번호 0000 초기화) |
| Notion 기준 도구 | `scripts/notion-scan.js`(브라우저에서 Notion 구성 읽기 전용 스캔), `scripts/notion-diff.py`(원본 지문과 비교), `scripts/notion-spec.py`·`scripts/notion-extract.py`(원본 전용: 명세·지문 만들기, 요청 항목 뽑기) |

운영 웹앱 기준 주소: `https://hada-notion.github.io/project1/`

## 배포

`main` 브랜치에 `supabase/functions/**` 또는 `supabase/migrations/**` 변경이 푸시되면
GitHub Actions가 자동으로: 전체 함수 `deno check` → 회귀 가드 스크립트 → `supabase db push`(마이그레이션) →
`supabase functions deploy --no-verify-jwt`(전체 함수) → 배포된 함수 목록/필수 Secrets 검증 → 마이그레이션 상태 출력.
화면(`*.html`, `*.js`, `assets/`)과 Pages는 `main` 푸시 때 GitHub Pages가 다시 빌드합니다. 화면·문서만 바꾼 PR은
`web-checks.yml`이 디자인 규칙·체크리스트 대조·회귀 가드를 확인합니다.

## 기준 문서

주제마다 기준은 한 곳이다. 다른 문서는 이 문서들을 가리키고, 같은 내용을 따로 적지 않는다.

| 주제 | 기준 |
| --- | --- |
| Notion 구성(속성·수식·버튼·자동화·보기·레이아웃)과 맞추는 순서 | [`docs/기준/적용-절차.md`](docs/기준/적용-절차.md). 전체 명세는 원본 Notion(비공개), 공개는 지문 [`docs/기준/노션-지문.json`](docs/기준/노션-지문.json) |
| Notion 이름·레이아웃 원칙(버튼·상태 속성·자동화 이름, 예전 이름) | [`docs/이름-규칙.md`](docs/이름-규칙.md) |
| 버튼·자동화가 부르는 서버 함수, 인증, Notion 자동화 원칙 | [`docs/버튼-웹훅-매핑.md`](docs/버튼-웹훅-매핑.md) |
| 화면 디자인 | [`docs/DESIGN.md`](docs/DESIGN.md) |
| 변경 이력과 버전별 지침 | [`CHANGELOG.md`](CHANGELOG.md), `docs/updates/` (양식 [`_TEMPLATE.md`](docs/updates/_TEMPLATE.md)) |
| 원본 패치 작업 흐름 | [`docs/패치-이슈-관리.md`](docs/패치-이슈-관리.md) |
| 새 학원 이식(Secrets·환경값) | [`docs/새-학원-이식-체크리스트.md`](docs/새-학원-이식-체크리스트.md) |
| 기능별 구조 | [`docs/키오스크-처리-흐름.md`](docs/키오스크-처리-흐름.md), [`docs/설계-수업관리-복사본.md`](docs/설계-수업관리-복사본.md)·[`docs/화면-데이터-목록.md`](docs/화면-데이터-목록.md), [`docs/학교-학사일정-연결.md`](docs/학교-학사일정-연결.md), [`docs/학생-보고서-본문-첨부파일.md`](docs/학생-보고서-본문-첨부파일.md), [`LEGAL_DOCUMENTS.md`](LEGAL_DOCUMENTS.md) |

운영 사용법은 Notion 메뉴얼이 기준이다. 저장소 문서와 Notion 메뉴얼이 다르면 Notion을 따르고 차이를 보고한다.

## 히스토리

과거 작업 경과는 Git 이력과 Notion `패치·이슈 관리` DB에 있다. 문서에는 현재 기준만 남긴다.
