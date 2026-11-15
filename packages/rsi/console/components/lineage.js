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
