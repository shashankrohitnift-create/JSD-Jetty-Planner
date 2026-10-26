/* 2D simulator: plays back the hour-by-hour trace of the selected run and combination.
   Builds the scene state, the playback controls, live figures, charts and the daily table. */
const SIM = {
  key: '', data: null, loading: false, err: '',
  t: 0, playing: false, speed: 6, lastTs: 0, lastDay: -1,
  eq: { sul: [], loader: [], crane: [] },   // eased equipment positions (m along the jetty)
  layout: null, scene: null,
};
const SPEEDS = [[1, '1 hour / s'], [6, '6 hours / s'], [24, '1 day / s'], [72, '3 days / s'], [168, '1 week / s']];
const BEAM = { P: 32, S: 32, H: 30 };
const OFFSHORE = -220;                  // anchorage distance off the berth line (m), drawing only

/* ---------- layout (metres; x along the jetty, y inland, sea at y < 0) ---------- */
function makeLayout(inp) {
  // a wide, flat site so the whole picture fits one screen: yards in a row, plant and SMS below them
  const L = inp.jettyLen, mid = L / 2;
  const rm = { x0: mid - 470, x1: mid - 60, y0: 220, y1: 370 }, fg = { x0: mid + 60, x1: mid + 470, y0: 220, y1: 370 };
  const rmC = (rm.x0 + rm.x1) / 2, fgC = (fg.x0 + fg.x1) / 2;
  const plant = { x0: mid - 90, x1: mid + 90, y0: 425, y1: 565 };
  // steel melt shop below the HBI yard and slab yard beside it, shown only with slab export
  const slab = inp.slabOn, sms = { x0: mid + 300, x1: mid + 470, y0: 425, y1: 565 }, sy = { x0: mid + 540, x1: mid + 800, y0: 425, y1: 565 };
  return {
    L, mid, deckW: 20, shoreY: 140, rm, fg, plant, sms, slabYard: sy, slab, tugBase: { x: L + 90, y: -40 },
    conv: {
      imp: [[mid - 6, 20], [mid - 6, 185], [rmC, 185], [rmC, rm.y0]],
      exp: [[fgC, fg.y0], [fgC, 195], [mid + 6, 195], [mid + 6, 20]],
      feed: [[rmC, rm.y1], [rmC, 460], [plant.x0, 460]],
      out: [[plant.x1, 460], [fgC, 460], [fgC, fg.y1]],
      toSms: [[plant.x1, 530], [sms.x0, 530]],
      yardToSms: [[mid + 400, fg.y1], [mid + 400, sms.y0]],
      smsToYard: [[sms.x1, 495], [sy.x0, 495]],
      slabOut: [[mid + 670, sy.y0], [mid + 670, 175], [mid + 20, 175], [mid + 20, 20]],
    },
    bounds: { x0: Math.min(rm.x0, -80) - 50, x1: Math.max(fg.x1, L + 160, slab ? sy.x1 : 0) + 40, y0: OFFSHORE - 60, y1: (slab ? Math.max(sy.y1, plant.y1) : plant.y1) + 25 },
  };
}

/* ---------- loading ---------- */
async function simLoad() {
  if (!RUN) return;
  const key = simKey();
  if (key === SIM.key || SIM.loading) return;
  SIM.loading = true; SIM.err = ''; simRenderShell();
  try {
    const d = await api('GET', `/api/runs/${RUN.id}/combos/${SEL.i}/${SEL.e}/trace${SEL.l ? '?sl=' + SEL.l : ''}`);
    d.slab = !!d.trace.slab;
    const acts = d.inputs.acts;
    d.pre = acts.filter(a => a.phase === 'pre'); d.post = acts.filter(a => a.phase === 'post');
    d.preMove = 0; while (d.preMove < d.pre.length && d.pre[d.preMove].tug) d.preMove++;
    d.postMove = d.post.findIndex(a => a.tug); if (d.postMove < 0) d.postMove = d.post.length;
    d.byN = {}; d.log.forEach(s => d.byN[s.n] = s);
    d.days = buildDaily(d);
    SIM.data = d; SIM.key = key; SIM.t = 0; SIM.playing = false; SIM.lastDay = -1;
    SIM.layout = makeLayout({ ...d.inputs, slabOn: d.slab });
    SIM.eq = { sul: Array.from({ length: d.inputs.sulN }, (_, i) => 15 + i * 22),
               loader: Array.from({ length: d.inputs.loaderN }, (_, i) => d.inputs.jettyLen - 15 - i * 22),
               crane: d.slab ? cranePark(d.inputs) : [] };
  } catch (e) { SIM.err = e.message; }
  SIM.loading = false; simRenderShell();
}

function simKey() { return `${RUN.id}|${SEL.i}|${SEL.e}|${SEL.l || ''}`; }
function cranePark(inp) { return Array.from({ length: inp.slabCraneN }, (_, i) => inp.jettyLen / 2 - 11 * (inp.slabCraneN - 1) + i * 22); }

function buildDaily(d) {
  const tr = d.trace, ratio = d.inputs.rmRatio, nd = Math.floor(tr.rm.length / 24), out = [];
  for (let i = 0; i < nd; i++) {
    const a = i * 24, b = a + 23, prev = a - 1;
    let prod = 0; for (let h = a; h <= b; h++) prod += tr.prod[h];
    const row = { i, iso: d.calendar.days[i].iso, rmIn: tr.imp[b] - (prev >= 0 ? tr.imp[prev] : 0), rmUsed: prod * ratio,
      rm: tr.rm[b], prod, fgOut: tr.exp[b] - (prev >= 0 ? tr.exp[prev] : 0), fg: tr.fg[b] };
    if (tr.slab) {
      let made = 0, sp = 0, sy = 0; for (let h = a; h <= b; h++) { made += tr.slabMade[h]; sp += tr.smsPlant[h]; sy += tr.smsYard[h]; }
      Object.assign(row, { smsPlant: sp, smsYard: sy, slabMade: made, slabOut: tr.slabExp[b] - (prev >= 0 ? tr.slabExp[prev] : 0), slab: tr.slab[b] });
    }
    out.push(row);
  }
  return out;
}

