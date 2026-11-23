'use strict';

PDL_COMPONENTS['plugin:official.rsi/rsiLineage'] = function (p, sc, root) {
  const rows = pvList(p.from, sc, root), keyOf = function (r) { return pv(p.key, r, root); }, parentOf = function (r) { return pv(p.parent, r, root); };
  const keys = rows.map(keyOf), kids = {}, roots = [];
  rows.forEach(function (r) { const pk = parentOf(r); if (pk != null && keys.indexOf(pk) >= 0) (kids[pk] = kids[pk] || []).push(r); else roots.push(r); });
  const n = p.node || {}, keepRecent = Number(p.keepRecent) > 0 ? Number(p.keepRecent) : 5;
  const flat = [];
  (function collect(list) {
    list.forEach(function (r) { flat.push(r); collect(kids[keyOf(r)] || []); });
  })(roots);
  const pinned = {};
  if (flat.length > keepRecent) {
    flat.slice(-keepRecent).forEach(function (r) { pinned[keyOf(r)] = true; });
    flat.forEach(function (r) {
      const k = keyOf(r), pk = parentOf(r), st = pv(n.state, r, root);
      if (r.selected || r.nodeSelected || (n.pressed && pv(n.pressed, r, root)) || st === 'current' || st === 'running' || st === 'preparing') pinned[k] = true;
      if ((kids[k] || []).length > 1) pinned[k] = true;
      if (pk != null && (kids[pk] || []).length > 1) pinned[k] = true;
    });
  }
  const labelTextOf = function (r) {
    if (r && r.id != null) return String(r.id);
    const raw = pvParts(n.label, r, root);
    return String(raw || keyOf(r) || '').replace(/<[^>]*>/g, '').trim();
  };
  const aspectMeta = { object: { cls: 'rsi-asp-obj', key: 'object' }, observability: { cls: 'rsi-asp-obs', key: 'observability' }, rubric: { cls: 'rsi-asp-rub', key: 'rubric' } };
  const renderAspectDots = function (r) {
    if (!r || !Array.isArray(r.aspects) || !r.aspects.length) return '';
    return '<span class="rsi-asp-dots">' + r.aspects.map(function (a) {
      const m = aspectMeta[a];
      return m ? '<i class="rsi-asp-dot ' + m.cls + '" data-aspect="' + m.key + '"></i>' : '';
    }).join('') + '</span>';
  };
  const renderNodeRow = function (r, depth, lines, insideBox) {
    const state = pv(n.state, r, root) || (r && r.pruned ? 'pruned' : '');
    const node = chipHtml({ cls: 'rsi-lin-v', label: pvParts(n.label, r, root), tone: pv(n.tone, r, root), pressed: n.pressed ? !!pv(n.pressed, r, root) : null,
      act: n.act, data: n.act ? pvArgs(n.args, r, root) : '', attrs: state ? ' data-state="' + h(state) + '"' : '' });
    const dots = renderAspectDots(r);
    const tail = p.tail ? pvParts(p.tail, r, root) : '';
    const cellList = [];
    (Array.isArray(p.cells) ? p.cells : p.cells ? [p.cells] : []).forEach(function (c) {
      if (c && c.type === 'each') {
        pvList(c.from, r, root).forEach(function (item) {
          const outHtml = pvControl(c.control, item, root);
          if (outHtml) cellList.push(outHtml);
        });
      } else if (c) {
        const outHtml = pvControl(c, r, root);
        if (outHtml) cellList.push(outHtml);
      }
    });
    const arr = '<svg class="rsi-lin-arr" viewBox="0 0 14 10" aria-hidden="true"><path d="M1 5h10.5M8 1.8L11.8 5 8 8.2"/></svg>';
    const chain = [node + dots].concat(cellList).join(arr);
    return '<div class="rsi-lin-row' + (insideBox ? ' rsi-lin-row-in' : '') + '" style="--d:' + depth + '">' + lines + chain + (tail ? '<span class="rsi-lin-tail">' + tail + '</span>' : '') + '</div>';
  };
  const out = [];
  // Invariant:
  // - isBranch=true:  rails.length === depth - 1 (ancestor rails at 1..depth-1; own elbow at depth)
  // - isBranch=false: rails.length === depth     (ancestor rails at 1..depth; linear up/down at depth+1)
  (function walk(list, depth, rails, isBranch, hasParent) {
    list.forEach(function (r, i) {
      const last = i === list.length - 1, key = keyOf(r);
      const nextRails = isBranch ? rails.concat([!last]) : rails;
      if (flat.length > keepRecent && !pinned[key]) {
        const chain = [r];
        let cur = r;
        while (true) {
          const ch = kids[keyOf(cur)] || [];
          if (ch.length !== 1 || pinned[keyOf(ch[0])]) break;
          cur = ch[0];
          chain.push(cur);
        }
        if (chain.length >= 2) {
          const foldKey = 'rsi-lin-grp:' + keyOf(chain[0]) + '..' + keyOf(chain[chain.length - 1]);
          const isOpen = typeof S !== 'undefined' && S.folds && !!S.folds[foldKey];
          const tailKids = kids[keyOf(cur)] || [];
          out.push({ group: chain, foldKey: foldKey, open: isOpen, depth: depth, last: last, rails: rails, isBranch: isBranch, hasParent: hasParent, down: tailKids.length > 0 });
          if (tailKids.length === 1) walk(tailKids, depth, nextRails, false, true);
          else if (tailKids.length > 1) walk(tailKids, depth + 1, nextRails, true, true);
          return;
        }
      }
      const own = kids[key] || [];
      out.push({ r: r, depth: depth, last: last, rails: rails, isBranch: isBranch, hasParent: hasParent, down: own.length > 0 });
      if (own.length === 1) walk(own, depth, nextRails, false, true);
      else if (own.length > 1) walk(own, depth + 1, nextRails, true, true);
    });
  })(roots, 0, [], false, false);
  const railHtml = function (rails) {
    return rails.map(function (on, l) { return on ? '<span class="rsi-lin-rail" style="--l:' + (l + 1) + '"></span>' : ''; }).join('');
  };
  return '<div class="scroll stick-end rsi-lin-box"><div class="scroll-x"><div class="rsi-lin">' + out.map(function (x) {
    if (x.group) {
      const first = labelTextOf(x.group[0]), end = labelTextOf(x.group[x.group.length - 1]);
      const span = first === end ? first : first + '~' + end;
      const chip = '<button type="button" class="chip rsi-lin-v rsi-lin-grp" data-act="fold" data-f="result" data-k="' + h(x.foldKey) + '" aria-expanded="' + (x.open ? 'true' : 'false') + '">' + h(x.open ? '− ' + span : '[' + span + ']') + '</button>';
      const meta = '<span class="rsi-lin-tail">' + h(x.open ? '收起 ' + x.group.length + ' 项' : x.group.length + ' 项 · 展开') + '</span>';
      const inner = x.open ? '<div class="rsi-lin-grp-body">' + x.group.map(function (gr, gi) {
        const innerLines = (gi > 0 ? '<span class="rsi-lin-up" style="--l:1"></span>' : '') + (gi < x.group.length - 1 ? '<span class="rsi-lin-down" style="--l:1"></span>' : '');
        return renderNodeRow(gr, 0, innerLines, true);
      }).join('') + '</div>' : '';
      const outerLines = railHtml(x.rails) +
        (x.isBranch ? '<span class="rsi-lin-elbow' + (x.last ? ' last' : '') + '" style="--l:' + x.depth + '"></span>' : (x.hasParent ? '<span class="rsi-lin-box-in" style="--l:' + (x.depth + 1) + '"></span>' : '')) +
        (x.down ? '<span class="rsi-lin-box-out" style="--l:' + (x.depth + 1) + '"></span>' : '');
      return '<div class="rsi-lin-grp-wrap' + (x.open ? ' is-open' : '') + '" style="--d:' + x.depth + '">' + outerLines +
        '<div class="rsi-lin-grp-box"><div class="rsi-lin-grp-head">' + chip + meta + '</div>' + inner + '</div></div>';
    }
    const lines = railHtml(x.rails) +
      (x.isBranch ? '<span class="rsi-lin-elbow' + (x.last ? ' last' : '') + '" style="--l:' + x.depth + '"></span>' : (x.hasParent ? '<span class="rsi-lin-up" style="--l:' + (x.depth + 1) + '"></span>' : '')) +
      (x.down ? '<span class="rsi-lin-down" style="--l:' + (x.depth + 1) + '"></span>' : '');
    return renderNodeRow(x.r, x.depth, lines, false);
  }).join('') + '</div></div></div>';
};

PDL_COMPONENTS['plugin:official.rsi/rsiTrend'] = function (p, sc, root) {
  const series = p.series ? pv(p.series, sc, root) : null;
  const xs = series && Array.isArray(series.points) ? series.points : pvList(p.from, sc, root);
  if (!xs.length) return '';
  const threshold = series && typeof series.threshold === 'number' && Number.isFinite(series.threshold) ? series.threshold : null;
  const dir = series && series.dir ? series.dir : 'up';
  const unit = series && series.unit ? String(series.unit) : '';
  const vs = xs.map(function (x) { return x.value; }).concat(threshold != null ? [threshold] : []);
  const lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs);
  const span = hi === lo ? 1 : (hi - lo);
  const padX = 56, padTop = 26, padBot = 28, H = 136;
  const W = Math.max(360, padX * 2 + Math.max(1, xs.length - 1) * 82);
  const svgStyle = xs.length <= 5 ? 'width:100%' : 'width:' + W + 'px;min-width:100%';
  const yOf = function (v) { return H - padBot - (hi === lo ? 0.5 : (v - lo) / span) * (H - padTop - padBot); };
  const pts = xs.map(function (x, i) {
    const cx = xs.length === 1 ? W / 2 : padX + i * (W - 2 * padX) / (xs.length - 1);
    return [cx, yOf(x.value)];
  });
  const grid = [0, 0.5, 1].map(function (t) {
    const gy = padTop + t * (H - padTop - padBot);
    return '<line class="rsi-trend-grid" x1="' + (padX - 10) + '" y1="' + gy + '" x2="' + (W - padX + 10) + '" y2="' + gy + '"/>';
  }).join('');
  const thLine = threshold != null ? (function () {
    const ty = yOf(threshold);
    const label = '护栏 ' + (dir === 'up' ? '≥' : '≤') + ' ' + threshold + (unit ? ' ' + unit : '');
    return '<line class="rsi-trend-th" x1="' + (padX - 10) + '" y1="' + ty + '" x2="' + (W - padX + 10) + '" y2="' + ty + '"/>' +
      '<text class="rsi-trend-th-lbl" x="' + (W - padX + 8) + '" y="' + (ty - 4) + '" text-anchor="end">' + h(label) + '</text>';
  })() : '';
  const line = pts.length > 1 ? '<polyline points="' + pts.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join(' ') + '"/>' : '';
  const dots = xs.map(function (x, i) {
    const q = pts[i], moved = i > 0 && xs[i - 1].version !== x.version, isCur = !!x.current;
    const axisLabel = x.label || (x.version + '-' + x.n);
    const cls = [moved ? 'moved' : '', isCur ? 'current' : ''].filter(Boolean).join(' ');
    return '<circle cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="' + (isCur ? '5' : '4') + '"' + (cls ? ' class="' + cls + '"' : '') + '/>' +
      '<text class="val' + (isCur ? ' current' : '') + '" x="' + q[0].toFixed(1) + '" y="' + (q[1] - 10).toFixed(1) + '">' + h(String(x.value)) + '</text>' +
      '<text class="axis' + (isCur ? ' current' : '') + '" x="' + q[0].toFixed(1) + '" y="' + (H - 8) + '">' + h(axisLabel) + '</text>';
  }).join('');
  const aria = series && series.name ? series.name : pvText(p.label, sc, root);
  return '<div class="rsi-trend-wrap"><div class="scroll-x stick-end rsi-trend-scroll"><svg class="rsi-trend" style="' + svgStyle + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + h(aria) + '">' +
    grid + thLine + line + dots + '</svg></div></div>';
};

