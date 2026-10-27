/* DRI Jetty Planner web UI: edits inputs, starts runs on the local API and shows stored results. */
const MIXES=['P','S','H','PS','PH','SH','PSH'];
const SHIPKEYS=['P','S','H'];
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const EXT_DAYS=30;

let DEF=null;        // defaults from the server
let P=null;          // inputs being edited
let RUN=null;        // loaded run (inputs + per-combination results) from the database
let RP=null;         // inputs the loaded run was made with
let RES={};          // results of the loaded run keyed 'IM|EX|SL' (SL is '' without slab export)
let SEL={i:'P',e:'P',l:''};
let DETAIL=null;     // selected combination: result, calendar, desk plan
let RUNS=[];
let DIRTY=false, BUSY=false, ERR='';
let TAB='plan';

const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const clone=o=>JSON.parse(JSON.stringify(o));
const mixName=(Q,m)=>m.split('').map(c=>Q.ships[c].name).join(' + ');
const mixesFor=(Q,dir)=>MIXES.filter(m=>m.split('').every(c=>Q.ships[c][dir]!==false));
// cargo streams: I = raw material in, E = finished goods (DRI/HBI) out, L = steel slab out
const DIRS={I:{name:'RM import',dot:'i',col:'--rm'},E:{name:'HBI export',dot:'e',col:'--fg'},L:{name:'Slab export',dot:'l',col:'--slab'}};
const ckey=(i,e,l)=>i+'|'+e+'|'+(l||'');
const slabRun=()=>!!(RUN&&RUN.results.some(r=>r.sl));
const comboTitle=()=>`${mixName(RP,SEL.i)} in · ${mixName(RP,SEL.e)} out${SEL.l?' · '+mixName(RP,SEL.l)+' slab':''}`;
function fmtN(x,d=0){if(x==null||isNaN(x)) return '—'; if(Math.abs(x)<0.5*Math.pow(10,-d)) x=0; return Number(x).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});}
function fmtT(t){return t==null?'—':Math.abs(t)>=1e6?fmtN(t/1e6,2)+' Mt':fmtN(t)+' t';}

async function api(method,url,body){
  const r=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  if(r.status===204) return null;
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.detail?(typeof data.detail==='string'?data.detail:JSON.stringify(data.detail)):`Request failed (${r.status})`);
  return data;
}

/* ---------- inputs panel ---------- */
const SECTIONS=[
  {id:'targets',title:'Annual targets',open:true,f:[['rmTarget','Raw material import (inward)','Mtpa'],['fgTarget','HBI export (outward)','Mtpa'],['slabTarget','SMS (slab) export (outward)','Mtpa · when slab export is ticked'],['tol','Allowed shortfall','% of target']]},
  {id:'jetty',title:'Jetty & year',open:true,f:[['jettyLen','Jetty length','m'],['gapPct','Clearance between ships','% of LOA (larger ship)'],['endPct','Clearance at each jetty end','% of LOA'],['maxJettyDays','Days in a year','plant and jetty']]},
  {id:'ships',title:'Ship classes & capacity utilisation',extra:'ships'},
  {id:'slab',title:'Steel slab export (3rd material)',extra:'slab'},
  {id:'plant',title:'DRI plant & yards',f:[['driCap','DRI production capacity','Mtpa'],['plantUtil','Plant utilisation','%'],['rmRatio','RM consumed per t of DRI','t / t'],['rmYardCap','RM yard capacity','t'],['rmInit','RM opening stock','t'],['rmSafety','RM safety stock','t'],['fgYardCap','HBI yard capacity','t'],['fgInit','HBI opening stock','t'],['fgSafety','HBI safety stock','t · kept for the SMS; export ships load only the HBI above it']]},
  {id:'equip',title:'SUL, loader & conveyors',f:[['sulN','Ship unloaders (SUL)','nos'],['sulRate','SUL rated capacity','tph each'],['sulEff','SUL efficiency','%'],['impConv','Import conveyor, jetty → RM yard','tph'],['impConvEff','Import conveyor efficiency','%'],['loaderN','Ship loaders','nos'],['loaderRate','Loader rated capacity','tph each'],['loaderEff','Loader efficiency','%'],['expConv','Export conveyor, HBI yard → jetty','tph'],['expConvEff','Export conveyor efficiency','%'],['cargoStop','Cargo stoppages (weather, shift change, hatch change)','% of time']]},
  {id:'marine',title:'Non-cargo activities',f:[['dayStart','Daylight window opens','hour'],['dayEnd','Daylight window closes','hour']],extra:'acts'},
  {id:'rules',title:'Planning rules',f:[['expTrigger','Call export ship when HBI stock reaches','% of parcel'],['rmCallDays','Call RM ship when stock above safety covers','days of plant use · 0 = as soon as a parcel fits'],['holdDays','Keep berth free for a call needed within','days'],['maxOcc','Highest acceptable berth occupancy','%']]}
];
const SLAB_F=[['smsCap','SMS production capacity','Mtpa of slab'],['smsUtil','SMS utilisation','%'],['slabDriRatio','HBI consumed per t of slab','t / t'],['smsDirectPct','SMS feed taken directly from the DRI plant','% · the rest comes from the HBI yard'],['smsStartH','SMS starts after the DRI plant','h · no slab made and no HBI taken before this'],['slabTrigger','Call slab ship when slab stock reaches','% of parcel'],
  ['slabYardCap','Slab yard capacity','t'],['slabInit','Slab opening stock','t'],
  ['slabCraneN','Slab loading cranes','nos · to be confirmed'],['slabCraneRate','Slab crane rated capacity','tph each · to be confirmed'],['slabCraneEff','Slab crane efficiency','% · to be confirmed']];
