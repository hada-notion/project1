// 여러 Supabase Edge Function(sync-registration-timetable, sync-registration-textbook 등)이
// 공통으로 참조하는 Notion 접속 정보와 데이터소스/속성 이름만 여기 둔다.
// 함수 하나에서만 쓰이는 데이터소스 ID나 속성명은 공용 모듈로 옮기지 않고 각 함수 폴더에 그대로 둔다.

// (2026-09-16) 배포 워크플로우가 --no-verify-jwt 없이 전체 함수를 재배포하면서 모든 함수의
// JWT 검증이 기본값(true)으로 초기화되어, Notion 버튼의 "웹훅 보내기" 액션(Supabase JWT를
// 보낼 수 없음)이 Supabase 게이트웨이 단계에서 막혀 함수 로그조차 남지 않는 문제가 있었다.
// 워크플로우에 --no-verify-jwt를 추가해 재배포를 트리거하기 위한 사소한 변경.

// 함수마다 다른 이름의 환경변수를 써 온 이력이 있어서(NOTION_API_KEY/NOTION_TOKEN/NOTION_SECRET),
// 하나로 통일하되 기존 배포 환경을 깨지 않도록 전부 순서대로 확인한다.
export const NOTION_TOKEN =
	Deno.env.get("NOTION_TOKEN") ?? Deno.env.get("NOTION_API_KEY") ?? Deno.env.get("NOTION_SECRET") ?? ""
export const NOTION_VERSION = "2025-09-03" // 멀티 데이터소스 DB의 parent.data_source_id를 쓰려면 이 버전 이상이 필요
export const NOTION_API = "https://api.notion.com/v1"

// ---------- 데이터소스(Notion DB) ID ----------
// (2026-09-21, 이식성 리팩토링) 이 워크스페이스 전용 데이터소스 ID 17개를 이 파일 한 곳에서만
// Supabase Secrets(환경변수)로 읽어오도록 통일했다. 예전에는 같은 ID 리터럴이 cascadeDeleteTarget.ts/
// createAssignmentTarget.ts/createLearningRecordTarget.ts/dashboardLinkTarget.ts/
// fixAttendanceTarget.ts/generateShared.ts/reportCacheBuilder.ts/syncReportCacheTarget.ts/
// classReportCacheTarget.ts/attendanceSyncShared.ts/sync-attendance/nightly-report-sync-audit
// 12개 파일에 각자 복사돼 있었다 — 다른 노션 워크스페이스(다른 학원)로 이 코드를 그대로 재사용하려면
// 그 12개 파일을 전부 찾아 고쳐야 했다는 뜻이다. 이제는 이 파일의 환경변수 이름 17개만 그 학원의
// 실제 데이터소스 ID로 채우면 코드 수정 없이 재사용할 수 있다 (메뉴얼 "이식 체크리스트" 참고).
// (진도교재 DB는 이미 이전부터 DATA_SOURCE_PROGRESS_BOOK_ID로 환경변수화돼 있었다, registrationTextbookTarget.ts 참고.)
export const DS_REGISTRATION = Deno.env.get("DATA_SOURCE_REGISTRATION_ID")! // 등록(학원) DB
export const DS_CLASS = Deno.env.get("DATA_SOURCE_CLASS_ID")! // 클래스(학원) DB

export const PROP_CLASS = "클래스" // 등록 DB의 클래스 relation (limit 1)
export const PROP_ENROLL_DATE = "등록일" // 등록 DB
export const PROP_END_DATE = "종료일" // 등록 DB
export const PROP_TITLE = "이름" // 등록(학원) DB
export const PROP_STATUS = "수강상태" // 등록(학원) DB (수식)
export const PROP_TIMETABLE = "시간표" // 등록(학원) DB
export const STATUS_ENDED = "🔴 수강 종료"

// 등록 관련 자동화(수업 생성/종료 처리/복원)가 공통으로 조회하는 데이터소스.
// class-session, end, timetable 세 함수가 각자 같은 리터럴을 들고 있던 것을 하나로 모음 (로드맵 리팩토링).
export const DS_ATTENDANCE = Deno.env.get("DATA_SOURCE_ATTENDANCE_ID")! // 출석(학원) DB
export const DS_CLASS_SESSION = Deno.env.get("DATA_SOURCE_CLASS_SESSION_ID")! // 수업(학원) DB
export const DS_LEARNING_RECORD = Deno.env.get("DATA_SOURCE_LEARNING_RECORD_ID")! // 학습기록(학원) DB