PDL_COMPONENTS['plugin:official.rsi/rsiCompareMatrix'] = function (p, sc, root) {
  const table = pv(p.from, sc, root);
  if (!table || !Array.isArray(table.sections) || !table.sections.length) return '';
  const folds = (typeof S !== 'undefined' && S.folds) ? S.folds : {};
  const mode = table.mode === 'cross' && Array.isArray(table.crossCols) && table.crossCols.length > 1 ? 'cross' : 'cycle';
  const showCrossToggle = Array.isArray(table.crossCols) && table.crossCols.length > 1;
  const ctrl = table.controlGroup;
  const cands = Array.isArray(table.candidateGroups) ? table.candidateGroups : [];
  const fmtMeanSd = function (cell) {
    if (!cell || cell.mean == null) return '<span class="rsi-mx-empty">—</span>';
    return '<span class="rsi-mx-num">' + h(cell.mean) + '</span>' +
      (cell.sd != null ? '<span class="rsi-mx-sd">±' + h(cell.sd) + '</span>' : '') +
      (cell.partial ? '<span class="rsi-mx-part">' + h(cell.n + '/' + (table.seeds ? table.seeds.length : '?')) + '</span>' : '');
  };
  const badgeHtml = function (tone, text) {
    if (!text) return '';
    return '<span class="rsi-mx-pill" data-tone="' + h(tone || 'muted') + '">' + h(text) + '</span>';
  };
  const seedStateHtml = function (st) {
    if (st === 'cross') return badgeHtml('danger', '越线');
    if (st === 'env') return badgeHtml('warn', '环境失败');
    if (st === 'failed') return badgeHtml('danger', '无结果');
    return badgeHtml('ok', '正常');
  };
  const tierPill = table.tier === 'explore' ? badgeHtml('warn', '探索快筛') : table.tier === 'confirm' ? badgeHtml('ok', '正式确认') : '';
  const topBar = '<div class="rsi-mx-bar">' +
    '<span class="rsi-mx-hint">' + (tierPill ? tierPill + ' ' : '') + h('共 ' + (table.totalMetrics || 0) + ' 项指标 · 点击指标行展开逐轮结果') + '</span>' +
    (showCrossToggle ? '<div class="rsi-mx-seg" role="group" aria-label="对比视角">' +
      '<button type="button" class="rsi-mx-seg-btn' + (mode === 'cycle' ? ' on' : '') + '" data-act="plugSet" data-plugin="official.rsi" data-k="cmpMode" data-v="cycle">' + h(ctrl && cands.length ? '当轮对照' : '本轮实测') + '</button>' +
      '<button type="button" class="rsi-mx-seg-btn' + (mode === 'cross' ? ' on' : '') + '" data-act="plugSet" data-plugin="official.rsi" data-k="cmpMode" data-v="cross">跨版本</button>' +
      '</div>' : '') +
    '</div>';
  let thead = '', colCount = 0;
  const hasPair = !!ctrl && cands.length > 0;
  if (mode === 'cycle') {
    const cols = ['<th class="rsi-mx-col-m">指标</th>'];
    if (ctrl) cols.push('<th class="rsi-mx-col-v">' + h(cands.length ? '对照' : '本轮') + ' <span class="rsi-mx-ver">' + h(ctrl.version) + '</span></th>');
    cands.forEach(function (g) {
      cols.push('<th class="rsi-mx-col-v">' + h(g.confirm ? '复验' : ctrl ? '候选' : '探索') + ' <span class="rsi-mx-ver">' + h(g.version) + '</span></th>');
    });
    if (hasPair) cols.push('<th class="rsi-mx-col-d">Δ 变化</th>');
    cols.push('<th class="rsi-mx-col-s">判定</th>');
    colCount = cols.length;
    thead = '<thead><tr>' + cols.join('') + '</tr></thead>';
  } else {
    const cols = ['<th class="rsi-mx-col-m">指标</th>'];
    table.crossCols.forEach(function (c) {
      cols.push('<th class="rsi-mx-col-v' + (c.current ? ' is-cur' : '') + '">' + h(c.label) + '</th>');
    });
    colCount = cols.length;
    thead = '<thead><tr>' + cols.join('') + '</tr></thead>';
  }
  const bodyHtml = table.sections.map(function (sec) {
    const secFoldKey = 'rsi-cmp-sec:' + (table.cycleLabel || '') + ':' + sec.k;
    const isOpen = sec.defaultOpen ? !folds[secFoldKey] : !!folds[secFoldKey];
    const secHead = '<tr class="rsi-mx-sec" data-tone="' + h(sec.tone || '') + '"><td colspan="' + colCount + '">' +
      '<button type="button" class="rsi-mx-sec-btn" data-act="fold" data-f="result" data-k="' + h(secFoldKey) + '" aria-expanded="' + (isOpen ? 'true' : 'false') + '">' +
      '<span class="rsi-mx-chev">' + (isOpen ? '▾' : '▸') + '</span>' +
      '<span class="rsi-mx-sec-title">' + h(sec.title) + '</span>' +
      '<span class="rsi-mx-sec-cnt">' + sec.rows.length + '</span>' +
      '</button></td></tr>';
    if (!isOpen) return secHead;
    const rowsHtml = sec.rows.map(function (m) {
      const rowFoldKey = 'rsi-cmp-row:' + (table.cycleLabel || '') + ':' + m.id;
      const rowOpen = !!folds[rowFoldKey];
      const trendBtn = m.hasTrend
        ? '<button type="button" class="rsi-mx-trend-btn' + (m.active ? ' on' : '') + '" data-act="plugSet" data-plugin="official.rsi" data-k="trendMetric" data-v="' + h(m.id) + '" title="在顶部趋势图查看此指标">' + (m.active ? '趋势中' : '趋势') + '</button>'
        : '';
      const metricCell = '<td class="rsi-mx-col-m"><div class="rsi-mx-m-wrap">' +
        '<button type="button" class="rsi-mx-m-btn" data-act="fold" data-f="result" data-k="' + h(rowFoldKey) + '" aria-expanded="' + (rowOpen ? 'true' : 'false') + '">' +
        '<span class="rsi-mx-chev">' + (rowOpen ? '▾' : '▸') + '</span>' +
        '<span class="rsi-mx-m-info"><span class="rsi-mx-m-name">' + h(m.name) + '</span>' +
        (m.ruleText ? '<span class="rsi-mx-m-rule">' + h(m.ruleText) + '</span>' : '') +
        '</span></button>' + trendBtn + '</div></td>';
      let cellsHtml = metricCell;
      if (mode === 'cycle') {
        if (ctrl) cellsHtml += '<td class="rsi-mx-col-v">' + fmtMeanSd(m.control) + '</td>';
        cands.forEach(function (g, gi) {
          const c = m.candidates && m.candidates[gi];
          cellsHtml += '<td class="rsi-mx-col-v' + (c && c.guard === 'fail' ? ' is-fail' : '') + '">' + fmtMeanSd(c) + '</td>';
        });
        if (hasPair) {
          const lead = m.candidates && m.candidates[0];
          const dirHint = m.dir === 'down' ? '越小越好' : '越大越好';
          const deltaTip = lead && lead.better === 'better' ? '变好（' + dirHint + '）' : lead && lead.better === 'worse' ? '变差（' + dirHint + '）' : '持平（' + dirHint + '）';
          const deltaHtml = lead && lead.delta != null
            ? '<span class="rsi-mx-delta" data-better="' + h(lead.better || '') + '" title="' + h(deltaTip) + '">' + h(lead.delta) + '</span>'
            : '<span class="rsi-mx-empty">—</span>';
          cellsHtml += '<td class="rsi-mx-col-d">' + deltaHtml + '</td>';
        }
        const statusTone = m.status === 'win' || m.status === 'pass' ? 'ok' : m.status === 'fail' ? 'danger' : m.status === 'warn' ? 'warn' : 'muted';
        cellsHtml += '<td class="rsi-mx-col-s">' + badgeHtml(statusTone, m.statusText) + '</td>';
      } else {
        (m.crossValues || []).forEach(function (cv) {
          cellsHtml += '<td class="rsi-mx-col-v' + (cv.current ? ' is-cur' : '') + (cv.guard === 'fail' ? ' is-fail' : '') + '">' +
            (cv.value != null ? '<span class="rsi-mx-num">' + h(cv.value) + '</span>' : '<span class="rsi-mx-empty">—</span>') +
            '</td>';
        });
      }
      let detailHtml = '';
      if (rowOpen) {
        const seeds = Array.isArray(table.seeds) ? table.seeds : [];
        const fmtSeedDelta = function (cv, sv) {
          const a = cv != null ? Number(cv) : NaN, b = sv != null ? Number(sv) : NaN;
          if (!Number.isFinite(a) || !Number.isFinite(b)) return '<span class="rsi-mx-empty">—</span>';
          const diff = b - a;
          const better = diff === 0 ? 'same' : (m.dir === 'down' ? diff < 0 : diff > 0) ? 'better' : 'worse';
          const txt = diff === 0 ? '0' : (diff > 0 ? '+' : '') + String(Number(diff.toPrecision(4)));
          return '<span class="rsi-mx-delta" data-better="' + better + '">' + h(txt) + '</span>';
        };
        const worstState = function (list) {
          if (list.indexOf('cross') >= 0) return 'cross';
          if (list.indexOf('env') >= 0) return 'env';
          if (list.indexOf('failed') >= 0) return 'failed';
          return list.length ? list[0] : '';
        };
        if (mode === 'cycle') {
          detailHtml = seeds.map(function (seed, si) {
            const cs = m.control && m.control.seeds ? m.control.seeds[si] : null;
            const states = [];
            let rowTds = '<td class="rsi-mx-col-m rsi-mx-seed-cell"><span class="rsi-mx-sub-rd">第 ' + (si + 1) + ' 轮 <span class="rsi-mx-seed">seed ' + h(seed) + '</span></span></td>';
            if (ctrl) {
              if (cs && cs.state) states.push(cs.state);
              rowTds += '<td class="rsi-mx-col-v' + (cs && (cs.state === 'cross' || cs.state === 'failed') ? ' is-fail' : '') + '">' +
                (cs && cs.value != null ? '<span class="rsi-mx-num">' + h(cs.value) + '</span>' : '<span class="rsi-mx-empty">—</span>') + '</td>';
            }
            let leadSeed = null;
            cands.forEach(function (g, gi) {
              const cand = m.candidates && m.candidates[gi];
              const s = cand && cand.seeds ? cand.seeds[si] : null;
              if (gi === 0) leadSeed = s;
              if (s && s.state) states.push(s.state);
              rowTds += '<td class="rsi-mx-col-v' + (s && (s.state === 'cross' || s.state === 'failed') ? ' is-fail' : '') + '">' +
                (s && s.value != null ? '<span class="rsi-mx-num">' + h(s.value) + '</span>' : '<span class="rsi-mx-empty">—</span>') + '</td>';
            });
            if (hasPair) rowTds += '<td class="rsi-mx-col-d">' + fmtSeedDelta(cs && cs.value, leadSeed && leadSeed.value) + '</td>';
            const st = worstState(states);
            rowTds += '<td class="rsi-mx-col-s">' + (st ? seedStateHtml(st) : '<span class="rsi-mx-empty">—</span>') + '</td>';
            return '<tr class="rsi-mx-seed-row">' + rowTds + '</tr>';
          }).join('');
        } else {
          const subCols = ['<th>当轮明细</th>'];
          if (ctrl) subCols.push('<th>对照 ' + h(ctrl.version) + '</th>');
          cands.forEach(function (g) { subCols.push('<th>' + h(g.confirm ? '复验 ' : ctrl ? '候选 ' : '探索 ') + h(g.version) + '</th>'); });
          subCols.push('<th>判定</th>');
          const subRows = seeds.map(function (seed, si) {
            const cs = m.control && m.control.seeds ? m.control.seeds[si] : null;
            const states = [];
            const tds = ['<td class="rsi-mx-sub-rd">第 ' + (si + 1) + ' 轮 <span class="rsi-mx-seed">seed ' + h(seed) + '</span></td>'];
            if (ctrl) {
              if (cs && cs.state) states.push(cs.state);
              tds.push('<td class="rsi-mx-col-v">' + (cs && cs.value != null ? '<span class="rsi-mx-num">' + h(cs.value) + '</span>' : '<span class="rsi-mx-empty">—</span>') + '</td>');
            }
            cands.forEach(function (g, gi) {
              const cand = m.candidates && m.candidates[gi];
              const s = cand && cand.seeds ? cand.seeds[si] : null;
              if (s && s.state) states.push(s.state);
              tds.push('<td class="rsi-mx-col-v">' + (s && s.value != null ? '<span class="rsi-mx-num">' + h(s.value) + '</span>' : '<span class="rsi-mx-empty">—</span>') + '</td>');
            });
            const st = worstState(states);
            tds.push('<td>' + (st ? seedStateHtml(st) : '<span class="rsi-mx-empty">—</span>') + '</td>');
            return '<tr>' + tds.join('') + '</tr>';
          }).join('');
          detailHtml = '<tr class="rsi-mx-detail-row"><td colspan="' + colCount + '"><div class="rsi-mx-sub-wrap">' +
            '<table class="rsi-mx-sub"><thead><tr>' + subCols.join('') + '</tr></thead><tbody>' + subRows + '</tbody></table>' +
            '</div></td></tr>';
        }
      }
      return '<tr class="rsi-mx-row' + (m.active ? ' is-active' : '') + '">' + cellsHtml + '</tr>' + detailHtml;
    }).join('');
    return secHead + rowsHtml;
  }).join('');
  return '<div class="rsi-mx-wrap">' + topBar + '<div class="scroll-x rsi-mx-scroll"><table class="rsi-mx' + (mode === 'cross' ? ' is-cross' : '') + '">' + thead + '<tbody>' + bodyHtml + '</tbody></table></div></div>';
};