const MT_FIELDS=['rmTarget','fgTarget','slabTarget'];     // entered in million tonnes a year, kept in tonnes
function fieldHTML([k,label,unit]){
  if(k==='slabTarget'&&!P.slabOn) return '';
  if(MT_FIELDS.includes(k)) return `<div class="fld"><label for="in-${k}">${label}<small>${unit}</small></label><input type="number" id="in-${k}" data-k="${k}" data-mt="1" value="${+(P[k]/1e6).toFixed(3)}" step="any"></div>`;
  return `<div class="fld"><label for="in-${k}">${label}${unit?`<small>${unit}</small>`:''}</label><input type="number" id="in-${k}" data-k="${k}" value="${+(+P[k]).toFixed(3)}" step="any"></div>`;
}
function renderPanel(){
  const openState={}; document.querySelectorAll('details.sec').forEach(d=>openState[d.dataset.id]=d.open);
  const nameVal=$('#run-name')?$('#run-name').value:'';
  let h=`<div class="panel-head"><div><div class="eyebrow">Inputs</div><b>Plant, jetty &amp; ships</b></div><button class="btn-q" id="reset">Reset to defaults</button></div>
  <div class="run-row"><input type="text" id="run-name" placeholder="Run name (optional)" aria-label="Run name" value="${esc(nameVal)}"><button class="btn" id="run-btn" ${BUSY?'disabled':''}>${BUSY?'Running…':'Run simulation'}</button></div>
  <div class="step-row" role="radiogroup" aria-label="Simulation time step"><span>Time step</span>
    ${[[60,'1 hour'],[6,'6 minutes']].map(([v,l])=>`<label class="chk"><input type="radio" name="stepmin" value="${v}" ${(+P.stepMin||60)===v?'checked':''}>${l}</label>`).join('')}
    <small>${(+P.stepMin||60)===6?'finer timing, about 4–10× slower':'default'}</small></div>`;
  for(const s of SECTIONS){
    const open=openState[s.id]!==undefined?openState[s.id]:s.open;
    h+=`<details class="sec" data-id="${s.id}" ${open?'open':''}><summary>${s.title}</summary><div class="sec-body">`;
    if(s.id==='targets') h+=`<div class="fld"><label for="in-startDate">First ship arrival<small>the year is counted from here</small></label><input type="date" id="in-startDate" data-k="startDate" value="${esc(P.startDate)}"></div>
      <div class="fld"><label for="out-firstdep">First HBI export ship departure<small>calculated from the plan</small></label><output id="out-firstdep" class="num" style="text-align:right;font-size:13px">${firstDepText()}</output></div>
      ${P.slabOn?`<div class="fld"><label for="out-firstslabdep">First SMS (slab) ship departure<small>calculated from the plan</small></label><output id="out-firstslabdep" class="num" style="text-align:right;font-size:13px">${firstSlabDepText()}</output></div>`:''}`;
    if(s.f) h+=s.f.map(fieldHTML).join('');
    if(s.extra==='ships'){
      const rows=[['loa','LOA m'],['dwt','DWT t'],['util','Load %']];
      h+=`<div class="tw"><table class="mini-t"><thead><tr><th></th>${SHIPKEYS.map(k=>`<th>${P.ships[k].name}</th>`).join('')}</tr></thead><tbody>
      ${rows.map(([f,l])=>`<tr><td>${l}</td>${SHIPKEYS.map(k=>`<td><input type="number" step="any" id="sh-${k}-${f}" data-ship="${k}" data-sf="${f}" value="${P.ships[k][f]}" aria-label="${P.ships[k].name} ${l}"></td>`).join('')}</tr>`).join('')}
      <tr><td>Berths</td>${SHIPKEYS.map(k=>`<td style="text-align:center"><input type="checkbox" id="sh-${k}-berth" data-berth="${k}" ${P.berthShip===k?'checked':''} aria-label="Count berths by ${P.ships[k].name}"></td>`).join('')}</tr>
      ${[['imp','Import'],['exp','Export'],...(P.slabOn?[['slab','Slab']]:[])].map(([f,l])=>`<tr><td>${l}</td>${SHIPKEYS.map(k=>`<td style="text-align:center"><input type="checkbox" id="sh-${k}-${f}" data-ship="${k}" data-sf="${f}" ${P.ships[k][f]!==false?'checked':''} aria-label="Use ${P.ships[k].name} for ${l.toLowerCase()}"></td>`).join('')}</tr>`).join('')}
      </tbody></table></div>`;
    }
    if(s.extra==='slab'){
      h+=`<label class="chk" style="justify-self:start"><input type="checkbox" id="slabon" ${P.slabOn?'checked':''}>Include steel slab export</label>`;
      h+=P.slabOn?SLAB_F.map(fieldHTML).join('')+``
        :``;
    }
    if(s.extra==='acts'){
      h+=`<label class="chk" style="justify-self:start"><input type="checkbox" id="nightnav" ${P.nightNav?'checked':''}>Night berthing allowed</label>
      <div class="sub-h">Activities per call (hours)</div>
      <div class="tw"><table class="mini-t"><thead><tr><th>Activity</th><th>Hours</th><th>When</th><th title="Ship movement: waits for the daylight window when night berthing is off">Move</th><th></th></tr></thead><tbody>
      ${P.acts.map((a,i)=>`<tr><td><input type="text" class="nm" id="act-${i}-n" data-act="${i}" data-af="n" value="${esc(a.n)}" aria-label="Activity name"></td>
      <td style="width:62px"><input type="number" step="0.25" id="act-${i}-h" data-act="${i}" data-af="h" value="${a.h}" aria-label="Hours"></td>
      <td style="width:92px"><select id="act-${i}-p" data-act="${i}" data-af="phase" aria-label="Before or after cargo"><option value="pre" ${a.phase==='pre'?'selected':''}>Before cargo</option><option value="post" ${a.phase==='post'?'selected':''}>After cargo</option></select></td>
      <td style="width:30px;text-align:center"><input type="checkbox" id="act-${i}-t" data-act="${i}" data-af="tug" ${a.tug?'checked':''} aria-label="Ship movement (daylight only when night berthing is off)"></td>
      <td style="width:24px"><button class="btn-x" data-arm="${i}" aria-label="Remove activity">×</button></td></tr>`).join('')}
      </tbody></table></div><button class="btn-q" id="act-add" style="justify-self:start">Add activity</button>
      `;
    }
    h+=`</div></details>`;
  }
  $('#panel').innerHTML=h;
}
function firstDepText(){const r=DETAIL&&DETAIL.result; return r&&r.firstDep!=null?hstr(r.firstDep):'—';}
function firstSlabDepText(){const d=DETAIL&&DETAIL.result&&(DETAIL.result.log||[]).filter(s=>s.dir==='L'&&s.departH!=null).map(s=>s.departH); return d&&d.length?hstr(Math.min(...d)):'—';}
function markDirty(){ if(!DIRTY){DIRTY=true; renderBanner();} }
function onPanel(e){
  const t=e.target;
  if(t.id==='run-name') return;
  if(t.dataset.k==='startDate'){if(/^\d{4}-\d{2}-\d{2}$/.test(t.value)){P.startDate=t.value; markDirty();}}
  else if(t.dataset.k){const v=parseFloat(t.value); if(!isNaN(v)){P[t.dataset.k]=t.dataset.mt?v*1e6:v; markDirty();}}
  else if(t.dataset.berth){P.berthShip=t.checked?t.dataset.berth:''; document.querySelectorAll('[data-berth]').forEach(x=>{if(x!==t)x.checked=false;}); markDirty();}
  else if(t.dataset.ship && t.type==='checkbox'){P.ships[t.dataset.ship][t.dataset.sf]=t.checked; markDirty();}
  else if(t.dataset.ship){const v=parseFloat(t.value); if(!isNaN(v)){P.ships[t.dataset.ship][t.dataset.sf]=v; markDirty();}}
  else if(t.dataset.act!==undefined){const a=P.acts[+t.dataset.act], f=t.dataset.af;
    if(f==='h'){const v=parseFloat(t.value); if(!isNaN(v)) a.h=v;} else if(f==='tug') a.tug=t.checked; else a[f]=t.value; markDirty();}
  else if(t.id==='nightnav'){P.nightNav=t.checked; markDirty();}
  else if(t.name==='stepmin'){if(t.checked&&P.stepMin!==+t.value){P.stepMin=+t.value; markDirty(); renderPanel();}}
  else if(t.id==='slabon'){if(P.slabOn!==t.checked){P.slabOn=t.checked; markDirty(); renderPanel();}}
}
$('#panel').addEventListener('input',onPanel);
$('#panel').addEventListener('change',e=>{onPanel(e); const f=e.target.dataset.af; if(f==='h'||f==='phase') renderPanel();});
$('#panel').addEventListener('click',e=>{
  const t=e.target.closest('button'); if(!t) return;
  if(t.id==='reset'){P=clone(DEF); markDirty(); renderPanel();}
  else if(t.id==='run-btn') runSimulation();
  else if(t.dataset.arm){P.acts.splice(+t.dataset.arm,1); markDirty(); renderPanel();}
  else if(t.id==='act-add'){P.acts.push({n:'New activity',h:0.5,phase:'pre',tug:false}); markDirty(); renderPanel();}
});

