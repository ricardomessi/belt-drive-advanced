/* app.js – Gates FEAD Advanced Engineering Suite – UI Engine */
'use strict';

// ── Global State ──────────────────────────────────────────────────────────────
let ST = {
  rpm: 1200, baseTension: 2500, tenIdx: 3,
  conditions: { ac:false, regen:false, bas:false, highIdle:false, peakAccel:false, nightRun:false, coldStart:false },
  dutyCycle:  { wltcLow:25, wltcMed:25, wltcHigh:25, wltcXHigh:25 },
  powerOverrides: {},
  acPower: 2.1,
  pulleys: null,      // deep copy of PULLEY_DEFAULTS, modified by drag/input
  powerTable: null    // editable power vs RPM data
};

// Cache for last computation results
let RESULTS = { hubLoad:null, tension:null, slip:null, fatigue:null, bearing:null, friction:null };

// ── Operating Conditions Config ───────────────────────────────────────────────
const CONDITIONS_CONFIG = [
  { key:'ac',        name:'A/C Compressor ON',   desc:'Air conditioning engaged.', effect:'↑ AC span tension, ↑ belt friction, ↑ bearing load' },
  { key:'regen',     name:'Regen Braking',        desc:'Alternator recovering kinetic energy.', effect:'↔ ALT tension direction reverses ~150°' },
  { key:'bas',       name:'BAS Motor Mode',       desc:'Belt-alternator-starter drives crankshaft.', effect:'↑ CRK tight-side +5kW equivalent tension' },
  { key:'highIdle',  name:'High Idle + Demand',   desc:'Stationary, full accessory load at 800 RPM.', effect:'↑ All tensions — low v means high T=P/v' },
  { key:'peakAccel', name:'Peak Acceleration',    desc:'Full throttle near 2300 RPM.', effect:'↑ FAN load cubed — approaches 2866 N PDF peak' },
  { key:'nightRun',  name:'Night Running',         desc:'Headlights, nav, all electrical on.', effect:'↑ ALT to ≥ 3.7 kW regardless of RPM' },
  { key:'coldStart', name:'Cold Start',            desc:'Higher belt stiffness, pre-warm conditions.', effect:'↑ Static tension factor ×1.15' }
];

// ── Power Table Initial Data ──────────────────────────────────────────────────
function initPowerTable() {
  // Accessible RPM points and default power values
  const rpms = [500,800,1000,1200,1400,1600,1800,2000];
  ST.powerTable = rpms.map(rpm => {
    const P = phInterp(rpm);
    return { rpm, CRK: P.CRK, FAN: P.FAN, ALT: P.ALT, AC: P.AC, TEN: P.TEN };
  });
}

// ── Canvas 2D Draggable Layout Editor ────────────────────────────────────────
let cvs, ctx2d;
let dragTarget = null, dragOffX = 0, dragOffY = 0;
let hoverTarget = null;
let dashOffset = 0;
let _2dTransform = { PAD:50, sc:1, minX:0, minY:0, W:0, H:0 };
let animId2d = null;

function initCanvas() {
  cvs = document.getElementById('canvas2d');
  ctx2d = cvs.getContext('2d');
  resizeCanvas();

  cvs.addEventListener('mousedown', onCanvasDown);
  cvs.addEventListener('mousemove', onCanvasMove);
  cvs.addEventListener('mouseup',   onCanvasUp);
  cvs.addEventListener('mouseleave',()=>{ hoverTarget=null; hidePulleyTip(); });
  window.addEventListener('resize', resizeCanvas);
}

function resizeCanvas() {
  if (!cvs) return;
  cvs.width  = cvs.offsetWidth;
  cvs.height = cvs.offsetHeight || 420;
}

function worldToCanvas(x, y) {
  const { PAD, sc, minX, minY, H } = _2dTransform;
  return { cx: PAD + (x - minX) * sc, cy: H - PAD - (y - minY) * sc };
}
function canvasToWorld(cx, cy) {
  const { PAD, sc, minX, minY, H } = _2dTransform;
  return { x: (cx - PAD) / sc + minX, y: (H - PAD - cy) / sc + minY };
}
function pulleyRadius(name) {
  return ST.pulleys[name].r * _2dTransform.sc;
}

function onCanvasDown(e) {
  const rect = cvs.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  for (const n of PH_ORDER) {
    const { cx, cy } = worldToCanvas(ST.pulleys[n].x, ST.pulleys[n].y);
    const cr = pulleyRadius(n);
    if (Math.hypot(mx-cx, my-cy) < cr) {
      dragTarget = n;
      dragOffX = mx - cx; dragOffY = my - cy;
      cvs.style.cursor = 'grabbing';
      return;
    }
  }
}

function onCanvasMove(e) {
  const rect = cvs.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;

  if (dragTarget) {
    const wx = canvasToWorld(mx - dragOffX + _2dTransform.sc * ST.pulleys[dragTarget].r, 0).x;
    const wy = canvasToWorld(0, my - dragOffY - _2dTransform.sc * ST.pulleys[dragTarget].r).y;
    // Snap to grid of 1mm
    ST.pulleys[dragTarget].x = Math.round(wx);
    ST.pulleys[dragTarget].y = Math.round(wy);
    updateCoordInputs();
    compute();
    return;
  }

  // Hover detection
  let found = null;
  for (const n of PH_ORDER) {
    const { cx, cy } = worldToCanvas(ST.pulleys[n].x, ST.pulleys[n].y);
    const cr = pulleyRadius(n);
    if (Math.hypot(mx-cx, my-cy) < cr) { found = n; break; }
  }
  if (found !== hoverTarget) {
    hoverTarget = found;
    if (found) { showPulleyTip(found, mx, my); cvs.style.cursor = 'grab'; }
    else        { hidePulleyTip(); cvs.style.cursor = 'crosshair'; }
  } else if (found) {
    movePulleyTip(mx, my);
  }
}

function onCanvasUp() { dragTarget = null; cvs.style.cursor = 'crosshair'; }

function showPulleyTip(n, mx, my) {
  const tip = document.getElementById('pulley-tooltip');
  const hl = RESULTS.hubLoad;
  const d  = hl ? hl.results[n] : null;
  const p  = ST.pulleys[n];
  let html = `<span style="color:${p.color};font-weight:700;font-family:'Rajdhani',sans-serif;font-size:.9rem">${n}</span>`;
  html += `<br>X: ${p.x.toFixed(1)} mm&nbsp;&nbsp;Y: ${p.y.toFixed(1)} mm`;
  html += `<br>R: ${p.r.toFixed(2)} mm`;
  if (d) {
    html += `<br>F<sub>hub</sub>: <b>${d.F.toFixed(0)} N</b>`;
    html += `<br>Dir: ${d.dir.toFixed(1)}°`;
    html += `<br>PDF ref: ${d.pdf_F} N`;
  }
  tip.innerHTML = html;
  tip.style.display = 'block';
  movePulleyTip(mx, my);
}
function movePulleyTip(mx, my) {
  const tip = document.getElementById('pulley-tooltip');
  tip.style.left = (mx + 14) + 'px';
  tip.style.top  = (my - 10) + 'px';
}
function hidePulleyTip() {
  const tip = document.getElementById('pulley-tooltip');
  if (tip) tip.style.display = 'none';
}

