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

// 등록(학원) DB / 클래스(학원) DB — timetable, textbook 두 함수가 모두 조회한다.
export const DS_REGISTRATION = "16dba040-586b-838a-ae3c-876c0e9cd474" // 등록(학원) DB
export const DS_CLASS = "67cba040-586b-835b-b02f-8708589c7cf1" // 클래스(학원) DB

export const PROP_CLASS = "클래스" // 등록 DB의 클래스 relation (limit 1)
export const PROP_ENROLL_DATE = "등록일" // 등록 DB
export const PROP_END_DATE = "종료일" // 등록 DB
export const PROP_TITLE = "이름" // 등록(학원) DB
export const PROP_STATUS = "수강상태" // 등록(학원) DB (수식)
export const PROP_TIMETABLE = "시간표" // 등록(학원) DB
export const STATUS_ENDED = "🔴 수강 종료"

// 등록 관련 자동화(수업 생성/종료 처리/복원)가 공통으로 조회하는 데이터소스.
// class-session, end, timetable 세 함수가 각자 같은 리터럴을 들고 있던 것을 하나로 모음 (로드맵 리팩토링).
export const DS_ATTENDANCE = "8aaba040-586b-8322-8437-87608a763415" // 출석(학원) DB
export const DS_CLASS_SESSION = "3b1ba040-586b-80ec-af20-000b31bb69b7" // 수업(학원) DB
export const DS_LEARNING_RECORD = "d97ba040-586b-8310-b710-8782e29b5c73" // 학습기록(학원) DB

// 출석(학원) DB 속성
export const PROP_ATTENDANCE_TITLE = "출석"
export const PROP_ATTENDANCE_REGISTRATION = "등록"
export const PROP_ATTENDANCE_CLASS_DATETIME = "수업일시"
export const PROP_ATTENDANCE_SESSION = "수업"
export const PROP_ATTENDANCE_ACTIVITY = "학습활동"
export const PROP_ATTENDANCE_LEARNING_RECORD = "학습기록"

// 수업(학원) DB 속성
export const PROP_SESSION_REGISTRATION = "등록" // roster (여러 학생)
export const PROP_SESSION_DATETIME = "수업일시"
export const PROP_SESSION_TIMETABLE = "시간표"
// generate-classes가 이 수업 행에 딸린 출석들을 만드는 동안 true로 표시 (2026-09-11 추가).
// 수업 행 자체는 이미 완성된 상태로 한 번에 생성되며, 출석 생성이 끝나면 자동으로 해제된다.
// "실시간 처리 상태" 수식이 이 값과 PROP_LAST_ERROR(마지막 오류)를 조합해서 화면에 표시한다.
export const PROP_SESSION_GEN_RUNNING = "생성중"

// 학습기록(학원) DB 속성
export const PROP_RECORD_SESSION = "수업"
export const PROP_RECORD_REGISTRATION = "등록"

// 종료된(또는 등록일이 삭제된) 등록의 미사용 개별 진도교재를 정리하는 내부 라우트.
// class-session/end/timetable 세 함수가 모두 이 URL로 fetch한다.
export const TEXTBOOK_CLEANUP_URL =
	"https://twczhsxybkcvjkdfdxvs.supabase.co/functions/v1/sync-registration-textbook/cleanup-on-end"

// 클래스.수업방식(그룹/개별 진도)은 삭제됨 — 이제 진도교재(학원) DB의 "진도방식" select로
// 반별교재(템플릿) 단위로 표현한다 (sync-registration-textbook에서 직접 문자열로 참조).

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
// 각 함수는 자기 자신을 뺀 나머지를 setSyncStatus의 otherFlagProps로 넘겨서 "하나라도 처리중이면
// 전체 상태를 처리중으로" 판단한다. (참고: 기존 sync-registration-textbook 코드는 이 중
// PROP_SYNC_ENROLL_RUNNING을 otherFlagProps에서 빠뜨리고 있었음 - 리팩토링 시 동작을 바꾸지 않기
// 위해 그 누락은 그대로 보존했다. 별도로 고칠지는 따로 판단 필요.)
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
// 수식으로 같은 날 다시 전환했다 — 이제 이 함수들은 "시험일"·"백분률"만 계산해 기록한다.
// 학생 DB의 레거시 "성적 생성" 체크박스·"시험범위(변수)" 관계형은 함께 제거했다
// (더 이상 어떤 자동화도 그 값을 읽지 않는다).
// "시험구분"(성적 DB)은 실사용 판단 결과 불필요해 제거함 (2026-09-16).
export const DS_EXAM_SCOPE = "3bdba040-586b-807a-91bd-000b5b4f2d98" // 시험범위(학원) DB
export const DS_GRADE = "3bdba040-586b-8006-9f62-000b39d855cc" // 성적(학원) DB
export const DS_STUDENT = "bdeba040-586b-827d-8ef6-871aff52cce9" // 학생(학원) DB

// 시험범위(학원) DB 속성
export const PROP_SCOPE_TITLE = "이름"
export const PROP_SCOPE_GRADE_LEVEL = "학년" // relation, limit 1
export const PROP_SCOPE_SCHOOL = "학교" // relation, limit 1 (비어있으면 학년 전체가 대상)
export const PROP_SCOPE_EXAM_SCHEDULE = "시험일정" // relation → 학원일정 DB
export const PROP_SCOPE_EXAM_DATE = "시험일" // date — 웹앱이 계산해 기록 (2026-09-16 수식→plain 전환)
export const PROP_SCOPE_RUNNING = "처리중"
export const PROP_SCOPE_LAST_ERROR = "마지막 오류"
export const PROP_SCOPE_SYNCED_AT = "마지막 동기화"
export const PROP_EXAM_SCHEDULE_DATE = "날짜" // 학원일정(학원) DB의 날짜 속성

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
