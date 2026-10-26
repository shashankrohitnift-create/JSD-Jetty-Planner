/* Extra resources screen: if a ship combination is NO, find what to add (jetty length, loaders/unloaders,
   yard space) to make it YES, in the priority order the user sets. Uses the unchanged simulation on the server. */
const RSC = {
  order: ['jetty', 'equip', 'yard'],
  limits: { jettyStep: 25, jettyMax: 300, equipMax: 4, yardStepPct: 10, yardMaxPct: 100 },
  key: '', out: null, busy: false, err: '',
};
const RSC_NAME = { jetty: 'Extra jetty length', equip: 'Extra loaders and unloaders', yard: 'Extra RM and HBI yard space' };
const RSC_LIMITS = [['jettyStep', 'Jetty length step', 'm'], ['jettyMax', 'Most extra jetty length', 'm'], ['equipMax', 'Most extra machines', 'nos'],
  ['yardStepPct', 'Yard space step', '% of each yard'], ['yardMaxPct', 'Most extra yard space', '% of each yard']];
const rscKey = () => RUN ? `${RUN.id}|${SEL.i}|${SEL.e}|${SEL.l || ''}` : '';

function renderRes() {
  const pane = $('#pane-res'); if (!pane) return;
  if (!RUN || !DETAIL) { pane.innerHTML = `<div class="card empty">No saved runs yet. Select <b>Run simulation</b> first.</div>`; return; }
  if (RSC.key !== rscKey()) { RSC.out = null; RSC.err = ''; }
  const r = RES[ckey(SEL.i, SEL.e, SEL.l)] || DETAIL.result, SB = slabRun();
  const IM = [...new Set(RUN.results.map(x => x.im))], EX = [...new Set(RUN.results.map(x => x.ex))], SL = [...new Set(RUN.results.map(x => x.sl))];
  const opts = (sel, list) => list.map(m => `<option value="${m}" ${sel === m ? 'selected' : ''}>${mixName(RP, m)}</option>`).join('');
  const prio = RSC.order.map((c, i) => `<label for="rsc-p${i}">${['1st', '2nd', '3rd'][i]} priority<select id="rsc-p${i}" data-prio="${i}">${
    Object.keys(RSC_NAME).map(k => `<option value="${k}" ${k === c ? 'selected' : ''}>${RSC_NAME[k]}</option>`).join('')}</select></label>`).join('');
  let h = `<div class="card">
    <div class="card-h"><div><div class="eyebrow">Extra resources</div><h2>If the jetty is not enough, what has to be added?</h2></div>
    </div>
    <div class="sel-row"><label for="rsc-i">Import fleet<select id="rsc-i">${opts(SEL.i, IM)}</select></label><label for="rsc-e">Export fleet<select id="rsc-e">${opts(SEL.e, EX)}</select></label>
      ${SB ? `<label for="rsc-l">Slab fleet<select id="rsc-l">${opts(SEL.l, SL)}</select></label>` : ''}
      <span class="vbadge ${r.feasible ? 'yes' : 'no'}">${r.inelig ? 'N/A' : r.feasible ? 'YES' : 'NO'}</span></div>
    <h3>Priority</h3>
    
    <div class="sel-row">${prio}</div>
    <h3>Limits for the search</h3>
    <div class="sel-row">${RSC_LIMITS.map(([k, l, u]) => `<label for="rsc-${k}">${l} <small>(${u})</small><input type="number" id="rsc-${k}" data-lim="${k}" value="${RSC.limits[k]}" min="0" step="any" style="width:110px"></label>`).join('')}</div>
    <div class="sel-row"><button class="btn" id="rsc-go" ${RSC.busy || r.inelig ? 'disabled' : ''}>${RSC.busy ? 'Searching…' : 'Find extra resources'}</button>
      ${r.inelig ? '<span class="note">A ship class in this fleet cannot use the jetty at all; pick another combination.</span>' : ''}</div>
  </div>`;
  if (RSC.err) h += `<div class="banner err">${esc(RSC.err)}</div>`;
  if (RSC.out) h += rscResult(RSC.out) + rscDiagnosis(RSC.out);
  pane.innerHTML = h;
}