function draw2D() {
  if (!cvs || !ctx2d) return;
  const W = cvs.width, H = cvs.height;
  if (!W || !H) return;
  ctx2d.clearRect(0, 0, W, H);

  const PAD = 52;
  const xs = PH_ORDER.map(n => ST.pulleys[n].x);
  const ys = PH_ORDER.map(n => ST.pulleys[n].y);
  const minX = Math.min(...xs) - 100, maxX = Math.max(...xs) + 100;
  const minY = Math.min(...ys) - 100, maxY = Math.max(...ys) + 100;
  const sc = Math.min((W - PAD*2) / (maxX - minX), (H - PAD*2) / (maxY - minY));
  _2dTransform = { PAD, sc, minX, minY, W, H };

  const tx = x => PAD + (x - minX) * sc;
  const ty = y => H - PAD - (y - minY) * sc;

  // Grid
  ctx2d.strokeStyle = '#0d1525'; ctx2d.lineWidth = 1;
  for (let gx = Math.ceil(minX/50)*50; gx <= maxX; gx += 50) {
    ctx2d.beginPath(); ctx2d.moveTo(tx(gx), PAD/2); ctx2d.lineTo(tx(gx), H-PAD/2); ctx2d.stroke();
  }
  for (let gy = Math.ceil(minY/50)*50; gy <= maxY; gy += 50) {
    ctx2d.beginPath(); ctx2d.moveTo(PAD/2, ty(gy)); ctx2d.lineTo(W-PAD/2, ty(gy)); ctx2d.stroke();
  }

  // Belt spans
  const hl = RESULTS.hubLoad;
  const avgF = hl ? Object.values(hl.results).reduce((s,d)=>s+d.F,0)/6 : 0;
  const bw = Math.max(2, Math.min(6, 2 + avgF/900));
  ctx2d.save();
  ctx2d.shadowColor = '#f59e0b'; ctx2d.shadowBlur = 8;
  ctx2d.strokeStyle = '#f59e0b'; ctx2d.lineWidth = bw;
  ctx2d.setLineDash([13,8]); ctx2d.lineDashOffset = dashOffset;
  if (hl) {
    for (const n of PH_ORDER) {
      const s = hl.spans[n]; if (!s) continue;
      ctx2d.beginPath();
      ctx2d.moveTo(tx(s.t1.x), ty(s.t1.y));
      ctx2d.lineTo(tx(s.t2.x), ty(s.t2.y));
      ctx2d.stroke();
    }
  }
  ctx2d.restore();

  // Pulleys
  const now = performance.now() * 0.001;
  for (const n of PH_ORDER) {
    const p = ST.pulleys[n];
    const cx2 = tx(p.x), cy2 = ty(p.y);
    const cr = p.r * sc;
    const d = hl ? hl.results[n] : null;
    const glow = d ? Math.min(d.F / 3200, 1) : 0;
    const isHover = hoverTarget === n;

    // Glow halo
    const grd = ctx2d.createRadialGradient(cx2, cy2, cr*0.3, cx2, cy2, cr*1.4);
    grd.addColorStop(0, p.color + Math.round(20 + glow*90).toString(16).padStart(2,'0'));
    grd.addColorStop(1, 'transparent');
    ctx2d.beginPath(); ctx2d.arc(cx2, cy2, cr*1.4, 0, Math.PI*2);
    ctx2d.fillStyle = grd; ctx2d.fill();

    // Outer rim
    ctx2d.beginPath(); ctx2d.arc(cx2, cy2, cr, 0, Math.PI*2);
    ctx2d.strokeStyle = isHover ? '#fff' : p.color;
    ctx2d.lineWidth = isHover ? 3 : 2;
    ctx2d.shadowColor = p.color; ctx2d.shadowBlur = 10 + glow*10;
    ctx2d.stroke(); ctx2d.shadowBlur = 0;

    // Belt groove
    ctx2d.beginPath(); ctx2d.arc(cx2, cy2, cr*0.86, 0, Math.PI*2);
    ctx2d.strokeStyle = p.color+'55'; ctx2d.lineWidth = 1; ctx2d.stroke();

    // Hub
    ctx2d.beginPath(); ctx2d.arc(cx2, cy2, cr*0.18, 0, Math.PI*2);
    ctx2d.fillStyle = '#080c14'; ctx2d.fill();
    ctx2d.strokeStyle = '#fff'; ctx2d.lineWidth = 1.2; ctx2d.stroke();

    // Rotating spokes
    const rotSpd = ST.rpm / 500;
    for (let sp = 0; sp < 4; sp++) {
      const ang = (sp * Math.PI/2) + now * (p.cw ? 1 : -1) * p.sr * rotSpd;
      ctx2d.beginPath();
      ctx2d.moveTo(cx2 + cr*0.18*Math.cos(ang), cy2 + cr*0.18*Math.sin(ang));
      ctx2d.lineTo(cx2 + cr*0.82*Math.cos(ang), cy2 + cr*0.82*Math.sin(ang));
      ctx2d.strokeStyle = p.color+'99'; ctx2d.lineWidth = 1.1; ctx2d.stroke();
    }

    // Label
    const lines = p.label.split('\n');
    ctx2d.textAlign = 'center';
    ctx2d.font = 'bold 10px Rajdhani,sans-serif'; ctx2d.fillStyle = '#fff';
    ctx2d.fillText(lines[0], cx2, cy2 - cr - 14);
    ctx2d.font = '8px Inter,sans-serif'; ctx2d.fillStyle = p.color;
    ctx2d.fillText(lines[1], cx2, cy2 - cr - 5);
    ctx2d.font = '7px JetBrains Mono,monospace'; ctx2d.fillStyle = '#3a5070';
    ctx2d.fillText(`(${p.x.toFixed(0)},${p.y.toFixed(0)})`, cx2, cy2 + cr + 12);
    ctx2d.textAlign = 'left';
  }

  // Hub-load arrows
  if (hl) {
    for (const n of PH_ORDER) {
      const d = hl.results[n]; if (!d || d.F < 1) continue;
      const p = ST.pulleys[n];
      const cx2 = tx(p.x), cy2 = ty(p.y);
      const maxF = 3500;
      const arrowLen = Math.min(d.F / maxF, 1) * 55 + 12;
      const angle = Math.atan2(-d.Fy, d.Fx);
      const ex = cx2 + arrowLen * Math.cos(angle);
      const ey = cy2 + arrowLen * Math.sin(angle);
      ctx2d.save();
      ctx2d.strokeStyle = '#ef4444'; ctx2d.fillStyle = '#ef4444';
      ctx2d.lineWidth = 2; ctx2d.shadowColor = '#ef4444'; ctx2d.shadowBlur = 8;
      ctx2d.beginPath(); ctx2d.moveTo(cx2, cy2); ctx2d.lineTo(ex, ey); ctx2d.stroke();
      const ah = 8, ang2 = Math.atan2(ey-cy2, ex-cx2);
      ctx2d.beginPath();
      ctx2d.moveTo(ex, ey);
      ctx2d.lineTo(ex - ah*Math.cos(ang2-0.4), ey - ah*Math.sin(ang2-0.4));
      ctx2d.lineTo(ex - ah*Math.cos(ang2+0.4), ey - ah*Math.sin(ang2+0.4));
      ctx2d.closePath(); ctx2d.fill();
      ctx2d.shadowBlur = 0;
      ctx2d.font = 'bold 7px JetBrains Mono,monospace';
      ctx2d.fillStyle = '#fca5a5';
      ctx2d.fillText(`${d.F.toFixed(0)}N`, ex + 4, ey - 2);
      ctx2d.restore();
    }
  }
}

function loop2D() {
  const v = hl_beltVel();
  dashOffset -= v * 0.8;
  draw2D();
  animId2d = requestAnimationFrame(loop2D);
}

function hl_beltVel() {
  return RESULTS.hubLoad ? RESULTS.hubLoad.v : 0;
}

