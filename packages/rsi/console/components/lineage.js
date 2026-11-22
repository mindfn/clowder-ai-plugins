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
      if (r.selected || r.nodeSelected || (n.pressed && pv(n.pressed, r, root)) || st === 'current' || st === 'running') pinned[k] = true;
      if ((kids[k] || []).length > 1) pinned[k] = true;
      if (pk != null && (kids[pk] || []).length > 1) pinned[k] = true;
    });
  }
  const labelTextOf = function (r) {
    if (r && r.id != null) return String(r.id);
    const raw = pvParts(n.label, r, root);
    return String(raw || keyOf(r) || '').replace(/<[^>]*>/g, '').trim();
  };
  const renderNodeRow = function (r, depth, lines, insideBox) {
    const state = pv(n.state, r, root);
    const node = chipHtml({ cls: 'rsi-lin-v', label: pvParts(n.label, r, root), tone: pv(n.tone, r, root), pressed: n.pressed ? !!pv(n.pressed, r, root) : null,
      act: n.act, data: n.act ? pvArgs(n.args, r, root) : '', attrs: state ? ' data-state="' + h(state) + '"' : '' });
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
    const chain = [node].concat(cellList).join(arr);
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
  const padX = 42, padTop = 26, padBot = 26, H = 132;
  const W = Math.max(360, padX * 2 + Math.max(1, xs.length - 1) * 76);
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
      '<text class="axis' + (isCur ? ' current' : '') + '" x="' + q[0].toFixed(1) + '" y="' + (H - 7) + '">' + h(axisLabel) + '</text>';
  }).join('');
  const aria = series && series.name ? series.name : pvText(p.label, sc, root);
  return '<div class="rsi-trend-wrap"><div class="scroll-x rsi-trend-scroll"><svg class="rsi-trend" style="' + svgStyle + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + h(aria) + '">' +
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
          const deltaHtml = lead && lead.delta != null
            ? '<span class="rsi-mx-delta" data-better="' + h(lead.better || '') + '">' + h(lead.delta) + '</span>'
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