PDL_COMPONENTS['plugin:official.rsi/rsiInitDag'] = function (p, sc, root) {
  const steps = pvList(p.from, sc, root);
  if (!steps.length) return '';
  const byKey = {};
  steps.forEach(function (s) { byKey[s.k] = s; });
  const colMemo = {};
  function colOf(k, seen) {
    if (colMemo[k] != null) return colMemo[k];
    const s = byKey[k];
    if (!s || !Array.isArray(s.depKeys) || !s.depKeys.length) return colMemo[k] = 0;
    const nextSeen = Object.assign({}, seen);
    nextSeen[k] = true;
    let best = 0;
    s.depKeys.forEach(function (dk) {
      if (byKey[dk] && !nextSeen[dk]) best = Math.max(best, colOf(dk, nextSeen) + 1);
    });
    return colMemo[k] = best;
  }
  const cols = [];
  steps.forEach(function (s) {
    const c = colOf(s.k, {});
    (cols[c] = cols[c] || []).push(s);
  });
  const compact = !!p.compact;
  const W = compact ? 104 : 128, H = compact ? 48 : 52, GX = compact ? 18 : 32, GY = 12, PAD = 8, R = 6;
  const maxRows = Math.max.apply(null, cols.map(function (list) { return list ? list.length : 0; }));
  const totalW = PAD * 2 + cols.length * W + Math.max(0, cols.length - 1) * GX;
  const totalH = PAD * 2 + maxRows * H + Math.max(0, maxRows - 1) * GY;
  const pos = {};
  cols.forEach(function (list, c) {
    if (!list) return;
    const colH = list.length * H + Math.max(0, list.length - 1) * GY;
    const startY = PAD + Math.round((totalH - PAD * 2 - colH) / 2);
    list.forEach(function (s, r) {
      pos[s.k] = { c: c, r: r, x: PAD + c * (W + GX), y: startY + r * (H + GY) };
    });
  });
  // Transitive reduction for visual clarity: drop edge u->v if v is already reachable from u via another dependency.
  function reaches(src, target, skipDirect) {
    const stack = (byKey[src] && byKey[src].depKeys ? byKey[src].depKeys : []).filter(function (dk) { return !skipDirect || dk !== target; });
    const seen = {};
    while (stack.length) {
      const cur = stack.pop();
      if (cur === target) return true;
      if (seen[cur] || !byKey[cur]) continue;
      seen[cur] = true;
      (byKey[cur].depKeys || []).forEach(function (dk) { stack.push(dk); });
    }
    return false;
  }
  const sel = steps.find(function (s) { return s.selected; }), selK = sel ? sel.k : '';
  const edges = [];
  steps.forEach(function (s) {
    (s.depKeys || []).forEach(function (dk) {
      if (!pos[dk] || !pos[s.k]) return;
      if (reaches(s.k, dk, true)) return;
      edges.push({ from: dk, to: s.k, done: byKey[dk].stage === 'done', active: selK && (dk === selK || s.k === selK) });
    });
  });
  // Orthogonal rounded bus path: horizontal out -> shared vertical bus before target column -> horizontal in.
  function orthoPath(x1, y1, busX, x2, y2) {
    if (Math.abs(y1 - y2) < 1) return 'M' + x1 + ',' + y1 + ' L' + x2 + ',' + y2;
    const dir = y2 > y1 ? 1 : -1;
    const r = Math.min(R, Math.abs(y2 - y1) / 2, Math.max(1, (busX - x1) / 2), Math.max(1, (x2 - busX) / 2));
    return 'M' + x1 + ',' + y1 +
      ' L' + (busX - r) + ',' + y1 +
      ' Q' + busX + ',' + y1 + ' ' + busX + ',' + (y1 + dir * r) +
      ' L' + busX + ',' + (y2 - dir * r) +
      ' Q' + busX + ',' + y2 + ' ' + (busX + r) + ',' + y2 +
      ' L' + x2 + ',' + y2;
  }
  // Draw inactive edges first so highlighted edges stay cleanly on top.
  edges.sort(function (a, b) { return (a.active ? 1 : 0) - (b.active ? 1 : 0); });
  const svgPaths = edges.map(function (e) {
    const a = pos[e.from], b = pos[e.to];
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    const busX = b.x - Math.round(GX / 2);
    const d = orthoPath(x1, y1, busX, x2, y2);
    const cls = 'rsi-dag-edge' + (e.done ? ' done' : '') + (e.active ? ' active' : '');
    return '<path class="' + cls + '" d="' + d + '"' + (e.active ? ' marker-end="url(#rsi-dag-arr-on)"' : ' marker-end="url(#rsi-dag-arr)"') + '/>';
  }).join('');
  const svg = '<svg class="rsi-dag-svg" width="' + totalW + '" height="' + totalH + '" viewBox="0 0 ' + totalW + ' ' + totalH + '" aria-hidden="true">' +
    '<defs><marker id="rsi-dag-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,1 L7,4 L0,7 z" class="rsi-dag-arr"/></marker>' +
    '<marker id="rsi-dag-arr-on" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,1 L7,4 L0,7 z" class="rsi-dag-arr active"/></marker></defs>' +
    svgPaths + '</svg>';
  const stageLabels = p.stages || {};
  const labelOf = function (st) { return !st ? '' : (stageLabels[st] ? pvText(stageLabels[st], sc, root) : st); };
  const legend = p.hideLegend ? '' : '<div class="rsi-dag-legend">' + ['waiting', 'running', 'pending', 'done', 'error'].map(function (st) {
    return '<span class="rsi-dag-leg" data-stage="' + st + '"><i class="rsi-dag-dot"></i>' + h(labelOf(st)) + '</span>';
  }).join('') + '</div>';
  const nodes = steps.map(function (s) {
    const q = pos[s.k];
    const title = s.terminal && p.terminalTitle ? pvText(p.terminalTitle, s, root) : p.title ? pvText(p.title, s, root) : (s.i + ' ' + s.k);
    const hasStage = !!s.stage;
    const meta = [labelOf(s.stage), s.owner || ''].filter(Boolean).join(' · ');
    const badge = !s.terminal && s.needCount > 0 && s.stage === 'pending' ? '<span class="rsi-dag-badge">' + s.needCount + '</span>' : '';
    const actAttr = p.act ? ' data-act="' + h(p.act) + '"' + pvArgs(p.args, s, root) : ' data-act="plugSet" data-plugin="official.rsi" data-k="initStep" data-v="' + h(s.k) + '"';
    return '<button type="button" class="rsi-dag-node' + (s.terminal ? ' terminal' : '') + '" data-step="' + h(s.k) + '"' + (hasStage ? ' data-stage="' + h(s.stage) + '"' : '') + ' aria-pressed="' + (s.selected ? 'true' : 'false') + '"' + actAttr +
      ' style="left:' + q.x + 'px;top:' + q.y + 'px;width:' + W + 'px;height:' + H + 'px">' +
      '<span class="rsi-dag-top">' + (hasStage ? '<i class="rsi-dag-dot"></i>' : '') + '<span class="rsi-dag-name">' + h(title) + '</span>' + badge + '</span>' +
      (meta ? '<span class="rsi-dag-sub">' + h(meta) + '</span>' : '') + '</button>';
  }).join('');
  return '<div class="rsi-dag-wrap">' + legend + '<div class="scroll-x rsi-dag-scroll"><div class="rsi-dag-canvas" style="width:' + totalW + 'px;height:' + totalH + 'px">' + svg + nodes + '</div></div></div>';
};

function rsiResolveLabels(raw, sc, root, defaults) {
  const out = Object.assign({}, defaults);
  if (raw && typeof raw === 'object') {
    Object.keys(raw).forEach(function (k) {
      const v = pvText(raw[k], sc, root);
      if (v) out[k] = v;
    });
  }
  return out;
}

function rsiFormatCausality(c, L) {
  if (!c) return { trigger: '—', action: '—', basis: '—' };
  let trigger = '—';
  if (c.triggerKind === 'baseline') trigger = L.trigBaseline;
  else if (c.triggerKind === 'repair') trigger = L.trigRepair.replace('{0}', String(c.triggerCycle || '')).replace('{1}', String(c.triggerVersion || ''));
  else if (c.triggerKind === 'direction') trigger = L.trigDir.replace('{0}', String(c.triggerCycle || '')).replace('{1}', String(c.triggerDetail || ''));
  else if (c.triggerKind === 'decision') trigger = L.trigDec.replace('{0}', String(c.triggerCycle || '')).replace('{1}', String(c.triggerDetail || ''));
  else if (c.triggerKind === 'cycle') trigger = L.trigCycle.replace('{0}', String(c.triggerCycle || '')).replace('{1}', String(c.triggerVersion || ''));
  else if (c.triggerVersion) trigger = L.trigParent.replace('{0}', String(c.triggerVersion));
  const prepBasis = c.basisKind === 'preparing'
    ? (c.ownerName
      ? (c.claimed ? L.basisPreparingClaimed : L.basisPreparingWaiting).replace('{0}', String(c.ownerName))
      : L.basisPreparing)
    : '';
  const basis = c.basisText || prepBasis || (c.basisKind === 'running' ? L.basisRunning : c.basisKind === 'evaluating' ? L.basisEval : c.basisKind === 'repaired' ? L.basisRepaired : L.basisNone);
  return { trigger: trigger, action: c.action || '—', basis: basis };
}

function rsiOverviewDefaults() {
  return {
    total: 'Total', current: 'Current', preparingStat: 'Preparing', pruned: 'Refuted', insufficient: 'Insufficient',
    obj: 'Object', obs: 'Observability', rub: 'Rubric', baseline: 'Baseline', unlabeled: 'Unlabeled',
    lensMetric: 'Metric', lensAspect: 'Aspects', fit: 'Fit', expandAll: 'Expand all', collapseChains: 'Fold chains', collapseGroup: 'Collapse', exportHtml: 'Export HTML',
    clusterTitle: '{1} unpromoted trials from {0} (chronological, none replaced {0})',
    foldCount: '{0} versions', foldHint: 'Click to expand {0} versions',
    cycleOf: 'Cycle {0}',
    stCurrent: 'Current', stConfirmed: 'Confirmed', stRunning: 'Running', stPreparing: 'Preparing', stPruned: 'Refuted ✕',
    stDeadEnd: 'Dead-end ✕', stGuardrail: 'Guardrail ✕', stWorse: 'Below control', stTied: 'Tied',
    stInsufficient: 'Insufficient', stRepaired: 'Superseded', stExplore: 'Explore', stBaseline: 'Baseline',
    annotatedBy: 'Source',
    trigBaseline: 'Initial baseline', trigParent: 'Based on {0}', trigRepair: 'Repaired after cycle {0} ({1})',
    trigDir: 'Cycle {0} direction: {1}', trigDec: 'Cycle {0} decision: {1}', trigCycle: 'Cycle {0} ({1})',
    basisRunning: 'Running', basisPreparing: 'Preparing next version; will run once submitted',
    basisPreparingClaimed: '{0} is implementing & reviewing; will run once submitted',
    basisPreparingWaiting: 'Waiting for {0} to claim and prepare',
    basisEval: 'Awaiting evaluation', basisRepaired: 'Superseded by repair', basisNone: 'No conclusion yet',
    lblTrigger: 'Trigger', lblAction: 'Change', lblBasis: 'Verdict basis',
    colSeed: 'seed', colState: 'status', colCommit: 'commit', colNote: 'job / note',
    scale: 'Scale', metric: 'Metric', sameScale: 'Same-scale', refDelta: 'Ref',
  };
}