// ── Coordinate Table ──────────────────────────────────────────────────────────
function buildCoordTable() {
  const tbody = document.getElementById('coords-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  for (const n of PH_ORDER) {
    const p = ST.pulleys[n];
    const color = p.color;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="color:${color};font-family:'Rajdhani',sans-serif;font-weight:700;font-size:.9rem">${n}</td>
      <td><input class="coord-input" data-pulley="${n}" data-field="x" value="${p.x.toFixed(1)}" step="0.1"/></td>
      <td><input class="coord-input" data-pulley="${n}" data-field="y" value="${p.y.toFixed(1)}" step="0.1"/></td>
      <td><input class="coord-input" data-pulley="${n}" data-field="r" value="${p.r.toFixed(2)}" step="0.1"/></td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('.coord-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const n = inp.dataset.pulley, f = inp.dataset.field;
      ST.pulleys[n][f] = parseFloat(inp.value) || 0;
      compute();
    });
  });
}

function updateCoordInputs() {
  document.querySelectorAll('.coord-input').forEach(inp => {
    const n = inp.dataset.pulley, f = inp.dataset.field;
    const val = ST.pulleys[n][f];
    inp.value = (f === 'r') ? val.toFixed(2) : val.toFixed(1);
  });
}

// ── Operating Conditions UI ───────────────────────────────────────────────────
function buildConditions() {
  const grid = document.getElementById('conditions-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const c of CONDITIONS_CONFIG) {
    const div = document.createElement('div');
    div.className = 'cond-item' + (ST.conditions[c.key] ? ' active' : '');
    div.dataset.key = c.key;
    div.innerHTML = `
      <div class="cond-check"><span class="cond-check-tick">✓</span></div>
      <div class="cond-info">
        <div class="cond-name">${c.name}</div>
        <div class="cond-desc">${c.desc}</div>
        <div class="cond-effect">${c.effect}</div>
      </div>`;
    div.addEventListener('click', () => {
      ST.conditions[c.key] = !ST.conditions[c.key];
      div.classList.toggle('active', ST.conditions[c.key]);
      compute();
      updateConditionsSummary();
    });
    grid.appendChild(div);
  }
  updateConditionsSummary();
}

function updateConditionsSummary() {
  const el = document.getElementById('conditions-summary');
  if (!el) return;
  const active = CONDITIONS_CONFIG.filter(c => ST.conditions[c.key]).map(c => c.name);
  el.textContent = active.length
    ? `Active: ${active.join(' · ')}`
    : 'No conditions active — using baseline load table values.';
}

// ── Duty Cycle UI ─────────────────────────────────────────────────────────────
function initDutyCycle() {
  ['wltcLow','wltcMed','wltcHigh','wltcXHigh'].forEach(key => {
    const sl = document.getElementById('dc-' + key);
    const lb = document.getElementById('lbl-dc-' + key);
    if (!sl || !lb) return;
    sl.addEventListener('input', () => {
      ST.dutyCycle[key] = +sl.value;
      lb.textContent = sl.value + '%';
      updateDutyTotal();
      compute();
    });
  });
  updateDutyTotal();
}

function updateDutyTotal() {
  const total = Object.values(ST.dutyCycle).reduce((s,v)=>s+v, 0);
  const el = document.getElementById('duty-total');
  if (!el) return;
  el.textContent = `Total: ${total}%`;
  el.className = 'duty-total' + (Math.abs(total - 100) > 5 ? ' warn' : '');
}

// ── Power Override Inputs ─────────────────────────────────────────────────────
function buildPowerInputs() {
  const grid = document.getElementById('power-inputs-grid');
  if (!grid) return;
  const colors = { CRK:'#f59e0b', FAN:'#8b5cf6', IDR:'#a78bfa', ALT:'#34d399', AC:'#f472b6', TEN:'#60a5fa' };
  grid.innerHTML = '';
  for (const n of PH_ORDER) {
    const div = document.createElement('div');
    div.className = 'power-input-item';
    const key = n.toLowerCase();
    div.innerHTML = `
      <label style="color:${colors[n]}">${n}</label>
      <input id="pow-${n}" type="number" step="0.1" min="0" max="30" placeholder="auto" class="power-input" data-key="${key}"/>
      <span>kW</span>`;
    grid.appendChild(div);
    div.querySelector('input').addEventListener('input', e => {
      const v = e.target.value.trim();
      if (v === '') delete ST.powerOverrides[key];
      else ST.powerOverrides[key] = parseFloat(v);
      compute();
    });
  }
}

// ── Power vs RPM Graph Editor ─────────────────────────────────────────────────
let powerChart = null;
const POWER_COLORS = { CRK:'#f59e0b', FAN:'#8b5cf6', ALT:'#34d399', AC:'#f472b6', TEN:'#60a5fa' };

function buildPowerGraph() {
  buildPowerTable();
  const canvas = document.getElementById('power-graph-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const rpms  = ST.powerTable.map(r => r.rpm);
  const ds = ['CRK','FAN','ALT','AC','TEN'].map(n => ({
    label: n,
    data:  ST.powerTable.map(r => r[n]),
    borderColor: POWER_COLORS[n],
    backgroundColor: POWER_COLORS[n]+'22',
    tension: 0.4, fill: false, pointRadius: 5, pointHoverRadius: 7,
    borderWidth: 2
  }));
  powerChart = new Chart(ctx, {
    type: 'line',
    data: { labels: rpms, datasets: ds },
    options: {
      responsive:true, maintainAspectRatio:false, animation:{duration:120},
      scales: {
        x:{ title:{display:true,text:'Engine Speed (RPM)',color:'#64748b'}, ticks:{color:'#475569'}, grid:{color:'#1d2a40'} },
        y:{ title:{display:true,text:'Power (kW)',color:'#64748b'},         ticks:{color:'#475569'}, grid:{color:'#1d2a40'} }
      },
      plugins: {
        legend:{labels:{color:'#94a3b8',font:{family:'JetBrains Mono',size:11}}},
        tooltip:{
          backgroundColor:'#0b0f1a', borderColor:'#243350', borderWidth:1,
          bodyFont:{family:'JetBrains Mono'}, titleFont:{family:'Rajdhani',size:13},
          callbacks:{ label: c => ` ${c.dataset.label}: ${c.parsed.y.toFixed(2)} kW` }
        }
      }
    }
  });
}

function buildPowerTable() {
  const wrap = document.getElementById('power-table-wrap');
  if (!wrap || !ST.powerTable) return;
  const headers = ['RPM','CRK','FAN','ALT','AC','TEN'];
  let h = `<table class="power-edit-table"><thead><tr>${headers.map(hd=>`<th>${hd}</th>`).join('')}</tr></thead><tbody>`;
  ST.powerTable.forEach((row, ri) => {
    h += `<tr><td>${row.rpm}</td>`;
    ['CRK','FAN','ALT','AC','TEN'].forEach(n => {
      h += `<td><input class="power-cell" type="number" step="0.01" value="${row[n].toFixed(2)}" data-row="${ri}" data-col="${n}"/></td>`;
    });
    h += '</tr>';
  });
  h += '</tbody></table>';
  wrap.innerHTML = h;
  wrap.querySelectorAll('.power-cell').forEach(inp => {
    inp.addEventListener('change', () => {
      const ri = +inp.dataset.row, n = inp.dataset.col;
      ST.powerTable[ri][n] = parseFloat(inp.value) || 0;
      updatePowerChart();
    });
  });
}

function updatePowerChart() {
  if (!powerChart) return;
  ['CRK','FAN','ALT','AC','TEN'].forEach((n, i) => {
    powerChart.data.datasets[i].data = ST.powerTable.map(r => r[n]);
  });
  powerChart.update();
}

// ── Results Tab Switching ─────────────────────────────────────────────────────
function initResultTabs() {
  document.querySelectorAll('.res-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.res-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.res-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById('res-panel-' + btn.dataset.tab);
      if (panel) panel.classList.add('active');
    });
  });
}

