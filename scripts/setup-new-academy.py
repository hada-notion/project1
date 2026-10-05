#!/usr/bin/env python3
"""
새 학원(고객)에게 이 저장소를 이식할 때, 저장소 안에 하드코딩된 이전 학원의
Supabase 프로젝트 정보를 이번 학원의 값으로 한 번에 치환하는 스크립트입니다.

무엇을 바꾸는지 (자동 치환 대상):
  1) supabase/migrations/*.sql  — pg_cron이 호출하는 Edge Function URL
  2) attendance_kiosk.html, legal_documents.html, student_report_part1.js,
     school_search.html
     — 정적 호스팅이라 서버 환경변수를 못 쓰는 프런트엔드 상수 SUPABASE_URL/SUPABASE_ANON_KEY
       (school_search.html은 school-api 엔드포인트 상수 ENDPOINT)
  3) README.md — 운영 웹앱 주소 안내문

무엇을 바꾸지 "않는지" (이 스크립트 범위 밖, 별도로 처리 필요):
  - GitHub Actions Secrets / Supabase Edge Function Secrets (docs/새-학원-이식-체크리스트.md 참고)
  - Notion 쪽의 "등록(학원) DB → 안내 링크" 수식에 박힌 GitHub Pages 주소
    (예: https://hada-notion.github.io/project1/student_report.html?token=...)
    이건 코드가 아니라 Notion 수식이라 이 학원의 Notion 워크스페이스에서 직접 고쳐야 합니다.

사용법:
  python3 scripts/setup-new-academy.py \
    --old-url https://twczhsxybkcvjkdfdxvs.supabase.co \
    --new-url https://<새 프로젝트 ref>.supabase.co \
    --old-anon-key <이전 anon key 전체 문자열> \
    --new-anon-key <새 anon key 전체 문자열> \
    --old-pages-path project1 \
    --new-pages-path <새 GitHub 저장소 이름>

이 저장소를 새로 clone한 뒤(첫 커밋/push 전에) 한 번 실행하세요. 실행 후 값이
잘 바뀌었는지 `git diff`로 확인하고 커밋하세요.
"""
import argparse
import pathlib
import sys

TARGET_FILES_URL_KEY = [
    "supabase/migrations/20260918190000_create_sync_queue.sql",
    "supabase/migrations/20260921020000_process_sync_queue_cron_auth.sql",
    "supabase/migrations/20260922150000_status_watchdog_cron.sql",
    "supabase/migrations/20260923010000_sync_queue_audited_at.sql",
    "supabase/migrations/20260924010000_backfill_assignment_deadlines_cron.sql",
    "supabase/migrations/20260926020000_status_watchdog_cron_15min.sql",
    "attendance_kiosk.html",
    "legal_documents.html",
    "student_report_part1.js",
    "school_search.html",
]

TARGET_FILES_PAGES_PATH = [
    "README.md",
]


def replace_in_file(path: pathlib.Path, replacements: list[tuple[str, str]]) -> int:
    if not path.exists():
        print(f"  (건너뜀: 파일 없음) {path}")
        return 0
    text = path.read_text(encoding="utf-8")
    total = 0
    for old, new in replacements:
        if not old:
            continue
        count = text.count(old)
        if count:
            text = text.replace(old, new)
            total += count
    if total:
        path.write_text(text, encoding="utf-8")
    print(f"  {path}: {total}건 치환")
    return total


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--old-url", default="https://twczhsxybkcvjkdfdxvs.supabase.co")
    parser.add_argument("--new-url", required=True, help="예: https://abcdefgh.supabase.co")
    parser.add_argument("--old-anon-key", default=(
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
        "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR3Y3poc3h5YmtjdmprZGZkeHZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyOTcwMDQsImV4cCI6MjEwMzg3MzAwNH0."
        "t7Ltb_iSYqE4gHSoGSm-OlpiLjGqIcgrhzGJ-t56EDc"
    ))
    parser.add_argument("--new-anon-key", required=True)
    parser.add_argument("--old-pages-path", default="project1")
    parser.add_argument("--new-pages-path", required=True, help="예: gangnam-academy (새 GitHub 저장소 이름)")
    parser.add_argument("--repo-root", default=".", help="저장소 루트 경로 (기본: 현재 디렉터리)")
    args = parser.parse_args()

    root = pathlib.Path(args.repo_root).resolve()
    print(f"저장소 루트: {root}")

    print("\n[1/2] Supabase URL / anon key 치환")
    url_replacements = [
        (args.old_url, args.new_url),
        (args.old_anon_key, args.new_anon_key),
    ]
    total = 0
    for rel in TARGET_FILES_URL_KEY:
        total += replace_in_file(root / rel, url_replacements)

    print("\n[2/2] GitHub Pages 경로 치환 (README 등 안내문)")
    path_replacements = [
        (f"github.io/{args.old_pages_path}/", f"github.io/{args.new_pages_path}/"),
        (f"({args.old_pages_path})", f"({args.new_pages_path})"),
    ]
    for rel in TARGET_FILES_PAGES_PATH:
        total += replace_in_file(root / rel, path_replacements)

    print(f"\n총 {total}건 치환 완료.")
    print("\n⚠️  이 스크립트가 다루지 않는 항목 (직접 처리 필요):")
    print("  - GitHub Actions Secrets / Supabase Edge Function Secrets 설정")
    print("    (docs/새-학원-이식-체크리스트.md 참고)")
    print("  - Notion '등록(학원) DB → 안내 링크' 수식의 GitHub Pages 주소")
    print("    (Notion 워크스페이스에서 직접 이 학원의 주소로 수정)")
    print("\ngit diff로 변경 내역을 확인한 뒤 커밋하세요.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