function rsiFoldLinearChains(nodes, selectedId, expandedMap, metricDir) {
  const MAX_FOLD_GROUP = 6;
  const byId = {}, kids = {};
  nodes.forEach(function (n) { byId[n.id] = n; });
  nodes.forEach(function (n) {
    if (n.parent && byId[n.parent]) (kids[n.parent] = kids[n.parent] || []).push(n);
  });
  // Structural boundaries only (never split a linear group just because a member inside it is selected).
  const isBoundary = function (n) {
    if (!n) return true;
    if (!n.parent || !byId[n.parent]) return true;
    if ((kids[n.parent] || []).length > 1) return true;
    if ((kids[n.id] || []).length !== 1) return true;
    if (n.state === 'current' || n.state === 'running' || n.state === 'preparing' || n.pruned) return true;
    if (n.disposition === 'advance') return true;
    return false;
  };
  const splitChunks = function (list) {
    if (list.length <= MAX_FOLD_GROUP) return [list];
    const chunks = [];
    let i = 0;
    while (i < list.length) {
      const rem = list.length - i;
      if (rem <= MAX_FOLD_GROUP) {
        chunks.push(list.slice(i));
        break;
      }
      // Never leave a trailing 1-node chunk.
      const take = rem === MAX_FOLD_GROUP + 1 ? MAX_FOLD_GROUP - 1 : MAX_FOLD_GROUP;
      chunks.push(list.slice(i, i + take));
      i += take;
    }
    return chunks;
  };
  const swallowed = {}, foldAtFirst = {}, reparent = {}, expandedGroups = [];
  let foldableCount = 0, expandedCount = 0;
  const hasOwn = Object.prototype.hasOwnProperty;
  const wildcard = expandedMap && hasOwn.call(expandedMap, '*') ? expandedMap['*'] : undefined;
  nodes.forEach(function (head) {
    if (!isBoundary(head)) return;
    (kids[head.id] || []).forEach(function (ch) {
      if (isBoundary(ch)) return;
      const mid = [], seen = {};
      let cur = ch;
      while (cur && !isBoundary(cur) && !seen[cur.id]) {
        seen[cur.id] = true;
        mid.push(cur);
        const nextList = kids[cur.id] || [];
        cur = nextList.length === 1 ? nextList[0] : null;
      }
      const tail = cur;
      // Fold only when total linear run (head + mid + tail) has >= 4 nodes (i.e. >= 2 middle nodes).
      if (!tail || mid.length < 2) return;
      const chunks = splitChunks(mid);
      let prevParent = head.id;
      chunks.forEach(function (ck) {
        const foldKey = ck[0].id + '~' + ck[ck.length - 1].id;
        const displayId = ck[0].id + ' ~ ' + ck[ck.length - 1].id;
        const hasSelected = !!(selectedId && ck.some(function (m) { return m.id === selectedId; }));
        const explicit = expandedMap && hasOwn.call(expandedMap, foldKey) ? expandedMap[foldKey] : undefined;
        const isOpen = explicit === true ? true
          : explicit === false ? false
          : wildcard === true ? true
          : wildcard === false ? false
          : hasSelected;
        foldableCount += 1;
        if (isOpen) {
          expandedCount += 1;
          if (prevParent !== ck[0].parent) reparent[ck[0].id] = prevParent;
          expandedGroups.push({
            foldKey: foldKey,
            displayId: displayId,
            count: ck.length,
            memberIds: ck.map(function (m) { return m.id; }),
          });
          prevParent = ck[ck.length - 1].id;
          return;
        }
        const aspSet = {};
        let bestVal = null;
        ck.forEach(function (m) {
          swallowed[m.id] = true;
          (m.aspects || []).forEach(function (a) { aspSet[a] = true; });
          if (typeof m.value === 'number' && Number.isFinite(m.value)) {
            if (bestVal == null || (metricDir === 'down' ? m.value < bestVal : m.value > bestVal)) bestVal = m.value;
          }
        });
        const mergedAspects = ['object', 'observability', 'rubric'].filter(function (a) { return !!aspSet[a]; });
        const foldNode = {
          id: 'fold:' + foldKey,
          parent: prevParent,
          isFold: true,
          foldKey: foldKey,
          displayId: displayId,
          count: ck.length,
          memberIds: ck.map(function (m) { return m.id; }),
          aspects: mergedAspects,
          aspectKind: mergedAspects.length ? 'declared' : 'unlabeled',
          value: bestVal,
          state: 'folded',
          pruned: false,
        };
        foldAtFirst[ck[0].id] = foldNode;
        prevParent = foldNode.id;
      });
      if (prevParent !== tail.parent) reparent[tail.id] = prevParent;
    });
  });
  const out = [];
  nodes.forEach(function (n) {
    if (foldAtFirst[n.id]) out.push(foldAtFirst[n.id]);
    if (swallowed[n.id]) return;
    out.push(reparent[n.id] ? Object.assign({}, n, { parent: reparent[n.id] }) : n);
  });
  return { nodes: out, foldableCount: foldableCount, expandedCount: expandedCount, expandedGroups: expandedGroups };
}

function rsiLayoutOverviewMap(nodes, expandedGroups) {
  const byId = {}, kids = {}, roots = {};
  const rootList = [];
  nodes.forEach(function (n) { byId[n.id] = n; });
  nodes.forEach(function (n) {
    if (n.parent && byId[n.parent]) (kids[n.parent] = kids[n.parent] || []).push(n);
    else { roots[n.id] = true; rootList.push(n); }
  });
  const inExpandedGroup = {};
  (expandedGroups || []).forEach(function (g) {
    (g.memberIds || []).forEach(function (id) { inExpandedGroup[id] = true; });
  });
  const CW = 178, CH = 70, GX = 38, GY = 10, PAD = 14, GRID_GX = 12, BOX_PAD = 12, BOX_HDR = 26;
  const FOLD_BOX_TOP = 30, FOLD_BOX_BOT = 10, FOLD_PAD_X = 8;
  const slotHOf = function (id) { return inExpandedGroup[id] ? CH + FOLD_BOX_TOP + FOLD_BOX_BOT : CH; };
  const pos = {}, edges = [], clusters = [];
  const leafClusterOf = function (list) {
    const leaves = [], branches = [];
    list.forEach(function (c) {
      if ((kids[c.id] || []).length === 0) leaves.push(c);
      else branches.push(c);
    });
    return { leaves: leaves, branches: branches };
  };
  const colsFor = function (count) {
    return Math.min(4, Math.max(2, Math.ceil(Math.sqrt(count))));
  };
  const subtreeSize = function (id, seen) {
    const ownH = slotHOf(id);
    if (seen[id]) return { w: CW, h: ownH };
    const nextSeen = Object.assign({}, seen); nextSeen[id] = true;
    const ch = (kids[id] || []).filter(function (c) { return !nextSeen[c.id]; });
    if (!ch.length) return { w: CW, h: ownH };
    const split = leafClusterOf(ch);
    let totalH = 0, maxChildW = 0;
    if (split.leaves.length >= 4) {
      const cols = colsFor(split.leaves.length);
      const rows = Math.ceil(split.leaves.length / cols);
      const boxW = BOX_PAD * 2 + cols * CW + (cols - 1) * GRID_GX;
      const boxH = BOX_HDR + BOX_PAD * 2 + rows * CH + (rows - 1) * GY;
      totalH += boxH;
      maxChildW = Math.max(maxChildW, boxW);
      split.branches.forEach(function (b) {
        const sz = subtreeSize(b.id, nextSeen);
        totalH += GY + sz.h;
        maxChildW = Math.max(maxChildW, sz.w);
      });
    } else {
      ch.forEach(function (c, i) {
        const sz = subtreeSize(c.id, nextSeen);
        totalH += (i > 0 ? GY : 0) + sz.h;
        maxChildW = Math.max(maxChildW, sz.w);
      });
    }
    return { w: CW + GX + maxChildW, h: Math.max(ownH, totalH) };
  };
  const place = function (id, x, topY, seen) {
    if (seen[id]) return;
    const nextSeen = Object.assign({}, seen); nextSeen[id] = true;
    const sz = subtreeSize(id, seen);
    const ownH = slotHOf(id);
    const y = topY + Math.round((sz.h - ownH) / 2) + (inExpandedGroup[id] ? FOLD_BOX_TOP : 0);
    pos[id] = { x: x, y: y };
    const ch = (kids[id] || []).filter(function (c) { return !nextSeen[c.id]; });
    if (!ch.length) return;
    const split = leafClusterOf(ch);
    const childX = x + CW + GX;
    if (split.leaves.length >= 4) {
      const cols = colsFor(split.leaves.length);
      const rows = Math.ceil(split.leaves.length / cols);
      const boxW = BOX_PAD * 2 + cols * CW + (cols - 1) * GRID_GX;
      const boxH = BOX_HDR + BOX_PAD * 2 + rows * CH + (rows - 1) * GY;
      let cursorY = topY;
      clusters.push({ parentId: id, count: split.leaves.length, x: childX, y: cursorY, w: boxW, h: boxH, leafIds: split.leaves.map(function (lf) { return lf.id; }) });
      edges.push({ from: id, toBox: { x: childX, y: cursorY + Math.round(boxH / 2), parentId: id }, cluster: true });
      split.leaves.forEach(function (lf, idx) {
        const col = idx % cols, row = Math.floor(idx / cols);
        pos[lf.id] = { x: childX + BOX_PAD + col * (CW + GRID_GX), y: cursorY + BOX_HDR + BOX_PAD + row * (CH + GY) };
      });
      cursorY += boxH;
      split.branches.forEach(function (b) {
        cursorY += GY;
        const bsz = subtreeSize(b.id, nextSeen);
        place(b.id, childX, cursorY, nextSeen);
        edges.push({ from: id, to: b.id });
        cursorY += bsz.h;
      });
    } else {
      let cursorY = topY;
      ch.forEach(function (c) {
        const csz = subtreeSize(c.id, nextSeen);
        place(c.id, childX, cursorY, nextSeen);
        edges.push({ from: id, to: c.id });
        cursorY += csz.h + GY;
      });
    }
  };
  let rootY = PAD;
  rootList.forEach(function (r) {
    const sz = subtreeSize(r.id, {});
    place(r.id, PAD, rootY, {});
    rootY += sz.h + GY * 2;
  });
  const foldBoxes = [];
  (expandedGroups || []).forEach(function (g) {
    const pts = (g.memberIds || []).map(function (id) { return pos[id]; }).filter(Boolean);
    if (!pts.length) return;
    let minX = Infinity, maxX2 = -Infinity, minY = Infinity, maxY2 = -Infinity;
    pts.forEach(function (q) {
      if (q.x < minX) minX = q.x;
      if (q.x + CW > maxX2) maxX2 = q.x + CW;
      if (q.y < minY) minY = q.y;
      if (q.y + CH > maxY2) maxY2 = q.y + CH;
    });
    foldBoxes.push({
      foldKey: g.foldKey,
      displayId: g.displayId,
      count: g.count,
      x: minX - FOLD_PAD_X,
      y: minY - FOLD_BOX_TOP,
      w: (maxX2 - minX) + FOLD_PAD_X * 2,
      h: (maxY2 - minY) + FOLD_BOX_TOP + FOLD_BOX_BOT,
    });
  });
  let maxX = 0, maxY = 0;
  Object.keys(pos).forEach(function (k) {
    if (pos[k].x + CW > maxX) maxX = pos[k].x + CW;
    if (pos[k].y + CH > maxY) maxY = pos[k].y + CH;
  });
  clusters.forEach(function (cl) {
    if (cl.x + cl.w > maxX) maxX = cl.x + cl.w;
    if (cl.y + cl.h > maxY) maxY = cl.y + cl.h;
  });
  foldBoxes.forEach(function (fb) {
    if (fb.x + fb.w > maxX) maxX = fb.x + fb.w;
    if (fb.y + fb.h > maxY) maxY = fb.y + fb.h;
  });
  return { byId: byId, pos: pos, edges: edges, clusters: clusters, foldBoxes: foldBoxes, CW: CW, CH: CH, totalW: maxX + PAD, totalH: maxY + PAD };
}

function rsiOverviewStateTag(n, L) {
  if (!n) return null;
  if (n.state === 'current') return { cls: 'ok', text: L.stCurrent };
  if (n.state === 'running') return { cls: 'info', text: L.stRunning };
  if (n.state === 'preparing') return { cls: 'prep', text: L.stPreparing };
  if (n.state === 'confirmed') return { cls: 'ok', text: L.stConfirmed };
  if (n.state === 'deadEnd') return { cls: 'danger', text: L.stDeadEnd };
  if (n.state === 'guardrail') return { cls: 'danger', text: L.stGuardrail };
  if (n.pruned || n.state === 'pruned') return { cls: 'danger', text: L.stPruned };
  if (n.state === 'worse') return { cls: 'danger', text: L.stWorse };
  if (n.state === 'tied') return { cls: 'muted', text: L.stTied };
  if (n.state === 'insufficient') return { cls: 'warn', text: L.stInsufficient };
  if (n.state === 'repaired') return { cls: 'muted', text: L.stRepaired };
  if (n.state === 'baseline') return { cls: 'muted', text: L.stBaseline };
  if (n.tier === 'explore' || n.state === 'explored') return { cls: 'muted', text: L.stExplore };
  return null;
}