// ── Charts: SF vs RPM + L10 vs RPM ───────────────────────────────────────────
let sfChart = null, l10Chart = null, slipTabChart = null, bearingTabChart = null;

const PULLEY_COLORS = { CRK:'#f59e0b', FAN:'#8b5cf6', IDR:'#a78bfa', ALT:'#34d399', AC:'#f472b6', TEN:'#60a5fa' };

function initSFChart() {
  const canvas = document.getElementById('sf-vs-rpm-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  sfChart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      responsive:true, maintainAspectRatio:false, animation:{duration:120},
      interaction:{mode:'index', intersect:false},
      scales: {
        x:{ title:{display:true,text:'Engine Speed (RPM)',color:'#64748b'}, ticks:{color:'#475569'}, grid:{color:'#1d2a40'} },
        y:{
          title:{display:true,text:'Slip Safety Factor (SF)',color:'#64748b'},
          ticks:{color:'#475569'}, grid:{color:'#1d2a40'},
          min: 0,
          suggestedMax: 4
        }
      },
      plugins: {
        legend:{labels:{color:'#94a3b8',font:{family:'JetBrains Mono',size:11}}},
        annotation: { annotations: [{
          type:'line', yMin:1.0, yMax:1.0,
          borderColor:'rgba(239,68,68,0.5)', borderWidth:1.5, borderDash:[4,4],
          label:{content:'SF=1 (slip limit)',display:true,color:'#ef4444',font:{size:10}}
        },{
          type:'line', yMin:1.3, yMax:1.3,
          borderColor:'rgba(245,158,11,0.4)', borderWidth:1, borderDash:[4,4],
          label:{content:'SF=1.3 (safe)',display:true,color:'#f59e0b',font:{size:10}}
        }]}
      }
    }
  });
  updateSFChart();
}

function updateSFChart() {
  if (!sfChart) return;
  const rpms = [];
  for (let r = 300; r <= 2600; r += 100) rpms.push(r);
  const ds = PH_ORDER.map(n => ({
    label: n, borderColor: PULLEY_COLORS[n], tension: 0.4,
    fill: false, borderWidth: 2, pointRadius: 0, data: []
  }));
  for (const rpm of rpms) {
    const td = phComputeBeltTension(ST.pulleys, rpm, ST.baseTension, ST.tenIdx, ST.conditions, ST.powerOverrides);
    const sf = phComputeSlipSafety(td, ST.tenIdx);
    PH_ORDER.forEach((n,i) => ds[i].data.push({ x: rpm, y: parseFloat(sf[n].SF.toFixed(3)) }));
  }
  sfChart.data.labels = rpms;
  sfChart.data.datasets = ds;
  sfChart.options.scales.x.type = 'linear';
  sfChart.update();
}

function initL10Chart() {
  const canvas = document.getElementById('l10-vs-rpm-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  l10Chart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      responsive:true, maintainAspectRatio:false, animation:{duration:120},
      interaction:{mode:'index',intersect:false},
      scales: {
        x:{ title:{display:true,text:'Engine Speed (RPM)',color:'#64748b'}, ticks:{color:'#475569'}, grid:{color:'#1d2a40'} },
        y:{ title:{display:true,text:'L10 Life (hours)',color:'#64748b'},   ticks:{color:'#475569'}, grid:{color:'#1d2a40'}, min:0 }
      },
      plugins:{ legend:{labels:{color:'#94a3b8',font:{family:'JetBrains Mono',size:11}}},
        tooltip:{ backgroundColor:'#0b0f1a',borderColor:'#243350',borderWidth:1,
          bodyFont:{family:'JetBrains Mono'}, callbacks:{label:c=>` ${c.dataset.label}: ${c.parsed.y.toFixed(0)} h`} }
      }
    }
  });
  updateL10Chart();
}

function updateL10Chart() {
  if (!l10Chart || !RESULTS.hubLoad) return;
  const rpms = [];
  for (let r = 300; r <= 2600; r += 100) rpms.push(r);
  const dsL10A = { label:'Ball L10A', borderColor:'#60a5fa', tension:.4, fill:false, borderWidth:2, pointRadius:0, data:[] };
  const dsL10B = { label:'Roller L10B', borderColor:'#a78bfa', tension:.4, fill:false, borderWidth:2, pointRadius:0, data:[] };
  const dsComp = { label:'Composite', borderColor:'#34d399', tension:.4, fill:false, borderWidth:2.5, pointRadius:0, borderDash:[5,3], data:[] };
  const dsRef  = { label:'C&U Composite ref (3305h)', borderColor:'#f59e0b55', tension:0, fill:false, borderWidth:1, pointRadius:0, borderDash:[3,5], data:[] };
  for (const rpm of rpms) {
    const hl2 = phComputeAllHubLoads(ST.pulleys, rpm, ST.baseTension, ST.tenIdx, ST.conditions, ST.powerOverrides);
    const bl  = phComputeWPBearingLife(hl2.results, rpm);
    dsL10A.data.push({ x:rpm, y: Math.min(bl.L10A,99999) });
    dsL10B.data.push({ x:rpm, y: Math.min(bl.L10B,99999) });
    dsComp.data.push({ x:rpm, y: Math.min(bl.L10_composite,99999) });
    dsRef.data.push({ x:rpm, y: 3305 });
  }
  l10Chart.data.labels = rpms;
  l10Chart.data.datasets = [dsL10A, dsL10B, dsComp, dsRef];
  l10Chart.update();
}

// ── Main Compute + Render ─────────────────────────────────────────────────────
function compute() {
  const { rpm, baseTension, tenIdx, conditions, powerOverrides, acPower, dutyCycle, pulleys } = ST;

  RESULTS.hubLoad  = phComputeAllHubLoads(pulleys, rpm, baseTension, tenIdx, conditions, powerOverrides);
  RESULTS.tension  = phComputeBeltTension(pulleys, rpm, baseTension, tenIdx, conditions, powerOverrides);
  RESULTS.slip     = phComputeSlipSafety(RESULTS.tension, tenIdx);
  RESULTS.fatigue  = phComputeFatigueLife(RESULTS.tension, dutyCycle);
  RESULTS.bearing  = phComputeWPBearingLife(RESULTS.hubLoad.results, rpm);
  RESULTS.friction = phComputeFrictionalPower(pulleys, rpm, baseTension, tenIdx, acPower);

  renderHubLoadTable();
  renderTensionTable();
  renderSlipTable();
  renderFatigueTable();
  renderBearingCards();
  renderFrictionTable();
  updateSFChart();
  updateL10Chart();
}

// ── Table Renderers ───────────────────────────────────────────────────────────
function fmtN(v)   { return typeof v==='number' ? v.toFixed(1) : '—'; }
function fmtDeg(v) { return typeof v==='number' ? v.toFixed(1)+'°' : '—'; }
function fmtKm(v)  { if (!isFinite(v)||v>=499999) return '>500 000'; return Math.round(v).toLocaleString(); }

