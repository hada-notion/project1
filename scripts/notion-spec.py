#!/usr/bin/env python3
"""원본 Notion 스캔(JSON)을 기준 명세로 정리한다.

입력: scripts/notion-scan.js 를 원본 Notion 브라우저 탭에서 실행해 받은 JSON
출력(출력 폴더):
- 노션-명세.json, 노션-명세.md: 전체 명세. 비공개(원본 Notion "Notion 기준 명세" 페이지에 올린다)
- 노션-지문.json: 항목별 지문만. 공개(docs/기준/노션-지문.json으로 커밋한다)
- 노션-레이아웃.md: DB별 페이지 레이아웃(수식·버튼 동작 없음). 공개(docs/기준/노션-레이아웃.md로 커밋한다)

    python -I scripts/notion-spec.py <scan.json> <출력 폴더>

- 서버 주소는 <HOST>로, 웹훅 헤더는 이름만 남긴다(값은 스캔 단계에서 이미 뺐다).
- ID·시각 같은 환경별 값은 지운다. 학원마다 같아야 하는 모양만 남긴다.
"""
import json
import re
import sys
from pathlib import Path

HOST = re.compile(r"[A-Za-z0-9-]+\.supabase\.co")
# 학원마다 다른 GitHub Pages 주소(학교 검색·학생 페이지 링크 수식)
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
PAGES = re.compile(r"https?://[A-Za-z0-9-]+\.github\.io/[A-Za-z0-9._-]+")
# 학원 환경마다 다른 DB: 모양만 기준, 행 데이터는 학원별
CONFIG_DBS = {"웹페이지(학원) DB", "알림톡 설정(학원) DB", "자동화 로그(학원) DB"}
# 원본에만 있는 관리용 DB와 이름 없는 인라인 보기는 명세에서 뺀다
SKIP_DBS = {"", "업데이트(학원) DB", "패치·이슈 관리 DB"}  # 원본 작업 기록 DB(옛 이름도 뺀다)


GLOBALS = {
    '{{"global":"today","source":"global"}}': "today()",
    '{{"global":"current_user","source":"global"}}': 'context("나")',
}


def mask(value):
    if isinstance(value, str):
        s = PAGES.sub("<PAGES>", HOST.sub("<HOST>", value)).replace("[{p:}]", "[페이지 지정]").replace("{p:}", "[페이지 지정]")
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
    # 대시보드의 빠른 필터는 공통 필터(globalFilters)와 같은 것이라 공통 필터로만 본다
    if v.get("quickFilters") and v.get("type") != "dashboard":
        o["quickFilters"] = norm_query(v["quickFilters"])
    if v.get("chart"):
        o["chart"] = norm_query(v["chart"])
    # 대시보드 공통 필터: 원본 밖(옛 복사본) DB를 가리키는 대상은 위젯에 쓰이지 않는 흔적이라 뺀다
    gfs = []
    for g in v.get("globalFilters") or []:
        targets = [t for t in g.get("targets") or [] if t.get("db") != "(밖의 DB)"]
        if targets:
            gfs.append({**g, "targets": targets})
    if gfs:
        o["globalFilters"] = norm_query(gfs)
    if v.get("widgets"):
        o["widgets"] = [[norm_view(w) for w in row if not w.get("missing")] for row in v["widgets"]]
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
    main = [x for x in (mod(m) for m in L.get("main") or []) if x]
    sidebar = [x for x in (mod(m) for m in L.get("sidebar") or []) if x]
    # 헤더·패널 위 고정·첫 탭(본문)에 놓인 속성은 패널 묶음에 나오지 않고 표시 방식도 적용되지 않는다.
    # 그 속성의 표시 방식·섹션 소속은 Notion 안에만 남은 값이라 비교에서 뺀다
    placed = set()
    for m in main + sidebar:
        for x in [m] + (m.get("firstTabModules") or []):
            placed.update(x.get("props") or [])
            if x.get("prop"):
                placed.add(x["prop"])
    sections = [{**s, "props": [p for p in s.get("props") or [] if p not in placed]}
                for s in L.get("sections") or []]
    return {
        "main": main,
        "sidebar": sidebar,
        "sections": sections,
        "visibility": dict(sorted((k, v) for k, v in (L.get("visibility") or {}).items() if k not in placed)),
    }


