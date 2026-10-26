/* Vessel plan screen: for the selected ship combination, the feasibility check, the month-by-month
   vessel plan (ships and tonnes of RM, HBI and slab, jetty busy share) and the full list of calls with a CSV
   download. Reads the saved run's result and call schedule; the calculation itself is not changed. */
function vpMonths() {
  const days = CAL().days, yd = CAL().yearDays, months = [];
  days.slice(0, yd).forEach(d => {
    let m = months[d.mi];
    if (!m) m = months[d.mi] = { mi: d.mi, label: MON[d.m] + ' ' + d.y, h0: d.i * 24, h1: d.i * 24 };
    m.h1 = (d.i + 1) * 24;
  });
  return months.filter(Boolean);
}

function vpPlan(r) {
  const months = vpMonths(), berths = r.berths || 1;
  return months.map(m => {
    const row = { label: m.label, hours: m.h1 - m.h0, I: [0, 0], E: [0, 0], L: [0, 0], used: 0 };
    r.log.forEach(s => {
      if (s.berthH >= m.h0 && s.berthH < m.h1) { row[s.dir][0]++; row[s.dir][1] += s.qty; }
      const end = s.departH != null ? s.departH : r.NH;
      row.used += Math.max(0, Math.min(end, m.h1) - Math.max(s.berthH, m.h0));
    });
    row.busy = row.used / (row.hours * berths) * 100;
    return row;
  });
}

function vpChecks(r) {
  const tol = 1 - RP.tol / 100, SB = slabRun(), has = t => (r.reasons || []).some(x => x.includes(t));
  const rows = [
    [r.imported >= RP.rmTarget * tol, 'RM import', `${fmtT(r.imported)} of ${fmtT(RP.rmTarget)}`],
    [r.exported >= RP.fgTarget * tol, 'HBI export', `${fmtT(r.exported)} of ${fmtT(RP.fgTarget)}`],
  ];
  if (SB) rows.push([r.slabExported >= RP.slabTarget * tol, 'Slab export', `${fmtT(r.slabExported)} of ${fmtT(RP.slabTarget)}`]);
  rows.push([!r.stockoutH, 'Plant never short of RM', `${fmtN(r.stockoutH)} h short`]);
  rows.push([!r.fgFullH, 'HBI yard never full', `${fmtN(r.fgFullH)} h full`]);
  if (SB) {
    rows.push([!r.slabFullH, 'Slab yard never full', `${fmtN(r.slabFullH)} h full`]);
    rows.push([!has('SMS short'), 'SMS always has its HBI', has('SMS short') ? (r.reasons.find(x => x.includes('SMS short'))) : 'never short']);
  }
  rows.push([r.occ <= RP.maxOcc, `Jetty busy within ${fmtN(RP.maxOcc)}%`, `${fmtN(r.occ, 1)}% of ${r.berths} berths’ time`]);
  return rows;
}

function vpCsv(r) {
  const head = ['Call', 'Cargo', 'Ship', 'Tonnes', 'Arrive', 'Cargo start', 'Cargo end', 'Sail', 'Hours at jetty', 'Waiting h'];
  const q = v => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [head.map(q).join(',')].concat(r.log.map(s => [s.n, DIRS[s.dir].name, RP.ships[s.t].name, Math.round(s.qty),
    hstr(s.berthH), s.cargoStartH != null ? hstr(s.cargoStartH) : '', s.cargoEndH != null ? hstr(s.cargoEndH) : '',
    s.departH != null ? hstr(s.departH) : 'carried over', s.departH != null ? (s.departH - s.berthH).toFixed(1) : '',
    (s.idle + s.waitTug).toFixed(1)].map(q).join(',')));
  return lines.join('\r\n');
}

