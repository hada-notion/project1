#!/usr/bin/env python3
"""운영 Notion 스캔을 원본 기준과 비교한다.

    python -I scripts/notion-diff.py <운영 scan.json> [기준]

기준은 둘 중 하나다.
- 공개 지문: docs/기준/노션-지문.json (기본값). 무엇이 다른지만 알 수 있다.
- 비공개 명세: 원본 "Notion 기준 명세" 페이지의 노션-명세.json. 원본 지원 때 쓴다.

결과 분류
- 같음: 지문이 같다
- 다름: 같은 이름의 항목이 원본과 다르다
- 없음: 원본에 있는데 운영에 없다
- 이름 다름: 운영의 다른 이름 항목이 원본 항목과 내용이 같다(예전 이름일 수 있음)
- 추가: 운영에만 있다(학원 고유일 수 있으니 지우지 않는다)

"다름"·"없음" 항목이 공개된 패치 문서(docs/updates)에 나오면 그 문서로 고치고,
나오지 않으면 아래에 찍히는 요청 문구를 원본에 보낸다.
"""
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("notion_spec", HERE / "notion-spec.py")
notion_spec = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(notion_spec)


def load_reference(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if "항목" in data:  # 공개 지문
        return data["항목"], data.get("스캔", "")
    return {k: h for k, (h, _) in notion_spec.items(data).items()}, "(비공개 명세)"


def published_items(repo):
    """공개 패치 문서에 이름이 나오는 항목인지 대략 판단하기 위한 본문."""
    text = []
    for f in sorted((repo / "docs" / "updates").glob("*.md")):
        text.append(f.read_text(encoding="utf-8"))
    return "\n".join(text)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    repo = HERE.parent
    ref_path = sys.argv[2] if len(sys.argv) > 2 else repo / "docs" / "기준" / "노션-지문.json"
    ref, ref_when = load_reference(ref_path)
    scan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    mine = {k: h for k, (h, _) in notion_spec.items(notion_spec.build(scan)).items()}

    same, diff, missing, extra = [], [], [], []
    for k, h in ref.items():
        if k not in mine:
            missing.append(k)
        elif mine[k] == h:
            same.append(k)
        else:
            diff.append(k)
    extra = [k for k in mine if k not in ref]

    # 내용은 같고 이름만 다른 쌍(같은 DB, 같은 종류)
    renamed = []
    by_hash = {}
    for k in extra:
        db, kind = k.split(" / ")[:2]
        by_hash.setdefault((db, kind, mine[k]), []).append(k)
    for k in list(missing):
        db, kind = k.split(" / ")[:2]
        hit = by_hash.get((db, kind, ref[k]))
        if hit:
            # 같은 내용이 여럿이면 한 번씩만 짝짓는다(이미 짝지은 것은 목록에서 뺀다)
            other = hit.pop(0)
            renamed.append((k, other))
            missing.remove(k)
            extra.remove(other)

    pub = published_items(repo)

    def in_patch(k):
        name = k.split(" / ")[-1]
        return name in pub

    print(f"기준: {ref_when}  운영 스캔: {scan.get('scannedAt', '')}")
    print(f"같음 {len(same)} · 다름 {len(diff)} · 없음 {len(missing)} · 이름 다름 {len(renamed)} · 추가 {len(extra)}")
    for title, rows in (("다름", diff), ("없음", missing)):
        if rows:
            print(f"\n## {title}")
            for k in rows:
                print(f"- {k}" + ("  (공개 패치 문서에 이름이 나옴)" if in_patch(k) else ""))
    if renamed:
        print("\n## 이름 다름 (운영 이름 → 원본 이름)")
        for k, old in renamed:
            print(f"- {old.split(' / ')[-1]} → {k}")
    if extra:
        print("\n## 추가 (운영에만 있음, 지우지 않음)")
        for k in extra:
            print(f"- {k}")

    ask = [k for k in diff + missing if not in_patch(k)]
    if ask:
        print("\n## 원본 요청 문구 (공개 패치에 없는 항목)")
        print("아래 항목의 원본 기준 내용을 요청합니다.")
        print(f"- 기준 지문: {ref_when}")
        print(f"- 운영 스캔: {scan.get('scannedAt', '')}")
        for k in ask:
            print(f"- {k} (원본 지문 {ref[k]}, 운영 지문 {mine.get(k, '없음')})")


if __name__ == "__main__":
    main()
