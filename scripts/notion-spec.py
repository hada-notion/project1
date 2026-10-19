#!/usr/bin/env python3
"""원본 Notion 스캔(JSON)을 기준 명세로 정리한다.

입력: scripts/notion-scan.js 를 원본 Notion 브라우저 탭에서 실행해 받은 JSON
출력(출력 폴더):
- 노션-명세.json, 노션-명세.md: 전체 명세. 비공개(원본 Notion "Notion 기준 명세" 페이지에 올린다)
- 노션-지문.json: 항목별 지문만. 공개(docs/기준/노션-지문.json으로 커밋한다)

    python -I scripts/notion-spec.py <scan.json> <출력 폴더>

- 서버 주소는 <HOST>로, 웹훅 헤더는 이름만 남긴다(값은 스캔 단계에서 이미 뺐다).
- ID·시각 같은 환경별 값은 지운다. 학원마다 같아야 하는 모양만 남긴다.
"""
import json
import re
import sys
from pathlib import Path

HOST = re.compile(r"[A-Za-z0-9-]+\.supabase\.co")
# 학원 환경마다 다른 DB: 모양만 기준, 행 데이터는 학원별
CONFIG_DBS = {"웹페이지(학원) DB", "알림톡 설정(학원) DB", "자동화 로그(학원) DB"}
# 원본에만 있는 관리용 DB와 이름 없는 인라인 보기는 명세에서 뺀다
SKIP_DBS = {"", "패치·이슈 관리 DB"}


GLOBALS = {
    '{{"global":"today","source":"global"}}': "today()",
    '{{"global":"current_user","source":"global"}}': 'context("나")',
}


def mask(value):
    if isinstance(value, str):
        s = HOST.sub("<HOST>", value).replace("[{p:}]", "[페이지 지정]").replace("{p:}", "[페이지 지정]")
        for raw, nice in GLOBALS.items():
            s = s.replace(raw, nice)
        if s.endswith("속성 편집: "):
            s += "(속성 지정 없음)"
        return s
    if isinstance(value, list):
        return [mask(v) for v in value]
    if isinstance(value, dict):
        return {k: mask(v) for k, v in value.items()}
    return value


def norm_query(q):
    """보기 필터·정렬에서 내부 id를 빼고 비교 가능한 모양만 남긴다."""
    def strip(o):
        if isinstance(o, dict):
            return {k: strip(v) for k, v in o.items() if k not in ("id",)}
        if isinstance(o, list):
            return [strip(v) for v in o]
        return o
    return strip(q or {})


def norm_view(v):
    o = {"name": v.get("name", ""), "type": v.get("type"), "visible": v.get("visible", []),
         "query": norm_query(v.get("query"))}
    for k in ("db", "groupBy", "icon"):
        if v.get(k):
            o[k] = v[k]
    return o


def norm_layout(L):
    if not L:
        return None

    def mod(m):
        # 지운 속성을 가리키는 모듈은 Notion 안에만 남은 흔적이라 화면에 보이지 않는다
        if m.get("prop") == "(지운 속성)":
            return None
        o = {"type": m.get("type")}
        for k in ("props", "prop", "config"):
            if m.get(k):
                o[k] = m[k]
        if "tabs" in m:
            o["tabs"] = [norm_view(t) for t in m["tabs"] if not t.get("missing")]
            o["firstTabModules"] = [x for x in (mod(x) for x in m.get("firstTabModules") or []) if x]
        return o
    return {
        "main": [x for x in (mod(m) for m in L.get("main") or []) if x],
        "sidebar": [x for x in (mod(m) for m in L.get("sidebar") or []) if x],
        "sections": L.get("sections") or [],
        "visibility": dict(sorted((L.get("visibility") or {}).items())),
    }


def norm_action(a):
    cfg = dict(a.get("cfg") or {})
    cfg.pop("apiVersion", None)
    if cfg.get("template_page_id"):  # 템플릿 페이지 id는 학원마다 다르다
        cfg["template_page_id"] = "(템플릿 지정)"
    return {"type": a.get("type"), "cfg": cfg}


def norm_auto(a):
    if not a or a.get("missing"):
        return {"missing": True}
    return {
        "name": a.get("name"),
        "status": a.get("status"),
        "trigger": a.get("trigger"),
        "actions": [norm_action(x) for x in a.get("actions") or []],
    }