function renderVessel() {
  const pane = $('#pane-vplan'); if (!pane) return;
  if (!RUN || !DETAIL) { pane.innerHTML = `<div class="card empty">No saved runs yet. Select <b>Run simulation</b> first.</div>`; return; }
  const r = DETAIL.result, SB = slabRun();
  const IM = [...new Set(RUN.results.map(x => x.im))], EX = [...new Set(RUN.results.map(x => x.ex))], SL = [...new Set(RUN.results.map(x => x.sl))];
  const opts = (sel, list) => list.map(m => `<option value="${m}" ${sel === m ? 'selected' : ''}>${mixName(RP, m)}</option>`).join('');
  let h = `<div class="card">
    <div class="card-h"><div><div class="eyebrow">Vessel plan</div><h2>${esc(comboTitle())}</h2></div>
    <span class="vbadge ${r.feasible ? 'yes' : 'no'}">${r.inelig ? 'N/A' : r.feasible ? 'FEASIBLE' : 'NOT FEASIBLE'}</span></div>
    <div class="sel-row"><label for="vp-i">Import fleet (RM)<select id="vp-i">${opts(SEL.i, IM)}</select></label>
      <label for="vp-e">Export fleet (HBI)<select id="vp-e">${opts(SEL.e, EX)}</select></label>
      ${SB ? `<label for="vp-l">Slab fleet<select id="vp-l">${opts(SEL.l, SL)}</select></label>` : ''}</div>`;
  if (r.inelig) { pane.innerHTML = h + `<p class="note">${esc(r.reasons[0] || 'A ship class in this fleet cannot use the jetty.')}</p></div>`; return; }
  h += `<h3>Feasibility check</h3><div class="tw"><table class="t"><thead><tr><th>Check</th><th>Result</th><th>Value</th></tr></thead><tbody>
    ${vpChecks(r).map(([ok, a, b]) => `<tr><td class="l">${a}</td><td>${pill(ok, 'OK', 'NOT MET')}</td><td class="l">${esc(b)}</td></tr>`).join('')}
    </tbody></table></div>
    ${r.feasible ? '' : ``}</div>`;
  const plan = vpPlan(r), tot = plan.reduce((a, m) => { ['I', 'E', 'L'].forEach(k => { a[k][0] += m[k][0]; a[k][1] += m[k][1]; }); a.used += m.used; a.hours += m.hours; return a; },
    { I: [0, 0], E: [0, 0], L: [0, 0], used: 0, hours: 0 });
  const cell = (v, t) => `<td>${v[0]}</td><td>${fmtN(v[1] / 1000)}</td>`;
  h += `<div class="card"><div class="card-h"><div><div class="eyebrow">Month by month</div><h3>Ships and tonnes per month</h3></div>
    </div>
    <div class="tw"><table class="t"><thead><tr><th>Month</th><th>RM ships</th><th>RM kt</th><th>HBI ships</th><th>HBI kt</th>${SB ? '<th>Slab ships</th><th>Slab kt</th>' : ''}<th>All ships</th><th>Jetty busy</th></tr></thead><tbody>
    ${plan.map(m => `<tr><td class="l">${m.label}</td>${cell(m.I)}${cell(m.E)}${SB ? cell(m.L) : ''}<td>${m.I[0] + m.E[0] + m.L[0]}</td><td>${fmtN(m.busy, 1)}%</td></tr>`).join('')}
    <tr style="font-weight:600"><td class="l">Year (${CAL().yearDays} days)</td>${cell(tot.I)}${cell(tot.E)}${SB ? cell(tot.L) : ''}<td>${tot.I[0] + tot.E[0] + tot.L[0]}</td><td>${fmtN(tot.used / (tot.hours * r.berths) * 100, 1)}%</td></tr>
    </tbody></table></div></div>`;
  h += `<div class="card"><div class="card-h"><div><div class="eyebrow">Every call</div><h3>${r.log.length} ship calls</h3></div>
    <button class="btn-q" id="vp-csv">Download as CSV</button></div>
    <div class="tw" style="max-height:520px;overflow:auto"><table class="t"><thead><tr><th>#</th><th>Cargo</th><th>Ship</th><th>Tonnes</th><th>Arrive</th><th>Cargo start</th><th>Cargo end</th><th>Sail</th><th>Hours at jetty</th><th>Waiting h</th></tr></thead><tbody>
    ${r.log.map(s => `<tr><td>${s.n}</td><td class="l"><span class="dot ${DIRS[s.dir].dot}"></span>${DIRS[s.dir].name}</td><td class="l">${RP.ships[s.t].name}</td><td>${fmtN(s.qty)}</td><td>${hstr(s.berthH)}</td><td>${s.cargoStartH != null ? hstr(s.cargoStartH) : '—'}</td><td>${s.cargoEndH != null ? hstr(s.cargoEndH) : '—'}</td><td>${s.departH != null ? hstr(s.departH) : 'carried over'}</td><td>${s.departH != null ? fmtN(s.departH - s.berthH, 1) : '—'}</td><td>${fmtN(s.idle + s.waitTug, 1)}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  pane.innerHTML = h;
}

document.addEventListener('change', async e => {
  if (!['vp-i', 'vp-e', 'vp-l'].includes(e.target.id)) return;
  const s = { ...SEL, [e.target.id.slice(-1)]: e.target.value };
  try { await selectCombo(s.i, s.e, s.l); } catch (err) { ERR = err.message; renderBanner(); }
});
document.addEventListener('click', e => {
  if (e.target.id !== 'vp-csv' || !DETAIL) return;
  const blob = new Blob([vpCsv(DETAIL.result)], { type: 'text/csv' }), a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `vessel-plan-run${RUN.id}-${SEL.i}-${SEL.e}${SEL.l ? '-' + SEL.l : ''}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

const _renderAllVp = renderAll, _renderEmptyVp = renderEmpty;
renderAll = function () { _renderAllVp(); renderVessel(); };
renderEmpty = function () { _renderEmptyVp(); renderVessel(); };
renderVessel();