def norm_action(a):
    cfg = dict(a.get("cfg") or {})
    cfg.pop("apiVersion", None)
    if cfg.get("template_page_id"):  # 템플릿 페이지 id는 학원마다 다르다
        cfg["template_page_id"] = "(템플릿 지정)"
    # 관계 값 [context("이 페이지")]와 context("이 페이지")는 같은 뜻이라 대괄호를 뗀다
    if isinstance(cfg.get("values"), dict):
        cfg["values"] = {k: (re.sub(r'^(\((?:add|append|remove)\) )?\[(context\("[^"]+"\))\]$', r"\1\2", v)
                             if isinstance(v, str) else v) for k, v in cfg["values"].items()}
    # 버튼이 여는 페이지 같은 페이지 id도 학원마다 다르다
    cfg = json.loads(UUID.sub("(페이지 지정)", json.dumps(cfg, ensure_ascii=False)))
    # 버튼이 실제로 쓰는 속성은 properties 목록이다. 목록 밖 값은 지운 속성의 흔적이라 화면에도 안 보인다
    if isinstance(cfg.get("properties"), list) and isinstance(cfg.get("values"), dict):
        keep = set(cfg["properties"]) | {"title"}
        cfg["values"] = {k: v for k, v in cfg["values"].items() if k in keep or k == "이름"}
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
            # 버튼 동작은 버튼 속성으로 본다. DB 자동화 목록의 트리거 "button" 항목은
            # 예전 버튼의 흔적일 수 있어(원본에 남아 있음) 기준에서 뺀다
            "automations": sorted((norm_auto(a) for a in db.get("automations") or []
                                   if (a or {}).get("trigger") != "button"),
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


def quick_text(v):
    q = v.get("quickFilters")
    return cell("; 빠른 필터 `" + json.dumps(q, ensure_ascii=False) + "`") if q else ""


def view_row(v, with_db=False):
    vis = cell("·".join(v.get("visible") or []))
    name = v.get("name") or "(이름 없음)"
    extra = f" · 그룹 `{json.dumps(v['groupBy'], ensure_ascii=False)}`" if v.get("groupBy") else ""
    db = f" | {v.get('db', '')}" if with_db else ""
    return f"| `{cell(name)}` | {v.get('type')}{db} | {vis} | {query_text(v.get('query'))}{quick_text(v)}{cell(extra)} |"


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


MODULE = {"editor": "본문(페이지 내용)", "discussions": "댓글", "properties": "속성 묶음",
          "relationsGroup": "관계 묶음"}
VIEW = {"page": "페이지", "table": "표", "board": "보드", "calendar": "캘린더", "gallery": "갤러리",
        "list": "리스트", "timeline": "타임라인", "dashboard": "대시보드", "chart": "차트"}
OP = {"relation_contains": "포함", "enum_is": "=", "enum_is_not": "≠", "enum_contains": "포함",
      "checkbox_is": "=", "date_is_within": "기간", "date_is": "=", "string_is": "=",
      "string_contains": "포함", "is_empty": "비어 있음", "is_not_empty": "비어 있지 않음",
      "status_is": "=", "status_is_not": "≠", "number_equals": "=", "date_is_on_or_after": "이후",
      "date_is_on_or_before": "이전"}


def cond_text(f):
    """보기 필터를 사람이 읽는 문장으로 바꾼다(같은 조건이 겹치면 한 번만)."""
    if not f:
        return ""
    if "filters" in f:
        parts = []
        for x in f["filters"]:
            t = cond_text(x)
            if t and t not in parts:
                parts.append(t)
        join = " 그리고 " if f.get("operator", "and") == "and" else " 또는 "
        s = join.join(parts)
        return f"({s})" if len(parts) > 1 and f.get("operator") == "or" else s
    prop, flt = f.get("property"), f.get("filter") or {}
    if flt.get("subfilter"):
        flt = flt["subfilter"]
    op, val = flt.get("operator"), flt.get("value")
    if isinstance(val, dict) and val.get("type") == "relative" and val.get("unit"):
        unit = {"day": "일", "week": "주", "month": "개월", "year": "년"}.get(val["unit"], val["unit"])
        side = {"past": "지난", "future": "다음"}.get(val.get("direction"), val.get("direction") or "")
        return f"`{prop}` {side} {val.get('count')}{unit}"
    if isinstance(val, dict) and val.get("type") == "relative":
        inner = val.get("value")
        v = "이 페이지" if isinstance(inner, dict) and inner.get("type") == "current_page_in_related_collection" \
            else json.dumps(inner, ensure_ascii=False)
    elif isinstance(val, list):
        v = " 또는 ".join(str(x.get("value") if isinstance(x, dict) else x) for x in val)
    elif isinstance(val, dict) and "value" in val:
        v = val["value"]
        v = json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v
    else:
        v = "" if val is None else json.dumps(val, ensure_ascii=False)
    if op == "relation_contains":
        return f"`{prop}`에 {v} 포함"
    return f"`{prop}` {OP.get(op, op)} {v}".strip()


def tab_cond(t):
    q = t.get("query") or {}
    bits = []
    if q.get("filter"):
        bits.append(cond_text(q["filter"]))
    for f in t.get("quickFilters") or []:
        bits.append(cond_text(f) + " (빠른 필터)")
    if q.get("sort"):
        bits.append("정렬 " + ", ".join(
            f"`{s.get('property')}` {'↑' if s.get('direction') == 'ascending' else '↓'}" for s in q["sort"]))
    return cell(" · ".join(b for b in bits if b))


CHART = {"line": "선", "bar": "세로 막대", "horizontal_bar": "가로 막대", "donut": "도넛", "number": "숫자"}
AGG = {"average": "평균", "sum": "합계", "count": "개수", "count_values": "값 개수", "min": "최소", "max": "최대",
       "median": "중앙값", "percent_per_group": "그룹별 비율"}
UNIT = {"day": "일별", "week": "주별", "month": "월별", "year": "연별", "relative": "상대 날짜"}


def chart_text(c):
    """차트 설정을 한 줄로: 종류 · X축(속성, 날짜 단위) · Y축(집계) · 그룹."""
    d = c.get("dataConfig") or {}
    bits = [CHART.get(c.get("type"), c.get("type") or "")]
    g = d.get("groupBy") or {}
    if g.get("property"):
        # 날짜 묶음은 바로 있거나(날짜 속성) 한 단계 안에 있다(수식 속성)
        inner = g if g.get("type") == "date" else (g.get("groupBy") if isinstance(g.get("groupBy"), dict) else {})
        unit = UNIT.get(inner.get("groupBy"), inner.get("groupBy")) if inner.get("type") == "date" else ""
        bits.append(f"X `{g['property']}`" + (f" {unit}" if unit else ""))
    agg = (d.get("aggregationConfig") or {}).get("aggregation") or {}
    if agg:
        bits.append(f"Y {AGG.get(agg.get('aggregator'), agg.get('aggregator'))}"
                    + (f" `{agg['property']}`" if agg.get("property") and agg.get("property") != "title" else ""))
    stack = ((d.get("aggregationConfig") or {}).get("stackOptions") or {}).get("groupBy") or {}
    if stack.get("property"):
        bits.append(f"그룹 `{stack['property']}`")
    return " · ".join(b for b in bits if b)


def render_layouts(spec, scanned_at):
    """공개용 DB별 페이지 레이아웃. 수식·버튼 동작은 넣지 않는다."""
    out = [
        "# Notion 페이지 레이아웃 (DB별)",
        "",
        "> `scripts/notion-spec.py`가 원본 스캔으로 만든다. 손으로 고치지 않는다. "
        "원본 레이아웃을 바꾸면 다시 스캔해 생성하고 지문과 함께 커밋한다. "
        "레이아웃 원칙은 [이름 규칙](../이름-규칙.md) 7장, 적용 순서는 [적용 절차](적용-절차.md).",
        "",
        f"- 원본 스캔: {scanned_at}",
        "- 각 DB는 세 부분으로 적는다. **1. 상단**(제목 아래 고정 속성), **2. 콘텐츠 탭**(첫 탭에 놓는 속성·블록과 "
        "나머지 탭), **3. 세부 정보 보기**(오른쪽 패널, 섹션별).",
        "- 표시 방식: 보임 = 항상 표시, 빈 값 숨김 = 비어 있으면 숨김, 숨김 = 항상 숨김(패널 맨 아래 '숨김'에 모임).",
        "- 상단·콘텐츠 탭·패널 위에 고정한 속성은 패널 섹션에 다시 나오지 않는다.",
        "- 바꾸는 곳: 상단·패널·첫 탭 내용은 커넥터(`page_layout`)로, 탭(연결 보기)과 탭 필터는 화면 "
        "\"레이아웃 사용자 지정\"에서 바꾼다.",
        "",
        "## 목차",
        "",
    ]
    names = [n for n, d in spec.items() if d.get("layout") and d["layout"]["main"]]
    out += [f"- [{n}](#{n.lower().replace(' ', '-').replace('(', '').replace(')', '')})" for n in names]
    short = {"show": "보임", "hide_if_empty": "빈 값 숨김", "hide": "숨김"}
    for name in names:
        L = spec[name]["layout"]
        vis = L.get("visibility") or {}
        allp = [p["name"] for p in spec[name]["props"] if p["type"] != "title"]
        out += ["", f"## {name}", ""]
        header = next((m.get("props") or [] for m in L["main"] if m["type"] == "titleWithIcon"), [])
        out += ["### 1. 상단", "", (" · ".join(f"`{p}`" for p in header) if header else "(고정 속성 없음)"), ""]
        shown = set(header)
        tabs_mod = next((m for m in L["main"] if m["type"] == "viewsMain"), None)
        body = [m for m in L["main"] if m["type"] not in ("cover", "titleWithIcon", "viewsMain")]
        out += ["### 2. 콘텐츠 탭", ""]
        if tabs_mod:
            tabs = tabs_mod.get("tabs") or []
            first = tabs[0]["name"] if tabs else ""
            out.append(f"첫 탭 `{first}`에 놓는 것(위에서부터):")
            out.append("")
            mods = tabs_mod.get("firstTabModules") or []
        else:
            out.append("탭 없음. 본문에 놓는 것(위에서부터):")
            out.append("")
            mods = body
        for i, m in enumerate(mods, 1):
            if m.get("prop"):
                shown.add(m["prop"])
                style = (m.get("config") or {}).get("property_formula", {}).get("style")
                out.append(f"{i}. `{m['prop']}`" + (" (작게)" if style == "small" else ""))
            else:
                out.append(f"{i}. {MODULE.get(m['type'], m['type'])}")
        if tabs_mod and len(tabs_mod.get("tabs") or []) > 1:
            out += ["", "| 탭 | 보기 | DB | 보이는 속성 | 조건 |", "| --- | --- | --- | --- | --- |"]
            for t in tabs_mod["tabs"][1:]:
                out.append(f"| `{cell(t.get('name') or '(이름 없음)')}` | {VIEW.get(t.get('type'), t.get('type'))} | "
                           f"{t.get('db', '')} | {cell(' · '.join(t.get('visible') or []))} | {tab_cond(t)} |")
            for t in tabs_mod["tabs"][1:]:
                if t.get("type") != "dashboard":
                    continue
                out += ["", f"대시보드 탭 `{t.get('name')}`:", ""]
                for gf in t.get("globalFilters") or []:
                    tg = ", ".join(f"{x['db']} `{x['property']}`" for x in gf.get("targets") or [])
                    out.append(f"- 공통 필터: 이 페이지 포함 → {tg}")
                for i, row in enumerate(t.get("widgets") or [], 1):
                    for w in row:
                        cond = tab_cond(w)
                        out.append(f"- {i}줄 `{w.get('name')}` ({w.get('db')}): "
                                   + (chart_text(w["chart"]) if w.get("chart") else VIEW.get(w.get("type"), w.get("type")))
                                   + (f" · {cond}" if cond else ""))
        out += ["", "### 3. 세부 정보 보기", ""]
        side = L.get("sidebar") or []
        pinned = [m["prop"] for m in side if m.get("type") == "property" and m.get("prop")]
        if pinned:
            out.append("- 패널 위 고정: " + " · ".join(f"`{p}`" for p in pinned))
            shown.update(pinned)
        hidden = []
        secs = L.get("sections") or []
        if any(m.get("type") == "properties" for m in side):
            for s in secs:
                items, seen_here = [], False
                for p in s["props"]:
                    if p in shown:
                        continue
                    seen_here = True
                    v = vis.get(p)
                    if v == "hide":
                        hidden.append(p)
                    else:
                        items.append(f"`{p}`" + (f" ({short[v]})" if v in ("hide_if_empty",) else ""))
                if seen_here:
                    out.append(f"- 섹션 `{s['title'] or '(이름 없음)'}`: " + (", ".join(items) if items else "(보이는 속성 없음)"))
            in_sec = {p for s in secs for p in s["props"]}
            rest = [p for p in allp if p not in shown and p not in in_sec]
            items = [f"`{p}`" + (" (빈 값 숨김)" if vis.get(p) == "hide_if_empty" else "")
                     for p in rest if vis.get(p) != "hide"]
            hidden += [p for p in rest if vis.get(p) == "hide"]
            if items:
                out.append(("- 섹션 밖: " if secs else "- 속성(섹션 없음): ") + ", ".join(items))
        elif not side:
            out.append("(패널 사용 안 함)")
        for m in side:
            if m.get("type") not in ("property", "properties"):
                out.append(f"- {MODULE.get(m['type'], m['type'])}")
        if hidden:
            out.append(f"- 숨김 {len(hidden)}개: " + ", ".join(f"`{p}`" for p in hidden))
    return "\n".join(out) + "\n"


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
    (out_dir / "노션-레이아웃.md").write_text(
        render_layouts(spec, scan.get("scannedAt", "")), encoding="utf-8")
    fp = fingerprint(spec, scan.get("scannedAt", ""))
    (out_dir / "노션-지문.json").write_text(
        json.dumps(fp, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(spec)} DB, 항목 {len(fp['항목'])}개 → {out_dir}")


if __name__ == "__main__":
    main()