/* ---------- runs ---------- */
async function runSimulation(){
  if(BUSY) return;
  if(!mixesFor(P,'imp').length||!mixesFor(P,'exp').length){ERR='Select at least one ship class for import and one for export under Ship classes.'; renderBanner(); return;}
  if(P.slabOn&&!mixesFor(P,'slab').length){ERR='Select at least one ship class for slab under Ship classes, or turn slab export off.'; renderBanner(); return;}
  BUSY=true; ERR=''; renderPanel(); renderBanner();
  try{
    P.sel={i:SEL.i,e:SEL.e,l:SEL.l||P.sel.l||'P'};
    const run=await api('POST','/api/runs',{name:$('#run-name').value,inputs:P});
    $('#run-name').value='';
    await showRun(run,false);
    await refreshRuns();
  }catch(e){ERR=e.message;}
  BUSY=false; renderPanel(); renderBanner();
}
async function openRun(id){
  try{ERR=''; await showRun(await api('GET','/api/runs/'+id),true); showTab('plan');}
  catch(e){ERR=e.message; renderBanner();}
}
// inputs saved before a field existed (e.g. the slab inputs) take that field's default
function withDefaults(Q){
  const o={...clone(DEF),...clone(Q)};
  if(Q.slabTrigger==null&&Q.expTrigger!=null) o.slabTrigger=Q.expTrigger;   // runs saved before the separate slab trigger used the HBI one
  if(Q.smsCap==null&&(Q.smsRate!=null||Q.slabTarget!=null)){   // runs saved with the SMS per hour or per year
    o.smsCap=(Q.smsRate!=null?Q.smsRate*(+o.maxJettyDays||333)*24:Q.slabTarget)/1e6; o.smsUtil=100;}
  o.ships={}; SHIPKEYS.forEach(k=>o.ships[k]={...DEF.ships[k],...((Q.ships||{})[k]||{})});
  o.sel={...DEF.sel,...(Q.sel||{})};
  return o;
}
async function showRun(run,loadInputs){
  RUN=run; RP=withDefaults(run.inputs); RES={};
  run.results.forEach(r=>RES[ckey(r.im,r.ex,r.sl)]=r);
  if(loadInputs){P=clone(RP); renderPanel();}
  DIRTY=false;
  const IM=[...new Set(run.results.map(r=>r.im))], EX=[...new Set(run.results.map(r=>r.ex))], SL=[...new Set(run.results.map(r=>r.sl))];
  SEL={i:IM.includes(RP.sel.i)?RP.sel.i:IM[0], e:EX.includes(RP.sel.e)?RP.sel.e:EX[0], l:SL.includes(RP.sel.l)?RP.sel.l:SL[0]};
  await selectCombo(SEL.i,SEL.e,SEL.l);
}
async function selectCombo(i,e,l=SEL.l){
  l=l||''; SEL={i,e,l}; P.sel={...P.sel,i,e}; if(l) P.sel.l=l;
  DETAIL=await api('GET',`/api/runs/${RUN.id}/combos/${i}/${e}${l?'?sl='+l:''}`);
  renderAll();
}
async function refreshRuns(){RUNS=await api('GET','/api/runs'); renderRuns();}

/* ---------- rendering ---------- */
$('#tabs').addEventListener('click',e=>{const b=e.target.closest('.tab'); if(b) showTab(b.dataset.tab);});
function showTab(t){TAB=t; document.querySelectorAll('.tab').forEach(b=>b.setAttribute('aria-selected',b.dataset.tab===t));
  document.querySelectorAll('.pane').forEach(p=>p.classList.toggle('hide',p.id!=='pane-'+t));}

// Show or hide the simulator tab; the choice is remembered in this browser
function setSimulatorsShown(on){
  document.querySelectorAll('[data-tab="sim2d"]').forEach(b=>b.hidden=!on);
  const btn=$('#sim-toggle'); btn.textContent=on?'Hide simulator':'Show simulator'; btn.setAttribute('aria-pressed',String(on));
  if(!on && TAB==='sim2d'){ if(typeof SIM!=='undefined') SIM.playing=false; showTab('plan'); }
  try{localStorage.setItem('dri-jetty-sims',on?'1':'0');}catch(e){}
}
$('#sim-toggle').addEventListener('click',()=>setSimulatorsShown($('#sim-toggle').getAttribute('aria-pressed')!=='true'));
(function(){let on=true; try{on=localStorage.getItem('dri-jetty-sims')!=='0';}catch(e){} setSimulatorsShown(on);})();

function renderBanner(){
  let h='';
  if(ERR) h=`<div class="banner err">${esc(ERR)}</div>`;
  else if(BUSY) h=`<div class="banner">Running all ship combinations${(+P.stepMin||60)===6?' in 6-minute steps':''}…${P.slabOn?' With slab export there are up to 343, so this takes longer.':''}${(+P.stepMin||60)===6?' 6-minute steps take several times longer than 1-hour steps.':''}</div>`;
  else if(RUN&&DIRTY) h=`<div class="banner">Inputs changed since run “${esc(RUN.name)}”. Select <b>Run simulation</b> to save a new run with these inputs.</div>`;
  else if(RUN) h=`<div class="note">Run #${RUN.id} · ${esc(RUN.created_at.slice(0,16))} · ${RUN.n_combos} mixes · ${(+RP.stepMin||60)===6?'6 min':'1 h'} steps</div>`;
  $('#banner').innerHTML=h;
}
function renderAll(){
  renderBanner(); renderHead(); renderPlan(); renderCombos(); renderSim(); renderCal(); renderRuns(); renderMethod();
  const fd=$('#out-firstdep'); if(fd) fd.textContent=firstDepText();
  const fs=$('#out-firstslabdep'); if(fs) fs.textContent=firstSlabDepText();
}
function renderEmpty(){
  const msg=`<div class="card empty">No saved runs yet. Check the inputs on the left and select <b>Run simulation</b>.</div>`;
  ['plan','combos','sim','cal'].forEach(p=>$('#pane-'+p).innerHTML=msg);
  $('#head-verdict').innerHTML=''; renderRuns(); renderMethod(); renderBanner();
}
const cur=()=>DETAIL.result;
const CAL=()=>DETAIL.calendar;

function renderHead(){
  const r=cur(), n=Object.values(RES).filter(x=>x.feasible).length;
  $('#head-verdict').innerHTML=`<div class="vbadge ${r.feasible?'yes':'no'}">${r.feasible?'YES':'NO'}</div>
  <div class="vtext"><b title="${esc(comboTitle())}">${comboTitle()}</b>
  <span>${n} of ${Object.keys(RES).length} mixes pass · run #${RUN.id}</span></div>`;
}

const kpi=(l,v,s='',cls='')=>`<div class="kpi ${cls}"><span class="l">${l}</span><span class="v">${v}</span>${s?`<span class="s">${s}</span>`:''}</div>`;
const pill=(ok,yes='YES',no='NO')=>`<span class="pill ${ok?'yes':'no'}">${ok?yes:no}</span>`;