/* ---------- scene state at time t (hours) ---------- */
function shipEntry(h, n) { const snap = SIM.data.trace.ships[h]; return snap && snap.find(e => e[0] === n); }

function legFrac(h, t, n, ph, ai, act) {
  // hours spent so far in this activity, found by walking back through the hourly record
  if (!act) return 1;   // the last activity has just finished; the ship is leaving this hour
  let h0 = h;
  while (h0 > 0) { const e = shipEntry(h0 - 1, n); if (!e || e[1] !== ph || e[3] !== ai || !e[4]) break; h0--; }
  return Math.min(1, Math.max(0, (t - h0) / Math.max(0.25, act.h)));
}

function berthX(lane, loa, L, endPct) {
  if (lane === 0) return endPct / 100 * loa;
  if (lane === 1) return L - endPct / 100 * loa - loa;
  return L / 2 - loa / 2 + (lane - 2) * 40;
}

function sceneAt(t) {
  const d = SIM.data, tr = d.trace, inp = d.inputs, L = inp.jettyLen, NH = tr.rm.length;
  const h = Math.max(0, Math.min(NH - 1, Math.floor(t))), day = Math.floor(h / 24), hr = h % 24;
  const ships = [];
  for (const e of tr.ships[h]) {
    const [n, ph, rem, ai, tug] = e, lg = d.byN[n], cls = lg.t, loa = inp.ships[cls].loa, beam = BEAM[cls];
    let off = 0, status;
    if (ph === 0) {
      if (ai < d.preMove) {
        const f = tug ? legFrac(h, t, n, 0, ai, d.pre[ai]) : 0;
        off = OFFSHORE * (1 - (ai + f) / d.preMove);
        status = !tug ? 'Waiting for daylight' : ai === 0 ? 'Arriving' : 'Berthing';
      } else status = d.pre[ai] ? d.pre[ai].n : 'Ready for cargo';
    } else if (ph === 1) {
      status = lg.dir === 'I' ? 'Discharging' : 'Loading';
    } else {
      if (ai >= d.postMove) {
        const f = tug ? legFrac(h, t, n, 2, ai, d.post[ai]) : 0;
        off = OFFSHORE * Math.min(1, (ai - d.postMove + f) / Math.max(1, d.post.length - d.postMove));
        status = !tug && d.post[ai] && d.post[ai].tug ? 'Waiting for daylight' : 'Departing';
      } else status = d.post[ai] ? d.post[ai].n : 'Finishing';
    }
    const done = lg.qty ? 1 - rem / lg.qty : 1;
    ships.push({ n, dir: lg.dir, cls, loa, beam, qty: lg.qty, rem, ph, ai, tug: !!tug, status, alpha: 1,
      x0: berthX(lg.lane, loa, L, inp.endPct), y: -(2 + beam / 2) + off, done,
      cargo: lg.dir === 'I' ? rem / lg.qty : 1 - rem / lg.qty });
  }
  // ships that sailed in the last two hours keep moving out to sea and fade
  for (const lg of d.log) {
    if (lg.departH == null || t < lg.departH || t > lg.departH + 2 || ships.some(s => s.n === lg.n)) continue;
    const loa = inp.ships[lg.t].loa, beam = BEAM[lg.t], k = (t - lg.departH) / 2;
    ships.push({ n: lg.n, dir: lg.dir, cls: lg.t, loa, beam, qty: lg.qty, rem: 0, ph: 3, tug: false, status: 'Sailed',
      alpha: 1 - k, x0: berthX(lg.lane, loa, L, inp.endPct), y: -(2 + beam / 2) + OFFSHORE * (1 + k),
      cargo: lg.dir === 'I' ? 0 : 1, done: 1 });
  }
  ships.sort((a, b) => a.n - b.n);
  // only the first RM ship in cargo is discharged; the next waits for the SULs
  ships.filter(s => s.dir === 'I' && s.ph === 1).slice(1).forEach(s => { s.status = 'Waiting for unloader'; });

  // equipment targets: SULs over discharging import ships, loader(s) over loading export ships
  const target = (list, nEq, park, maxShips = nEq) => {
    const tg = park.slice(), w = list.slice(0, Math.min(nEq, maxShips));
    if (!w.length) return tg;
    let k = 0;
    w.forEach((s, i) => {
      const cnt = Math.floor(nEq / w.length) + (i < nEq % w.length ? 1 : 0);
      for (let j = 0; j < cnt; j++) tg[k++] = s.x0 + s.loa * (j + 1) / (cnt + 1);
    });
    return tg;
  };
  const sulPark = Array.from({ length: inp.sulN }, (_, i) => 15 + i * 22);
  const ldPark = Array.from({ length: inp.loaderN }, (_, i) => L - 15 - i * 22);
  const sulT = target(ships.filter(s => s.dir === 'I' && s.ph === 1), inp.sulN, sulPark, 1);   // all SULs work one RM ship at a time
  const ldT = target(ships.filter(s => s.dir === 'E' && s.ph === 1), inp.loaderN, ldPark);
  const crT = d.slab ? target(ships.filter(s => s.dir === 'L' && s.ph === 1), inp.slabCraneN, cranePark(inp)) : [];

  // tugs: alongside ships doing a tug activity, the rest at the tug base
  const tugs = []; let used = 0;
  ships.filter(s => s.tug).forEach(s => {
    const k = inp.ships[s.cls].tugs;
    for (let j = 0; j < k; j++, used++) {
      const pos = [[s.x0 - 25, s.y], [s.x0 + s.loa + 25, s.y], [s.x0 + s.loa / 2, s.y - s.beam / 2 - 18], [s.x0 + s.loa / 2, s.y + s.beam / 2 + 14]][j % 4];
      tugs.push({ x: pos[0], y: pos[1], busy: true });
    }
  });
  for (let j = used; j < inp.tugsAvail; j++) tugs.push({ x: SIM.layout.tugBase.x + (j % 5) * 22, y: SIM.layout.tugBase.y - Math.floor(j / 5) * 16, busy: false });

  const prev = h > 0 ? h - 1 : 0;
  return {
    t, h, day, hr, L, layout: SIM.layout, inp, ships, tugs, sulT, ldT, crT, slabOn: d.slab,
    slab: d.slab ? tr.slab[h] : 0, slabMade: d.slab ? tr.slabMade[h] : 0, smsPlant: d.slab ? tr.smsPlant[h] : 0, smsYard: d.slab ? tr.smsYard[h] : 0, slabExp: d.slab ? tr.slabExp[h] : 0,
    slabFlow: d.slab ? (h > 0 ? tr.slabExp[h] - tr.slabExp[prev] : tr.slabExp[0]) : 0,
    rm: tr.rm[h], fg: tr.fg[h], prod: tr.prod[h], prodFull: inp.driCap * 1e6 * inp.plantUtil / 100 / (d.calendar.yearDays * 24),
    impFlow: h > 0 ? tr.imp[h] - tr.imp[prev] : tr.imp[0], expFlow: h > 0 ? tr.exp[h] - tr.exp[prev] : tr.exp[0],
    imp: tr.imp[h], exp: tr.exp[h], tugsUsed: tr.tugs[h], night: hr < 6 || hr >= 18,
    date: d.calendar.days[Math.min(day, d.calendar.days.length - 1)],
  };
}