// "Why it is NO, in detail": facts, cause, what the most of each resource did, and a checked fix
function rscDiagnosis(o) {
  if (!o.diagnosis || !o.diagnosis.length) return '';
  const cols = ['jetty', 'equip', 'yard', 'all'];
  const colName = c => {
    if (c === 'all') return 'All three at most';
    const a = rscAdds(o.atMax[c], c); return `${RSC_NAME[c].replace('Extra ', '')}<br><small>${a.v}</small>`; };
  const items = o.diagnosis.map((d, i) => {
    const when = d.periods && d.periods.length ? `<li>When: ${d.periods.slice(0, 6).map(p => `${hstr(p.start)} for ${fmtN(p.hours)} h`).join('; ')}${d.periods.length > 6 ? ` and ${d.periods.length - 6} more` : ''}.</li>` : '';
    const eff = `<div class="tw"><table class="t"><thead><tr><th>${esc(d.title.split(' ').slice(0, 3).join(' '))}…</th><th>Now</th>${cols.map(c => `<th>${colName(c)}</th>`).join('')}</tr></thead><tbody>
      <tr><td class="l">Value</td><td>${rscVal(d.check, o.base[d.check])}</td>${cols.map(c => `<td>${d.effects[c].text}${d.effects[c].changed ? '' : ' <span class="pill na">no change</span>'}</td>`).join('')}</tr></tbody></table></div>`;
    const why = ['jetty', 'equip', 'yard'].filter(c => d.resourceWhy && d.resourceWhy[c])
      .map(c => `<li><b>${RSC_NAME[c]}:</b> ${esc(d.resourceWhy[c])}</li>`).join('');
    const v = d.verified;
    const checked = v ? `<p class="note">Checked by simulation: with ${fmtT(v.rmInit)} RM opening stock the plant is starved ${fmtN(v.stockoutH)} h and this combination is
      <span class="pill ${v.feasible ? 'yes' : 'no'}">${v.feasible ? 'YES' : 'NO'}</span> (berth occupancy ${fmtN(v.occ, 1)}%)${v.feasible ? '' : `; still failing: ${v.reasons.map(esc).join('; ')}`}.
      The saved run is not changed; enter it under Plant &amp; yards and run again to keep it.</p>` : '';
    return `<div class="card"><div class="card-h"><div><div class="eyebrow">Failed check ${i + 1} of ${o.diagnosis.length}</div><h3>✗ ${esc(d.title)}</h3></div></div>
      <h3>What happened</h3><ul class="reasons">${d.facts.map(f => `<li>${esc(f)}</li>`).join('')}${when}</ul>
      <h3>Why</h3><p>${esc(d.cause)}</p>
      <h3>What the most of each resource did</h3>${eff}
      ${why ? `<ul class="reasons">${why}</ul>` : ''}
      <h3>What would fix it</h3><p>${esc(d.fix)}</p>${checked}</div>`;
  }).join('');
  return `<div class="card"><div class="card-h"><div><div class="eyebrow">In detail</div><h2>${o.found ? 'Why it is NO now' : 'Why it is not possible with jetty resources'}</h2></div>
    </div></div>${items}`;
}
function rscVal(k, v) {
  if (k === 'occ') return fmtN(v, 1) + '%';
  if (/H$/.test(k)) return fmtN(v) + ' h';
  return fmtT(v);
}

function rscAdds(d, cat) {
  if (cat === 'jetty') return { v: d.jetty.add ? `+${fmtN(d.jetty.add)} m` : 'none', s: `${fmtN(d.jetty.from)} m → ${fmtN(d.jetty.to)} m` };
  if (cat === 'equip') {
    const parts = [['sulN', 'SUL'], ['loaderN', 'loader'], ['slabCraneN', 'slab crane']].filter(([k]) => d.equip[k].add)
      .map(([k, n]) => `+${d.equip[k].add} ${n}${d.equip[k].add > 1 ? 's' : ''}`);
    const now = [['sulN', 'SUL'], ['loaderN', 'loader'], ['slabCraneN', 'slab crane']].filter(([k]) => d.equip[k].add)
      .map(([k, n]) => `${n} ${d.equip[k].from} → ${d.equip[k].to}`);
    return { v: parts.join(', ') || 'none', s: now.join(' · ') || 'machines as they are' };
  }
  const y = d.yard;
  return { v: y.pct ? `+${fmtN(y.pct)}%` : 'none',
    s: y.pct ? `RM +${fmtT(y.rmYardCap.add)} (to ${fmtT(y.rmYardCap.to)}) · HBI +${fmtT(y.fgYardCap.add)} (to ${fmtT(y.fgYardCap.to)})${slabRun() ? ` · slab +${fmtT(y.slabYardCap.add)}` : ''}` : 'yards as they are' };
}