function renderHubLoadTable() {
  const el = document.getElementById('hubload-table');
  if (!el || !RESULTS.hubLoad) return;
  const { results } = RESULTS.hubLoad;
  const cols = ['Pulley','T_in (N)','T_out (N)','F_hub (N)','Dir (°)','PDF F (N)','PDF Dir (°)','ΔF (N)','ΔDir (°)'];
  let h = `<table class="res-table"><thead><tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>`;
  for (const n of PH_ORDER) {
    const d = results[n];
    const dF  = (d.F    - d.pdf_F  ).toFixed(1);
    const dD  = (d.dir  - d.pdf_dir).toFixed(1);
    const clF = Math.abs(+dF)<300 ? 'val-ok' : 'val-hi';
    const clD = Math.abs(+dD)<15  ? 'val-ok' : 'val-hi';
    h += `<tr>
      <td style="color:${PULLEY_COLORS[n]}">${n}</td>
      <td>${fmtN(d.T_in)}</td><td>${fmtN(d.T_out)}</td>
      <td style="font-weight:700">${fmtN(d.F)}</td>
      <td>${fmtDeg(d.dir)}</td>
      <td>${d.pdf_F}</td><td>${d.pdf_dir}°</td>
      <td class="${clF}">${+dF>=0?'+':''}${dF}</td>
      <td class="${clD}">${+dD>=0?'+':''}${dD}</td>
    </tr>`;
  }
  el.innerHTML = h + '</tbody></table>';
}

function renderTensionTable() {
  const el = document.getElementById('tension-table');
  if (!el || !RESULTS.tension) return;
  const cols = ['Pulley','P (kW)','v (m/s)','T_eff (N)','T_tight (N)','T_slack (N)','T_centrifugal (N)','T_total (N)','T_ratio'];
  let h = `<table class="res-table"><thead><tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>`;
  const d = RESULTS.tension;
  for (const n of PH_ORDER) {
    const t = d[n];
    h += `<tr>
      <td style="color:${PULLEY_COLORS[n]}">${n}</td>
      <td>${t.P_kW.toFixed(2)}</td>
      <td>${t.v.toFixed(2)}</td>
      <td>${fmtN(t.T_eff)}</td>
      <td style="font-weight:700">${fmtN(t.T_tight)}</td>
      <td>${fmtN(t.T_slack)}</td>
      <td>${fmtN(t.T_centrifugal)}</td>
      <td>${fmtN(t.T_total_tight)}</td>
      <td>${t.T_ratio > 90 ? '∞' : t.T_ratio.toFixed(2)}</td>
    </tr>`;
  }
  el.innerHTML = h + '</tbody></table>';
}

function renderSlipTable() {
  const el = document.getElementById('slip-table');
  if (!el || !RESULTS.slip) return;
  const cols = ['Pulley','Wrap (°)','Capstan e^μθ','T_tight/T_slack','SF','Status'];
  let h = `<table class="res-table"><thead><tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>`;
  for (const n of PH_ORDER) {
    const s = RESULTS.slip[n];
    const cls = s.status==='OK'?'tag-ok':s.status==='MARGINAL'?'tag-marginal':'tag-slip';
    h += `<tr>
      <td style="color:${PULLEY_COLORS[n]}">${n}</td>
      <td>${s.wrap_deg.toFixed(1)}°</td>
      <td>${s.capstan_ratio.toFixed(2)}</td>
      <td>${s.actual_ratio > 90 ? '∞' : s.actual_ratio.toFixed(2)}</td>
      <td style="font-weight:700">${s.SF.toFixed(3)}</td>
      <td class="${cls}">${s.status}</td>
    </tr>`;
  }
  el.innerHTML = h + '</tbody></table>';
}

function renderFatigueTable() {
  const el   = document.getElementById('fatigue-table');
  const sum  = document.getElementById('fatigue-summary');
  if (!el || !RESULTS.fatigue) return;
  const { pulleyLife, overallLife_km } = RESULTS.fatigue;
  const cols = ['Pulley','T_tight (N)','T_eff (N)','Miner Damage','Life (km)','Dominant Phase'];
  let h = `<table class="res-table"><thead><tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>`;
  for (const n of PH_ORDER) {
    const l = pulleyLife[n];
    const cls = l.life_km < 50000 ? 'val-hi' : l.life_km < 200000 ? 'tag-marginal' : 'val-ok';
    h += `<tr>
      <td style="color:${PULLEY_COLORS[n]}">${n}</td>
      <td>${fmtN(l.T_tight)}</td><td>${fmtN(l.T_eff)}</td>
      <td>${l.miner_damage.toExponential(3)}</td>
      <td class="${cls}">${fmtKm(l.life_km)}</td>
      <td style="color:#94a3b8;font-size:.65rem">${l.dominant_phase}</td>
    </tr>`;
  }
  el.innerHTML = h + '</tbody></table>';
  if (sum) {
    const clsO = overallLife_km<50000?'#ef4444':overallLife_km<200000?'#f59e0b':'#10b981';
    sum.innerHTML = `
      <div class="fat-kpi"><div class="fat-kpi-label">Overall Belt Life</div>
        <div class="fat-kpi-val" style="color:${clsO}">${fmtKm(overallLife_km)}</div>
        <div class="fat-kpi-unit">km (limited by worst pulley)</div></div>
      <div class="fat-kpi"><div class="fat-kpi-label">Wöhler Model</div>
        <div class="fat-kpi-val" style="font-size:.9rem;color:#94a3b8">N<sub>f</sub> = 10<sup>8</sup>×(1200/T)<sup>10</sup></div></div>
      <div class="fat-kpi"><div class="fat-kpi-label">Fatigue Rule</div>
        <div class="fat-kpi-val" style="font-size:.85rem;color:#94a3b8">Palmgren-Miner D=Σ(w/Nf)</div></div>`;
  }
}

function renderBearingCards() {
  const el = document.getElementById('bearing-cards');
  if (!el || !RESULTS.bearing) return;
  const b = RESULTS.bearing;
  const clA = b.L10A < b.ref.L10A * 0.5 ? '#ef4444' : b.L10A < b.ref.L10A ? '#f59e0b' : '#10b981';
  const clB = b.L10B < b.ref.L10B * 0.5 ? '#ef4444' : b.L10B < b.ref.L10B ? '#f59e0b' : '#10b981';
  const clC = b.L10_composite < b.ref.L10_composite * 0.5 ? '#ef4444' : b.L10_composite < b.ref.L10_composite ? '#f59e0b' : '#10b981';
  el.innerHTML = `
    <div class="bearing-card">
      <div class="bearing-card-title" style="color:#60a5fa">🔵 Ball Bearing (Cr = 19035 N)</div>
      <div class="bearing-stat"><span class="bearing-stat-label">WP Speed</span><span class="bearing-stat-val">${b.wp_rpm.toFixed(0)} RPM</span></div>
      <div class="bearing-stat"><span class="bearing-stat-label">Equiv. Load P_ball</span><span class="bearing-stat-val">${b.P_ball.toFixed(1)} N</span></div>
      <div class="bearing-stat"><span class="bearing-stat-label">L10A Life</span><span class="bearing-stat-val" style="color:${clA}">${b.L10A.toFixed(0)} h</span></div>
      <div class="bearing-stat"><span class="bearing-stat-label">C&U Reference L10A</span><span class="bearing-stat-ref">17820 h</span></div>
    </div>
    <div class="bearing-card">
      <div class="bearing-card-title" style="color:#a78bfa">🟣 Roller Bearing (Cr = 38179 N)</div>
      <div class="bearing-stat"><span class="bearing-stat-label">Equiv. Load P_roller</span><span class="bearing-stat-val">${b.P_roller.toFixed(1)} N</span></div>
      <div class="bearing-stat"><span class="bearing-stat-label">L10B Life</span><span class="bearing-stat-val" style="color:${clB}">${b.L10B.toFixed(0)} h</span></div>
      <div class="bearing-stat"><span class="bearing-stat-label">C&U Reference L10B</span><span class="bearing-stat-ref">3860 h</span></div>
    </div>
    <div class="bearing-card">
      <div class="bearing-card-title" style="color:#34d399">🟢 Composite (Series)</div>
      <div class="bearing-stat"><span class="bearing-stat-label">WP Belt Force (TEN proxy)</span><span class="bearing-stat-val">${b.F_ten.toFixed(0)} N</span></div>
      <div class="bearing-stat"><span class="bearing-stat-label">Impeller Radial Force</span><span class="bearing-stat-val">${b.F_radial} N</span></div>
      <div class="bearing-stat"><span class="bearing-stat-label">L10 Composite</span><span class="bearing-stat-val" style="color:${clC};font-size:1.1rem;font-weight:700">${b.L10_composite.toFixed(0)} h</span></div>
      <div class="bearing-stat"><span class="bearing-stat-label">C&U Reference</span><span class="bearing-stat-ref">3305 h (composite)</span></div>
    </div>`;
}

