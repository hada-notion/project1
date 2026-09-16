// Supabase Edge Function: fix-attendance
//
// Triggered by the "출석 조정" button on a 수업(학원) DB page (via Notion's built-in
// "웹훅 보내기" automation action -- same wiring pattern as the "수업추가" button).
//
// Reconciles that class-session's attendance records against its timetable's registrations
// that were ACTIVE AS OF THIS CLASS SESSION'S OWN DATE (등록일 <= 수업일시 <= 종료일, or 종료일
// empty) -- NOT "현재 시각 기준 수강상태". Checking current-time status is wrong: e.g. a student who
// ended on 9/8 was still validly attending on 9/7, so 9/7's attendance must NOT be flagged
// "extra" just because "now" (9/9+) is past their end date. Matches the session-bound
// activeRegistrations definition in the "생성 오류" formula on 수업(학원) DB.
//
//   - Missing (registration is active but has no attendance page for this class session):
//       - If an attendance page already exists for that registration on the same calendar
//         day but isn't linked to any class session (수업 relation empty) -> LINK it here.
//       - Otherwise -> CREATE a new attendance page.
//   - Extra (attendance page exists but its registration is no longer actively enrolled)
//     or Duplicate (more than one attendance page for the same registration on this class
//     session, keep only the earliest) -> set "삭제" checkbox = true, so the existing
//     cascade-delete automation/function handles the actual deletion (including downstream
//     학습활동 records).

import {
	getPage,
	queryDataSource,
	queryAllPages,
	createPage,
	updatePageProperties,
	relIds,
} from "../_shared/notionClient.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"

// 수업(학원) DB의 "출석조정 처리중" 체크박스 + "마지막 오류" 텍스트 필드로 진행 상황을 표시한다
// (2026-09-11: 공유 select "동기화 상태"에서 체크박스로 마이그레이션됨). best-effort로 갱신하며 실패해도 무시한다.
const PROP_ATTENDANCE_FIX_RUNNING = "출석조정 처리중"
const PROP_SHARED_LAST_ERROR = "마지막 오류"

async function markAttendanceFixRunning(classSessionId: string): Promise<void> {
  try {
    // 새 실행이 시작되는 순간(버튼 클릭 직후) 이전 오류를 바로 지워서, 끝날 때까지 오래된 오류
    // 텍스트가 남아있지 않도록 합니다 (