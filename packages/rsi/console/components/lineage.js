'use strict';

PDL_COMPONENTS['plugin:official.rsi/rsiLineage'] = function (p, sc, root) {
  const rows = pvList(p.from, sc, root), keyOf = function (r) { return pv(p.key, r, root); }, parentOf = function (r) { return pv(p.parent, r, root); };
  const keys = rows.map(keyOf), kids = {}, roots = [];
  rows.forEach(function (r) { const pk = parentOf(r); if (pk != null && keys.indexOf(pk) >= 0) (kids[pk] = kids[pk] || []).push(r); else roots.push(r); });
  const out = [];
  (function walk(list, depth, rails) {
    list.forEach(function (r, i) {
      const last = i === list.length - 1, own = kids[keyOf(r)] || [];
      out.push({ r: r, depth: depth, last: last, rails: rails, down: own.length > 0 });
      walk(own, depth + 1, depth === 0 ? [] : rails.concat([!last]));
    });
  })(roots, 0, []);
  const n = p.node || {};
  return '<div class="scroll stick-end rsi-lin-box"><div class="scroll-x"><div class="rsi-lin">' + out.map(function (x) {
    const r = x.r, state = pv(n.state, r, root);
    const lines = x.rails.map(function (on, l) { return on ? '<span class="rsi-lin-rail" style="--l:' + (l + 1) + '"></span>' : ''; }).join('') +
      (x.depth ? '<span class="rsi-lin-elbow' + (x.last ? ' last' : '') + '" style="--l:' + x.depth + '"></span>' : '') +
      (x.down ? '<span class="rsi-lin-down" style="--l:' + (x.depth + 1) + '"></span>' : '');
    const node = chipHtml({ cls: 'rsi-lin-v', label: pvParts(n.label, r, root), tone: pv(n.tone, r, root), pressed: n.pressed ? !!pv(n.pressed, r, root) : null,
      act: n.act, data: n.act ? pvArgs(n.args, r, root) : '', attrs: state ? ' data-state="' + h(state) + '"' : '' });
    const tail = p.tail ? pvParts(p.tail, r, root) : '';
    return '<div class="rsi-lin-row" style="--d:' + x.depth + '">' + lines + node + pvControls(p.cells, r, root) + (tail ? '<span class="rsi-lin-tail">' + tail + '</span>' : '') + '</div>';
  }).join('') + '</div></div></div>';
};