// 아래 8개는 원래 각 target 파일이 자기 것만 로컬로 들고 있던 것을, 위와 같은 이유로 여기로 모았다.
export const DS_STUDY_ACTIVITY = Deno.env.get("DATA_SOURCE_STUDY_ACTIVITY_ID")! // 학습활동(학원) DB
export const DS_DASHBOARD = Deno.env.get("DATA_SOURCE_DASHBOARD_ID")! // 대시보드(학원) DB
export const DS_SCHEDULE_EVENT = Deno.env.get("DATA_SOURCE_SCHEDULE_EVENT_ID")! // 일정(학원) DB
export const DS_TEXTBOOK_CART = Deno.env.get("DATA_SOURCE_TEXTBOOK_CART_ID")! // 교재비(학원) DB
export const DS_TEXTBOOK_DISTRIBUTION = Deno.env.get("DATA_SOURCE_TEXTBOOK_DISTRIBUTION_ID")! // 교재배부(학원) DB
export const DS_TEXTBOOK_PAYMENT = Deno.env.get("DATA_SOURCE_TEXTBOOK_PAYMENT_ID")! // 교재결제(학원) DB
export const DS_TIMETABLE = Deno.env.get("DATA_SOURCE_TIMETABLE_ID")! // 시간표(학원) DB
export const DS_TUITION = Deno.env.get("DATA_SOURCE_TUITION_ID")! // 수강료(학원) DB
export const DS_REPORT = Deno.env.get("DATA_SOURCE_REPORT_ID")! // 보고서(학원) DB

// 출석(학원) DB 속성
export const PROP_ATTENDANCE_TITLE = "출석"
export const PROP_ATTENDANCE_REGISTRATION = "등록"
export const PROP_ATTENDANCE_CLASS_DATETIME = "수업일시"
export const PROP_ATTENDANCE_SESSION = "수업"
export const PROP_ATTENDANCE_ACTIVITY = "학습활동"
export const PROP_ATTENDANCE_LEARNING_RECORD = "학습기록"
// 시간표 -> 수업(학원) DB 생성 시 이미 복사돼 있는 담당강사를, 출석 생성/연결 시에도 함께
// 복사하기 위한 속성명 (2026-09-16 버그 수정: 이전엔 수업까지만 복사되고 출석에는 전달되지
// 않고 있었음 — registrationSync.ts의 attachSessionsAndAttendance에서 사용).
export const PROP_ATTENDANCE_TEACHER = "담당강사"

// 수업(학원) DB 속성
export const PROP_SESSION_REGISTRATION = "등록" // roster (여러 학생)
export const PROP_SESSION_DATETIME = "수업일시"
export const PROP_SESSION_TIMETABLE = "시간표"
// 시간표에서 generate-classes가 수업 생성 시 복사해두는 담당강사 (2026-09-16 추가 —
// registrationSync.ts가 이 값을 읽어 출석에도 다시 복사하는 데 사용).
export const PROP_SESSION_TEACHER = "담당강사"
// generate-classes가 이 수업 행에 딸린 출석들을 만드는 동안 true로 표시 (2026-09-11 추가).
// 수업 행 자체는 이미 완성된 상태로 한 번에 생성되며, 출석 생성이 끝나면 자동으로 해제된다.
// "실시간 처리 상태" 수식이 이 값과 PROP_LAST_ERROR(마지막 오류)를 조합해서 화면에 표시한다.
export const PROP_SESSION_GEN_RUNNING = "생성중"

// 학습기록(학원) DB 속성
export const PROP_RECORD_SESSION = "수업"
export const PROP_RECORD_REGISTRATION = "등록"

// 종료된(또는 등록일이 삭제된) 등록의 미사용 개별 진도교재를 정리하는 내부 라우트.
// class-session/end/timetable 세 함수가 모두 이 URL로 fetch한다.
// (2026-09-21, 이식성 리팩토링) 예전에는 이 Supabase 프로젝트의 URL이 그대로 박혀 있어서, 다른
// 학원(다른 Supabase 프로젝트)에 재배포하면 항상 이 워크스페이스의 함수를 잘못 호출하게 되는
// 문제가 있었다. SB_URL(다른 파일들과 동일한 환경변수)로 조립하도록 고쳤다.
export const TEXTBOOK_CLEANUP_URL = `${Deno.env.get("SB_URL") ?? ""}/functions/v1/sync-registration-textbook/cleanup-on-end`

// 클래스.수업방식(그룹/개별 진도)은 삭제됨 — 이제 진도교재(학원) DB의 "진도방식" select로
// 반별교재(템플릿) 단위로 표현한다 (sync-registration-textbook에서 직접 문자열로 참조).