function rsiRenderOverviewCanvas(data, L, opts) {
  const esc = opts.esc;
  const rawNodes = data.nodes || [];
  const metric = data.metric || { dir: 'up', unit: '' };
  const selectedId = opts.selectedId || data.selectedVersion || data.currentVersion || (rawNodes[rawNodes.length - 1] && rawNodes[rawNodes.length - 1].id);
  const folded = rsiFoldLinearChains(rawNodes, selectedId, opts.expandedMap || null, metric.dir || 'up');
  const nodes = folded.nodes;
  const layout = rsiLayoutOverviewMap(nodes, folded.expandedGroups);
  const byId = layout.byId, pos = layout.pos, CW = layout.CW, CH = layout.CH;
  const lens = opts.lens === 'aspect' ? 'aspect' : 'metric';
  const activePath = {};
  (function traceUp(id) {
    let cur = id, guard = 0;
    while (cur && !activePath[cur] && guard++ < 500) {
      activePath[cur] = true;
      cur = byId[cur] && byId[cur].parent;
    }
  })(selectedId);
  const finiteVals = rawNodes.map(function (n) { return n.value; }).filter(function (v) { return typeof v === 'number' && Number.isFinite(v); });
  const vMin = finiteVals.length ? Math.min.apply(null, finiteVals) : 0;
  const vMax = finiteVals.length ? Math.max.apply(null, finiteVals) : 1;
  const normOf = function (v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    if (vMax === vMin) return 0.65;
    const raw = (v - vMin) / (vMax - vMin);
    return metric.dir === 'down' ? 1 - raw : raw;
  };
  const aspectMeta = { object: { cls: 'rsi-asp-obj', label: L.obj }, observability: { cls: 'rsi-asp-obs', label: L.obs }, rubric: { cls: 'rsi-asp-rub', label: L.rub } };
  const aspectTextOf = function (n) {
    if (n.aspectKind === 'baseline') return L.baseline;
    if (n.aspects && n.aspects.length) return n.aspects.map(function (a) { return aspectMeta[a] ? aspectMeta[a].label : a; }).join(' · ');
    return L.unlabeled;
  };
  const svgEdges = layout.edges.map(function (e) {
    const a = pos[e.from];
    if (!a) return '';
    if (e.toBox) {
      const x1 = a.x + CW, y1 = a.y + CH / 2, x2 = e.toBox.x, y2 = e.toBox.y;
      const onPath = !!activePath[e.from] && byId[selectedId] && byId[selectedId].parent === e.from;
      const cls = 'rsi-map-edge cluster' + (onPath ? ' active' : '');
      if (Math.abs(y1 - y2) < 1) return '<path class="' + cls + '" d="M' + x1 + ',' + y1 + ' L' + x2 + ',' + y2 + '"/>';
      const mx = Math.round((x1 + x2) / 2);
      return '<path class="' + cls + '" d="M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2 + '"/>';
    }
    const b = pos[e.to];
    if (!b) return '';
    const x1 = a.x + CW, y1 = a.y + CH / 2, x2 = b.x, y2 = b.y + CH / 2;
    const onPath = !!(activePath[e.from] && activePath[e.to]);
    const targetNode = byId[e.to];
    const pruned = !!(targetNode && targetNode.pruned);
    const prepEdge = !!(targetNode && targetNode.state === 'preparing');
    const cls = 'rsi-map-edge' + (onPath ? ' active' : '') + (pruned ? ' pruned' : '') + (prepEdge ? ' preparing' : '');
    if (Math.abs(y1 - y2) < 1) return '<path class="' + cls + '" d="M' + x1 + ',' + y1 + ' L' + x2 + ',' + y2 + '"/>';
    const mx = Math.round((x1 + x2) / 2);
    return '<path class="' + cls + '" d="M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2 + '"/>';
  }).join('');
  const clusterHtml = layout.clusters.map(function (cl) {
    const title = L.clusterTitle.replace(/\{0\}/g, cl.parentId).replace(/\{1\}/g, String(cl.count));
    return '<div class="rsi-map-cluster" style="left:' + cl.x + 'px;top:' + cl.y + 'px;width:' + cl.w + 'px;height:' + cl.h + 'px">' +
      '<div class="rsi-map-cluster-hdr">' + esc(title) + '</div></div>';
  }).join('');
  const foldBoxesHtml = (layout.foldBoxes || []).map(function (fb) {
    const countTxt = L.foldCount.replace(/\{0\}/g, String(fb.count));
    return '<div class="rsi-map-fold-box" data-fold-key="' + esc(fb.foldKey) + '" style="left:' + fb.x + 'px;top:' + fb.y + 'px;width:' + fb.w + 'px;height:' + fb.h + 'px">' +
      '<div class="rsi-map-fold-box-hdr">' +
        '<span class="rsi-map-fold-box-title">' + esc(fb.displayId + ' · ' + countTxt) + '</span>' +
        '<button type="button" class="rsi-map-fold-box-btn" data-rsi-map-act="toggle-fold" data-fold-key="' + esc(fb.foldKey) + '" data-fold-open="1">' + esc(L.collapseGroup) + '</button>' +
      '</div></div>';
  }).join('');
  const cardsHtml = nodes.map(function (n) {
    const q = pos[n.id];
    if (!q) return '';
    if (n.isFold) {
      const foldDots = (n.aspects || []).map(function (a) {
        const m = aspectMeta[a];
        return m ? '<i class="rsi-asp-dot ' + m.cls + '" title="' + esc(m.label) + '"></i>' : '';
      }).join('');
      const countTxt = L.foldCount.replace(/\{0\}/g, String(n.count));
      const hintTxt = L.foldHint.replace(/\{0\}/g, String(n.count));
      const foldVal = n.value != null ? String(n.value) : '▸';
      return '<button type="button" class="rsi-map-node is-fold' + (activePath[n.id] ? ' on-path' : '') + '" data-state="folded" data-rsi-map-act="toggle-fold" data-fold-key="' + esc(n.foldKey) + '" data-fold-open="0"' +
        ' style="left:' + q.x + 'px;top:' + q.y + 'px;width:' + CW + 'px;height:' + CH + 'px" title="' + esc(n.displayId + ' · ' + hintTxt) + '">' +
        '<span class="rsi-map-top"><span class="rsi-map-id">' + esc(n.displayId) + '</span><span class="rsi-map-tag muted">' + esc(countTxt) + '</span><span class="rsi-map-val">' + esc(foldVal) + '</span></span>' +
        '<span class="rsi-map-sub">' + esc(hintTxt) + '</span>' +
        '<span class="rsi-map-foot"><span class="rsi-asp-dots">' + foldDots + '</span><span class="rsi-map-fold-cue">▾</span></span>' +
        '</button>';
    }
    const primaryAspect = n.aspectKind === 'baseline' ? 'baseline' : (n.aspects && n.aspects[0]) || 'unlabeled';
    const tag = rsiOverviewStateTag(n, L);
    const stateBadge = tag ? '<span class="rsi-map-tag ' + tag.cls + '">' + esc(tag.text) + '</span>' : '';
    const dots = (n.aspects || []).map(function (a) {
      const m = aspectMeta[a];
      return m ? '<i class="rsi-asp-dot ' + m.cls + '" title="' + esc(m.label) + '"></i>' : '';
    }).join('');
    const deltaHtml = lens === 'aspect'
      ? '<span class="rsi-map-asp-lbl">' + esc(aspectTextOf(n)) + '</span>'
      : n.state === 'preparing' && n.ownerName
        ? '<span class="rsi-map-scale">' + esc(n.ownerName) + '</span>'
        : n.deltaText
          ? '<span class="rsi-map-delta" data-better="' + esc(n.comparable ? (n.better || '') : 'muted') + '">' + esc((n.comparable ? '' : '~') + n.deltaText) + '</span>'
          : (n.metricVersion ? '<span class="rsi-map-scale">' + esc(n.metricVersion) + '</span>' : '');
    const pct = lens === 'metric' && !n.pruned ? normOf(n.value) : null;
    const barHtml = pct != null ? '<span class="rsi-map-bar"><span class="rsi-map-bar-fill" style="width:' + Math.max(8, Math.round(pct * 100)) + '%"></span></span>' : '';
    const cls = 'rsi-map-node' + (lens === 'aspect' ? ' lens-aspect asp-' + primaryAspect : '') + (n.pruned ? ' is-pruned' : '');
    const isSel = n.id === selectedId;
    const actAttrs = ' data-act="plugSet" data-plugin="official.rsi" data-k="selO" data-v="' + esc(n.pick || '') + '"';
    const compactVal = n.value != null ? String(n.value) : (n.state === 'preparing' ? '…' : '—');
    return '<button type="button" class="' + cls + '" data-state="' + esc(n.state || '') + '" data-ver="' + esc(n.id) + '" aria-pressed="' + (isSel ? 'true' : 'false') + '"' + actAttrs +
      ' style="left:' + q.x + 'px;top:' + q.y + 'px;width:' + CW + 'px;height:' + CH + 'px" title="' + esc((n.id + ' · ' + (n.valueText || '—') + ' · ' + (n.changeBrief || n.changeShort || '')).trim()) + '">' +
      '<span class="rsi-map-top"><span class="rsi-map-id">' + esc(n.id) + '</span>' + stateBadge + '<span class="rsi-map-val">' + esc(compactVal) + '</span></span>' +
      '<span class="rsi-map-sub">' + esc(n.tag || (n.value == null && n.headlineBrief ? n.headlineBrief : n.changeShort) || n.id) + '</span>' +
      '<span class="rsi-map-foot"><span class="rsi-asp-dots">' + dots + '</span>' + deltaHtml + '</span>' +
      barHtml + '</button>';
  }).join('');
  const svg = '<svg class="rsi-map-svg" width="' + layout.totalW + '" height="' + layout.totalH + '" viewBox="0 0 ' + layout.totalW + ' ' + layout.totalH + '" aria-hidden="true">' + svgEdges + '</svg>';
  const zoom = opts.zoom && opts.zoom > 0 ? opts.zoom : 1;
  const transformStyle = zoom !== 1 ? ';transform:scale(' + zoom + ')' : '';
  return {
    totalW: layout.totalW,
    totalH: layout.totalH,
    foldableCount: folded.foldableCount,
    expandedCount: folded.expandedCount,
    html: '<div class="rsi-map-canvas" data-base-w="' + layout.totalW + '" data-base-h="' + layout.totalH + '" style="width:' + layout.totalW + 'px;height:' + layout.totalH + 'px' + transformStyle + '">' + clusterHtml + foldBoxesHtml + svg + cardsHtml + '</div>',
  };
}

function rsiRenderOverviewInspector(data, L, selId, opts) {
  const esc = opts.esc;
  const nodes = data.nodes || [];
  const n = nodes.find(function (x) { return x.id === selId; }) || nodes[0];
  if (!n) return '';
  const sd = data.selectedDetail && data.selectedDetail.id === n.id ? data.selectedDetail : null;
  const tag = rsiOverviewStateTag(n, L);
  const aspectMeta = { object: { cls: 'rsi-asp-obj', label: L.obj }, observability: { cls: 'rsi-asp-obs', label: L.obs }, rubric: { cls: 'rsi-asp-rub', label: L.rub } };
  const aspChips = n.aspectKind === 'baseline'
    ? '<span class="rsi-cc-asp">' + esc(L.baseline) + '</span>'
    : (n.aspects && n.aspects.length)
      ? n.aspects.map(function (a) {
          const m = aspectMeta[a];
          return m ? '<span class="rsi-cc-asp ' + m.cls + '"><i class="rsi-asp-dot ' + m.cls + '"></i>' + esc(m.label) + '</span>' : '';
        }).join('')
      : '<span class="rsi-cc-asp">' + esc(L.unlabeled) + '</span>';
  const c = sd && sd.causality
    ? rsiFormatCausality(sd.causality, L)
    : {
        trigger: n.parent ? L.trigParent.replace('{0}', n.parent) : L.trigBaseline,
        action: n.changeBrief || n.changeShort || '—',
        basis: n.headlineBrief || (n.state === 'preparing' ? (n.ownerName ? (n.claimed ? L.basisPreparingClaimed : L.basisPreparingWaiting).replace('{0}', n.ownerName) : L.basisPreparing) : n.state === 'running' ? L.basisRunning : n.state === 'repaired' ? L.basisRepaired : L.basisNone),
      };
  const metaParts = [
    n.parent ? (n.parent + ' → ' + n.id) : L.stBaseline,
    n.cycleN ? L.cycleOf.replace('{0}', String(n.cycleN)) : '',
    n.metricVersion || '',
    n.commitShort || '',
  ].filter(Boolean);
  const deltaBadge = n.deltaText
    ? '<span class="rsi-mx-pill" data-tone="' + (n.comparable ? (n.better === 'better' ? 'ok' : n.better === 'worse' ? 'danger' : 'muted') : 'warn') + '">' +
      esc((n.comparable ? L.sameScale : L.refDelta) + ' ' + n.deltaText) + '</span>'
    : '';
  const receiptsHtml = (sd && sd.receipts && sd.receipts.length)
    ? '<div class="rsi-map-rcpts">' + sd.receipts.map(function (r) {
        return '<span class="rsi-map-rcpt"><b>' + esc(L.colSeed + ' ' + r.seed) + '</b> · ' + esc(r.state) +
          (r.commit ? ' · ' + esc(r.commit) : '') + (r.jobId ? ' · ' + esc(r.jobId) : '') + '</span>';
      }).join('') + '</div>'
    : '';
  const notePills = [
    n.tag ? '<span class="rsi-mx-pill" data-tone="' + (n.pruned ? 'danger' : 'muted') + '">' + esc(n.tag) + '</span>' : '',
    n.annotatedBy ? '<span class="rsi-mx-pill" data-tone="muted">' + esc((L.annotatedBy || 'Source') + '：' + n.annotatedBy) + '</span>' : '',
  ].filter(Boolean).join('');
  return '<div class="rsi-map-inspect' + (opts.mode === 'modal' ? ' in-modal' : '') + '">' +
    '<div class="rsi-map-ins-hd">' +
      '<div class="rsi-map-ins-id">' +
        '<b>' + esc(n.id) + '</b>' +
        (tag ? '<span class="rsi-map-tag ' + tag.cls + '">' + esc(tag.text) + '</span>' : '') +
        aspChips +
      '</div>' +
      '<div class="rsi-map-ins-metric">' +
        '<span class="rsi-map-ins-mval">' + esc((data.metric && data.metric.name ? data.metric.name + ': ' : '') + (n.valueText || '—')) + '</span>' +
        deltaBadge +
      '</div>' +
    '</div>' +
    '<div class="rsi-map-ins-meta">' + esc(metaParts.join(' · ')) + '</div>' +
    (notePills ? '<div class="rsi-map-ins-note">' + notePills + '</div>' : '') +
    '<div class="rsi-map-ins-chain">' +
      '<p><b>' + esc(L.lblTrigger) + '：</b>' + esc(c.trigger) + '</p>' +
      '<p><b>' + esc(L.lblAction) + '：</b>' + esc(c.action) + '</p>' +
      '<p><b>' + esc(L.lblBasis) + '：</b>' + esc(c.basis) + '</p>' +
    '</div>' +
    receiptsHtml +
  '</div>';
}