PDL_COMPONENTS['plugin:official.rsi/rsiTrend'] = function (p, sc, root) {
  const xs = pvList(p.from, sc, root), vs = xs.map(function (x) { return x.value; }), lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs), W = 560, H = 120, pad = 28;
  const pt = function (x, i) { return [pad + i * (W - 2 * pad) / Math.max(1, xs.length - 1), H - pad - (hi === lo ? 0.5 : (x.value - lo) / (hi - lo)) * (H - 2 * pad)]; };
  const pts = xs.map(pt);
  return '<svg class="rsi-trend" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + h(pvText(p.label, sc, root)) + '">' +
    '<polyline points="' + pts.map(function (q) { return q.join(','); }).join(' ') + '"/>' +
    xs.map(function (x, i) { const q = pts[i], moved = i > 0 && xs[i - 1].version !== x.version;
      return '<circle cx="' + q[0] + '" cy="' + q[1] + '" r="4"' + (moved ? ' class="moved"' : '') + '/><text x="' + q[0] + '" y="' + (q[1] - 9) + '">' + h(String(x.value)) + '</text>' +
        '<text class="axis" x="' + q[0] + '" y="' + (H - 6) + '">' + h(x.version + ' · ' + x.n) + '</text>'; }).join('') + '</svg>';
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
  const W = 132, H = 52, GX = 28, GY = 12, PAD = 8;
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
  const sel = steps.find(function (s) { return s.selected; }), selK = sel ? sel.k : '';
  const edges = [];
  steps.forEach(function (s) {
    (s.depKeys || []).forEach(function (dk) {
      if (pos[dk] && pos[s.k]) edges.push({ from: dk, to: s.k, done: byKey[dk].stage === 'done', active: selK && (dk === selK || s.k === selK) });
    });
  });
  // Draw inactive edges first so highlighted edges stay cleanly on top.
  edges.sort(function (a, b) { return (a.active ? 1 : 0) - (b.active ? 1 : 0); });
  const svgPaths = edges.map(function (e) {
    const a = pos[e.from], b = pos[e.to];
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    const span = b.c - a.c;
    let d;
    if (span <= 1) {
      const mx = Math.round((x1 + x2) / 2);
      d = 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2;
    } else {
      // Multi-column skip edge: travel horizontally past intermediate column in a clear top/bottom lane, then turn smoothly into target.
      const clearX = pos[e.to].x - Math.round(GX * 0.55);
      const goTop = y1 <= totalH / 2 && y2 <= totalH / 2;
      const laneY = goTop ? Math.max(4, PAD - 2) : Math.min(totalH - 4, totalH - PAD + 2);
      const stayInRow = Math.abs(y1 - totalH / 2) > H * 0.55;
      const midY = stayInRow ? y1 : laneY;
      d = 'M' + x1 + ',' + y1 + ' C' + (x1 + Math.round(GX * 0.6)) + ',' + midY + ' ' + clearX + ',' + midY + ' ' + clearX + ',' + Math.round((midY + y2) / 2) +
        ' S' + (x2 - Math.round(GX * 0.45)) + ',' + y2 + ' ' + x2 + ',' + y2;
    }
    const cls = 'rsi-dag-edge' + (e.done ? ' done' : '') + (e.active ? ' active' : '');
    return '<path class="' + cls + '" d="' + d + '"' + (e.active ? ' marker-end="url(#rsi-dag-arr-on)"' : ' marker-end="url(#rsi-dag-arr)"') + '/>';
  }).join('');
  const svg = '<svg class="rsi-dag-svg" width="' + totalW + '" height="' + totalH + '" viewBox="0 0 ' + totalW + ' ' + totalH + '" aria-hidden="true">' +
    '<defs><marker id="rsi-dag-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,1 L7,4 L0,7 z" class="rsi-dag-arr"/></marker>' +
    '<marker id="rsi-dag-arr-on" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,1 L7,4 L0,7 z" class="rsi-dag-arr active"/></marker></defs>' +
    svgPaths + '</svg>';
  const stageLabels = p.stages || {};
  const labelOf = function (st) { return stageLabels[st] ? pvText(stageLabels[st], sc, root) : st; };
  const legend = '<div class="rsi-dag-legend">' + ['waiting', 'running', 'pending', 'done', 'error'].map(function (st) {
    return '<span class="rsi-dag-leg" data-stage="' + st + '"><i class="rsi-dag-dot"></i>' + h(labelOf(st)) + '</span>';
  }).join('') + '</div>';
  const nodes = steps.map(function (s) {
    const q = pos[s.k];
    const title = p.title ? pvText(p.title, s, root) : (s.i + ' ' + s.k);
    const meta = [labelOf(s.stage), s.owner || ''].filter(Boolean).join(' · ');
    const badge = s.needCount > 0 && s.stage === 'pending' ? '<span class="rsi-dag-badge">' + s.needCount + '</span>' : '';
    const actAttr = p.act ? ' data-act="' + h(p.act) + '"' + pvArgs(p.args, s, root) : ' data-act="plugSet" data-plugin="official.rsi" data-k="initStep" data-v="' + h(s.k) + '"';
    return '<button type="button" class="rsi-dag-node" data-step="' + h(s.k) + '" data-stage="' + h(s.stage) + '" aria-pressed="' + (s.selected ? 'true' : 'false') + '"' + actAttr +
      ' style="left:' + q.x + 'px;top:' + q.y + 'px;width:' + W + 'px;height:' + H + 'px">' +
      '<span class="rsi-dag-top"><i class="rsi-dag-dot"></i><span class="rsi-dag-name">' + h(title) + '</span>' + badge + '</span>' +
      '<span class="rsi-dag-sub">' + h(meta) + '</span></button>';
  }).join('');
  return '<div class="rsi-dag-wrap">' + legend + '<div class="scroll-x rsi-dag-scroll"><div class="rsi-dag-canvas" style="width:' + totalW + 'px;height:' + totalH + 'px">' + svg + nodes + '</div></div></div>';
};