function renderFrictionTable() {
  const el  = document.getElementById('friction-table');
  const kpi = document.getElementById('friction-kpi-row');
  const bar = document.getElementById('friction-bar-wrap');
  if (!el || !RESULTS.friction) return;
  const fr = RESULTS.friction;
  const cols = ['Pulley','T Non-AC (N)','T With-AC (N)','ΔT (N)','ΔF_hub (N)','ΔP_friction (W)'];
  let h = `<table class="res-table"><thead><tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>`;
  for (const n of PH_ORDER) {
    const d = fr.frictResult[n];
    const hasDelta = Math.abs(d.delta_T) > 0.1;
    h += `<tr>
      <td style="color:${PULLEY_COLORS[n]}">${n}</td>
      <td>${fmtN(d.T_noac)}</td>
      <td>${fmtN(d.T_ac)}</td>
      <td class="${hasDelta?'val-hi':''}">${d.delta_T>0?'+':''}${fmtN(d.delta_T)}</td>
      <td>${fmtN(d.delta_F_hub)}</td>
      <td>${(d.delta_P_friction*1000).toFixed(1)} W</td>
    </tr>`;
  }
  el.innerHTML = h + '</tbody></table>';

  if (kpi) {
    kpi.innerHTML = `
      <div class="fric-kpi"><div class="fric-kpi-label">AC Power Added</div><div class="fric-kpi-val">${fr.delta_P_accessory.toFixed(2)}</div><div class="fric-kpi-unit">kW</div></div>
      <div class="fric-kpi"><div class="fric-kpi-label">Extra Belt Friction</div><div class="fric-kpi-val">${(fr.delta_P_friction_total*1000).toFixed(1)}</div><div class="fric-kpi-unit">W</div></div>
      <div class="fric-kpi"><div class="fric-kpi-label">Total Power Overhead</div><div class="fric-kpi-val">${fr.delta_P_total.toFixed(2)}</div><div class="fric-kpi-unit">kW</div></div>
      <div class="fric-kpi"><div class="fric-kpi-label">Belt Friction % of AC</div><div class="fric-kpi-val" style="color:#f59e0b">${fr.pct_overhead.toFixed(2)}</div><div class="fric-kpi-unit">%</div></div>`;
  }

  if (bar) {
    const maxP = Math.max(fr.total_P_ac, fr.total_P_noac, 1);
    const pNoAC = (fr.total_P_noac / maxP * 100).toFixed(1);
    const pAC   = (fr.total_P_ac   / maxP * 100).toFixed(1);
    const pFric = Math.min(fr.delta_P_friction_total / maxP * 100, 100).toFixed(1);
    bar.innerHTML = `
      <div class="fric-bar-title">Power Distribution (relative to max)</div>
      <div class="fric-bar-row"><span class="fric-bar-label">Non-AC total</span><span class="fric-bar-track"><span class="fric-bar-fill" style="width:${pNoAC}%;background:#8b5cf6"></span></span><span class="fric-bar-val">${fr.total_P_noac.toFixed(2)} kW</span></div>
      <div class="fric-bar-row"><span class="fric-bar-label">AC-ON total</span><span class="fric-bar-track"><span class="fric-bar-fill" style="width:${pAC}%;background:#f472b6"></span></span><span class="fric-bar-val">${fr.total_P_ac.toFixed(2)} kW</span></div>
      <div class="fric-bar-row"><span class="fric-bar-label">Extra friction</span><span class="fric-bar-track"><span class="fric-bar-fill" style="width:${pFric}%;background:#ef4444"></span></span><span class="fric-bar-val">${(fr.delta_P_friction_total*1000).toFixed(1)} W</span></div>`;
  }
}

// ── Sliders ───────────────────────────────────────────────────────────────────
function initSliders() {
  const rpmSl  = document.getElementById('adv-rpm');
  const tenSl  = document.getElementById('adv-tension');
  const tenrSl = document.getElementById('adv-tensioner');
  const acSl   = document.getElementById('ac-power-slider');
  if (rpmSl) rpmSl.addEventListener('input', () => {
    ST.rpm = +rpmSl.value;
    document.getElementById('lbl-adv-rpm').textContent = ST.rpm + ' RPM';
    compute();
  });
  if (tenSl) tenSl.addEventListener('input', () => {
    ST.baseTension = +tenSl.value;
    document.getElementById('lbl-adv-tension').textContent = ST.baseTension + ' N';
    compute();
  });
  const TEN_LABELS = ['FREE','REPLACE','MAX','MEAN','MIN','LOAD'];
  const TEN_ARMS   = [32.0, 24.3, 19.1, 15.4, 11.9, 358.7];
  if (tenrSl) tenrSl.addEventListener('input', () => {
    ST.tenIdx = +tenrSl.value;
    document.getElementById('lbl-adv-tensioner').textContent = `${TEN_LABELS[ST.tenIdx]} (${TEN_ARMS[ST.tenIdx]}°)`;
    compute();
  });
  if (acSl) acSl.addEventListener('input', () => {
    ST.acPower = +acSl.value;
    document.getElementById('lbl-ac-power').textContent = ST.acPower.toFixed(1) + ' kW';
    RESULTS.friction = phComputeFrictionalPower(ST.pulleys, ST.rpm, ST.baseTension, ST.tenIdx, ST.acPower);
    renderFrictionTable();
  });
}

// ── Reset Layout Button ───────────────────────────────────────────────────────
function initResetBtn() {
  const btn = document.getElementById('btn-reset-layout');
  if (!btn) return;
  btn.addEventListener('click', () => {
    ST.pulleys = JSON.parse(JSON.stringify(PULLEY_DEFAULTS));
    updateCoordInputs();
    compute();
  });
}

// ── PDF Export ────────────────────────────────────────────────────────────────
function initExport() {
  const btn = document.getElementById('btn-download-pdf');
  if (btn) btn.addEventListener('click', downloadPDF);
  const btnX = document.getElementById('btn-download-excel');
  if (btnX) btnX.addEventListener('click', downloadExcel);
}