PDL_COMPONENTS['plugin:official.rsi/rsiOverviewMap'] = function (p, sc, root) {
  const data = pv(p.from, sc, root);
  if (!data || !Array.isArray(data.nodes) || !data.nodes.length) return '';
  const L = rsiResolveLabels(p.labels, sc, root, rsiOverviewDefaults());
  const isModal = p.mode === 'modal' || pv(p.mode, sc, root) === 'modal';
  const mode = isModal ? 'modal' : 'inline';
  const nodes = data.nodes;
  const lens = data.lens === 'aspect' ? 'aspect' : 'metric';
  const objId = String(data.objectiveId || 'default');
  const hostGlobal = typeof window !== 'undefined' ? window : globalThis;
  const zoomStore = hostGlobal.__rsiMapZoom || (hostGlobal.__rsiMapZoom = {});
  const foldStore = hostGlobal.__rsiMapExpanded || (hostGlobal.__rsiMapExpanded = {});
  const savedZoom = typeof zoomStore[objId] === 'number' && zoomStore[objId] >= 0.25 && zoomStore[objId] <= 2 ? zoomStore[objId] : 1;
  const expandedMap = foldStore[objId] || {};
  const selectedId = data.selectedVersion || data.currentVersion || (nodes[nodes.length - 1] && nodes[nodes.length - 1].id);
  const rendered = rsiRenderOverviewCanvas(data, L, { esc: h, lens: lens, selectedId: selectedId, mode: mode, zoom: savedZoom, expandedMap: expandedMap });
  const inspectorHtml = rsiRenderOverviewInspector(data, L, selectedId, { esc: h, mode: mode });
  const stats = data.stats || { total: nodes.length, pruned: 0, insufficient: 0, current: data.currentVersion };
  const exportPayload = Object.assign({}, data, { labels: L });
  const safeJson = JSON.stringify(exportPayload).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const allExpanded = rendered.foldableCount > 0 && rendered.expandedCount >= rendered.foldableCount;
  const foldBtn = rendered.foldableCount > 0
    ? '<button type="button" class="rsi-map-btn" data-rsi-map-act="' + (allExpanded ? 'collapse-all' : 'expand-all') + '">' + h(allExpanded ? L.collapseChains : L.expandAll) + '</button>'
    : '';
  const headBar = '<div class="rsi-map-bar-top">' +
    '<div class="rsi-map-stats">' +
      '<span>' + h(L.total) + ' <b>' + h(stats.total) + '</b></span>' +
      '<span>' + h(L.current) + ' <b>' + h(stats.current || '—') + '</b></span>' +
      (stats.preparing ? '<span class="is-prep">' + h(L.preparingStat) + ' <b>' + h(stats.preparing) + '</b></span>' : '') +
      (stats.pruned ? '<span class="is-pruned">' + h(L.pruned) + ' <b>' + h(stats.pruned) + '</b></span>' : '') +
      (stats.insufficient ? '<span>' + h(L.insufficient) + ' <b>' + h(stats.insufficient) + '</b></span>' : '') +
      '<span class="rsi-map-leg"><i class="rsi-asp-dot rsi-asp-obj"></i>' + h(L.obj) + ' <i class="rsi-asp-dot rsi-asp-obs"></i>' + h(L.obs) + ' <i class="rsi-asp-dot rsi-asp-rub"></i>' + h(L.rub) + '</span>' +
    '</div>' +
    '<div class="rsi-map-tools">' +
      '<div class="rsi-mx-seg" role="group">' +
        '<button type="button" class="rsi-mx-seg-btn' + (lens === 'metric' ? ' on' : '') + '" data-act="plugSet" data-plugin="official.rsi" data-k="overviewLens" data-v="metric">' + h(L.lensMetric) + '</button>' +
        '<button type="button" class="rsi-mx-seg-btn' + (lens === 'aspect' ? ' on' : '') + '" data-act="plugSet" data-plugin="official.rsi" data-k="overviewLens" data-v="aspect">' + h(L.lensAspect) + '</button>' +
      '</div>' +
      foldBtn +
      '<button type="button" class="rsi-map-btn" data-rsi-map-act="zoom-out" aria-label="Zoom out">−</button>' +
      '<button type="button" class="rsi-map-btn rsi-map-zl" data-rsi-map-act="zoom-reset" title="100%">' + Math.round(savedZoom * 100) + '%</button>' +
      '<button type="button" class="rsi-map-btn" data-rsi-map-act="zoom-in" aria-label="Zoom in">+</button>' +
      '<button type="button" class="rsi-map-btn" data-rsi-map-act="fit">' + h(L.fit) + '</button>' +
      '<button type="button" class="rsi-map-btn" data-rsi-map-act="export-html">' + h(L.exportHtml) + '</button>' +
    '</div>' +
  '</div>';
  const stageW = Math.round(rendered.totalW * savedZoom), stageH = Math.round(rendered.totalH * savedZoom);
  const canvasScroll = '<div class="rsi-map-scroll"><div class="rsi-map-stage" style="width:' + stageW + 'px;height:' + stageH + 'px">' + rendered.html + '</div></div>';
  const bodyHtml = isModal
    ? '<div class="rsi-map-split">' + canvasScroll + '<aside class="rsi-map-aside">' + inspectorHtml + '</aside></div>'
    : canvasScroll + inspectorHtml;
  return '<div class="rsi-map-wrap' + (isModal ? ' is-modal' : '') + '" data-obj-id="' + h(objId) + '" data-zoom="' + savedZoom + '">' + headBar + bodyHtml +
    '<script type="application/json" class="rsi-map-data">' + safeJson + '</script></div>';
};