// 시간표(학원) DB: "수업 방식" select (그룹 수업/개별 수업). (2026-09-22, PART N-6) "등록" 버튼이
// 클래스에 연결된 시간표를 전부 자동 연결하던 기존 로직이, 개별 수업(과외)처럼 같은 클래스 안에
// 시간대별 시간표 row가 여러 개 있는 경우 전부 다 연결해버려서, 학생 1명이 그 반의 모든 시간대에
// 한꺼번에 연결되고 그대로 "수업 생성"을 누르면 모든 시간대에 출석이 생기는 문제가 있었다(등록
// 시점에는 어느 시간대에 배정될지 아직 정해지지 않았기 때문). 이제 "등록" 버튼은 "개별 수업"으로
// 표시된 시간표는 자동 연결 대상에서 제외하고, 그룹 수업(또는 수업 방식 미설정) 시간표만 자동
// 연결한다. 개별 수업은 담당자가 실제 배정될 시간표를 수동으로 연결한 뒤 "수업 생성"을 누르는
// 흐름으로 처리한다 (registrationEnrollTarget.ts 참고).
export const PROP_TIMETABLE_CLASS_MODE = "수업 방식" // 시간표(학원) DB
export const TIMETABLE_MODE_INDIVIDUAL = "개별 수업"

// 등록 DB: 시간표/교재 두 Edge Function이 각각 처리 중인지 표시하는 내부용 체크박스.
// "동기화 상태"(사용자에게 보이는 select)는 이 둘을 조합해서 계산한다 —
// 둘 중 하나라도 처리 중이면 "처리 중", 둘 다 끝나야 "완료"로 표시한다.
export const PROP_SYNC_TIMETABLE_RUNNING = "시간표 처리중"
export const PROP_SYNC_TEXTBOOK_RUNNING = "교재 처리중"
// "수업 생성"/"종료 처리" 버튼 전용 함수도 같은 방식으로 처리 중 여부를 표시한다 (2026-09-10 추가).
export const PROP_SYNC_CLASS_SESSION_RUNNING = "수업 처리중"
export const PROP_SYNC_END_RUNNING = "종료 처리중"
// "등록" 버튼(종료 버튼의 반대) 전용 함수도 같은 방식으로 처리 중 여부를 표시한다.
export const PROP_SYNC_ENROLL_RUNNING = "등록 처리중"
export const PROP_SYNCED_AT = "마지막 동기화" // 등록(학원) DB: 마지막으로 동기화 완료된 시각
// 등록(학원) DB: 자동화 실패 시 에러 메시지를 남기는 공유 텍스트 필드. 다음 성공 시 자동으로 비워짐.
// "실시간 처리 상태" 수식이 이 값과 각 "처리중" 체크박스를 조합해서 화면에 표시한다 (2026-09-11).
export const PROP_LAST_ERROR = "마지막 오류"

// 삭제 캐스케이드(cascade-delete) 대상 4개 DB(수업/출석/학습기록/학습활동) 공통 속성.
// (2026-09-10 추가 → 같은 날 재검토 후 변경) 처음엔 "삭제 상태"를 별도 속성으로 분리했었지만,
// 삭제와 다른 동기화 작업(학습기록 생성/출제 등)이 동시에 겹치는 경우가 드물다는 판단에 따라
// (2026-09-11 마이그레이션) 이 4개 DB도 등록/클래스 DB와 같은 체크박스+"실시간 처리 상태" 수식 패턴으로 통일했다 (PROP_SYNC_STATUS는 삭제됨).
// 안에서 기존 처리중/완료/오류 옵션을 그대로 재사용한다.
// 체크박스 이름이 DB마다 "삭제체크"/"삭제 체크"로 제각각이던 것도 "삭제 체크"로 통일했다.
// 참고: 이 체크박스는 더 이상 cascade-delete 실행에 필수적인 게이트가 아니다 — "삭제" 버튼이
// 웹훅을 직접 호출하는 것 자체가 삭제 의도의 트리거이며, 체크박스는 캐스케이드되는 하위 항목들에
// 남기는 시각적 표시(감사 추적용)로만 쓰인다.
export const PROP_DELETE_CHECKBOX = "삭제 체크"
// cascade-delete가 삭제 진행 중인 페이지에 표시하는 체크박스 이름 (수업/출석/학습기록/학습활동 4개 DB 공통).
export const PROP_DELETING_RUNNING = "삭제 처리중"

// 시간표 DB: generate-classes(수업/출석 생성) 처리 상태 표시용 (2026-09-10 추가 →
// 2026-09-11 마이그레이션: 공유 select "생성 상태"에서 체크박스 + "실시간 처리 상태" 수식으로 전환).
export const PROP_TIMETABLE_GEN_RUNNING = "생성중"
export const PROP_TIMETABLE_LAST_ERROR = "마지막 오류"

