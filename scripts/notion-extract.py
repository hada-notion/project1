#!/usr/bin/env python3
"""운영이 요청한 항목만 비공개 명세에서 뽑아 전달용 글로 만든다(원본 전용).

    python -I scripts/notion-extract.py <비공개 노션-명세.json> <요청 목록 파일>

요청 목록 파일: notion-diff.py가 찍은 "원본 요청 문구"를 그대로 붙여 넣은 텍스트.
`- DB / 종류 / 이름` 줄만 읽는다. 결과는 표준 출력으로 나오며, 확인한 뒤 그대로 보낸다.
"""
import importlib.util
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("notion_spec", HERE / "notion-spec.py")
notion_spec = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(notion_spec)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    all_items = notion_spec.items(spec)
    asked = []
    for line in Path(sys.argv[2]).read_text(encoding="utf-8").splitlines():
        m = re.match(r"^- (.+? / .+? / .+?)(?: \(원본 지문.*)?$", line.strip())
        if m:
            asked.append(m.group(1).strip())
    print("# 원본 기준 내용 전달\n")
    for k in asked:
        if k not in all_items:
            print(f"## {k}\n\n원본 명세에 없는 항목입니다.\n")
            continue
        h, body = all_items[k]
        print(f"## {k}\n\n- 원본 지문: {h}")
        if isinstance(body, dict) and body.get("formula"):
            print("- 넣는 곳: 이 DB의 수식 속성 → 수식 편집 → 전체를 아래로 바꾸기\n")
            print(notion_spec.md_block(body["formula"]))
        else:
            print("\n" + notion_spec.md_block(json.dumps(body, ensure_ascii=False, indent=1)))
        print("- 적용 후 notion-diff.py로 다시 비교해 이 항목이 \"같음\"인지 확인한다.\n")


if __name__ == "__main__":
    main()