def build(scan):
    spec = {}
    for name, db in sorted(scan["dbs"].items()):
        if name in SKIP_DBS:
            continue
        props = []
        for p in sorted(db["props"], key=lambda x: x["name"]):
            o = {"name": p["name"], "type": p["type"]}
            for k in ("formula", "options", "target", "twoWay", "limit", "via", "of", "agg", "format"):
                if k in p:
                    o[k] = p[k]
            if p.get("statusGroups"):
                o["statusGroups"] = True
            if p.get("button"):
                o["button"] = norm_auto(p["button"])
            props.append(o)
        spec[name] = {
            "config": name in CONFIG_DBS,
            "props": props,
            "automations": sorted((norm_auto(a) for a in db.get("automations") or []),
                                  key=lambda a: a.get("name") or ""),
            "views": [norm_view(v) for v in db.get("views") or []],
            "layout": norm_layout(db.get("layout")),
        }
    return mask(spec)


def _squash(o):
    """비교용: 문자열의 공백 차이를 지우고, 같은 필터가 두 번 들어간 것은 하나로 본다."""
    if isinstance(o, str):
        return re.sub(r"\s+", "", o)
    if isinstance(o, list):
        items = [_squash(v) for v in o]
        out, seen = [], set()
        for v in items:
            key = json.dumps(v, sort_keys=True, ensure_ascii=False)
            if isinstance(v, dict) and "filter" in v and "property" in v:
                if key in seen:
                    continue
                seen.add(key)
            out.append(v)
        return out
    if isinstance(o, dict):
        return {k: _squash(v) for k, v in o.items()}
    return o