// 참고: 아래 5개 "처리중" 체크박스는 서로 배타적이지 않고 동시에 여러 개가 true일 수 있다.
// "하나라도 처리중이면 전체 상태를 처리중으로" 보여주는 실제 계산은 등록(학원) DB의 "실시간 처리
// 상태" 노션 수식이 이 체크박스들을 직접 실시간으로 조합해서 담당한다.
// (2026-09-21 정리: 예전에는 각 함수가 setSyncStatus 호출 시 "자기 자신을 뺀 나머지" 목록을
// otherFlagProps라는 인자로 넘기게 돼 있었는데, setCombinedSyncStatus 구현이 이 값을 전혀 읽지
// 않는 완전한 죽은 인자였다. sync-registration-textbook만 그 목록에서 PROP_SYNC_ENROLL_RUNNING을
// 빠뜨리고 있었지만, 애초에 아무 데도 쓰이지 않으니 실제 동작에는 아무 영향이 없었다. 혼동을
// 줄이기 위해 otherFlagProps 인자 자체를 registrationSync.ts/generateShared.ts와 모든 호출부에서
// 제거했다 — 이제 이 목록은 아래 ALL_SYNC_RUNNING_FLAGS 참고용으로만 남아 있고, 코드 어디에서도
// 참조하지 않는다.)
export const ALL_SYNC_RUNNING_FLAGS = [
	PROP_SYNC_TIMETABLE_RUNNING,
	PROP_SYNC_TEXTBOOK_RUNNING,
	PROP_SYNC_CLASS_SESSION_RUNNING,
	PROP_SYNC_END_RUNNING,
	PROP_SYNC_ENROLL_RUNNING,
]

// ---------- 성적관리(시험범위/성적/시험/학생) ----------
// sync-exam-scope, sync-exam-score 두 함수가 공통으로 참조한다 (로드맵 4-5, 2026-09-16).
// 노션 수식이던 "응시학생 현황"·"시험일"(시험범위 DB), "백분률"(성적 DB)을 웹앱에서 계산해
// plain 속성에 기록하는 것으로 한때 바꿨었지만, "응시학생 현황"은 정확한 속성명을 쓰는 노션
// 수식으로 같은 날 다시 전환했다. "시험일" 자동 계산도 요청한 적 없는 기능이라 같은 날 삭제해
// "시험일"은 사용자가 직접 입력하는 수동 날짜 속성으로 남겨뒀다 — 이제 이 함수들은 "백분률"만
// 계산해 기록한다.
// 학생 DB의 레거시 "성적 생성" 체크박스·"시험범위(변수)" 관계형은 함께 제거했다
// (더 이상 어떤 자동화도 그 값을 읽지 않는다).
// "시험구분"(성적 DB)은 실사용 판단 결과 불필요해 제거함 (2026-09-16).
export const DS_EXAM_SCOPE = Deno.env.get("DATA_SOURCE_EXAM_SCOPE_ID")! // 시험범위(학원) DB
export const DS_GRADE = Deno.env.get("DATA_SOURCE_GRADE_ID")! // 성적(학원) DB
export const DS_STUDENT = Deno.env.get("DATA_SOURCE_STUDENT_ID")! // 학생(학원) DB

// 시험범위(학원) DB 속성
export const PROP_SCOPE_TITLE = "이름"
export const PROP_SCOPE_GRADE_LEVEL = "학년" // relation, limit 1
export const PROP_SCOPE_SCHOOL = "학교" // relation, limit 1 (비어있으면 학년 전체가 대상)
export const PROP_SCOPE_RUNNING = "처리중"
export const PROP_SCOPE_LAST_ERROR = "마지막 오류"
export const PROP_SCOPE_SYNCED_AT = "마지막 동기화"
// 참고: "시험일정"(관계) · "시험일"(날짜)은 더 이상 이 함수들이 계산/기록하지 않는 순수 노션
// 속성이라 여기 상수로 남겨두지 않는다 (2026-09-16, 시험일 자동 계산 삭제).

// 성적(학원) DB 속성
export const PROP_GRADE_TITLE = "이름"
export const PROP_GRADE_STUDENT = "학생" // relation, limit 1
export const PROP_GRADE_SCOPE = "시험범위" // relation, limit 1 → 시험범위 DB
export const PROP_GRADE_GRADE_LEVEL = "학년" // relation
export const PROP_GRADE_SCHOOL = "학교" // relation
export const PROP_GRADE_RANK = "등수" // number
export const PROP_GRADE_ATTENDEE_COUNT = "응시인원" // number
export const PROP_GRADE_PERCENTILE = "백분률" // number — 웹앱이 계산해 기록 (2026-09-16 수식→plain 전환)

// 학생(학원) DB 속성 (성적관리 조회 전용)
export const PROP_STUDENT_TITLE = "학생이름"
export const PROP_STUDENT_GRADE_LEVEL = "학년" // relation, limit 1
export const PROP_STUDENT_SCHOOL = "학교" // relation, limit 1
export const PROP_STUDENT_ENROLL_STATUS = "등록상태" // formula(text)
export const STUDENT_STATUS_ENROLLED = "🟢 등록 중"