function rscResult(o) {
  const b = o.base;
  if (b.feasible) return `<div class="card"><ul class="reasons"><li class="ok">✓ This combination is already YES (berth occupancy ${fmtN(b.occ, 1)}%). Nothing extra is needed.</li></ul></div>`;
  const pkg = o.found || o.best, res = pkg.result;
  const cards = o.order.map((c, i) => { const a = rscAdds(pkg, c);
    return kpi(`${['1st', '2nd', '3rd'][i]} · ${RSC_NAME[c]}`, a.v, a.s, a.v === 'none' ? '' : 'ok'); }).join('');
  const row = (l, x, y, f = v => v) => `<tr><td class="l">${l}</td><td>${f(x)}</td><td>${f(y)}</td></tr>`;
  const SB = slabRun();
  let h = `<div class="card">
    <div class="card-h"><div><div class="eyebrow">${o.found ? 'Answer' : 'Not reachable within the limits'}</div>
    <h2>${o.found ? 'Add this to turn the combination YES' : 'Even the most allowed is not enough; this came closest'}</h2></div>
    <span class="vbadge ${res.feasible ? 'yes' : 'no'}">${res.feasible ? 'YES' : 'NO'}</span></div>
    <div class="kpis">${cards}</div>
    <div class="split"><div><h3>Before and after</h3><div class="tw"><table class="t"><thead><tr><th>Check</th><th>Now</th><th>With the additions</th></tr></thead><tbody>
      ${row('Berth occupancy', b.occ, res.occ, v => fmtN(v, 1) + '%')}
      ${row('Berth positions', b.berths, res.berths)}
      ${row('RM imported in 1 year', b.imported, res.imported, fmtT)}
      ${row('HBI exported in 1 year', b.exported, res.exported, fmtT)}
      ${SB ? row('Slab exported in 1 year', b.slabExported, res.slabExported, fmtT) : ''}
      ${row('Plant starved of RM', b.stockoutH, res.stockoutH, v => fmtN(v) + ' h')}
      ${row('HBI yard full', b.fgFullH, res.fgFullH, v => fmtN(v) + ' h')}
      ${SB ? row('Slab yard full (SMS stopped)', b.slabFullH, res.slabFullH, v => fmtN(v) + ' h') : ''}
      ${row('Average ship waiting', b.avgIdle, res.avgIdle, v => fmtN(v, 1) + ' h')}
    </tbody></table></div></div>
    <div><h3>Why it was NO</h3><ul class="reasons">${b.reasons.map(x => `<li class="bad">✗ ${esc(x)}</li>`).join('')}</ul>
      ${res.feasible ? '' : `<h3>Still failing</h3><ul class="reasons">${res.reasons.map(x => `<li class="bad">✗ ${esc(x)}</li>`).join('')}</ul>
      <p class="note">Jetty length, machines and yard space cannot fix these. Look at the other inputs instead${
        res.stockoutH > 0 && !(+RP.rmInit) ? `: the RM opening stock is 0 t, so the plant has no RM until the first ship has discharged. An opening stock covers that start.`
        : ' (for example opening stock, plant output or the targets).'}</p>`}</div></div>
  </div>
  <div class="card"><div class="card-h"><div><div class="eyebrow">For comparison</div><h3>Each resource on its own</h3></div>
    </div>
    <div class="tw"><table class="t"><thead><tr><th>Resource</th><th>Least that works alone</th><th>Detail</th><th>Occupancy</th></tr></thead><tbody>
    ${['jetty', 'equip', 'yard'].map(c => { const a = o.alone[c];
      if (!a) return `<tr><td class="l">${RSC_NAME[c]}</td><td colspan="3" class="l"><span class="pill no">cannot fix it alone</span> within the limits</td></tr>`;
      const x = rscAdds(a, c); return `<tr><td class="l">${RSC_NAME[c]}</td><td>${x.v}</td><td class="l">${x.s}</td><td>${fmtN(a.result.occ, 1)}%</td></tr>`; }).join('')}
    </tbody></table></div>
    
  </div>`;
  return h;
}

document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset && t.dataset.prio !== undefined) {
    const i = +t.dataset.prio, j = RSC.order.indexOf(t.value);
    [RSC.order[i], RSC.order[j]] = [t.value, RSC.order[i]];
    RSC.out = null; renderRes(); return;
  }
  if (t.dataset && t.dataset.lim) { const v = parseFloat(t.value); if (!isNaN(v)) RSC.limits[t.dataset.lim] = v; RSC.out = null; return; }
  if (['rsc-i', 'rsc-e', 'rsc-l'].includes(t.id)) {
    const s = { ...SEL, [t.id.slice(-1)]: t.value };
    try { await selectCombo(s.i, s.e, s.l); } catch (err) { ERR = err.message; renderBanner(); }
  }
});
document.addEventListener('click', async e => {
  if (e.target.id !== 'rsc-go' || RSC.busy) return;
  RSC.busy = true; RSC.err = ''; RSC.key = rscKey(); renderRes();
  try {
    RSC.out = await api('POST', `/api/runs/${RUN.id}/combos/${SEL.i}/${SEL.e}/resources${SEL.l ? '?sl=' + SEL.l : ''}`, { order: RSC.order, limits: RSC.limits });
  } catch (err) { RSC.err = err.message; RSC.out = null; }
  RSC.busy = false; renderRes();
});

// draw this screen whenever the planner redraws the others
const _renderAllBase = renderAll, _renderEmptyBase = renderEmpty;
renderAll = function () { _renderAllBase(); renderRes(); };
renderEmpty = function () { _renderEmptyBase(); renderRes(); };
renderRes();
