#!/usr/bin/env python3
"""새 학원 Notion에서 원본 예시 데이터를 비운다(배포 담당자·운영 AI 전용).

원본 템플릿을 새 학원 워크스페이스에 복제한 직후, 키·웹훅을 넣기 전에 한 번 실행한다.
"비울 DB" 목록(CLEAR_DBS)에 이름이 있는 DB의 페이지만 휴지통으로 보낸다. 목록에 없는 DB
(메뉴·웹페이지·알림톡 설정·과목·학년·교시·라이브러리·단원목록, 매뉴얼 페이지)는 건드리지 않는다.
휴지통으로 보내므로 Notion 휴지통에서 되살릴 수 있다.

- 그 학원 Notion 통합(integration) 토큰을 환경변수 NOTION_TOKEN에 넣고 실행한다.
  토큰은 인자로 넘기거나 출력하지 않는다. 통합에는 복제한 페이지 전체를 공유해 둔다.
- 기본은 확인만 한다(DB별 지울 건수 출력, 아무것도 지우지 않음).
- 실제로 지우려면 --apply와 --confirm-workspace "<워크스페이스 이름>"을 함께 준다.
  이름이 이 토큰의 워크스페이스 이름과 정확히 같아야 한다(원본에서 잘못 돌리는 일을 막음).
- 원본 워크스페이스 이름을 환경변수 HADA_SOURCE_WORKSPACE에 넣어 두면 그 워크스페이스에서는
  --apply를 거부한다(원본 지원 PC용 안전장치, 값은 커밋하지 않는다).

사용법:
  python -I scripts/clear-example-data.py
  python -I scripts/clear-example-data.py --apply --confirm-workspace "OO학원"
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = "https://api.notion.com/v1"
VERSION = "2025-09-03"

# 비울 DB. 하위 데이터부터 지운다(앞에 있는 DB부터). 이름은 Notion DB 제목 그대로.
CLEAR_DBS = [
    "학습활동(학원) DB",
    "학습기록(학원) DB",
    "출석(학원) DB",
    "수업(학원) DB",
    "대시보드(학원) DB",
    "진도교재(학원) DB",
    "보고서(학원) DB",
    "결제(학원) DB",
    "수강료(학원) DB",
    "교재결제(학원) DB",
    "교재배부(학원) DB",
    "교재비(학원) DB",
    "알림톡 발송함(학원) DB",
    "가정통신문(학원) DB",
    "자동화 로그(학원) DB",
    "성적(학원) DB",
    "시험정보(학원) DB",
    "시험(학원) DB",
    "일정(학원) DB",
    "시간표(학원) DB",
    "등록(학원) DB",
    "클래스(학원) DB",
    "학생(학원) DB",
    "학교(학원) DB",
    "근무(학원) DB",
    "강사(학원) DB",
    "자료(학원) DB",
    "업데이트(학원) DB",
    "패치·이슈 관리 DB",  # 업데이트(학원) DB의 옛 이름
]

# 남기는 DB(참고용). 이 목록과 CLEAR_DBS에 모두 없는 DB가 보이면 알려 준다.
KEEP_DBS = [
    "메뉴(학원) DB",
    "웹페이지(학원) DB",
    "알림톡 설정(학원) DB",
    "과목(학원) DB",
    "학년(학원) DB",
    "교시(학원) DB",
    "라이브러리(학원) DB",
    "단원목록(학원) DB",
]


def request(method, path, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API + path,
        data=data,
        method=method,
        headers={"Authorization": "Bearer " + token, "Notion-Version": VERSION, "Content-Type": "application/json"},
    )
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.load(res)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 5:
                wait = float(e.headers.get("Retry-After") or 0) or 1.5 * (attempt + 1)
                time.sleep(min(wait, 30))
                continue
            detail = e.read().decode("utf-8", "replace")[:300]
            raise SystemExit(f"Notion API {method} {path.split('?')[0]} 실패: {e.code} {detail}")
        except urllib.error.URLError as e:
            if attempt < 5:
                time.sleep(2)
                continue
            raise SystemExit(f"Notion API 연결 실패: {e.reason}")
    raise SystemExit("Notion API 재시도 한도 초과")


def title_of(obj):
    return "".join(t.get("plain_text", "") for t in obj.get("title") or []).strip()


def data_sources(token):
    found, cursor = [], None
    while True:
        body = {"filter": {"property": "object", "value": "data_source"}, "page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        data = request("POST", "/search", token, body)
        for r in data.get("results", []):
            if r.get("in_trash") or r.get("archived"):
                continue
            found.append((title_of(r), r["id"]))
        if not data.get("has_more"):
            return found
        cursor = data.get("next_cursor")


def page_ids(token, ds_id):
    ids, cursor = [], None
    while True:
        body = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        data = request("POST", f"/data_sources/{ds_id}/query", token, body)
        ids += [r["id"] for r in data.get("results", []) if not r.get("in_trash") and not r.get("archived")]
        if not data.get("has_more"):
            return ids
        cursor = data.get("next_cursor")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # Windows 콘솔에서 한글 출력
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="실제로 휴지통으로 보낸다(없으면 확인만)")
    parser.add_argument("--confirm-workspace", default="", help="--apply 때 필수: 이 토큰의 워크스페이스 이름")
    args = parser.parse_args()

    token = os.environ.get("NOTION_TOKEN", "")
    if not token:
        raise SystemExit("환경변수 NOTION_TOKEN이 없습니다(그 학원 Notion 통합 토큰).")

    me = request("GET", "/users/me", token)
    workspace = (me.get("bot") or {}).get("workspace_name") or ""
    print(f"워크스페이스: {workspace or '(이름 없음)'}")

    if args.apply:
        if not workspace or args.confirm_workspace != workspace:
            raise SystemExit("--confirm-workspace가 이 토큰의 워크스페이스 이름과 다릅니다. 지우지 않았습니다.")
        source = os.environ.get("HADA_SOURCE_WORKSPACE", "").strip()
        if source and source == workspace:
            raise SystemExit("원본 워크스페이스입니다. 지우지 않았습니다.")

    by_name = {}
    for name, ds_id in data_sources(token):
        by_name.setdefault(name, []).append(ds_id)

    unknown = sorted(n for n in by_name if n not in CLEAR_DBS and n not in KEEP_DBS)
    missing = [n for n in CLEAR_DBS[:-1] if n not in by_name]  # 옛 이름은 없어도 된다

    plan, total = [], 0
    print("\n[비울 DB]")
    for name in CLEAR_DBS:
        for ds_id in by_name.get(name, []):
            ids = page_ids(token, ds_id)
            plan.append((name, ds_id, ids))
            total += len(ids)
            print(f"  {name}: {len(ids)}건")
    print(f"  합계: {total}건")
    print("\n[남기는 DB] " + ", ".join(n for n in KEEP_DBS if n in by_name))
    if missing:
        print("\n[찾지 못한 비울 DB] " + ", ".join(missing) + "  (통합에 공유됐는지 확인)")
    if unknown:
        print("\n[목록에 없는 DB, 건드리지 않음] " + ", ".join(unknown))

    if not args.apply:
        print("\n확인만 했습니다. 실제로 비우려면 --apply --confirm-workspace \"<워크스페이스 이름>\"을 붙여 다시 실행하세요.")
        return

    print("\n휴지통으로 보내는 중...")
    done = 0
    for name, ds_id, ids in plan:
        for pid in ids:
            request("PATCH", f"/pages/{pid}", token, {"in_trash": True})
            done += 1
            if done % 50 == 0:
                print(f"  {done}/{total}")
            time.sleep(0.35)  # Notion API 평균 초당 3회 한도
        print(f"  {name}: {len(ids)}건 완료")

    print("\n[다시 세기]")
    left = 0
    for name, ds_id, _ in plan:
        n = len(page_ids(token, ds_id))
        left += n
        print(f"  {name}: {n}건 남음")
    print("완료: 남은 건수 0" if left == 0 else f"남은 건수 {left}건. 다시 실행하면 남은 것만 지웁니다.")
    if left:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
