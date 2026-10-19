// Notion 구성 스캔 (읽기 전용)
//
// 쓰는 법: 대상 학원 Notion의 "공개 DB" 페이지를 브라우저에서 열고, 그 탭의 개발자 콘솔
// (또는 브라우저 도구의 JavaScript 실행)에 이 파일 전체를 붙여 넣는다. DB는 그 페이지
// 아래 DB, 관계로 이어진 DB, 그 페이지가 속한 DB(메뉴)를 모두 찾는다.
// 결과 JSON을 내려받는다(hada-scan.json).
// 그다음 `python -I scripts/notion-spec.py hada-scan.json <출력 폴더>`로 정리하고,
// 원본 명세와 `python -I scripts/notion-diff.py`로 비교한다.
//
// - Notion 화면이 쓰는 내부 읽기 API(syncRecordValuesMain)만 부른다. 아무것도 쓰지 않는다.
// - 웹훅 헤더는 이름만 남기고 값은 버린다. 서버 주소는 <HOST>로 바꾼다.
// - 환경마다 다른 ID(컬렉션·속성·스페이스)는 이름으로 바꾸고 버린다.
(async () => {
  const REQ = async (table, ids) => {
    const out = {};
    for (let i = 0; i < ids.length; i += 50) {
      const r = await fetch('/api/v3/syncRecordValuesMain', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requests: ids.slice(i, i + 50).map((id) => ({ pointer: { table, id }, version: -1 })) }),
      });
      Object.assign(out, (await r.json()).recordMap?.[table] || {});
    }
    const vals = {};
    for (const [id, x] of Object.entries(out)) { const v = x?.value?.value || x?.value; if (v) vals[id] = v; }
    return vals;
  };
  const text = (t) => (t || []).map((x) => x[0]).join('');
  const HOST = (s) => s.replace(/[A-Za-z0-9-]+\.supabase\.co/g, '<HOST>');

  // 1) 페이지 트리에서 데이터베이스 블록 찾기: 지금 페이지와 그 하위(공개 DB 페이지에서 실행 권장)
  const pageId = (location.pathname.match(/[0-9a-f]{32}/) || [])[0];
  const dashed = (h) => h.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  const collIds = new Set();
  const seen = new Set();
  let frontier = [dashed(pageId)];
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const blocks = await REQ('block', frontier.filter((b) => !seen.has(b)));
    frontier.forEach((b) => seen.add(b));
    const next = [];
    for (const b of Object.values(blocks)) {
      if (b.collection_id) collIds.add(b.collection_id);
      if (b.format?.collection_pointer?.id) collIds.add(b.format.collection_pointer.id);
      (b.content || []).forEach((c) => next.push(c));
    }
    frontier = next;
  }

  // 2) 컬렉션과 관계 대상까지
  let cols = await REQ('collection', [...collIds]);
  const relTargets = new Set();
  Object.values(cols).forEach((c) => Object.values(c.schema || {}).forEach((p) => {
    const t = p.collection_id || p.collection_pointer?.id; if (t && !cols[t]) relTargets.add(t);
  }));
  Object.assign(cols, await REQ('collection', [...relTargets]));
  // 관계로 이어진 DB(예: 다른 곳에 있는 수강료)와 시작 페이지가 속한 DB(메뉴)도 대상
  relTargets.forEach((t) => cols[t] && collIds.add(t));
  const root = (await REQ('block', [dashed(pageId)]))[dashed(pageId)];
  if (root?.parent_table === 'collection' && !cols[root.parent_id]) {
    Object.assign(cols, await REQ('collection', [root.parent_id]));
  }
  if (root?.parent_table === 'collection') collIds.add(root.parent_id);
  const cname = (id) => (cols[id] ? text(cols[id].name) : '(밖의 DB)');
  const pname = (cid, pid) => {
    const s = cols[cid]?.schema || {};
    if (pid === 'title') return Object.values(s).find((p) => p.type === 'title')?.name || 'title';
    return s[pid]?.name || null;
  };

  // 3) 자동화(버튼 포함)
  const autoIds = new Set();
  Object.values(cols).forEach((c) => {
    (c.format?.automation_ids || []).forEach((a) => autoIds.add(a));
    Object.values(c.schema || {}).forEach((p) => p.automation_id && autoIds.add(p.automation_id));
  });
  const autos = await REQ('automation', [...autoIds]);
  const actIds = []; Object.values(autos).forEach((a) => (a.action_ids || []).forEach((x) => actIds.push(x)));
  const acts = await REQ('automation_action', actIds);
  // 버튼·자동화가 페이지를 만드는 DB(관계로 이어지지 않은 결제 DB 등)도 대상에 넣는다
  const actTargets = new Set();
  Object.values(acts).forEach((ac) => {
    const t = ac.config?.collection?.id || ac.config?.target?.collection?.id;
    if (t && !cols[t]) actTargets.add(t);
  });
  if (actTargets.size) {
    Object.assign(cols, await REQ('collection', [...actTargets]));
    actTargets.forEach((t) => {
      if (!cols[t]) return;
      collIds.add(t);
      (cols[t].format?.automation_ids || []).forEach((a) => autoIds.add(a));
      Object.values(cols[t].schema || {}).forEach((p) => p.automation_id && autoIds.add(p.automation_id));
    });
    Object.assign(autos, await REQ('automation', [...autoIds].filter((a) => !autos[a])));
    const more = []; Object.values(autos).forEach((a) => (a.action_ids || []).forEach((x) => !acts[x] && more.push(x)));
    Object.assign(acts, await REQ('automation_action', more));
  }

  // 속성 id가 이 DB에 없으면(변수로 고른 다른 DB 페이지 편집) 모든 DB에서 하나뿐인 이름을 찾는다
  const anyPname = (pid) => {
    const names = new Set();
    Object.values(cols).forEach((c) => { const p = c.schema?.[pid]; if (p) names.add(p.name); });
    return names.size === 1 ? [...names][0] : null;
  };
  let varNames = {};
  const VAR = (raw) => {
    let d = raw; try { d = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { /* keep */ }
    if (d && d.variable_id) return '변수("' + (varNames[d.variable_id] || d.variable_id) + '")';
    if (d && d.global === 'button_page') return 'context("이 페이지")';
    if (d && d.global === 'trigger_page') return 'context("트리거 페이지")';
    if (d && d.global === 'now') return 'now()';
    if (d && d.global === 'me') return 'context("나")';
    return '{' + (typeof raw === 'string' ? raw : JSON.stringify(raw)) + '}';
  };
  const seg = (arr, cid) => (arr || []).map((s) => {
    if (!Array.isArray(s)) return JSON.stringify(s);
    const [t, a] = s;
    if (t === '‣' && a) {
      const [k, d = {}] = a[0];
      if (k === 'fpp') return 'prop("' + (d.name || pname(d.collection?.id || cid, d.property) || d.property) + '")';
      if (k === 'fv') return VAR(d.id);
      if (k === 'p') return '[페이지 지정]';
      return '{' + k + ':' + (d.name || '') + '}';
    }
    return t;
  }).join('');
  const isSeg = (v) => Array.isArray(v) && v.length && Array.isArray(v[0]) && typeof v[0][0] === 'string';
  const clean = (o, cid) => {
    const walk = (v, k) => {
      if (k === 'customHeaders' && Array.isArray(v)) return v.map((h) => h.key);
      if (typeof v === 'string') return HOST(v);
      if (isSeg(v)) return HOST(seg(v, cid));
      if (Array.isArray(v)) return v.map((x) => walk(x));
      if (v && typeof v === 'object') {
        if (v.table === 'collection' && v.id) return cname(v.id);
        const o2 = {};
        for (const [kk, vv] of Object.entries(v)) {
          if (kk === 'spaceId' || kk === 'space_id') continue;
          o2[kk] = walk(vv, kk);
        }
        return o2;
      }
      return v;
    };
    return walk(o);
  };
  const actionOf = (ac, cid) => {
    if (!ac) return { missing: true };
    const cfg = clean(ac.config || {}, cid);
    const targetCid = ac.config?.collection?.id || ac.config?.target?.collection?.id || cid;
    if (cfg.values) {
      const nv = {};
      for (const [pid, val] of Object.entries(cfg.values)) {
        const key = ac.type === 'define_variables'
          ? '변수 ' + (val?.name || pid)
          : (pname(targetCid, pid) || pname(cid, pid) || anyPname(pid) || pid);
        const v = val?.value?.value ?? val?.value;
        nv[key] = v === undefined ? '(비움)' : v;
      }
      cfg.values = nv;
    }
    delete cfg.variableIds;
    if (Array.isArray(cfg.properties)) cfg.properties = cfg.properties.map((p) => pname(targetCid, p) || anyPname(p) || p);
    if (typeof cfg.target === 'object' && cfg.target?.id) cfg.target = VAR(cfg.target.id);
    delete cfg.apiVersion;
    return { type: ac.type, cfg };
  };
  const autoOf = (id, cid) => {
    const a = autos[id]; if (!a) return { missing: true };
    varNames = {};
    (a.action_ids || []).forEach((x) => {
      const ac = acts[x];
      if (ac?.type === 'define_variables') {
        Object.entries(ac.config?.values || {}).forEach(([vid, v]) => { varNames[vid] = v?.name || vid; });
      }
    });
    const tr = a.trigger || {}; let trig = tr.type;
    if (tr.event) {
      const e = tr.event; const parts = [];
      if (e.pagesAdded) parts.push('페이지 추가');
      const pe = e.pagePropertiesEdited;
      if (pe) {
        const list = pe.all || pe.any || pe.some || [];
        const cond = (f) => {
          if (!f || f.operator === 'changes_to_any') return '바뀜';
          const v = f.value === undefined ? '' : ' ' + JSON.stringify(f.value.value ?? f.value);
          return f.operator + v;
        };
        const join = pe.type === 'all' ? ' 그리고 ' : ' 또는 ';
        parts.push('속성 편집: ' + list.map((x) => '`' + (pname(cid, x.property) || x.property) + '` ' + cond(x.filter)).join(join));
      }
      if (e.pagesRemoved) parts.push('페이지 삭제');
      trig = parts.join(' / ') || 'event';
    }
    return { name: a.properties?.name || '', status: a.status, trigger: trig,
      actions: (a.action_ids || []).map((x) => actionOf(acts[x], cid)) };
  };

  // 4) 보기: DB 블록의 view_ids
  const parents = Object.values(cols).map((c) => c.parent_id).filter(Boolean);
  const blocks = await REQ('block', parents);
  const viewIds = []; Object.values(blocks).forEach((b) => (b.view_ids || []).forEach((v) => viewIds.push(v)));
  const views = await REQ('collection_view', viewIds);

  // 5) 페이지 레이아웃: 헤더 고정 속성, 본문 모듈, 탭(연결 보기), 패널 섹션, 속성 표시 방식
  const REQP = async (ptrs, table) => {
    const out = {};
    for (let i = 0; i < ptrs.length; i += 50) {
      const r = await fetch('/api/v3/syncRecordValuesMain', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requests: ptrs.slice(i, i + 50).map((p) => ({ pointer: p, version: -1 })) }),
      });
      const m = (await r.json()).recordMap?.[table] || {};
      for (const [id, x] of Object.entries(m)) { const v = x?.value?.value || x?.value; if (v) out[id] = v; }
    }
    return out;
  };
  const layoutPtrs = Object.values(cols).map((c) => c.format?.layout_pointer).filter(Boolean);
  const layouts = await REQP(layoutPtrs, 'layout');
  const tabBlockPtrs = [];
  Object.values(layouts).forEach((L) => (L.modules?.page_layout_schema || []).forEach((m) => {
    if (m.collection_view_block_pointer) tabBlockPtrs.push(m.collection_view_block_pointer);
  }));
  const tabBlocks = await REQP(tabBlockPtrs, 'block');
  const tabViewIds = []; Object.values(tabBlocks).forEach((b) => (b.view_ids || []).forEach((v) => tabViewIds.push(v)));
  const tabViews = await REQ('collection_view', tabViewIds);
  const viewOf = (v, cid) => {
    const f = v.format || {};
    const vcid = f.collection_pointer?.id || cid;
    const pk = Object.keys(f).find((k) => /_properties$/.test(k) && Array.isArray(f[k]));
    const visible = pk ? f[pk].filter((x) => x.visible !== false).map((x) => pname(vcid, x.property)).filter(Boolean) : [];
    // 대시보드 보기의 필터는 위젯이 보여 주는 다른 DB의 속성을 가리킨다
    const vname = (val) => pname(vcid, val) || (v.type === 'dashboard' && anyPname(val)) || '(지운 속성)';
    const query = JSON.parse(JSON.stringify(v.query2 || {}, (k, val) => {
      if (k === 'property' && typeof val === 'string') return vname(val);
      if (k === 'id' || k === 'spaceId') return undefined;
      return val;
    }));
    const out = { name: v.name || '', type: v.type, db: cname(vcid), visible, query };
    // 보기 위 빠른 필터(칩)도 조건이다. query2와 따로 저장된다
    if ((f.property_filters || []).length) {
      out.quickFilters = JSON.parse(JSON.stringify(f.property_filters.map((x) => x.filter), (k, val) => {
        if (k === 'property' && typeof val === 'string') return vname(val);
        if (k === 'id') return undefined;
        return val;
      }));
    }
    if (f.board_columns_by || f.collection_group_by) out.groupBy = JSON.parse(JSON.stringify(f.collection_group_by || f.board_columns_by, (k, val) => (k === 'property' ? pname(vcid, val) : val)));
    if (v.format?.view_icon || v.icon) out.icon = v.format?.view_icon || v.icon;
    return out;
  };
  const layoutOf = (c, cid) => {
    const L = layouts[c.format?.layout_pointer?.id];
    const names = (ids) => (ids || []).map((p) => pname(cid, p)).filter(Boolean);
    const mod = (m) => {
      const o = { type: m.type };
      if (m.propertyIds) o.props = names(m.propertyIds);
      if (m.propertyId) o.prop = pname(cid, m.propertyId) || '(지운 속성)';
      if (m.config && Object.keys(m.config).length) o.config = m.config;
      if (m.collection_view_block_pointer) {
        const b = tabBlocks[m.collection_view_block_pointer.id];
        o.tabs = (b?.view_ids || []).map((vid) => tabViews[vid] ? viewOf(tabViews[vid], cid) : { missing: true });
        const tm = L.modules?.views_main_tab_modules || {};
        o.firstTabModules = Object.values(tm)[0]?.map((x) => mod(x)) || [];
      }
      return o;
    };
    const vis = {};
    (c.format?.property_visibility || []).forEach((x) => { const n = pname(cid, x.property); if (n) vis[n] = x.visibility; });
    return {
      main: (L?.modules?.page_layout_schema || []).map(mod),
      sidebar: (L?.modules?.page_info_layout_schema || []).map(mod),
      sections: (c.format?.property_groups || []).map((g) => ({ title: g.title || '', props: names(g.propertyIds) })),
      visibility: vis,
    };
  };

  const result = { scannedAt: new Date().toISOString(), dbs: {} };
  for (const [cid, c] of Object.entries(cols)) {
    if (!collIds.has(cid)) continue;
    const props = [];
    for (const [pid, p] of Object.entries(c.schema || {})) {
      const o = { name: p.name, type: p.type };
      if (p.type === 'formula') o.formula = p.formula2 ? seg(p.formula2.code, cid) : '(예전 형식)';
      if (p.options) o.options = p.options.map((x) => x.value);
      if (p.groups) o.statusGroups = true;
      if (p.type === 'relation') {
        const t = p.collection_id || p.collection_pointer?.id;
        o.target = cname(t);
        if (p.property) o.twoWay = pname(t, p.property) || p.property;
        if (p.limit) o.limit = p.limit;
      }
      if (p.type === 'rollup') {
        o.via = pname(cid, p.relation_property);
        const rel = c.schema[p.relation_property];
        const t = rel?.collection_id || rel?.collection_pointer?.id;
        o.of = pname(t, p.target_property) || p.target_property;
        o.agg = p.aggregation || null;
      }
      if (p.type === 'number' && p.number_format) o.format = p.number_format;
      if (p.automation_id) o.button = autoOf(p.automation_id, cid);
      props.push(o);
    }
    const blk = blocks[c.parent_id];
    const vs = (blk?.view_ids || []).map((vid) => (views[vid] ? viewOf(views[vid], cid) : { missing: true }));
    result.dbs[text(c.name)] = {
      props,
      automations: (c.format?.automation_ids || []).map((a) => autoOf(a, cid)),
      views: vs,
      layout: layoutOf(c, cid),
    };
  }
  window.__hadaScanResult = result;
  const blob = new Blob([JSON.stringify(result, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'hada-scan.json';
  document.body.appendChild(a); a.click(); a.remove();
  return 'DB ' + Object.keys(result.dbs).length + ', ' + blob.size + ' bytes';
})();