function renderPlan(){
  const D=DETAIL.plan, K=D.kpis, r=cur();
  const fitRows=D.fits.map(f=>`<tr><td class="l">${f.ships}</td><td>${f.count}</td><td>${fmtN(f.length)}</td><td>${fmtN(f.spare)}</td><td>${pill(f.fits,'FITS','NO')}</td></tr>`).join('');
  const typeRows=D.types.map(a=>`<tr><td class="l"><span class="dot ${DIRS[a.dir].dot}"></span>${DIRS[a.dir].name} · ${a.name}</td>
    <td>${fmtN(a.parcel)}</td><td>${fmtN(a.calls)}</td><td>${fmtN(a.perMonth,1)}</td><td>${fmtN(a.cargoH,1)}</td><td>${fmtN(a.nc,1)}</td><td>${fmtN(a.per,1)}</td><td>${fmtN(a.berthDays,0)}</td><td>${fmtN(a.share,1)}%</td>
    <td>${!a.ok?'<span class="pill na">not allowed</span>':!a.selected?'<span class="pill na">not selected</span>':''}</td></tr>`).join('');
  $('#pane-plan').innerHTML=`
  <div class="card">
    <div class="card-h"><div><div class="eyebrow">Step 1A · desk plan</div><h2>Shipment planning for ${comboTitle()}</h2></div>
    <div class="verdict"><span class="vbadge ${D.ok?'yes':'no'}" style="font-size:24px">${D.ok?'YES':'NO'}</span><span class="note">Desk check, before simulation</span></div></div>
    <div class="kpis">
      ${kpi('Days in a year',fmtN(K.nWork),'plant and jetty')}
      ${kpi('Import rate (effective)',fmtN(K.impRate)+' tph',`needs ${fmtN(K.needImp)} tph average`, K.impRate>=K.needImp?'':'bad')}
      ${kpi('Export rate (effective)',fmtN(K.expRate)+' tph',`needs ${fmtN(K.needExp)} tph average`, K.expRate>=K.needExp?'':'bad')}
      ${kpi('DRI production',fmtN(K.prod/K.nWork)+' t/day',fmtT(K.prod)+' in '+K.nWork+' plant days')}
      ${kpi('RM consumption',fmtN(K.rmNeed/K.nWork)+' t/day',fmtT(K.rmNeed)+' / year')}
      ${kpi('RM yard cover',fmtN(K.rmCover,1)+' days','at full yard')}
      ${kpi('HBI yard cover',fmtN(K.fgCover,1)+' days','until yard is full')}
      ${kpi('Calls needed',fmtN(K.impCalls+K.expCalls+K.slabCalls),`${K.impCalls} import · ${K.expCalls} export${K.slab?` · ${K.slabCalls} slab`:''}`)}
      ${K.slab?kpi('Slab rate (effective)',fmtN(K.slabRate)+' tph',`needs ${fmtN(K.needSlab)} tph average`, K.slabRate>=K.needSlab?'':'bad')
        +kpi('DRI to SMS',fmtN(K.smsDri/K.nWork)+' t/day',fmtT(K.smsDri)+' / year for '+fmtT(RP.slabTarget)+' slab')
        +kpi('Slab yard cover',fmtN(K.slabCover,1)+' days','until yard is full'):''}
    </div>
    <ul class="reasons">${D.checks.map(([ok,t])=>`<li class="${ok?'ok':'bad'}">${ok?'✓':'✗'} ${esc(t)}</li>`).join('')}</ul>
    
  </div>
  <div class="card">
    <div class="card-h"><div><div class="eyebrow">Constraint 1 · ${fmtN(RP.jettyLen)} m jetty</div><h2>Which ships can use the jetty</h2></div></div>
    ${jettySVG(D.pair)}
    <div class="tw"><table class="t"><thead><tr><th>Ship class</th><th>LOA m</th><th>DWT t</th><th>Load %</th><th>Parcel t</th><th>Length</th><th>Usable</th></tr></thead><tbody>
    ${D.eligibility.map(e=>`<tr><td class="l">${e.name}</td><td>${fmtN(e.loa)}</td><td>${fmtN(e.dwt)}</td><td>${fmtN(e.util,1)}</td><td>${fmtN(e.parcel)}</td><td>${pill(e.lenOk,'OK','NO')}</td><td>${pill(e.ok)}</td></tr>`).join('')}
    </tbody></table></div>
    <h3>Ships alongside at the same time</h3>
    <div class="tw"><table class="t"><thead><tr><th>Ships alongside</th><th>Count</th><th>Length used m</th><th>Spare m</th><th>Fits ${fmtN(RP.jettyLen)} m</th></tr></thead><tbody>${fitRows}</tbody></table></div>
    
  </div>
  <div class="card">
    <div class="card-h"><div><div class="eyebrow">Calls per ship class</div><h2>Annual call requirement</h2></div></div>
    <div class="tw"><table class="t"><thead><tr><th>Direction · class</th><th>Parcel t</th><th>Calls / yr</th><th>Calls / month</th><th>Cargo h / call</th><th>Non-cargo h / call</th><th>Berth h / call</th><th>Berth days / yr</th><th>Share of jetty time</th><th></th></tr></thead><tbody>${typeRows}</tbody></table></div>
    
  </div>`;
}

function jettySVG(pair){
  const W=900,H=150,ml=20,mr=20, J=RP.jettyLen, sc=(W-ml-mr)/Math.max(J,1), si=pair.imp, se=pair.exp, L=pair.length, fit=pair.fits;
  const hull=(x,len,y,cls,name)=>{const w=len*sc, bow=Math.min(18,w*.12);
    return `<path d="M${x} ${y} H${x+w-bow} L${x+w} ${y+14} L${x+w-bow} ${y+28} H${x} Z" style="fill:var(${cls})"/><text class="lbl-w" x="${x+8}" y="${y+18}">${esc(name)} · ${fmtN(len)} m</text>`;};
  const x1=ml+pair.endM*sc, x2=x1+si.loa*sc+pair.gapM*sc;
  return `<div class="tw"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Jetty layout with the largest import and export ship alongside">
  <rect x="0" y="0" width="${W}" height="96" style="fill:var(--water)"/>
  <rect x="${ml}" y="96" width="${J*sc}" height="14" style="fill:var(--deck)"/>
  ${hull(x1,si.loa,52,'--rm','Import: '+si.name)}${hull(x2,se.loa,52,'--fg','Export: '+se.name)}
  <line x1="${ml}" x2="${ml+J*sc}" y1="128" y2="128" style="stroke:var(--muted)"/>
  <line x1="${ml}" x2="${ml}" y1="122" y2="134" style="stroke:var(--muted)"/><line x1="${ml+J*sc}" x2="${ml+J*sc}" y1="122" y2="134" style="stroke:var(--muted)"/>
  <text class="ax" x="${ml+J*sc/2}" y="145" text-anchor="middle">Jetty ${fmtN(J)} m · used ${fmtN(L)} m · ${fit?'spare '+fmtN(J-L)+' m':'over by '+fmtN(L-J)+' m'}</text>
  <text class="lbl" x="${W-mr}" y="22" text-anchor="end" style="fill:var(${fit?'--ok':'--bad'})">${fit?'Both fit together':'Cannot berth together'}</text>
  </svg></div>`;
}