async function downloadPDF() {
  const btn = document.getElementById('btn-download-pdf');
  if (btn) { btn.textContent = '⏳ Generating PDF…'; btn.disabled = true; }
  try {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation:'portrait', unit:'mm', format:'a4' });
    const W = 210, M = 14;
    const title = document.getElementById('report-title')?.value || 'Gates FEAD Engineering Analysis';
    const author = document.getElementById('report-author')?.value || 'Engineer';
    const project = document.getElementById('report-project')?.value || 'Ashok Leyland H6';
    const date = new Date().toLocaleDateString('en-GB');

    // ── Header ──
    pdf.setFillColor(7,9,15);
    pdf.rect(0,0,W,30,'F');
    pdf.setTextColor(245,158,11);
    pdf.setFontSize(16); pdf.setFont('helvetica','bold');
    pdf.text(title, M, 12);
    pdf.setTextColor(148,163,184);
    pdf.setFontSize(8); pdf.setFont('helvetica','normal');
    pdf.text(`${project}  |  ${author}  |  ${date}`, M, 18);
    pdf.text(`RPM: ${ST.rpm}  |  Tension: ${ST.baseTension} N  |  Tensioner: ${['FREE','REPLACE','MAX','MEAN','MIN','LOAD'][ST.tenIdx]}`, M, 23);

    let y = 36;

    // ── 2D Canvas snapshot ──
    if (cvs) {
      const imgData = cvs.toDataURL('image/png');
      const imgW = W - M*2, imgH = imgW * (cvs.height / cvs.width);
      pdf.addImage(imgData, 'PNG', M, y, imgW, Math.min(imgH, 80));
      y += Math.min(imgH, 80) + 5;
    }

    // ── Section helper ──
    const section = (title) => {
      if (y > 265) { pdf.addPage(); y = 14; }
      pdf.setFillColor(20, 29, 46);
      pdf.rect(M, y, W-M*2, 7, 'F');
      pdf.setTextColor(245,158,11); pdf.setFontSize(9); pdf.setFont('helvetica','bold');
      pdf.text(title, M+2, y+5);
      y += 9;
    };

    // ── Hub Load ──
    section('1. Hub Load Results');
    if (RESULTS.hubLoad) {
      const rows = PH_ORDER.map(n => {
        const d = RESULTS.hubLoad.results[n];
        return [n, fmtN(d.T_in), fmtN(d.T_out), fmtN(d.F), fmtDeg(d.dir),
                String(d.pdf_F), d.pdf_dir+'°',
                (d.F-d.pdf_F>=0?'+':'')+((d.F-d.pdf_F).toFixed(1))];
      });
      pdf.autoTable({
        startY: y, margin:{left:M,right:M},
        head: [['Pulley','T_in (N)','T_out (N)','F_hub (N)','Dir','PDF F (N)','PDF Dir','ΔF (N)']],
        body: rows,
        styles:{fontSize:7.5,cellPadding:1.5,fillColor:[11,15,26],textColor:[226,232,240],lineColor:[29,42,64]},
        headStyles:{fillColor:[14,22,46],textColor:[245,158,11],fontStyle:'bold'},
        alternateRowStyles:{fillColor:[15,22,34]},
        didDrawPage: data => { y = data.cursor.y + 4; }
      });
      y = pdf.lastAutoTable.finalY + 6;
    }

    // ── Belt Tension ──
    section('2. Belt Tension Analysis');
    if (RESULTS.tension) {
      const rows = PH_ORDER.map(n => {
        const t = RESULTS.tension[n];
        return [n, t.P_kW.toFixed(2), t.v.toFixed(2), fmtN(t.T_eff), fmtN(t.T_tight), fmtN(t.T_slack), fmtN(t.T_centrifugal), fmtN(t.T_total_tight)];
      });
      pdf.autoTable({
        startY: y, margin:{left:M,right:M},
        head: [['Pulley','P(kW)','v(m/s)','T_eff(N)','T_tight(N)','T_slack(N)','T_c(N)','T_total(N)']],
        body: rows,
        styles:{fontSize:7.5,cellPadding:1.5,fillColor:[11,15,26],textColor:[226,232,240],lineColor:[29,42,64]},
        headStyles:{fillColor:[14,22,46],textColor:[245,158,11],fontStyle:'bold'},
        alternateRowStyles:{fillColor:[15,22,34]},
        didDrawPage: data => { y = data.cursor.y + 4; }
      });
      y = pdf.lastAutoTable.finalY + 6;
    }

    // ── Belt Slip ──
    section('3. Belt Slip Safety Factor');
    if (RESULTS.slip) {
      const rows = PH_ORDER.map(n => {
        const s = RESULTS.slip[n];
        return [n, s.wrap_deg.toFixed(1)+'°', s.capstan_ratio.toFixed(2), s.actual_ratio>90?'∞':s.actual_ratio.toFixed(2), s.SF.toFixed(3), s.status];
      });
      pdf.autoTable({
        startY: y, margin:{left:M,right:M},
        head: [['Pulley','Wrap','e^(μθ)','T_t/T_s','SF','Status']],
        body: rows,
        styles:{fontSize:7.5,cellPadding:1.5,fillColor:[11,15,26],textColor:[226,232,240],lineColor:[29,42,64]},
        headStyles:{fillColor:[14,22,46],textColor:[245,158,11],fontStyle:'bold'},
        alternateRowStyles:{fillColor:[15,22,34]},
        didDrawPage: data => { y = data.cursor.y + 4; }
      });
      y = pdf.lastAutoTable.finalY + 6;
    }

    // ── Fatigue ──
    section('4. Belt Fatigue Life (Wöhler + Palmgren-Miner)');
    if (RESULTS.fatigue) {
      const rows = PH_ORDER.map(n => {
        const l = RESULTS.fatigue.pulleyLife[n];
        return [n, fmtN(l.T_tight), fmtN(l.T_eff), l.miner_damage.toExponential(2), fmtKm(l.life_km)+' km', l.dominant_phase];
      });
      rows.push(['OVERALL', '', '', '', fmtKm(RESULTS.fatigue.overallLife_km)+' km', '(worst pulley)']);
      pdf.autoTable({
        startY: y, margin:{left:M,right:M},
        head: [['Pulley','T_tight(N)','T_eff(N)','Miner D','Life','Dominant Phase']],
        body: rows,
        styles:{fontSize:7.5,cellPadding:1.5,fillColor:[11,15,26],textColor:[226,232,240],lineColor:[29,42,64]},
        headStyles:{fillColor:[14,22,46],textColor:[245,158,11],fontStyle:'bold'},
        alternateRowStyles:{fillColor:[15,22,34]},
        didDrawPage: data => { y = data.cursor.y + 4; }
      });
      y = pdf.lastAutoTable.finalY + 6;
    }

    // ── WP Bearing ──
    section('5. Water Pump Bearing Life (ISO 281)');
    if (RESULTS.bearing) {
      const b = RESULTS.bearing;
      const rows = [
        ['WP Speed',         `${b.wp_rpm.toFixed(0)} RPM`, ''],
        ['Belt Force (TEN)', `${b.F_ten.toFixed(0)} N`,    ''],
        ['Impeller Radial',  `${b.F_radial} N`,            ''],
        ['Ball P_equiv',     `${b.P_ball.toFixed(1)} N`,   ''],
        ['Roller P_equiv',   `${b.P_roller.toFixed(1)} N`, ''],
        ['L10A (Ball)',      `${b.L10A.toFixed(0)} h`,      `C&U ref: ${b.ref.L10A} h`],
        ['L10B (Roller)',    `${b.L10B.toFixed(0)} h`,      `C&U ref: ${b.ref.L10B} h`],
        ['L10 Composite',   `${b.L10_composite.toFixed(0)} h`, `C&U ref: ${b.ref.L10_composite} h`]
      ];
      pdf.autoTable({
        startY: y, margin:{left:M,right:M},
        head: [['Parameter','Calculated','C&U Reference']],
        body: rows,
        styles:{fontSize:7.5,cellPadding:1.5,fillColor:[11,15,26],textColor:[226,232,240],lineColor:[29,42,64]},
        headStyles:{fillColor:[14,22,46],textColor:[245,158,11],fontStyle:'bold'},
        alternateRowStyles:{fillColor:[15,22,34]},
        didDrawPage: data => { y = data.cursor.y + 4; }
      });
      y = pdf.lastAutoTable.finalY + 6;
    }

    // ── Friction ──
    section('6. Frictional Power — Non-AC vs AC ON');
    if (RESULTS.friction) {
      const fr = RESULTS.friction;
      const rows = PH_ORDER.map(n => {
        const d = fr.frictResult[n];
        return [n, fmtN(d.T_noac), fmtN(d.T_ac), (d.delta_T>=0?'+':'')+fmtN(d.delta_T), fmtN(d.delta_F_hub), (d.delta_P_friction*1000).toFixed(1)+' W'];
      });
      rows.push(['TOTAL','','','',`${fr.delta_P_total.toFixed(2)} kW overhead`,`Friction overhead: ${fr.pct_overhead.toFixed(2)}%`]);
      pdf.autoTable({
        startY: y, margin:{left:M,right:M},
        head: [['Pulley','T Non-AC(N)','T AC-ON(N)','ΔT(N)','ΔF_hub(N)','ΔP_friction']],
        body: rows,
        styles:{fontSize:7.5,cellPadding:1.5,fillColor:[11,15,26],textColor:[226,232,240],lineColor:[29,42,64]},
        headStyles:{fillColor:[14,22,46],textColor:[245,158,11],fontStyle:'bold'},
        alternateRowStyles:{fillColor:[15,22,34]},
        didDrawPage: data => { y = data.cursor.y + 4; }
      });
      y = pdf.lastAutoTable.finalY + 6;
    }

    // ── Operating conditions ──
    section('7. Operating Conditions & Duty Cycle');
    pdf.setTextColor(148,163,184); pdf.setFontSize(8); pdf.setFont('helvetica','normal');
    const activeC = CONDITIONS_CONFIG.filter(c=>ST.conditions[c.key]).map(c=>c.name);
    pdf.text(`Active conditions: ${activeC.length ? activeC.join(', ') : 'None (baseline)'}`, M, y); y+=5;
    pdf.text(`WLTC Low: ${ST.dutyCycle.wltcLow}%  Medium: ${ST.dutyCycle.wltcMed}%  High: ${ST.dutyCycle.wltcHigh}%  Extra-High: ${ST.dutyCycle.wltcXHigh}%`, M, y); y+=8;

    // ── Footer ──
    const pgCount = pdf.getNumberOfPages();
    for (let i=1;i<=pgCount;i++) {
      pdf.setPage(i);
      pdf.setTextColor(71,85,105); pdf.setFontSize(7);
      pdf.text(`Gates FEAD Advanced Engineering Suite · Page ${i}/${pgCount}`, M, 292);
    }

    const safeName = title.replace(/[^a-z0-9]/gi,'_').toLowerCase();
    pdf.save(`${safeName}_${ST.rpm}rpm.pdf`);
  } catch(err) {
    alert('PDF generation failed: ' + err.message);
    console.error(err);
  } finally {
    if (btn) { btn.innerHTML = '<span class="btn-export-icon">⬇</span> Download A4 Engineering Report (PDF)'; btn.disabled = false; }
  }
}