def _hash(o):
    import hashlib
    raw = json.dumps(_squash(o), sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def items(spec):
    """비교 단위. 키는 사람이 읽을 수 있게 `DB / 종류 / 이름`, 값은 (지문, 내용)."""
    out = {}
    for db, d in spec.items():
        out[f"{db} / DB"] = (_hash({"config": d["config"]}), {"config": d["config"]})
        for p in d["props"]:
            body = {k: v for k, v in p.items() if k not in ("name", "button")}
            kind = "수식" if p["type"] == "formula" else "속성"
            out[f"{db} / {kind} / {p['name']}"] = (_hash(body), body)
            if p.get("button"):
                b = {k: v for k, v in p["button"].items() if k != "name"}
                out[f"{db} / 버튼 / {p['name']}"] = (_hash(b), b)
        for a in d["automations"]:
            out[f"{db} / 자동화 / {a.get('name')}"] = (_hash(a), a)
        for v in d["views"]:
            out[f"{db} / DB 보기 / {v.get('name') or '(이름 없음)'}"] = (_hash(v), v)
        L = d.get("layout")
        if L:
            for m in L["main"]:
                if m["type"] == "titleWithIcon":
                    out[f"{db} / 레이아웃 / 헤더"] = (_hash(m.get("props", [])), m.get("props", []))
                if m["type"] == "viewsMain":
                    out[f"{db} / 레이아웃 / 첫 탭"] = (_hash(m.get("firstTabModules", [])), m.get("firstTabModules", []))
                    for t in m.get("tabs", []):
                        out[f"{db} / 탭 / {t.get('name') or '(이름 없음)'}"] = (_hash(t), t)
            body = [m for m in L["main"] if m["type"] in ("property",)]
            out[f"{db} / 레이아웃 / 본문 속성"] = (_hash(body), body)
            panel = {"sidebar": L["sidebar"], "sections": L["sections"], "visibility": L["visibility"]}
            out[f"{db} / 레이아웃 / 패널"] = (_hash(panel), panel)
    return out


def fingerprint(spec, scanned_at):
    return {
        "설명": "원본 Notion 기준의 항목별 지문. 내용은 비공개 명세에 있다. "
                "scripts/notion-diff.py로 운영 스캔과 비교한다.",
        "스캔": scanned_at,
        "항목": {k: h for k, (h, _) in sorted(items(spec).items())},
    }


def md_block(text):
    fence = "````" if "```" in text else "```"
    return f"{fence}\n{text}\n{fence}"


def trigger_text(t):
    return t if isinstance(t, str) else json.dumps(t, ensure_ascii=False)


def value_text(v):
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    if "\n" in s or len(s) > 90:
        body = "\n".join("    " + line for line in md_block(s).split("\n"))
        return "\n\n" + body + "\n"
    return f" `{s}`"


def action_text(a):
    t, cfg = a.get("type"), a.get("cfg") or {}
    if a.get("missing"):
        return "(동작을 읽지 못함)"
    if t == "http_request":
        hs = cfg.get("customHeaders") or []
        return f"웹훅 보내기 `{cfg.get('url')}`" + (f" (헤더: {', '.join(hs)})" if hs else "")
    vals = cfg.get("values") or {}
    if t == "create_page":
        target = cfg.get("collection") or (cfg.get("target") or {}).get("collection")
        head = f"페이지 추가: {target}"
    elif t in ("update_pages", "update_page"):
        head = f"페이지 편집: {cfg.get('target')}"
    elif t == "define_variables":
        head = "변수 정하기"
    else:
        rest = {k: v for k, v in cfg.items() if k != "values"}
        head = f"{t}: `{json.dumps(rest, ensure_ascii=False)}`"
    lines = [head]
    for k, v in vals.items():
        lines.append(f"  - `{k}` ←{value_text(v)}")
    return "\n".join(lines)


def render_md(spec, scanned_at):
    out = [
        "# Notion 기준 명세 (원본 스캔에서 생성)",
        "",
        "> 이 파일은 `scripts/notion-spec.py`가 원본 스캔으로 만든다. 손으로 고치지 않는다. "
        "원본을 바꾼 뒤 다시 스캔해 생성하고, 바뀐 줄을 커밋에서 확인한다. "
        "적용 순서는 [적용 절차](적용-절차.md), 이름·레이아웃 원칙은 [이름 규칙](../이름-규칙.md).",
        "",
        f"- 스캔 시각: {scanned_at}",
        "- 서버 주소는 `<HOST>`, 웹훅 헤더는 이름만 적는다.",
        "",
        "## 목차",
        "",
    ]
    for name in spec:
        out.append(f"- {name}")
    for name, db in spec.items():
        out += ["", f"## {name}", ""]
        if db["config"]:
            out += ["(학원 설정 DB: 속성 모양만 기준, 행은 학원별)", ""]
        out += ["### 속성", "", "| 이름 | 종류 | 설정 |", "| --- | --- | --- |"]
        formulas, buttons = [], []
        for p in db["props"]:
            bits = []
            if p.get("options"):
                bits.append("선택지: " + ", ".join(map(str, p["options"])))
            if p.get("target"):
                bits.append(f"관계 → {p['target']}" + (f" (양방향 `{p['twoWay']}`)" if p.get("twoWay") else "")
                            + (" (1개)" if p.get("limit") == 1 else ""))
            if p["type"] == "rollup":
                bits.append(f"`{p.get('via')}`의 `{p.get('of')}` ({p.get('agg') or '원래 값'})")
            if p.get("format"):
                bits.append(f"형식 {p['format']}")
            if p["type"] == "formula":
                formulas.append(p)
                bits.append("수식 아래")
            if p.get("button"):
                buttons.append(p)
                bits.append("동작 아래")
            cell = "; ".join(bits).replace("|", "\\|")
            out.append(f"| `{p['name']}` | {p['type']} | {cell} |")
        if formulas:
            out += ["", "### 수식", ""]
            for p in formulas:
                out += [f"#### `{p['name']}`", "", md_block(p["formula"]), ""]
        if buttons:
            out += ["### 버튼", ""]
            for p in buttons:
                b = p["button"]
                out.append(f"#### [{p['name']}]")
                out.append("")
                for a in b.get("actions") or []:
                    out.append("- " + action_text(a))
                out.append("")
        if db["automations"]:
            out += ["### 자동화", ""]
            for a in db["automations"]:
                state = "" if a.get("status") == "active" else f" ({a.get('status')})"
                out.append(f"#### {a.get('name')}{state}")
                out.append("")
                out.append(f"- 트리거: {trigger_text(a.get('trigger'))}")
                for x in a.get("actions") or []:
                    out.append("- " + action_text(x))
                out.append("")
        if db["views"]:
            out += ["### DB 보기", "", "| 이름 | 종류 | 보이는 속성 | 필터·정렬 |", "| --- | --- | --- | --- |"]
            for v in db["views"]:
                out.append(view_row(v))
        if db.get("layout"):
            out += render_layout(db["layout"])
    return "\n".join(out) + "\n"


VIS = {"show": "항상 표시", "hide_if_empty": "비어 있으면 숨김", "hide": "항상 숨김"}


def cell(s):
    return str(s).replace("|", "\\|").replace("\n", " ")


def query_text(q):
    if not q:
        return ""
    parts = []
    if q.get("filter"):
        parts.append("필터 `" + json.dumps(q["filter"], ensure_ascii=False) + "`")
    if q.get("sort"):
        parts.append("정렬 " + ", ".join(f"{s.get('property')} {s.get('direction')}" for s in q["sort"]))
    return cell("; ".join(parts))


def view_row(v, with_db=False):
    vis = cell("·".join(v.get("visible") or []))
    name = v.get("name") or "(이름 없음)"
    extra = f" · 그룹 `{json.dumps(v['groupBy'], ensure_ascii=False)}`" if v.get("groupBy") else ""
    db = f" | {v.get('db', '')}" if with_db else ""
    return f"| `{cell(name)}` | {v.get('type')}{db} | {vis} | {query_text(v.get('query'))}{cell(extra)} |"


def render_layout(L):
    out = ["", "### 페이지 레이아웃", ""]
    vis = L.get("visibility") or {}
    for m in L.get("main") or []:
        t = m.get("type")
        if t == "titleWithIcon":
            out.append("- 헤더: " + " · ".join(f"`{p}`" for p in m.get("props") or []))
        elif t == "property":
            style = (m.get("config") or {})
            out.append(f"- 본문 속성: `{m.get('prop')}`" + (f" {json.dumps(style, ensure_ascii=False)}" if style else ""))
        elif t == "viewsMain":
            first = m.get("firstTabModules") or []
            out.append("- 첫 탭 내용: " + ", ".join(
                (f"`{x['prop']}`" if x.get("prop") else x.get("type")) for x in first))
            out += ["", "| 탭 | 종류 | DB | 보이는 속성 | 필터·정렬 |", "| --- | --- | --- | --- | --- |"]
            for tab in m.get("tabs") or []:
                out.append(view_row(tab, with_db=True))
            out.append("")
        elif t not in ("cover",):
            out.append(f"- 본문: {t}")
    shown = set()
    for m in (L.get("main") or []) + (L.get("sidebar") or []):
        for x in [m] + (m.get("firstTabModules") or []):
            shown.update(x.get("props") or [])
            if x.get("prop"):
                shown.add(x["prop"])
    vis = {p: v for p, v in vis.items() if p not in shown}
    side = L.get("sidebar") or []
    if side:
        out.append("- 세부 정보 패널:")
        for m in side:
            if m.get("type") == "property":
                out.append(f"  - 속성 모듈 `{m.get('prop')}`")
            elif m.get("type") == "properties":
                secs = L.get("sections") or []
                if secs:
                    for s in secs:
                        items = ", ".join(f"`{p}` {VIS.get(vis.get(p), '기본')}" for p in s["props"] if p not in shown)
                        out.append(f"  - 섹션 `{s['title'] or '(이름 없음)'}`: {items}")
                else:
                    items = ", ".join(f"`{p}` {VIS.get(v, v)}" for p, v in vis.items())
                    out.append(f"  - 속성 묶음: {items}")
            else:
                out.append(f"  - {m.get('type')}")
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if len(sys.argv) != 3:
        sys.exit("사용: python -I scripts/notion-spec.py <scan.json> <출력 폴더(.local 아래 권장)>")
    scan_path = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    if out_dir.resolve().is_relative_to(Path("docs").resolve()):
        sys.exit("전체 명세는 공개 폴더(docs)에 만들지 않는다. .local 아래로 출력하고 지문만 복사한다.")
    scan = json.loads(scan_path.read_text(encoding="utf-8"))
    spec = build(scan)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "노션-명세.json").write_text(
        json.dumps(spec, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (out_dir / "노션-명세.md").write_text(render_md(spec, scan.get("scannedAt", "")), encoding="utf-8")
    fp = fingerprint(spec, scan.get("scannedAt", ""))
    (out_dir / "노션-지문.json").write_text(
        json.dumps(fp, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(spec)} DB, 항목 {len(fp['항목'])}개 → {out_dir}")


if __name__ == "__main__":
    main()