function renderCombos(){
  const IM=[...new Set(RUN.results.map(r=>r.im))], EX=[...new Set(RUN.results.map(r=>r.ex))];
  const SB=slabRun(), SL=[...new Set(RUN.results.map(r=>r.sl))], calls=r=>r.impCalls+r.expCalls+(r.slabCalls||0);
  const rows=IM.map(i=>`<tr><th class="rh">${mixName(RP,i)}</th>${EX.map(e=>{const r=RES[ckey(i,e,SEL.l)], c=r.inelig?'na':r.feasible?'yes':'no', cu=(SEL.i===i&&SEL.e===e)?' cur':'';
    return `<td><button class="mc ${c}${cu}" data-combo="${ckey(i,e,SEL.l)}" title="${esc(mixName(RP,i))} in, ${esc(mixName(RP,e))} out${SEL.l?', '+esc(mixName(RP,SEL.l))+' slab':''}">${r.inelig?'<b>N/A</b><small>not allowed</small>':`<b>${r.feasible?'YES':'NO'}</b><small>${r.impCalls}+${r.expCalls}${SB?'+'+r.slabCalls:''} calls</small><small>${fmtN(r.occ,0)}% occ.</small>`}</button></td>`;}).join('')}</tr>`).join('');
  const list=RUN.results.filter(r=>!r.inelig).sort((a,b)=>(b.feasible-a.feasible)||(a.reasons.length-b.reasons.length)||(calls(a)-calls(b))||(a.occ-b.occ));
  const nYes=SB?RUN.results.filter(r=>r.sl===SEL.l&&r.feasible).length:0;
  const na=RUN.results.filter(r=>r.inelig).length;
  $('#pane-combos').innerHTML=`
  <div class="card">
    <div class="card-h"><div><div class="eyebrow">Step 1B · constraint 2</div><h2>Import × export${SB?' × slab':''} ship combinations</h2></div></div>
    ${SB?`<div class="sel-row"><label for="combo-sel-l">Slab fleet<select id="combo-sel-l">${SL.map(m=>`<option value="${m}" ${SEL.l===m?'selected':''}>${mixName(RP,m)}</option>`).join('')}</select></label><span class="note">${nYes} of ${IM.length*EX.length} pass with this slab fleet · ${RUN.n_feasible} of ${RUN.n_combos} over all slab fleets</span></div>`:''}
    <div class="tw"><table class="matrix"><thead><tr><th class="rh">Import ↓ / Export →</th>${EX.map(e=>`<th>${mixName(RP,e).replace(/ \+ /g,' +<br>')}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
  </div>
  <div class="card">
    <div class="card-h"><div><div class="eyebrow">Ranking</div><h2>All simulated combinations</h2></div></div>
    <div class="tw" style="${SB?'max-height:640px;overflow:auto':''}"><table class="t"><thead><tr><th>Import fleet</th><th>Export fleet</th>${SB?'<th>Slab fleet</th>':''}<th>Result</th><th>Import calls</th><th>Export calls</th>${SB?'<th>Slab calls</th>':''}<th>RM imported</th><th>HBI exported</th>${SB?'<th>Slab exported</th><th>Slab yard full h</th>':''}<th>Berth occ.</th><th>Avg turnaround h</th><th>Plant starved h</th><th>HBI yard full h</th><th>Lowest RM stock</th><th>Main issue</th></tr></thead><tbody>
    ${list.map(r=>`<tr class="${SEL.i===r.im&&SEL.e===r.ex&&SEL.l===r.sl?'sel':''}" data-combo="${ckey(r.im,r.ex,r.sl)}" style="cursor:pointer"><td class="l">${mixName(RP,r.im)}</td><td class="l">${mixName(RP,r.ex)}</td>${SB?`<td class="l">${mixName(RP,r.sl)}</td>`:''}<td>${pill(r.feasible)}</td><td>${r.impCalls}</td><td>${r.expCalls}</td>${SB?`<td>${r.slabCalls}</td>`:''}<td>${fmtT(r.imported)}</td><td>${fmtT(r.exported)}</td>${SB?`<td>${fmtT(r.slabExported)}</td><td>${fmtN(r.slabFullH)}</td>`:''}<td>${fmtN(r.occ,1)}%</td><td>${fmtN(r.avgTurn,1)}</td><td>${fmtN(r.stockoutH)}</td><td>${fmtN(r.fgFullH)}</td><td>${fmtT(r.minRM)}</td><td class="l">${esc(r.reasons[0]||r.warnings[0]||'—')}</td></tr>`).join('')}
    </tbody></table></div>
  </div>`;
  const sl=$('#combo-sel-l'); if(sl) sl.addEventListener('change',async e=>{try{await selectCombo(SEL.i,SEL.e,e.target.value);}catch(err){ERR=err.message; renderBanner();}});
}
document.addEventListener('click',async e=>{const c=e.target.closest('[data-combo]'); if(!c||!RUN) return; const [i,x,l]=c.dataset.combo.split('|');
  try{await selectCombo(i,x,l); showTab('sim');}catch(err){ERR=err.message; renderBanner();}});

function niceStep(r){const p=Math.pow(10,Math.floor(Math.log10(r||1)));const f=r/p;return (f<=1?1:f<=2?2:f<=5?5:10)*p;}
const fmtK=v=>v>=1e6?fmtN(v/1e6,v%1e6?1:0)+'M':v>=1e3?fmtN(v/1e3)+'k':fmtN(v);
function lineChart({data,color,ymax,lines,label}){
  const W=900,H=230,ml=52,mr=14,mt=14,mb=26,n=data.length;
  const step=niceStep(ymax/4), top=Math.ceil(ymax/step)*step;
  const X=i=>ml+i*(W-ml-mr)/Math.max(1,n-1), Y=v=>mt+(H-mt-mb)*(1-Math.max(0,v)/top);
  let s=`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">`;
  for(let v=0;v<=top+1e-6;v+=step) s+=`<line class="gl" x1="${ml}" x2="${W-mr}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ax" x="${ml-6}" y="${Y(v)+4}" text-anchor="end">${fmtK(v)}</text>`;
  CAL().days.forEach((d,i)=>{if(d.dd===1) s+=`<text class="ax" x="${X(i)+2}" y="${H-8}">${MON[d.m]}</text>`;});
  const yd=CAL().yearDays;
  if(n>yd) s+=`<line x1="${X(yd-1)}" x2="${X(yd-1)}" y1="${mt}" y2="${H-mb}" style="stroke:var(--ink);stroke-dasharray:2 3"/><text class="ax" x="${X(yd-1)-4}" y="${mt+10}" text-anchor="end">Day ${yd}</text>`;
  const pts=data.map((v,i)=>`${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' L');
  s+=`<path d="M${X(0)},${Y(0)} L${pts} L${X(n-1)},${Y(0)} Z" style="fill:var(${color});fill-opacity:.13"/>`;
  s+=`<path d="M${pts}" style="fill:none;stroke:var(${color});stroke-width:1.8"/>`;
  for(const l of lines) s+=`<line x1="${ml}" x2="${W-mr}" y1="${Y(l.v)}" y2="${Y(l.v)}" style="stroke:var(${l.c});stroke-dasharray:5 4;stroke-width:1.3"/><text class="ax" x="${W-mr-4}" y="${Y(l.v)-5}" text-anchor="end" style="fill:var(${l.c})">${l.t} ${fmtK(l.v)}</text>`;
  const li=n-1; s+=`<circle cx="${X(li)}" cy="${Y(data[li])}" r="3.5" style="fill:var(${color})"/>`;
  return s+'</svg>';
}
function monthBars(r){
  const days=CAL().days, NM=days[days.length-1].mi+1, W=900,H=200,ml=40,mr=10,mt=12,mb=26, ci=Array(NM).fill(0), ce=Array(NM).fill(0), cl=Array(NM).fill(0);
  const mlab=Array(NM); days.forEach(d=>{if(!mlab[d.mi]) mlab[d.mi]=MON[d.m]+" '"+String(d.y).slice(2);});
  r.log.forEach(s=>{const m=days[Math.min(days.length-1,Math.floor(Math.max(0,s.berthH)/24))].mi; ({I:ci,E:ce,L:cl}[s.dir])[m]++;});
  const mx=Math.max(1,...ci.map((v,i)=>v+ce[i]+cl[i])), step=niceStep(mx/4), top=Math.ceil(mx/step)*step;
  const bw=(W-ml-mr)/NM, Y=v=>mt+(H-mt-mb)*(1-v/top);
  let s=`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Vessel calls per month">`;
  for(let v=0;v<=top;v+=step) s+=`<line class="gl" x1="${ml}" x2="${W-mr}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ax" x="${ml-6}" y="${Y(v)+4}" text-anchor="end">${v}</text>`;
  for(let m=0;m<NM;m++){const x=ml+m*bw+bw*.18, w=bw*.64;
    s+=`<rect x="${x}" y="${Y(ci[m])}" width="${w}" height="${Y(0)-Y(ci[m])}" style="fill:var(--rm)"/>`;
    s+=`<rect x="${x}" y="${Y(ci[m]+ce[m])}" width="${w}" height="${Y(ci[m])-Y(ci[m]+ce[m])}" style="fill:var(--fg)"/>`;
    if(cl[m]) s+=`<rect x="${x}" y="${Y(ci[m]+ce[m]+cl[m])}" width="${w}" height="${Y(ci[m]+ce[m])-Y(ci[m]+ce[m]+cl[m])}" style="fill:var(--slab)"/>`;
    s+=`<text class="lbl" x="${x+w/2}" y="${Y(ci[m]+ce[m]+cl[m])-4}" text-anchor="middle">${ci[m]+ce[m]+cl[m]}</text>`;
    s+=`<text class="ax" x="${x+w/2}" y="${H-8}" text-anchor="middle">${mlab[m]}</text>`;}
  return s+'</svg>';
}
function gantt(r){
  const dw=4, ml=8, days=CAL().days, nL=Math.max(2,...r.log.map(s=>s.lane+1)), lh=30, top=22;
  const W=ml+days.length*dw+8, H=top+nL*lh+6;
  let s=`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Berth occupancy across the year">`;
  days.forEach((d,i)=>{if(d.st!=='work') s+=`<rect x="${ml+i*dw}" y="${top}" width="${dw}" height="${nL*lh}" style="fill:var(--${d.st})"><title>${d.iso} · ${esc(d.why)}</title></rect>`;
    if(d.dd===1) s+=`<line class="gl" x1="${ml+i*dw}" x2="${ml+i*dw}" y1="4" y2="${H}"/><text class="ax" x="${ml+i*dw+3}" y="14">${MON[d.m]}</text>`;});
  for(let l=1;l<nL;l++) s+=`<line class="gl" x1="${ml}" x2="${W}" y1="${top+l*lh}" y2="${top+l*lh}"/>`;
  const yd=CAL().yearDays;
  s+=`<line x1="${ml+yd*dw}" x2="${ml+yd*dw}" y1="4" y2="${H}" style="stroke:var(--ink);stroke-dasharray:2 3"/><text class="ax" x="${ml+yd*dw+3}" y="${H-4}">Day ${yd}</text>`;
  r.log.forEach(v=>{const end=v.departH??r.NH, y=top+v.lane*lh+4, x=ml+v.berthH/24*dw, w=Math.max(1.5,(end-v.berthH)/24*dw), col=DIRS[v.dir].col;
    const cs=v.cargoStartH??end, ce=v.cargoEndH??end;
    s+=`<g><title>#${v.n} ${DIRS[v.dir].name} ${RP.ships[v.t].name} · ${fmtN(v.qty)} t · ${hstr(v.berthH)} → ${v.departH!=null?hstr(v.departH):'carried over'}</title>
    <rect x="${x}" y="${y}" width="${w}" height="${lh-8}" rx="2" style="fill:var(${col});fill-opacity:.38"/>
    <rect x="${ml+cs/24*dw}" y="${y}" width="${Math.max(1,(ce-cs)/24*dw)}" height="${lh-8}" style="fill:var(${col})"/></g>`;});
  return s+'</svg>';
}
function hstr(h){h=Math.max(0,h); const days=CAL().days, d=Math.min(days.length-1,Math.floor(h/24)), m=Math.round((h-d*24)*60), hh=Math.floor(m/60), mm=m%60;
  return days[d].dd+' '+MON[days[d].m]+' '+String(days[d].y).slice(2)+' '+String(Math.min(hh,23)).padStart(2,'0')+':'+String(hh>23?59:mm).padStart(2,'0');}

function renderSim(){
  const r=cur(), IM=[...new Set(RUN.results.map(x=>x.im))], EX=[...new Set(RUN.results.map(x=>x.ex))], SL=[...new Set(RUN.results.map(x=>x.sl))], SB=slabRun();
  const opts=(sel,list)=>list.map(m=>`<option value="${m}" ${sel===m?'selected':''}>${mixName(RP,m)}</option>`).join('');
  let h=`<div class="card"><div class="card-h"><div><div class="eyebrow">Step 2 · ${(+RP.stepMin||60)===6?'6-minute':'hour-by-hour'} simulation from ${hstr(0).slice(0,-6)}</div><h2>Can this ship combination carry the year?</h2></div></div>
  <div class="sel-row"><label for="sel-i">Import fleet (RM)<select id="sel-i">${opts(SEL.i,IM)}</select></label><label for="sel-e">Export fleet (HBI)<select id="sel-e">${opts(SEL.e,EX)}</select></label>${SB?`<label for="sel-l">Slab fleet<select id="sel-l">${opts(SEL.l,SL)}</select></label>`:''}
  <span class="vbadge ${r.feasible?'yes':'no'}">${r.feasible?'YES':'NO'}</span></div>
  <ul class="reasons">${r.reasons.map(x=>`<li class="bad">✗ ${esc(x)}</li>`).join('')}${r.feasible?`<li class="ok">✓ ${SB?'All three targets met with no plant stoppage, no HBI or slab yard overflow':'Both targets met with no plant stoppage, no HBI yard overflow'} and berth occupancy within ${fmtN(RP.maxOcc)}%</li>`:''}${(r.warnings||[]).map(x=>`<li class="warn">! ${esc(x)}</li>`).join('')}</ul></div>`;
  if(r.inelig){$('#pane-sim').innerHTML=h; bindSel(); return;}
  const tI=RP.rmTarget, tE=RP.fgTarget;
  h+=`<div class="kpis">
    ${kpi('RM imported in 1 year',fmtT(r.imported),`${fmtN(r.imported/tI*100,1)}% · from 1st arrival ${hstr(r.firstArr)}`,r.imported>=tI*(1-RP.tol/100)?'ok':'bad')}
    ${kpi('HBI exported in 1 year',fmtT(r.exported),`${fmtN(r.exported/tE*100,1)}% · from 1st sailing ${r.firstDep!=null?hstr(r.firstDep):'—'}`,r.exported>=tE*(1-RP.tol/100)?'ok':'bad')}
    ${SB?kpi('Slab exported in 1 year',fmtT(r.slabExported),`${fmtN(r.slabExported/RP.slabTarget*100,1)}% · from 1st sailing ${r.firstSlabDep!=null?hstr(r.firstSlabDep):'—'}`,r.slabExported>=RP.slabTarget*(1-RP.tol/100)?'ok':'bad'):''}
    ${kpi('Vessel calls',fmtN(r.impCalls+r.expCalls+(r.slabCalls||0)),`${r.impCalls} import · ${r.expCalls} export${SB?` · ${r.slabCalls} slab`:''}`)}
    ${kpi('Berth occupancy',fmtN(r.occ,1)+'%',`${r.berths} berth positions · quay length ${fmtN(r.lenOcc,0)}%`,r.occ>RP.maxOcc?'bad':'')}
    ${kpi('Avg ship turnaround',fmtN(r.avgTurn,1)+' h','berthing to sailing')}
    ${kpi('Avg ship waiting',fmtN(r.avgIdle,1)+' h','alongside, waiting for cargo, space, SUL/loader or daylight')}
    ${kpi('Plant starved of RM',fmtN(r.stockoutH)+' h','',r.stockoutH?'bad':'ok')}
    ${kpi('HBI yard full',fmtN(r.fgFullH)+' h',r.lost>1?fmtT(r.lost)+' production lost':'',r.fgFullH?'bad':'ok')}
    ${kpi('DRI produced',fmtT(r.produced),`in the ${CAL().yearDays}-day year`)}
    ${SB?kpi('Slab yard full',fmtN(r.slabFullH)+' h',r.slabFullH?'SMS stopped':'SMS never stopped',r.slabFullH?'bad':'ok'):''}
    ${kpi(`Stock on day ${CAL().yearDays}`,fmtT(r.endRM)+' RM',fmtT(r.endFG)+' HBI'+(SB?' · '+fmtT(r.endSlab)+' slab':''))}
  </div>
  <div class="split">
    <div class="card"><div class="card-h"><h3>RM yard stock</h3><div class="legend"><span><i style="background:var(--rm)"></i>Stock</span><span style="color:var(--bad)"><i class="dash"></i>Capacity</span><span style="color:var(--warn)"><i class="dash"></i>Safety</span></div></div>
      ${lineChart({data:r.dRM,color:'--rm',ymax:Math.max(RP.rmYardCap,r.maxRM)*1.05,lines:[{v:RP.rmYardCap,c:'--bad',t:'Capacity'},{v:RP.rmSafety,c:'--warn',t:'Safety'}],label:'Raw material yard stock by day'})}</div>
    <div class="card"><div class="card-h"><h3>HBI yard stock</h3><div class="legend"><span><i style="background:var(--fg)"></i>Stock</span><span style="color:var(--bad)"><i class="dash"></i>Capacity</span>${RP.fgSafety?'<span style="color:var(--warn)"><i class="dash"></i>Safety</span>':''}</div></div>
      ${lineChart({data:r.dFG,color:'--fg',ymax:Math.max(RP.fgYardCap,r.maxFG)*1.05,lines:[{v:RP.fgYardCap,c:'--bad',t:'Capacity'},...(RP.fgSafety?[{v:RP.fgSafety,c:'--warn',t:'Safety'}]:[])],label:'HBI yard stock by day'})}</div>
  </div>
  ${SB?`<div class="card"><div class="card-h"><h3>Slab yard stock</h3><div class="legend"><span><i style="background:var(--slab)"></i>Stock</span><span style="color:var(--bad)"><i class="dash"></i>Capacity</span></div></div>
      ${lineChart({data:r.dSlab,color:'--slab',ymax:Math.max(RP.slabYardCap,r.maxSlab)*1.05,lines:[{v:RP.slabYardCap,c:'--bad',t:'Capacity'}],label:'Slab yard stock by day'})}</div>`:''}
  <div class="card"><div class="card-h"><h3>Vessel calls per month</h3><div class="legend"><span><i class="sq" style="background:var(--rm)"></i>RM import</span><span><i class="sq" style="background:var(--fg)"></i>HBI export</span>${SB?'<span><i class="sq" style="background:var(--slab)"></i>Slab export</span>':''}</div></div>${monthBars(r)}</div>
  <div class="card"><div class="card-h"><h3>Jetty occupancy, berth position by day</h3><div class="legend"><span><i class="sq" style="background:var(--rm)"></i>Import cargo</span><span><i class="sq" style="background:var(--fg)"></i>Export cargo</span>${SB?'<span><i class="sq" style="background:var(--slab)"></i>Slab cargo</span>':''}<span><i class="sq" style="background:var(--fg);opacity:.38"></i>Non-cargo &amp; waiting</span></div></div>
    <div class="gantt-wrap">${gantt(r)}</div></div>
  <div class="card"><div class="card-h"><div><div class="eyebrow">Vessel call schedule</div><h3>${r.log.length} calls planned on calendar days</h3></div></div>
    <div class="tw" style="max-height:520px;overflow:auto"><table class="t"><thead><tr><th>#</th><th>Cargo</th><th>Ship</th><th>Quantity t</th><th>Arrive</th><th>Cargo start</th><th>Cargo end</th><th>Sail</th><th>Cargo h</th><th>Non-cargo h</th><th>Waiting h</th></tr></thead><tbody>
    ${r.log.map(s=>`<tr><td>${s.n}</td><td class="l"><span class="dot ${DIRS[s.dir].dot}"></span>${DIRS[s.dir].name}</td><td class="l">${RP.ships[s.t].name}</td><td>${fmtN(s.qty)}</td><td>${hstr(s.berthH)}</td><td>${s.cargoStartH!=null?hstr(s.cargoStartH):'—'}</td><td>${s.cargoEndH!=null?hstr(s.cargoEndH):'—'}</td><td>${s.departH!=null?hstr(s.departH):'carried over'}</td><td>${s.cargoStartH!=null?fmtN(((s.cargoEndH??r.NH)-s.cargoStartH),1):'—'}</td><td>${fmtN(s.ncH,1)}</td><td>${fmtN(s.idle+s.waitTug,1)}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  $('#pane-sim').innerHTML=h; bindSel();
}
function bindSel(){['i','e','l'].forEach(k=>{const el=$('#sel-'+k); if(el) el.addEventListener('change',async e=>{const s={...SEL,[k]:e.target.value};
  try{await selectCombo(s.i,s.e,s.l);}catch(err){ERR=err.message; renderBanner();}});});}

function renderCal(){
  const cal=CAL(), r=cur(), arr={};
  if(!r.inelig) r.log.forEach(s=>{const d=Math.floor(Math.max(0,s.berthH)/24); (arr[d]=arr[d]||[]).push(s);});
  let h=`<div class="card"><div class="card-h"><div><div class="eyebrow">Constraints 3 &amp; 4 · ${cal.yearDays}-day year from ${hstr(0).slice(0,-6)}</div><h2>Calendar with vessel arrivals</h2></div>
  <span class="note">${comboTitle()}</span></div>
  <div class="kpis">${kpi('Days in a year',cal.yearDays,'plant and jetty')}</div>
  <div class="cal-leg"><span><span class="dot i"></span>I = import ship arrives</span><span><span class="dot e"></span>E = export ship arrives</span>${SEL.l?'<span><span class="dot l"></span>L = slab ship arrives</span>':''}</div>
  <div class="cal">`;
  const yr=cal.days.slice(0,cal.yearDays), NM=yr[yr.length-1].mi+1;
  for(let m=0;m<NM;m++){
    const md=yr.filter(d=>d.mi===m);
    h+=`<div class="mon"><div class="mh">${MON[md[0].m]} ${md[0].y}</div><div class="mg">${DOW.map(d=>`<div class="dh">${d[0]}</div>`).join('')}${'<div></div>'.repeat(md[0].dow)}`;
    md.forEach(d=>{const a=arr[d.i]||[]; const tip=d.iso+' · day '+(d.i+1)+(d.why?' · '+d.why:' · Working')+a.map(s=>`\n${DIRS[s.dir].name} ${RP.ships[s.t].name} ${fmtN(s.qty)} t`).join('');
      h+=`<div class="dc st-${d.st}" title="${esc(tip)}"><span>${d.dd}</span><span class="mk">${a.map(s=>`<i class="${s.dir}">${s.dir}${s.t}</i>`).join('')}</span></div>`;});
    h+=`</div></div>`;
  }
  h+=`</div></div>`;
  $('#pane-cal').innerHTML=h;
}

function renderRuns(){
  if(!RUNS.length){$('#pane-runs').innerHTML=`<div class="card empty">No saved runs yet.</div>`; return;}
  $('#pane-runs').innerHTML=`<div class="card"><div class="card-h"><div><div class="eyebrow">Database</div><h2>Saved simulation runs</h2></div></div>
  <div class="tw"><table class="t"><thead><tr><th>#</th><th>Name</th><th>Saved</th><th>First ship arrival</th><th>Combinations</th><th>Feasible</th><th>Run time</th><th></th></tr></thead><tbody>
  ${RUNS.map(r=>`<tr class="${RUN&&RUN.id===r.id?'sel':''}"><td>${r.id}</td><td class="l">${esc(r.name)}</td><td>${esc(r.created_at)}</td><td>${esc(r.start_date)}</td><td>${r.n_combos}</td><td>${r.n_feasible}</td><td>${fmtN(r.duration_s,1)} s</td>
  <td style="display:flex;gap:6px;justify-content:flex-end"><button class="btn-q" data-open="${r.id}">Open</button><button class="btn-del" data-del="${r.id}">Delete</button></td></tr>`).join('')}
  </tbody></table></div></div>`;
}
$('#pane-runs').addEventListener('click',async e=>{
  const o=e.target.closest('[data-open]'), d=e.target.closest('[data-del]');
  if(o) openRun(+o.dataset.open);
  if(d){
    if(!d.classList.contains('confirm')){d.classList.add('confirm'); d.textContent='Confirm delete'; return;}
    try{
      const id=+d.dataset.del; await api('DELETE','/api/runs/'+id); await refreshRuns();
      if(RUN&&RUN.id===id){RUN=null; DETAIL=null; if(RUNS.length) await openRun(RUNS[0].id); else {renderEmpty(); renderPanel();} showTab('runs');}
    }catch(err){ERR=err.message; renderBanner();}
  }
});

function renderMethod(){
  const Q=RP||P;
  $('#pane-method').innerHTML=`<div class="card"><div class="prose">
  <div class="eyebrow">How the model works</div><h2>Method and assumptions</h2>
  <p><b>Step 1A, desk plan.</b> For each ship class the parcel is DWT × capacity utilisation. Calls per year = annual tonnage ÷ parcel. Berth time per call = parcel ÷ effective handling rate + the non-cargo activity hours. The effective import rate is SUL count × rating × efficiency, capped by the import conveyor, less cargo stoppages; export uses the loader and export conveyor the same way.</p>
  <p><b>Step 1B, combinations.</b> Up to seven fleet options per direction (three single classes, three pairs, all three) give up to 49 import × export combinations. Only ship classes ticked for import are used in import fleets, and only those ticked for export in export fleets. Mixed fleets alternate classes call by call. Every combination runs through the same simulation.</p>
  <p><b>Steel slab export (when ticked).</b> A third cargo goes out. You enter the SMS like the plant: production capacity (Mtpa of slab), utilisation and HBI consumed per t of slab. Slab made = capacity × utilisation, evenly over the year; every hour the SMS takes that hour's slab × ratio of HBI: the set share (70% by default) straight from the DRI plant and the rest from the HBI yard, and puts the slab in the slab yard, which has its own capacity. If the slab yard is full the SMS stops; if the plant or the HBI yard cannot supply its share, the SMS is short of HBI. The HBI export and SMS (slab) export targets are entered in Mtpa under Annual targets. If the slab yard is full the SMS stops and those hours are counted. A slab ship (same three classes, those ticked as Slab, parcel = DWT × the class's load %, as for RM and HBI) is called when slab stock reaches the export trigger share of its parcel, and is loaded by the slab cranes. Slab ships share the jetty length and non-cargo activities. With slab on there are up to 7 × 7 × 7 = 343 combinations. The desk check adds the slab calls to occupancy and checks DRI output ≥ HBI export + HBI to the SMS.</p>
  <p><b>Step 2, simulation.</b> Steps of 1 hour (default) or 6 minutes, chosen under the Run button, starting at 00:00 on the first ship's arrival date. Rates stay per hour; each step moves that step's share, and ships can be called every step:</p>
  <ol>
    <li>A year has ${fmtN(Q.maxJettyDays)} days, for both the plant and the jetty. RM imports are counted for one year from the first import ship's arrival. HBI exports are counted from the first export ship's loading until one year after it sails. The run goes ${EXT_DAYS} days past the year end so the export year is complete.</li>
    <li>The DRI plant runs continuously, making its annual output (capacity × utilisation) evenly over the year, drawing RM at the RM-per-DRI ratio. It stops if RM runs out and is curtailed if the HBI yard is full.</li>
    <li>An import ship is called when the RM yard can take its parcel. An export ship is called when HBI stock reaches the trigger share of its parcel. When both are due, the one with fewer days of cover goes first. A berth is held free if the most urgent ship needs it within the hold window.</li>
    <li>A ship berths only if all ships alongside still fit the jetty length: their LOA, plus ${fmtN(Q.gapPct)}% of the larger ship's LOA between each two ships, plus ${fmtN(Q.endPct)}% of the end ship's LOA at each jetty end. At most one import ship per SUL and one export ship per loader can be alongside.</li>
    <li>Non-cargo activities run in sequence before and after cargo. Tugs are not a limit (enough tugs); ship movements wait for daylight only if night berthing is off.</li>
    <li>Discharge stops when the RM yard is full; loading waits when HBI stock is empty. That time is recorded as ship waiting.</li>
  </ol>
  <p><b>YES</b> means: both annual targets (all three with slab) met within the allowed shortfall, no plant stoppage for RM, no HBI yard overflow, no SMS stoppage for a full slab yard, and berth occupancy at or below the limit. Occupancy = ship-hours alongside in the year ÷ (hours in the year × berth positions).</p>
  <p><b>Storage.</b> Each run is saved in the local SQLite database with its inputs, the result of every combination and the daily RM and HBI yard stock. The call schedule, calendar and desk plan are rebuilt from the saved inputs when a combination is opened.</p>
  
  </div></div>`;
}

/* ---------- start ---------- */
(async function init(){
  try{
    DEF=await api('GET','/api/defaults');
    RUNS=await api('GET','/api/runs');
    if(RUNS.length){ await openRun(RUNS[0].id); }
    else { P=clone(DEF); renderPanel(); renderEmpty(); }
  }catch(e){
    if(!P){P=DEF?clone(DEF):null;}
    ERR='Cannot reach the local server: '+e.message; renderBanner();
  }
})();