function downloadExcel() {
  if (typeof XLSX === 'undefined') { alert('XLSX library not loaded.'); return; }
  const wb = XLSX.utils.book_new();
  // Sheet 1: Hub Load
  if (RESULTS.hubLoad) {
    const rows = [['Pulley','T_in(N)','T_out(N)','F_hub(N)','Dir(°)','PDF_F(N)','PDF_Dir(°)','ΔF(N)','ΔDir(°)']];
    PH_ORDER.forEach(n=>{
      const d=RESULTS.hubLoad.results[n];
      rows.push([n,+d.T_in.toFixed(1),+d.T_out.toFixed(1),+d.F.toFixed(1),+d.dir.toFixed(1),d.pdf_F,d.pdf_dir,+(d.F-d.pdf_F).toFixed(1),+(d.dir-d.pdf_dir).toFixed(1)]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Hub Load');
  }
  // Sheet 2: Tension
  if (RESULTS.tension) {
    const rows = [['Pulley','P(kW)','v(m/s)','T_eff(N)','T_tight(N)','T_slack(N)','T_centrifugal(N)','T_total(N)']];
    PH_ORDER.forEach(n=>{const t=RESULTS.tension[n];rows.push([n,+t.P_kW.toFixed(2),+t.v.toFixed(2),+t.T_eff.toFixed(1),+t.T_tight.toFixed(1),+t.T_slack.toFixed(1),+t.T_centrifugal.toFixed(1),+t.T_total_tight.toFixed(1)]);});
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Belt Tension');
  }
  // Sheet 3: Slip
  if (RESULTS.slip) {
    const rows = [['Pulley','Wrap(°)','Capstan e^mu*theta','T_t/T_s','SF','Status']];
    PH_ORDER.forEach(n=>{const s=RESULTS.slip[n];rows.push([n,+s.wrap_deg.toFixed(1),+s.capstan_ratio.toFixed(3),s.actual_ratio>90?'∞':+s.actual_ratio.toFixed(2),+s.SF.toFixed(3),s.status]);});
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Belt Slip');
  }
  // Sheet 4: Fatigue
  if (RESULTS.fatigue) {
    const rows = [['Pulley','T_tight(N)','T_eff(N)','Miner Damage','Life(km)']];
    PH_ORDER.forEach(n=>{const l=RESULTS.fatigue.pulleyLife[n];rows.push([n,+l.T_tight.toFixed(1),+l.T_eff.toFixed(1),l.miner_damage,+l.life_km.toFixed(0)]);});
    rows.push(['OVERALL','','','',+RESULTS.fatigue.overallLife_km.toFixed(0)]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Fatigue Life');
  }
  // Sheet 5: Bearing
  if (RESULTS.bearing) {
    const b=RESULTS.bearing;
    const rows=[['Parameter','Value','C&U Ref'],['WP RPM',b.wp_rpm.toFixed(0),''],['P_ball(N)',b.P_ball.toFixed(1),''],['P_roller(N)',b.P_roller.toFixed(1),''],['L10A(h)',b.L10A.toFixed(0),b.ref.L10A],['L10B(h)',b.L10B.toFixed(0),b.ref.L10B],['L10_composite(h)',b.L10_composite.toFixed(0),b.ref.L10_composite]];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'WP Bearing Life');
  }
  // Sheet 6: Friction
  if (RESULTS.friction) {
    const fr=RESULTS.friction;
    const rows=[['Pulley','T_noac(N)','T_ac(N)','dT(N)','dF_hub(N)','dP_friction(W)']];
    PH_ORDER.forEach(n=>{const d=fr.frictResult[n];rows.push([n,+d.T_noac.toFixed(1),+d.T_ac.toFixed(1),+d.delta_T.toFixed(1),+d.delta_F_hub.toFixed(1),+(d.delta_P_friction*1000).toFixed(1)]);});
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Frictional Power');
  }
  XLSX.writeFile(wb, `gates_fead_advanced_${ST.rpm}rpm.xlsx`);
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  // Deep copy pulley defaults for mutable state
  ST.pulleys = JSON.parse(JSON.stringify(PULLEY_DEFAULTS));

  initPowerTable();
  initCanvas();
  buildCoordTable();
  buildConditions();
  initDutyCycle();
  buildPowerInputs();
  buildPowerGraph();
  initResultTabs();
  initSliders();
  initResetBtn();
  initExport();
  initSFChart();
  initL10Chart();

  // Initial computation
  compute();

  // Start canvas animation loop
  loop2D();
});