PDL_COMPONENTS['plugin:official.rsi/rsiCycleCard'] = function (p, sc, root) {
  const card = pv(p.from, sc, root);
  if (!card) return '';
  const L = rsiResolveLabels(p.labels, sc, root, {
    vBaseline: 'Baseline', vKeep: 'Keep', vTune: 'Tune', vRollback: 'Rollback', vSunset: 'Sunset', vInsufficient: 'Insufficient',
    obj: 'Object', obs: 'Observability', rub: 'Rubric', baseline: 'Baseline', unlabeled: 'Unlabeled',
    refPaired: 'vs {0}', refExplore: 'Explore (no same-cycle control)', refSingle: 'Baseline group',
    tagExploreNoCtrl: 'Explore reference', tagNoCtrl: 'No same-cycle control',
    lblTrigger: 'Trigger', lblAction: 'Change', lblBasis: 'Verdict basis',
    trigBaseline: 'Initial baseline', trigParent: 'Based on {0}', trigRepair: 'Repaired after cycle {0} ({1})',
    trigDir: 'Cycle {0} direction: {1}', trigDec: 'Cycle {0} decision: {1}', trigCycle: 'Cycle {0} ({1})',
    basisRunning: 'Running', basisEval: 'Awaiting evaluation', basisRepaired: 'Superseded by repair', basisNone: 'No conclusion yet',
    condTitle: 'Fixed conditions & rubric', bodyHide: 'Hide full evaluation details', bodyShow: 'Show full evaluation details ({0} chars)',
    rcptTitle: 'Execution & artifact receipts',
    ckMetricVersion: 'Metric scale', ckTier: 'Tier', ckSeeds: 'Seeds', ckControl: 'Control', ckConfig: 'Config ({0})', ckGuardrails: 'Guardrails',
    tierExplore: 'Explore (non-promoting)', tierConfirm: 'Confirm', tierBaseline: 'Baseline',
    ctrlSkip: 'Skipped outer control', ctrlPaired: 'Paired {0}', ctrlSingle: 'Single group', reserved: 'reserved {0}',
    colSeed: 'seed', colState: 'status', colCommit: 'commit', colDur: 'duration', colNote: 'job / note',
  });
  const folds = (typeof S !== 'undefined' && S.folds) ? S.folds : {};
  const verdictMeta = {
    baseline: { tone: 'info', label: L.vBaseline },
    keep: { tone: 'ok', label: L.vKeep },
    tune: { tone: 'ok', label: L.vTune },
    rollback: { tone: 'danger', label: L.vRollback },
    sunset: { tone: 'muted', label: L.vSunset },
    insufficient: { tone: 'warn', label: L.vInsufficient },
  };
  const vm = verdictMeta[card.verdict] || { tone: 'muted', label: card.verdict || '' };
  const aspectMeta = { object: { cls: 'rsi-asp-obj', label: L.obj }, observability: { cls: 'rsi-asp-obs', label: L.obs }, rubric: { cls: 'rsi-asp-rub', label: L.rub } };
  const aspChips = card.aspectKind === 'baseline'
    ? '<span class="rsi-cc-asp">' + h(L.baseline) + '</span>'
    : (card.aspects && card.aspects.length)
      ? card.aspects.map(function (a) {
          const m = aspectMeta[a];
          return m ? '<span class="rsi-cc-asp ' + m.cls + '"><i class="rsi-asp-dot ' + m.cls + '"></i>' + h(m.label) + '</span>' : '';
        }).join('')
      : '<span class="rsi-cc-asp">' + h(L.unlabeled) + '</span>';
  const main = card.main;
  const refText = main ? (main.refKind === 'paired' ? L.refPaired.replace('{0}', main.refVersion || '') : main.refKind === 'explore' ? L.refExplore : L.refSingle) : '';
  const metricStrip = main ? (
    '<div class="rsi-cc-metric">' +
      '<div class="rsi-cc-m-left"><span class="rsi-cc-m-lbl">' + h(main.name) + ' · ' + h(refText) + '</span>' +
      '<div class="rsi-cc-m-vals">' +
        (main.comparable && main.refValue != null ? '<span class="rsi-cc-m-ref">' + h(main.refValue) + ' → </span>' : '') +
        '<span class="rsi-cc-m-num">' + h(main.value) + '</span>' +
        (main.sd != null ? '<span class="rsi-mx-sd">±' + h(main.sd) + '</span>' : '') +
        (main.comparable && main.delta != null
          ? '<span class="rsi-mx-pill" data-tone="' + (main.better === 'better' ? 'ok' : main.better === 'worse' ? 'danger' : 'muted') + '">' + h(main.delta) + '</span>'
          : '<span class="rsi-mx-pill" data-tone="warn">' + h(card.tier === 'explore' ? L.tagExploreNoCtrl : L.tagNoCtrl) + '</span>') +
      '</div></div>' +
      '<div class="rsi-cc-badges">' +
        '<span class="rsi-mx-pill" data-tone="' + h(vm.tone) + '">' + h(vm.label) + '</span>' +
        '<span class="rsi-mx-pill" data-tone="muted">' + h(card.metricVersion || 'E1') + '</span>' +
        aspChips +
      '</div>' +
    '</div>'
  ) : '';
  const c = rsiFormatCausality(card.causality, L);
  const chainHtml = '<div class="rsi-cc-chain">' +
    '<p><b>' + h(L.lblTrigger) + '：</b>' + h(c.trigger) + '</p>' +
    '<p><b>' + h(L.lblAction) + '：</b>' + h(c.action) + '</p>' +
    '<p><b>' + h(L.lblBasis) + '：</b>' + h(c.basis || card.headline || '—') + '</p>' +
  '</div>';
  const condKey = 'rsi-cc-cond:' + card.foldId;
  const condOpen = !!folds[condKey];
  const condLabel = function (rw) {
    if (rw.kKey === 'metricVersion') return L.ckMetricVersion;
    if (rw.kKey === 'tier') return L.ckTier;
    if (rw.kKey === 'seeds') return L.ckSeeds;
    if (rw.kKey === 'control') return L.ckControl;
    if (rw.kKey === 'config') return L.ckConfig.replace('{0}', rw.version || '');
    if (rw.kKey === 'guardrails') return L.ckGuardrails;
    return rw.k || rw.kKey || '';
  };
  const condVal = function (rw) {
    if (rw.kKey === 'tier') return rw.vKey === 'explore' ? L.tierExplore : rw.vKey === 'baseline' ? L.tierBaseline : L.tierConfirm;
    if (rw.kKey === 'control') return rw.vKey === 'skipControl' ? L.ctrlSkip : rw.vKey === 'paired' ? L.ctrlPaired.replace('{0}', rw.version || '') : L.ctrlSingle;
    if (rw.kKey === 'seeds') return [rw.v, rw.reserved ? L.reserved.replace('{0}', rw.reserved) : ''].filter(Boolean).join(' · ') || '—';
    return rw.v || '—';
  };
  const condHtml = (card.conditions && card.conditions.length) ? (
    '<div class="rsi-cc-fold">' +
      '<button type="button" class="rsi-cc-fold-btn" data-act="fold" data-f="result" data-k="' + h(condKey) + '" aria-expanded="' + (condOpen ? 'true' : 'false') + '">' +
        '<span class="rsi-mx-chev">' + (condOpen ? '▾' : '▸') + '</span><span>' + h(L.condTitle) + ' (' + card.conditions.length + ')</span></button>' +
      (condOpen ? '<div class="rsi-cc-conds">' + card.conditions.map(function (rw) {
        return '<div class="rsi-cc-crow"><span class="rsi-cc-ck">' + h(condLabel(rw)) + '</span><span class="rsi-cc-cv">' + h(condVal(rw)) + '</span></div>';
      }).join('') + '</div>' : '') +
    '</div>'
  ) : '';
  const bodyKey = 'rsi-cc-body:' + card.foldId;
  const bodyOpen = card.autoFoldBody ? !!folds[bodyKey] : !folds[bodyKey];
  const bodyHtml = card.body ? (
    '<div class="rsi-cc-fold">' +
      '<button type="button" class="rsi-cc-fold-btn" data-act="fold" data-f="result" data-k="' + h(bodyKey) + '" aria-expanded="' + (bodyOpen ? 'true' : 'false') + '">' +
        '<span class="rsi-mx-chev">' + (bodyOpen ? '▾' : '▸') + '</span><span>' + h(bodyOpen ? L.bodyHide : L.bodyShow.replace('{0}', String(card.bodyLength))) + '</span></button>' +
      (bodyOpen ? '<div class="rsi-cc-body">' + h(card.body).replace(/\n/g, '<br>') + '</div>' : '') +
    '</div>'
  ) : '';
  const rcptKey = 'rsi-cc-rcpt:' + card.foldId;
  const rcptOpen = !!folds[rcptKey];
  const rcptHtml = (card.receipts && card.receipts.length) ? (
    '<div class="rsi-cc-fold">' +
      '<button type="button" class="rsi-cc-fold-btn" data-act="fold" data-f="result" data-k="' + h(rcptKey) + '" aria-expanded="' + (rcptOpen ? 'true' : 'false') + '">' +
        '<span class="rsi-mx-chev">' + (rcptOpen ? '▾' : '▸') + '</span><span>' + h(L.rcptTitle) + ' (' + card.receipts.length + ')</span></button>' +
      (rcptOpen ? '<div class="scroll-x rsi-cc-rcpt-wrap"><table class="rsi-mx-sub"><thead><tr><th>' + h(L.colSeed) + '</th><th>' + h(L.colState) + '</th><th>' + h(L.colCommit) + '</th><th>' + h(L.colDur) + '</th><th>' + h(L.colNote) + '</th></tr></thead><tbody>' +
        card.receipts.map(function (r) {
          return '<tr><td class="rsi-mx-seed">' + h(r.seed) + '</td><td>' + h(r.state) + '</td><td class="rsi-mx-seed">' + h(r.commit || '—') + '</td><td>' + h(r.duration || '—') + '</td><td>' + h(r.jobId || r.error || '—') + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '') +
    '</div>'
  ) : '';
  return '<div class="rsi-cc-wrap">' + metricStrip + chainHtml + condHtml + bodyHtml + rcptHtml + '</div>';
};

(function () {
  if (typeof document === 'undefined') return;
  const hostGlobal = typeof window !== 'undefined' ? window : globalThis;
  if (hostGlobal.__rsiMapClickHandler) {
    document.removeEventListener('click', hostGlobal.__rsiMapClickHandler);
  }
  if (hostGlobal.__rsiMapWheelHandler) {
    document.removeEventListener('wheel', hostGlobal.__rsiMapWheelHandler);
    delete hostGlobal.__rsiMapWheelHandler;
  }
  if (hostGlobal.__rsiMapPointerOverHandler) {
    document.removeEventListener('pointerover', hostGlobal.__rsiMapPointerOverHandler);
  }
  if (hostGlobal.__rsiMapKeyHandler) {
    document.removeEventListener('keydown', hostGlobal.__rsiMapKeyHandler);
    delete hostGlobal.__rsiMapKeyHandler;
  }
  const ZOOM_MIN = 0.25, ZOOM_MAX = 2.0;
  function clampZoom(v) {
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(v * 100) / 100));
  }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function setZoom(root, nextZoom, anchor) {
    const stage = root.querySelector('.rsi-map-stage');
    const canvas = root.querySelector('.rsi-map-canvas');
    const scroll = root.querySelector('.rsi-map-scroll');
    const zl = root.querySelector('.rsi-map-zl');
    if (!stage || !canvas) return;
    const baseW = parseFloat(canvas.getAttribute('data-base-w') || canvas.style.width) || canvas.offsetWidth || 400;
    const baseH = parseFloat(canvas.getAttribute('data-base-h') || canvas.style.height) || canvas.offsetHeight || 200;
    const prevZ = parseFloat(root.getAttribute('data-zoom') || '1') || 1;
    const z = clampZoom(nextZoom);
    let anchorX = 0, anchorY = 0, relX = 0, relY = 0;
    if (anchor && scroll) {
      const rect = scroll.getBoundingClientRect();
      relX = anchor.clientX - rect.left;
      relY = anchor.clientY - rect.top;
      anchorX = (scroll.scrollLeft + relX) / prevZ;
      anchorY = (scroll.scrollTop + relY) / prevZ;
    }
    root.setAttribute('data-zoom', String(z));
    const objId = root.getAttribute('data-obj-id') || 'default';
    (hostGlobal.__rsiMapZoom = hostGlobal.__rsiMapZoom || {})[objId] = z;
    canvas.style.transform = z === 1 ? '' : 'scale(' + z + ')';
    stage.style.width = Math.round(baseW * z) + 'px';
    stage.style.height = Math.round(baseH * z) + 'px';
    if (zl) zl.textContent = Math.round(z * 100) + '%';
    if (anchor && scroll) {
      scroll.scrollLeft = Math.max(0, Math.round(anchorX * z - relX));
      scroll.scrollTop = Math.max(0, Math.round(anchorY * z - relY));
    }
  }
  function applyZoom(root, act) {
    const canvas = root.querySelector('.rsi-map-canvas');
    const scroll = root.querySelector('.rsi-map-scroll');
    if (!canvas) return;
    const baseW = parseFloat(canvas.getAttribute('data-base-w') || canvas.style.width) || canvas.offsetWidth || 400;
    const baseH = parseFloat(canvas.getAttribute('data-base-h') || canvas.style.height) || canvas.offsetHeight || 200;
    const cur = parseFloat(root.getAttribute('data-zoom') || '1') || 1;
    if (act === 'zoom-in') setZoom(root, cur + 0.15);
    else if (act === 'zoom-out') setZoom(root, cur - 0.15);
    else if (act === 'zoom-reset') setZoom(root, 1);
    else if (act === 'fit' && scroll) {
      const availW = Math.max(240, (scroll.clientWidth || 720) - 40);
      const availH = Math.max(180, (scroll.clientHeight || 420) - 40);
      setZoom(root, Math.min(1, availW / baseW, availH / baseH));
    }
  }
  function rerenderCanvasInPlace(root) {
    const dataEl = root.querySelector('.rsi-map-data');
    const stage = root.querySelector('.rsi-map-stage');
    if (!dataEl || !stage) return;
    let payload;
    try { payload = JSON.parse(dataEl.textContent || '{}'); } catch (_) { return; }
    const L = Object.assign(rsiOverviewDefaults(), payload.labels || {});
    const objId = root.getAttribute('data-obj-id') || String(payload.objectiveId || 'default');
    const expandedMap = (hostGlobal.__rsiMapExpanded && hostGlobal.__rsiMapExpanded[objId]) || {};
    const curZoom = parseFloat(root.getAttribute('data-zoom') || '1') || 1;
    const lens = payload.lens === 'aspect' ? 'aspect' : 'metric';
    const selectedId = payload.selectedVersion || payload.currentVersion;
    const rendered = rsiRenderOverviewCanvas(payload, L, { esc: escHtml, lens: lens, selectedId: selectedId, zoom: curZoom, expandedMap: expandedMap });
    stage.innerHTML = rendered.html;
    stage.style.width = Math.round(rendered.totalW * curZoom) + 'px';
    stage.style.height = Math.round(rendered.totalH * curZoom) + 'px';
    const foldToggleBtn = root.querySelector('[data-rsi-map-act="expand-all"], [data-rsi-map-act="collapse-all"]');
    if (foldToggleBtn) {
      const allExpanded = rendered.foldableCount > 0 && rendered.expandedCount >= rendered.foldableCount;
      foldToggleBtn.setAttribute('data-rsi-map-act', allExpanded ? 'collapse-all' : 'expand-all');
      foldToggleBtn.textContent = allExpanded ? L.collapseChains : L.expandAll;
    }
  }
  function buildStandaloneHtml(data) {
    const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
    const title = String(data.objectiveName || data.objectiveId || 'RSI Lineage').replace(/[<>&"]/g, '');
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + title + '</title>' +
      '<style>:root{--bg:#f8fafc;--card:#fff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--ok:#0f766e;--info:#2563eb;--warn:#b45309;--danger:#b91c1c;--obj:#0f766e;--obs:#9333ea;--rub:#4338ca}' +
      '@media(prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#111827;--ink:#f1f5f9;--muted:#94a3b8;--line:#1f2937;--ok:#2dd4bf;--info:#60a5fa;--warn:#fbbf24;--danger:#f87171;--obj:#2dd4bf;--obs:#c084fc;--rub:#818cf8}}' +
      '*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:var(--bg);color:var(--ink);display:flex;flex-direction:column;height:100vh}' +
      'header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;border-bottom:1px solid var(--line);background:var(--card)}' +
      'header h1{margin:0;font-size:15px}header .sub{font-size:12px;color:var(--muted)}main{display:grid;grid-template-columns:1fr 360px;flex:1;min-height:0}' +
      '.map{position:relative;overflow:auto;padding:16px}.canvas{position:relative}svg.edges{position:absolute;inset:0;pointer-events:none}' +
      'path.e{fill:none;stroke:var(--line);stroke-width:1.6}path.e.on{stroke:var(--ok);stroke-width:2.2}path.e.pr{stroke:var(--danger);stroke-dasharray:4 3;opacity:.6}path.e.cl{stroke-dasharray:4 4;opacity:.75}' +
      '.clbox{position:absolute;border:1px dashed var(--line);border-radius:12px;background:color-mix(in srgb,var(--card) 55%,transparent)}.clhdr{padding:6px 10px;font-size:11px;color:var(--muted);font-weight:600}' +
      '.nd{position:absolute;display:flex;flex-direction:column;justify-content:space-between;padding:7px 9px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--ink);cursor:pointer;text-align:left}' +
      '.nd.cur{border-color:var(--ok);box-shadow:0 0 0 2px color-mix(in srgb,var(--ok) 30%,transparent)}.nd.pr{border-color:color-mix(in srgb,var(--danger) 55%,var(--line));background:color-mix(in srgb,var(--danger) 7%,var(--card))}' +
      '.nd.sel{outline:2px solid var(--info);outline-offset:1px}.top{display:flex;align-items:center;gap:6px;font-size:12px}.id{font-family:monospace;font-weight:700}.val{margin-left:auto;font-family:monospace;font-size:11px;font-weight:600}' +
      '.subt{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.foot{display:flex;align-items:center;justify-content:space-between;font-size:10px;color:var(--muted)}' +
      '.dots{display:inline-flex;gap:3px}.dots i{width:7px;height:7px;border-radius:2px;display:inline-block}.dots .obj{background:var(--obj)}.dots .obs{background:var(--obs)}.dots .rub{background:var(--rub)}' +
      'aside{border-left:1px solid var(--line);background:var(--card);padding:16px;overflow:auto}.chain p{margin:0 0 8px;padding-left:10px;border-left:2px solid var(--line);font-size:13px;line-height:1.5}' +
      '.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;background:color-mix(in srgb,var(--muted) 15%,transparent)}table{width:100%;border-collapse:collapse;font-size:11px;margin-top:8px}td,th{text-align:left;padding:4px 6px;border-bottom:1px solid var(--line);font-family:monospace}</style></head>' +
      '<body><header><div><h1 id="t"></h1><div class="sub" id="sub"></div></div><div class="sub" id="st"></div></header><main><div class="map"><div class="canvas" id="cv"></div></div><aside id="as"></aside></main>' +
      '<script id="D" type="application/json">' + json + '</script>' +
      '<script>(function(){const D=JSON.parse(document.getElementById("D").textContent);const L=D.labels||{};const N=D.nodes||[];const byId={},kids={},roots=[];N.forEach(n=>byId[n.id]=n);N.forEach(n=>{if(n.parent&&byId[n.parent])(kids[n.parent]=kids[n.parent]||[]).push(n);else roots.push(n)});' +
      'const CW=178,CH=70,GX=38,GY=10,PAD=18,GGX=12,BP=12,BH=26,pos={},edges=[],boxes=[];const sp=l=>({lf:l.filter(c=>!(kids[c.id]||[]).length),br:l.filter(c=>(kids[c.id]||[]).length)});const cf=n=>Math.min(4,Math.max(2,Math.ceil(Math.sqrt(n))));' +
      'const sz=(id,sn)=>{if(sn[id])return{w:CW,h:CH};const ns=Object.assign({},sn);ns[id]=1;const ch=(kids[id]||[]).filter(c=>!ns[c.id]);if(!ch.length)return{w:CW,h:CH};const s=sp(ch);let h=0,mw=0;if(s.lf.length>=4){const cols=cf(s.lf.length),rows=Math.ceil(s.lf.length/cols);h=BH+BP*2+rows*CH+(rows-1)*GY;mw=BP*2+cols*CW+(cols-1)*GGX;s.br.forEach(b=>{const z=sz(b.id,ns);h+=GY+z.h;mw=Math.max(mw,z.w)})}else{ch.forEach((c,i)=>{const z=sz(c.id,ns);h+=(i?GY:0)+z.h;mw=Math.max(mw,z.w)})}return{w:CW+GX+mw,h:Math.max(CH,h)}};' +
      'const pl=(id,x,ty,sn)=>{if(sn[id])return;const ns=Object.assign({},sn);ns[id]=1;const z=sz(id,sn);pos[id]={x,y:ty+Math.round((z.h-CH)/2)};const ch=(kids[id]||[]).filter(c=>!ns[c.id]);if(!ch.length)return;const s=sp(ch),cx=x+CW+GX;if(s.lf.length>=4){const cols=cf(s.lf.length),rows=Math.ceil(s.lf.length/cols),bw=BP*2+cols*CW+(cols-1)*GGX,bh=BH+BP*2+rows*CH+(rows-1)*GY;let cy=ty;boxes.push({p:id,n:s.lf.length,x:cx,y:cy,w:bw,h:bh});edges.push({f:id,bx:cx,by:cy+Math.round(bh/2)});s.lf.forEach((lf,i)=>{const c=i%cols,r=Math.floor(i/cols);pos[lf.id]={x:cx+BP+c*(CW+GGX),y:cy+BH+BP+r*(CH+GY)}});cy+=bh;s.br.forEach(b=>{cy+=GY;const bz=sz(b.id,ns);pl(b.id,cx,cy,ns);edges.push({f:id,t:b.id});cy+=bz.h})}else{let cy=ty;ch.forEach(c=>{const cz=sz(c.id,ns);pl(c.id,cx,cy,ns);edges.push({f:id,t:c.id});cy+=cz.h+GY})}};' +
      'let ry=PAD;roots.forEach(r=>{const z=sz(r.id,{});pl(r.id,PAD,ry,{});ry+=z.h+GY*2});let mx=0,my=0;Object.values(pos).forEach(q=>{mx=Math.max(mx,q.x+CW);my=Math.max(my,q.y+CH)});boxes.forEach(b=>{mx=Math.max(mx,b.x+b.w);my=Math.max(my,b.y+b.h)});' +
      'let sel=D.selectedVersion||D.currentVersion||(N[0]&&N[0].id);const stMap={current:L.stCurrent,confirmed:L.stConfirmed,running:L.stRunning,preparing:L.stPreparing,pruned:L.stPruned,deadEnd:L.stDeadEnd,guardrail:L.stGuardrail,worse:L.stWorse,tied:L.stTied,insufficient:L.stInsufficient,repaired:L.stRepaired,baseline:L.stBaseline,explored:L.stExplore};' +
      'document.getElementById("t").textContent=D.objectiveName||D.objectiveId;document.getElementById("sub").textContent=(L.metric||"Metric")+": "+(D.metric&&D.metric.name||"")+" · "+(L.scale||"Scale")+" "+(D.metricVersion||"E1");document.getElementById("st").textContent=(L.total||"Total")+" "+N.length+" · "+(L.current||"Current")+" "+(D.currentVersion||"—")+" · "+(L.pruned||"Refuted")+" "+((D.stats&&D.stats.pruned)||0);' +
      'const esc=s=>String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");function render(){const on={};let c=sel,g=0;while(c&&!on[c]&&g++<500){on[c]=1;c=byId[c]&&byId[c].parent}const W=mx+PAD,H=my+PAD;const cv=document.getElementById("cv");cv.style.width=W+"px";cv.style.height=H+"px";' +
      'const bx=boxes.map(b=>"<div class=\\"clbox\\" style=\\"left:"+b.x+"px;top:"+b.y+"px;width:"+b.w+"px;height:"+b.h+"px\\"><div class=\\"clhdr\\">"+esc((L.clusterTitle||"{1} unpromoted trials from {0}").replace(/\\{0\\}/g,b.p).replace(/\\{1\\}/g,String(b.n)))+"</div></div>").join("");' +
      'const ep=edges.map(e=>{const a=pos[e.f],x1=a.x+CW,y1=a.y+CH/2;if(e.bx!=null){const m=Math.round((x1+e.bx)/2),cl="e cl"+(on[e.f]&&byId[sel]&&byId[sel].parent===e.f?" on":"");return"<path class=\\""+cl+"\\" d=\\""+(Math.abs(y1-e.by)<1?"M"+x1+","+y1+" L"+e.bx+","+e.by:"M"+x1+","+y1+" C"+m+","+y1+" "+m+","+e.by+" "+e.bx+","+e.by)+"\\"/>"}const b=pos[e.t],x2=b.x,y2=b.y+CH/2,m=Math.round((x1+x2)/2),cl="e"+(on[e.f]&&on[e.t]?" on":"")+(byId[e.t]&&byId[e.t].pruned?" pr":"");return"<path class=\\""+cl+"\\" d=\\""+(Math.abs(y1-y2)<1?"M"+x1+","+y1+" L"+x2+","+y2:"M"+x1+","+y1+" C"+m+","+y1+" "+m+","+y2+" "+x2+","+y2)+"\\"/>"}).join("");' +
      'const nd=N.map(n=>{const q=pos[n.id],cl="nd"+(n.state==="current"?" cur":"")+(n.pruned?" pr":"")+(n.id===sel?" sel":""),dt=(n.aspects||[]).map(a=>"<i class=\\""+(a==="object"?"obj":a==="observability"?"obs":"rub")+"\\"></i>").join("");const st=stMap[n.state]||"";return"<button class=\\""+cl+"\\" data-id=\\""+esc(n.id)+"\\" style=\\"left:"+q.x+"px;top:"+q.y+"px;width:"+CW+"px;height:"+CH+"px\\"><div class=\\"top\\"><span class=\\"id\\">"+esc(n.id)+"</span><span class=\\"val\\">"+esc(n.value!=null?String(n.value):"—")+"</span></div><div class=\\"subt\\">"+esc(n.tag||(n.value==null&&n.headlineBrief?n.headlineBrief:n.changeShort)||"")+"</div><div class=\\"foot\\"><span class=\\"dots\\">"+dt+"</span><span>"+esc(n.pruned?st:n.deltaText||st)+"</span></div></button>"}).join("");' +
      'cv.innerHTML=bx+"<svg class=\\"edges\\" width=\\""+W+"\\" height=\\""+H+"\\">"+ep+"</svg>"+nd;cv.querySelectorAll(".nd").forEach(b=>b.onclick=()=>{sel=b.dataset.id;render()});const n=byId[sel]||N[0];if(!n)return;const sd=D.selectedDetail&&D.selectedDetail.id===n.id?D.selectedDetail:null;const st=stMap[n.state]||n.state||"";' +
      'const asp=n.aspectKind==="baseline"?(L.baseline||"Baseline"):(n.aspects&&n.aspects.length?n.aspects.map(a=>a==="object"?(L.obj||a):a==="observability"?(L.obs||a):(L.rub||a)).join(" · "):(L.unlabeled||"Unlabeled"));' +
      'const actTxt=(sd&&sd.causality&&sd.causality.action)||n.changeBrief||n.changeShort||"—";const basTxt=(sd&&sd.causality&&sd.causality.basisText)||n.headlineBrief||"";' +
      'document.getElementById("as").innerHTML="<h2 style=\\"margin:0 0 6px;font-size:17px\\">"+esc(n.id)+" <span class=\\"pill\\">"+esc(st)+"</span>"+(n.tag?" <span class=\\"pill\\">"+esc(n.tag)+"</span>":"")+"</h2><div style=\\"font-size:12px;color:var(--muted);margin-bottom:12px\\">"+esc((n.parent?n.parent+" → ":"")+(n.metricVersion||"")+(n.commitShort?" · "+n.commitShort:"")+" · "+asp+(n.annotatedBy?" · "+(L.annotatedBy||"Source")+": "+n.annotatedBy:""))+"</div>"+' +
      '"<div style=\\"font-size:13px;margin-bottom:12px\\"><b>"+esc(D.metric&&D.metric.name||L.metric||"Metric")+": </b>"+esc(n.valueText||"—")+(n.deltaText?" ("+esc((n.comparable?(L.sameScale||"Same-scale"):(L.refDelta||"Ref"))+" "+n.deltaText)+")":"")+"</div>"+' +
      '"<div class=\\"chain\\"><p><b>"+esc(L.lblAction||"Change")+": </b>"+esc(actTxt)+"</p>"+(basTxt?"<p><b>"+esc(L.lblBasis||"Basis")+": </b>"+esc(basTxt)+"</p>":"")+"</div>"+' +
      '((sd&&sd.receipts&&sd.receipts.length)?"<table><thead><tr><th>"+esc(L.colSeed||"seed")+"</th><th>"+esc(L.colState||"status")+"</th><th>"+esc(L.colCommit||"commit")+"</th><th>"+esc(L.colNote||"note")+"</th></tr></thead><tbody>"+sd.receipts.map(r=>"<tr><td>"+esc(r.seed)+"</td><td>"+esc(r.state)+"</td><td>"+esc(r.commit||"—")+"</td><td>"+esc(r.jobId||r.error||"—")+"</td></tr>").join("")+"</tbody></table>":"")}render()})();</script></body></html>';
  }
  function downloadStandaloneHtml(data) {
    try {
      const html = buildStandaloneHtml(data);
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'rsi-lineage-' + String(data.objectiveId || 'export').replace(/[^a-zA-Z0-9_-]/g, '') + '.html';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (_) {}
  }
  const onClick = function (ev) {
    const btn = ev.target && ev.target.closest && ev.target.closest('[data-rsi-map-act]');
    if (!btn) return;
    const wrap = btn.closest('.rsi-map-wrap');
    if (!wrap) return;
    const act = btn.getAttribute('data-rsi-map-act');
    if (act === 'export-html') {
      const dataEl = wrap.querySelector('.rsi-map-data');
      if (!dataEl) return;
      try { downloadStandaloneHtml(JSON.parse(dataEl.textContent || '{}')); } catch (_) {}
      return;
    }
    if (act === 'toggle-fold' || act === 'expand-all' || act === 'collapse-all') {
      const objId = wrap.getAttribute('data-obj-id') || 'default';
      const store = (hostGlobal.__rsiMapExpanded = hostGlobal.__rsiMapExpanded || {});
      const map = (store[objId] = store[objId] || {});
      if (act === 'toggle-fold') {
        const fk = btn.getAttribute('data-fold-key');
        if (fk) {
          const wasOpen = btn.getAttribute('data-fold-open') === '1';
          map[fk] = !wasOpen;
        }
      } else if (act === 'expand-all') {
        store[objId] = { '*': true };
      } else {
        store[objId] = { '*': false };
      }
      rerenderCanvasInPlace(wrap);
      return;
    }
    applyZoom(wrap, act);
  };
  const onScrollWheel = function (ev) {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    const scroll = ev.currentTarget;
    const wrap = scroll && scroll.closest && scroll.closest('.rsi-map-wrap');
    if (!wrap) return;
    ev.preventDefault();
    const cur = parseFloat(wrap.getAttribute('data-zoom') || '1') || 1;
    const step = ev.deltaY < 0 ? 1.08 : 1 / 1.08;
    setZoom(wrap, cur * step, ev);
  };
  const onPointerOver = function (ev) {
    const scroll = ev.target && ev.target.closest && ev.target.closest('.rsi-map-scroll');
    if (!scroll || scroll.__rsiWheelBound) return;
    scroll.__rsiWheelBound = true;
    scroll.addEventListener('wheel', onScrollWheel, { passive: false });
  };
  hostGlobal.__rsiMapClickHandler = onClick;
  hostGlobal.__rsiMapPointerOverHandler = onPointerOver;
  document.addEventListener('click', onClick);
  document.addEventListener('pointerover', onPointerOver, { passive: true });
})();