function easeEquipment(sc, dt) {
  const k = Math.min(1, dt * 3);
  SIM.eq.sul = SIM.eq.sul.map((x, i) => x + ((sc.sulT[i] ?? x) - x) * k);
  SIM.eq.loader = SIM.eq.loader.map((x, i) => x + ((sc.ldT[i] ?? x) - x) * k);
  SIM.eq.crane = SIM.eq.crane.map((x, i) => x + ((sc.crT[i] ?? x) - x) * k);
  sc.sul = SIM.eq.sul; sc.loader = SIM.eq.loader; sc.crane = SIM.eq.crane;
}

/* ---------- shell: controls, figures, charts, table ---------- */
function simTabActive() { return TAB === 'sim2d'; }

function simRenderShell() {
  let host = $('#sim-shared');
  if (!host) { host = document.createElement('div'); host.id = 'sim-shared'; host.className = 'sim-shared'; }
  const pane = $('#pane-sim2d'), view = $('#pane-sim2d .sim-view');
  if (view && host.contains(view)) pane.insertBefore(view, host);   // keep the canvas when the shell is rebuilt
  if (host.parentElement !== pane) pane.appendChild(host);
  if (!RUN) { host.innerHTML = `<div class="card empty">No saved runs yet. Select <b>Run simulation</b> first.</div>`; return; }
  if (SIM.loading) { host.innerHTML = `<div class="card empty">Loading the hour-by-hour simulation…</div>`; return; }
  if (SIM.err) { host.innerHTML = `<div class="banner err">${esc(SIM.err)}</div>`; return; }
  if (!SIM.data) return;
  const d = SIM.data, NH = d.trace.rm.length, IM = [...new Set(RUN.results.map(r => r.im))], EX = [...new Set(RUN.results.map(r => r.ex))], SL = [...new Set(RUN.results.map(r => r.sl))];
  const opts = (sel, list) => list.map(m => `<option value="${m}" ${sel === m ? 'selected' : ''}>${mixName(RP, m)}</option>`).join('');
  host.innerHTML = `
  <div class="card sim-controls">
    <div class="sel-row">
      <label for="simsel-i">Import fleet<select id="simsel-i">${opts(SEL.i, IM)}</select></label>
      <label for="simsel-e">Export fleet<select id="simsel-e">${opts(SEL.e, EX)}</select></label>
      ${SEL.l ? `<label for="simsel-l">Slab fleet<select id="simsel-l">${opts(SEL.l, SL)}</select></label>` : ''}
      <label for="sim-speed">Speed<select id="sim-speed">${SPEEDS.map(([v, l]) => `<option value="${v}" ${SIM.speed === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div class="sim-transport">
      <button class="btn-q" data-sim="start" title="Go to start" aria-label="Go to start">⏮</button>
      <button class="btn-q" data-sim="-24" title="Back 1 day">−1 d</button>
      <button class="btn-q" data-sim="-1" title="Back 1 hour">−1 h</button>
      <button class="btn" id="sim-play" data-sim="play">${SIM.playing ? 'Pause' : 'Play'}</button>
      <button class="btn-q" data-sim="1" title="Forward 1 hour">+1 h</button>
      <button class="btn-q" data-sim="24" title="Forward 1 day">+1 d</button>
      <button class="btn-q" data-sim="end" title="Go to end" aria-label="Go to end">⏭</button>
      <input type="range" id="sim-scrub" min="0" max="${NH - 1}" step="1" value="${Math.floor(SIM.t)}" aria-label="Timeline">
      <output id="sim-clock" class="num"></output>
    </div>
  </div>
  <div class="sim-stage"><div id="sim-stage-main"></div><aside class="card sim-live" id="sim-live" aria-label="Live figures"></aside></div>
  <div class="split">
    <div class="card"><div class="card-h"><h3>RM, HBI${d.slab ? ' and slab' : ''} stock</h3><div class="legend"><span><i style="background:var(--rm)"></i>RM stock</span><span><i style="background:var(--fg)"></i>HBI stock</span>${d.slab ? '<span><i style="background:var(--slab)"></i>Slab stock</span>' : ''}<span style="color:var(--bad)"><i class="dash"></i>Yard capacity</span></div></div>
      <div id="sim-chart-stock">${stockChart(d)}</div></div>
    <div class="card"><div class="card-h"><h3>Plant production</h3><div class="legend"><span><i class="sq" style="background:var(--accent)"></i>DRI made per day</span><span><i style="background:var(--rm)"></i>RM used per day</span></div></div>
      <div id="sim-chart-prod">${prodChart(d)}</div></div>
  </div>
  <div class="card"><div class="card-h"><div><div class="eyebrow">Daily table</div><h3>RM${d.slab ? ', HBI and slab' : ' and HBI'} stock, plant production</h3></div></div>
    <div class="tw" id="sim-table" style="max-height:420px;overflow:auto"><table class="t"><thead><tr><th>Day</th><th>Date</th><th>RM received t</th><th>RM used t</th><th>RM stock t</th><th>DRI made t</th><th>HBI shipped t</th><th>HBI stock t</th>${d.slab ? '<th>HBI to SMS from plant t</th><th>HBI to SMS from HBI yard t</th><th>Slab made t</th><th>Slab shipped t</th><th>Slab stock t</th>' : ''}</tr></thead><tbody>
    ${d.days.map(r => `<tr data-day="${r.i}"><td>${r.i + 1}</td><td>${r.iso}</td><td>${fmtN(r.rmIn)}</td><td>${fmtN(r.rmUsed)}</td><td>${fmtN(r.rm)}</td><td>${fmtN(r.prod)}</td><td>${fmtN(r.fgOut)}</td><td>${fmtN(r.fg)}</td>${d.slab ? `<td>${fmtN(r.smsPlant)}</td><td>${fmtN(r.smsYard)}</td><td>${fmtN(r.slabMade)}</td><td>${fmtN(r.slabOut)}</td><td>${fmtN(r.slab)}</td>` : ''}</tr>`).join('')}
    </tbody></table></div></div>`;
  if (view) $('#sim-stage-main').appendChild(view);
  SIM.lastDay = -1; SIM.hudForce = true;
  simUpdateHud(sceneAt(SIM.t));
}

function simSeek(t) { SIM.t = Math.max(0, Math.min(SIM.data.trace.rm.length - 1, t)); }

document.addEventListener('click', e => {
  const b = e.target.closest('[data-sim]'); if (!b || !SIM.data) return;
  const a = b.dataset.sim, NH = SIM.data.trace.rm.length;
  if (a === 'play') { SIM.playing = !SIM.playing; SIM.lastTs = 0; if (SIM.t >= NH - 1) SIM.t = 0; b.textContent = SIM.playing ? 'Pause' : 'Play'; }
  else if (a === 'start') simSeek(0);
  else if (a === 'end') simSeek(NH - 1);
  else simSeek(Math.floor(SIM.t) + Number(a));
});
document.addEventListener('input', e => { if (e.target.id === 'sim-scrub' && SIM.data) simSeek(+e.target.value); });
document.addEventListener('change', async e => {
  if (e.target.id === 'sim-speed') SIM.speed = +e.target.value;
  if (['simsel-i', 'simsel-e', 'simsel-l'].includes(e.target.id)) {
    const s = { ...SEL, [e.target.id.slice(-1)]: e.target.value };
    try { await selectCombo(s.i, s.e, s.l); } catch (err) { ERR = err.message; renderBanner(); }
  }
});

function simUpdateHud(sc) {
  const d = SIM.data, inp = sc.inp, clock = $('#sim-clock'); if (!clock) return;
  const dt = sc.date, yd = d.calendar.yearDays;
  clock.textContent = `Day ${sc.day + 1} · ${dt.dd} ${MON[dt.m]} ${dt.y} ${String(sc.hr).padStart(2, '0')}:00`;
  const sc2 = $('#sim-scrub'); if (sc2 && document.activeElement !== sc2) sc2.value = Math.floor(SIM.t);
  // chart cursors move every frame; the figures and ship list change once per simulated hour
  document.querySelectorAll('.sim-cursor').forEach(l => {
    const x = l.dataset.x0 * 1 + (l.dataset.w * 1) * (SIM.t / (d.trace.rm.length - 1)); l.setAttribute('x1', x); l.setAttribute('x2', x); });
  if (SIM.hudH === sc.h && !SIM.hudForce) return;
  SIM.hudH = sc.h; SIM.hudForce = false;
  const dayRow = d.days[Math.min(sc.day, d.days.length - 1)];
  const atJetty = sc.ships.filter(s => s.ph !== 3 && s.y > -60), waiting = sc.ships.filter(s => s.status === 'Waiting for daylight').length;
  const used = atJetty.reduce((a, s) => a + s.loa, 0), pace = Math.min(1, sc.h / (yd * 24));
  const pct = (v, of) => Math.max(0, Math.min(100, of ? v / of * 100 : 0));
  // cumulative tonnes against the yearly target, with a marker where a straight-line pace would be by now
  const goal = (name, v, target, color) => {
    const gap = v - target * pace;
    return `<div class="lrow"><div class="lt"><span>${name}</span><b>${fmtT(v)}</b></div>
      <div class="lbar"><i style="width:${pct(v, target)}%;background:var(${color})"></i><em style="left:${pace * 100}%" title="Straight-line pace"></em></div>
      <div class="ls"><span>${fmtN(pct(v, target), 1)}% of ${fmtT(target)}</span><span class="${gap >= 0 ? 'ok' : 'warn'}">${gap >= 0 ? '+' : '−'}${fmtT(Math.abs(gap))} vs pace</span></div></div>`;
  };
  const yardRow = (name, v, cap, safe, color, full) => `<div class="lrow"><div class="lt"><span>${name}</span><b>${fmtT(v)}</b></div>
      <div class="lbar"><i style="width:${pct(v, cap)}%;background:var(${color})"></i>${safe > 0 ? `<em class="safe" style="left:${pct(safe, cap)}%" title="Safety stock"></em>` : ''}</div>
      <div class="ls"><span class="${full ? 'bad' : ''}">${fmtN(pct(v, cap), 0)}% of ${fmtT(cap)}</span>${safe > 0 ? `<span>safety ${fmtT(safe)}</span>` : ''}</div></div>`;
  const cell = (label, v, sub = '', cls = '') => `<div class="lc ${cls}"><span>${label}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  $('#sim-live').innerHTML = `
    <div class="live-clock"><b class="num">${String(sc.hr).padStart(2, '0')}:00</b><span>${dt.dd} ${MON[dt.m]} ${dt.y}<br>day ${sc.day + 1} of ${yd}${sc.day >= yd ? ' (after year end)' : ''}</span><i class="${sc.night ? 'night' : 'day'}">${sc.night ? 'Night' : 'Day'}</i></div>
    <h4>Year to date vs target</h4>
    ${goal('RM imported', sc.imp, inp.rmTarget, '--rm')}${goal('HBI exported', sc.exp, inp.fgTarget, '--fg')}${sc.slabOn ? goal('Slab exported', sc.slabExp, inp.slabTarget, '--slab') : ''}
    <h4>Yards</h4>
    ${yardRow('RM yard', sc.rm, inp.rmYardCap, inp.rmSafety, '--rm', sc.rm < inp.rmSafety)}${yardRow('HBI yard', sc.fg, inp.fgYardCap, inp.fgSafety, '--fg', sc.fg >= inp.fgYardCap - 1)}${sc.slabOn ? yardRow('Slab yard', sc.slab, inp.slabYardCap, 0, '--slab', sc.slab >= inp.slabYardCap - 1) : ''}
    <h4>Flow now · t/h</h4>
    <div class="lgrid">
      ${cell('RM unloading', fmtN(sc.impFlow))}${cell('HBI loading', fmtN(sc.expFlow))}
      ${cell('DRI plant', fmtN(sc.prod), `${fmtN(pct(sc.prod, sc.prodFull), 0)}% · today ${fmtK(dayRow.prod)} t`, sc.prod < sc.prodFull - 1 ? 'bad' : 'ok')}
      ${cell('RM to plant', fmtN(sc.prod * inp.rmRatio))}
      ${sc.slabOn ? cell('HBI to SMS', fmtN(sc.smsPlant + sc.smsYard), `plant ${fmtN(sc.smsPlant)} · yard ${fmtN(sc.smsYard)}`) + cell('Slab made', fmtN(sc.slabMade), '', sc.slabMade > 0.01 ? 'ok' : 'bad') + cell('Slab loading', fmtN(sc.slabFlow)) : ''}
    </div>
    <h4>Jetty</h4>
    <div class="lgrid">
      ${cell('Ships alongside', atJetty.length, waiting ? `${waiting} waiting for daylight` : 'none waiting')}${cell('Length in use', fmtN(used) + ' m', `${fmtN(pct(used, sc.L), 0)}% of ${fmtN(sc.L)} m`)}
      ${cell('Tugs busy', `${sc.tugsUsed ?? sc.tugs.filter(t => t.busy).length} / ${inp.tugsAvail}`)}${cell('DRI full rate', fmtN(sc.prodFull), 't/h')}
    </div>
    <h4>Ships</h4>
    <div class="lships">${sc.ships.length ? sc.ships.map(s => `<div class="lship"><div class="lt"><span><span class="dot ${DIRS[s.dir].dot}"></span>#${s.n} ${inp.ships[s.cls].name} · ${DIRS[s.dir].name}</span><b>${fmtN(s.done * 100, 0)}%</b></div>
      <div class="lbar thin"><i style="width:${s.done * 100}%;background:var(${s.dir === 'I' ? '--rm' : s.dir === 'L' ? '--slab' : '--fg'})"></i></div>
      <div class="ls"><span>${esc(s.status)}</span><span>${fmtT(s.qty - s.rem)} of ${fmtT(s.qty)}</span></div></div>`).join('') : '<p class="note">No ship at the jetty.</p>'}</div>`;
  if (sc.day !== SIM.lastDay) {
    const tb = $('#sim-table'), old = tb.querySelector('tr.sel'); if (old) old.classList.remove('sel');
    const row = tb.querySelector(`tr[data-day="${sc.day}"]`);
    if (row) { row.classList.add('sel'); tb.scrollTop = row.offsetTop - tb.clientHeight / 2; }
    SIM.lastDay = sc.day;
  }
}

/* ---------- charts with a time cursor ---------- */
function chartFrame(W, H, ml, mr, mt, mb, top, step, fmt) {
  let s = '';
  const Y = v => mt + (H - mt - mb) * (1 - v / top);
  for (let v = 0; v <= top + 1e-6; v += step) s += `<line class="gl" x1="${ml}" x2="${W - mr}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ax" x="${ml - 6}" y="${Y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
  SIM.data.calendar.days.forEach((d, i) => { if (d.dd === 1) { const x = ml + (W - ml - mr) * i * 24 / (SIM.data.trace.rm.length - 1); s += `<text class="ax" x="${x + 2}" y="${H - 8}">${MON[d.m]}</text>`; } });
  return { s, Y };
}
function stockChart(d) {
  const W = 900, H = 240, ml = 52, mr = 14, mt = 14, mb = 26, tr = d.trace, inp = d.inputs, n = tr.rm.length;
  const ymax = Math.max(inp.rmYardCap, inp.fgYardCap, ...tr.rm, d.slab ? inp.slabYardCap : 0) * 1.05, step = niceStep(ymax / 4), top = Math.ceil(ymax / step) * step;
  const fr = chartFrame(W, H, ml, mr, mt, mb, top, step, fmtK), X = h => ml + (W - ml - mr) * h / (n - 1);
  const path = arr => { let p = ''; for (let h = 0; h < n; h += 3) p += (p ? ' L' : 'M') + X(h).toFixed(1) + ',' + fr.Y(arr[h]).toFixed(1); return p; };
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="RM and HBI stock by hour">${fr.s}`;
  [[inp.rmYardCap, 'RM yard'], [inp.fgYardCap, 'HBI yard'], ...(d.slab ? [[inp.slabYardCap, 'Slab yard']] : [])].forEach(([v, t]) => s += `<line x1="${ml}" x2="${W - mr}" y1="${fr.Y(v)}" y2="${fr.Y(v)}" style="stroke:var(--bad);stroke-dasharray:5 4"/><text class="ax" x="${W - mr - 4}" y="${fr.Y(v) - 5}" text-anchor="end" style="fill:var(--bad)">${t} ${fmtK(v)}</text>`);
  s += `<path d="${path(tr.rm)}" style="fill:none;stroke:var(--rm);stroke-width:1.6"/><path d="${path(tr.fg)}" style="fill:none;stroke:var(--fg);stroke-width:1.6"/>`;
  if (d.slab) s += `<path d="${path(tr.slab)}" style="fill:none;stroke:var(--slab);stroke-width:1.6"/>`;
  s += `<line class="sim-cursor" data-x0="${ml}" data-w="${W - ml - mr}" x1="${ml}" x2="${ml}" y1="${mt}" y2="${H - mb}" style="stroke:var(--ink);stroke-width:1.5"/>`;
  return s + '</svg>';
}
function prodChart(d) {
  const W = 900, H = 240, ml = 52, mr = 14, mt = 14, mb = 26, days = d.days, n = d.trace.rm.length;
  const ymax = Math.max(...days.map(r => Math.max(r.prod, r.rmUsed)), 1) * 1.1, step = niceStep(ymax / 4), top = Math.ceil(ymax / step) * step;
  const fr = chartFrame(W, H, ml, mr, mt, mb, top, step, fmtK), X = h => ml + (W - ml - mr) * h / (n - 1), bw = Math.max(1, (W - ml - mr) / days.length - 0.6);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="DRI production and RM use per day">${fr.s}`;
  days.forEach(r => s += `<rect x="${X(r.i * 24).toFixed(1)}" y="${fr.Y(r.prod).toFixed(1)}" width="${bw.toFixed(2)}" height="${(fr.Y(0) - fr.Y(r.prod)).toFixed(1)}" style="fill:var(--accent);fill-opacity:.75"/>`);
  s += `<path d="${days.map((r, i) => (i ? 'L' : 'M') + X(r.i * 24 + 12).toFixed(1) + ',' + fr.Y(r.rmUsed).toFixed(1)).join(' ')}" style="fill:none;stroke:var(--rm);stroke-width:1.6"/>`;
  s += `<line class="sim-cursor" data-x0="${ml}" data-w="${W - ml - mr}" x1="${ml}" x2="${ml}" y1="${mt}" y2="${H - mb}" style="stroke:var(--ink);stroke-width:1.5"/>`;
  return s + '</svg>';
}

/* ---------- 2D view ---------- */
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

function draw2D(sc, now) {
  const cv = $('#sim2d-canvas'); if (!cv) return;
  const lay = sc.layout, B = lay.bounds, bw = B.x1 - B.x0, bh = B.y1 - B.y0, dpr = window.devicePixelRatio || 1;
  // fit the whole site on screen: full card width, height no lower than the bottom of the window
  const top = cv.getBoundingClientRect().top + window.scrollY, cssW = cv.clientWidth || 800;
  const cssH = Math.round(Math.max(220, Math.min(cssW * bh / bw, window.innerHeight - Math.min(top, window.innerHeight * 0.45) - 24)));
  if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr); cv.style.height = cssH + 'px';
    document.documentElement.style.setProperty('--sim-h', cssH + 'px');
  }
  const g = cv.getContext('2d'), k = Math.min(cssW / bw, cssH / bh), ox = (cssW - bw * k) / 2, oy = (cssH - bh * k) / 2;
  const C = { water: cssVar('--water'), land: cssVar('--surface-2'), deck: cssVar('--deck'), ink: cssVar('--ink'), muted: cssVar('--muted'),
    rm: cssVar('--rm'), fg: cssVar('--fg'), surface: cssVar('--surface-solid') || cssVar('--surface'), line: cssVar('--line'), ok: cssVar('--ok'), bad: cssVar('--bad'),
    warn: cssVar('--warn'), accent: cssVar('--accent'), slab: cssVar('--slab') };
  const FONT = '"Open Sans", system-ui, sans-serif';
  const px = v => v / k;                                  // screen pixels -> metres
  const text = (s, x, y, size, color, align = 'left', weight = '600') => {
    g.font = `${weight} ${px(size)}px ${FONT}`; g.fillStyle = color; g.textAlign = align; g.fillText(s, x, y); };
  // rounded label on a solid background so numbers stay readable over water, land and ships
  const pill = (s, x, y, size, color, align = 'center', border = color) => {
    g.font = `700 ${px(size)}px ${FONT}`;
    const w = g.measureText(s).width + px(12), h = px(size + 8), x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    g.fillStyle = C.surface; g.strokeStyle = border; g.lineWidth = px(1.2);
    g.beginPath(); g.roundRect(x0, y - h / 2, w, h, h / 2); g.fill(); g.stroke();
    g.fillStyle = color; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(s, x0 + px(6), y + px(0.5)); g.textBaseline = 'alphabetic';
  };
  const kt = v => v >= 1e6 ? fmtN(v / 1e6, 2) + ' Mt' : fmtN(v / 1000, v < 1e5 ? 1 : 0) + ' kt';
  const box = (r, stroke, wdt = 1.2) => {
    g.fillStyle = C.surface; g.strokeStyle = stroke; g.lineWidth = px(wdt);
    g.beginPath(); g.roundRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, px(10)); g.fill(); g.stroke();
  };

  // sea (darker offshore, slow swell lines) and land, in screen space so they fill the whole canvas
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const shore = oy + (lay.shoreY - B.y0) * k;
  g.fillStyle = C.water; g.fillRect(0, 0, cssW, shore);
  const sea = g.createLinearGradient(0, 0, 0, shore); sea.addColorStop(0, 'rgba(10,50,90,.16)'); sea.addColorStop(1, 'rgba(10,50,90,0)');
  g.fillStyle = sea; g.fillRect(0, 0, cssW, shore);
  g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 1; g.setLineDash([6, 18]);
  for (let i = 1; i < 6; i++) { const y = shore * i / 6; g.lineDashOffset = -(now / 120) - i * 7; g.beginPath(); g.moveTo(0, y); g.lineTo(cssW, y); g.stroke(); }
  g.setLineDash([]);
  g.fillStyle = C.land; g.fillRect(0, shore, cssW, cssH - shore);
  g.strokeStyle = C.line; g.beginPath(); g.moveTo(0, shore); g.lineTo(cssW, shore); g.stroke();
  g.setTransform(dpr * k, 0, 0, dpr * k, (ox - B.x0 * k) * dpr, (oy - B.y0 * k) * dpr);
  text('Anchorage', lay.L * 0.8, OFFSHORE - 20, 12, C.muted, 'center');

  // conveyors with moving cargo and a t/h badge
  const conveyor = (pts, flow, rate, color, label, lx, ly, align = 'center') => {
    g.lineCap = 'round'; g.strokeStyle = C.line; g.lineWidth = 8; g.setLineDash([]);
    g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke();
    if (flow > 0.5) {
      g.strokeStyle = color; g.lineWidth = 5; g.setLineDash([10, 14]); g.lineDashOffset = -(now / 1000) * 40 * Math.min(2, flow / Math.max(1, rate) + 0.3);
      g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); g.setLineDash([]);
    }
    if (label) pill(`${label} ${flow > 0.5 ? fmtN(flow) + ' t/h' : 'idle'}`, lx, ly, 10.5, flow > 0.5 ? color : C.muted, align, flow > 0.5 ? color : C.line);
  };
  conveyor(lay.conv.imp, sc.impFlow, SIM.data.rates.imp, C.rm, 'Import', lay.mid - 20, 95, 'right');
  conveyor(lay.conv.exp, sc.expFlow, SIM.data.rates.exp, C.fg, 'Export', lay.mid + (sc.slabOn ? 32 : 20), 95, 'left');
  conveyor(lay.conv.feed, sc.prod * sc.inp.rmRatio, sc.prodFull * sc.inp.rmRatio, C.rm, 'RM feed', (lay.rm.x0 + lay.rm.x1) / 2 - 12, 412, 'right');
  conveyor(lay.conv.out, sc.prod - sc.smsPlant, sc.prodFull, C.fg, 'HBI', (lay.fg.x0 + lay.fg.x1) / 2 - 12, 412, 'right');
  if (sc.slabOn) {
    const smsFull = sc.inp.smsRate * sc.inp.slabDriRatio;     // HBI the SMS takes at full rate
    conveyor(lay.conv.toSms, sc.smsPlant, smsFull * sc.inp.smsDirectPct / 100, C.fg, '', 0, 0);
    conveyor(lay.conv.yardToSms, sc.smsYard, smsFull * (100 - sc.inp.smsDirectPct) / 100, C.fg, '', 0, 0);
    conveyor(lay.conv.smsToYard, sc.slabMade, sc.inp.smsRate, C.slab, '', 0, 0);
    conveyor(lay.conv.slabOut, sc.slabFlow, SIM.data.rates.slab, C.slab, 'Slab', lay.mid + 682, (lay.fg.y0 + lay.fg.y1) / 2, 'left');
  }

  // trestle and jetty deck with crane rails
  g.fillStyle = C.deck; g.fillRect(lay.mid - 14, lay.deckW, 28, lay.shoreY - lay.deckW);
  if (sc.slabOn) g.fillRect(lay.mid + 14, lay.deckW, 12, lay.shoreY - lay.deckW);
  g.fillRect(0, 0, lay.L, lay.deckW);
  g.strokeStyle = C.surface; g.lineWidth = px(1); [4, lay.deckW - 4].forEach(y => { g.beginPath(); g.moveTo(0, y); g.lineTo(lay.L, y); g.stroke(); });
  const along = sc.ships.filter(s => s.ph !== 3 && s.y > -60), used = along.reduce((a, s) => a + s.loa, 0);

  // yards: big tonnage, % of capacity bar with safety marker, pile that grows with stock
  const yard = (r, stock, cap, safe, color, name) => {
    const w = r.x1 - r.x0, hgt = r.y1 - r.y0, f = Math.max(0, Math.min(1, stock / cap));
    box(r, C.line);
    const pw = w * (0.18 + 0.34 * f), ph = hgt * (0.1 + 0.32 * f), cx = r.x0 + w * 0.74, by = r.y1 - px(16);
    g.fillStyle = color; g.globalAlpha = 0.8; g.beginPath(); g.moveTo(cx - pw / 2, by); g.quadraticCurveTo(cx, by - ph * 2, cx + pw / 2, by); g.closePath(); g.fill(); g.globalAlpha = 1;
    text(name, r.x0 + px(10), r.y0 + px(15), 11, C.muted);
    text(kt(stock), r.x0 + px(10), r.y0 + px(34), 17, C.ink, 'left', '800');
    text(`${fmtN(f * 100, 0)}% of ${kt(cap)}`, r.x0 + px(10), r.y0 + px(49), 10.5, color, 'left', '700');
    const bx = r.x0 + px(10), bwid = w - px(20), byy = r.y1 - px(9);
    g.fillStyle = C.line; g.fillRect(bx, byy, bwid, px(5));
    g.fillStyle = color; g.fillRect(bx, byy, bwid * f, px(5));
    if (safe > 0) { g.fillStyle = C.bad; g.fillRect(bx + bwid * Math.min(1, safe / cap) - px(1), byy - px(3), px(2), px(11)); }
  };
  yard(lay.rm, sc.rm, sc.inp.rmYardCap, sc.inp.rmSafety, C.rm, 'RM yard');
  yard(lay.fg, sc.fg, sc.inp.fgYardCap, sc.inp.fgSafety, C.fg, 'HBI yard');

  // plant boxes: name, rate now, % of full rate
  const unit = (r, name, rate, sub, on) => {
    box(r, on ? C.ok : C.bad, 2);
    const cx = (r.x0 + r.x1) / 2;
    text(name, cx, r.y0 + px(15), 11, C.muted, 'center');
    text(on ? `${fmtN(rate)} t/h` : 'Stopped', cx, r.y0 + px(34), 17, on ? C.ink : C.bad, 'center', '800');
    text(sub, cx, r.y0 + px(50), 10.5, on ? C.ok : C.bad, 'center', '700');
  };
  const run = sc.prod / Math.max(1, sc.prodFull), p = lay.plant;
  unit(p, 'DRI plant', sc.prod, `${fmtN(run * 100, 0)}% of full rate`, run > 0.01);
  if (run > 0.01) { g.fillStyle = C.warn; g.globalAlpha = 0.35 + 0.3 * Math.sin(now / 300); g.beginPath(); g.arc(p.x1 - px(12), p.y0 + px(12), px(5), 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }
  if (sc.slabOn) {
    unit(lay.sms, 'SMS slab', sc.slabMade, `HBI in ${fmtN(sc.smsPlant + sc.smsYard)} t/h`, sc.slabMade > 0.01);
    yard(lay.slabYard, sc.slab, sc.inp.slabYardCap, 0, C.slab, 'Slab yard');
  }

  // ships: hull with cargo bar; labels with status, tonnes handled and % done
  for (const s of sc.ships) {
    const x0 = s.x0, x1 = s.x0 + s.loa, y0 = s.y - s.beam / 2, y1 = s.y + s.beam / 2, bow = Math.min(28, s.loa * 0.12);
    const col = s.dir === 'I' ? C.rm : s.dir === 'L' ? C.slab : C.fg;
    const hull = d => { g.beginPath(); g.moveTo(x0 + d, y0 + d); g.lineTo(x1 - bow + d, y0 + d); g.lineTo(x1 + d, s.y + d); g.lineTo(x1 - bow + d, y1 + d); g.lineTo(x0 + d, y1 + d); g.closePath(); g.fill(); };
    g.globalAlpha = Math.max(0, s.alpha);
    g.fillStyle = 'rgba(0,0,0,.14)'; hull(4);
    g.fillStyle = col; hull(0);
    g.fillStyle = C.surface; g.fillRect(x0 + 4, y0 + 4, 16, s.beam - 8);                        // deckhouse at the stern
    const hl = s.loa - 30 - bow;                                                                  // hold length, shows cargo on board
    g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(x0 + 24, s.y - 6, hl, 12);
    g.fillStyle = C.surface; g.fillRect(x0 + 24, s.y - 6, hl * s.cargo, 12);
    if (s.alpha > 0.4) {
      pill(`#${s.n} ${sc.inp.ships[s.cls].name} · ${s.status}`, x0, y0 - px(32), 10.5, C.ink, 'left', col);
      pill(`${kt(s.qty - s.rem)} of ${kt(s.qty)} · ${fmtN(s.done * 100, 0)}%`, x0, y0 - px(12), 10.5, col, 'left', col);
    }
    g.globalAlpha = 1;
  }

  // tugs
  for (const tg of sc.tugs) {
    g.fillStyle = tg.busy ? C.warn : C.muted; g.beginPath(); g.ellipse(tg.x, tg.y, 9, 5, 0, 0, Math.PI * 2); g.fill();
  }
  const busy = sc.tugs.filter(t => t.busy).length;
  pill(`Tugs ${busy} of ${sc.tugs.length} busy`, sc.layout.tugBase.x + 44, sc.layout.tugBase.y - Math.ceil(sc.inp.tugsAvail / 5) * 16 - px(8), 10.5, busy ? C.warn : C.muted, 'center', C.line);

  // SULs and loader on the jetty rails, booms over the ship when working
  const cranes = (xs, color, name, dir) => {
    const grp = { on: [], off: [] };
    xs.forEach(x => {
      const working = sc.ships.some(s => s.dir === dir && s.ph === 1 && x > s.x0 && x < s.x0 + s.loa);
      g.fillStyle = color; g.fillRect(x - 7, 1, 14, lay.deckW - 2);
      g.strokeStyle = color; g.lineWidth = 4; g.beginPath(); g.moveTo(x, 4); g.lineTo(x, working ? -30 - 6 * Math.sin(now / 250 + x) : -8); g.stroke();
      grp[working ? 'on' : 'off'].push(x);
    });
    // one label per group, so equipment standing close together never overprints
    [['on', C.ink, '700'], ['off', C.muted, '600']].forEach(([key, c, w]) => {
      const g2 = grp[key]; if (!g2.length) return;
      text(g2.length > 1 ? `${g2.length} ${name}s` : name, g2.reduce((a, x) => a + x, 0) / g2.length, lay.deckW + px(14), 10, c, 'center', w);
    });
  };
  cranes(sc.sul, C.ink, 'SUL', 'I');
  cranes(sc.loader, C.accent, 'Loader', 'E');
  cranes(sc.crane, C.slab, 'Crane', 'L');

  // night shade, then clock and legend in screen space
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (sc.night) { g.fillStyle = 'rgba(10,20,40,.18)'; g.fillRect(0, 0, cssW, cssH); }
  const dt = sc.date, clock = `Day ${sc.day + 1} · ${dt.dd} ${MON[dt.m]} ${dt.y} · ${String(sc.hr).padStart(2, '0')}:00 · ${sc.night ? 'night' : 'day'}`;
  g.font = `700 13px ${FONT}`; const cw = g.measureText(clock).width + 24;
  g.fillStyle = C.surface; g.strokeStyle = C.line; g.lineWidth = 1; g.beginPath(); g.roundRect(10, 10, cw, 28, 14); g.fill(); g.stroke();
  g.fillStyle = C.ink; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(clock, 22, 24.5);
  const jl = `Jetty ${fmtN(lay.L)} m · ${along.length} ship${along.length === 1 ? '' : 's'} alongside · ${fmtN(used)} m in use (${fmtN(used / lay.L * 100, 0)}%)`;
  g.font = `600 12px ${FONT}`; const jw = g.measureText(jl).width + 24;
  g.fillStyle = C.surface; g.beginPath(); g.roundRect(10, 44, jw, 24, 12); g.fill(); g.stroke();
  g.fillStyle = C.ink; g.fillText(jl, 22, 56.5);
  g.font = `600 12px ${FONT}`;
  let lx = cssW - 10;
  [['Slab', C.slab, sc.slabOn], ['HBI', C.fg, true], ['RM', C.rm, true]].forEach(([t, c, on]) => {
    if (!on) return; const w = g.measureText(t).width + 30; lx -= w;
    g.fillStyle = C.surface; g.beginPath(); g.roundRect(lx, 11, w - 6, 26, 13); g.fill();
    g.fillStyle = c; g.beginPath(); g.arc(lx + 12, 24, 5, 0, Math.PI * 2); g.fill();
    g.fillStyle = C.ink; g.fillText(t, lx + 21, 24.5);
  });
  g.textBaseline = 'alphabetic';
}

/* ---------- main loop ---------- */
let simLastFrame = 0;
function simFrame(now) {
  requestAnimationFrame(simFrame);
  if (!simTabActive()) { simLastFrame = now; return; }
  const host = $('#sim-shared'), pane = $('#pane-' + TAB);
  if (!host || host.parentElement !== pane) simRenderShell();
  if (RUN && simKey() !== SIM.key) { simLoad(); return; }
  if (!SIM.data) return;
  const dt = simLastFrame ? Math.min(0.1, (now - simLastFrame) / 1000) : 0; simLastFrame = now;
  const NH = SIM.data.trace.rm.length;
  if (SIM.playing) {
    SIM.t += dt * SIM.speed;
    if (SIM.t >= NH - 1) { SIM.t = NH - 1; SIM.playing = false; const b = $('#sim-play'); if (b) b.textContent = 'Play'; }
  }
  const sc = sceneAt(SIM.t); easeEquipment(sc, dt); SIM.scene = sc;
  draw2D(sc, now);
  simUpdateHud(sc);
}
requestAnimationFrame(simFrame);
