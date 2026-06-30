/* physics.js – FEAD Advanced Engineering Suite – Calculation Engine */
'use strict';

// ── Belt Material Constants ───────────────────────────────────────────────────
const BELT = {
  ribs: 8, pitch: 3.56, crossArea: 64.0,
  linearMass: 0.18,   // kg/m  — 8-rib Aramid MT620
  mu: 0.35,           // belt-pulley friction coeff (rubber on steel)
  muBearing: 0.002,   // bearing friction coeff (deep groove ball)
  wohlerM: 10,        // Wöhler exponent for Aramid core
  wohlerNref: 1e8,    // reference cycle count
  wohlerTref: 1200    // N — reference tension for Wöhler
};

// ── Pulley Datum Values (Reference PDF) ──────────────────────────────────────────
const PULLEY_DEFAULTS = {
  CRK:{ x:0,       y:0,     r:79.57,  eff:159.13, sr:1.000, cw:true,  color:'#f59e0b', label:'CRK\nCrankshaft' },
  FAN:{ x:6,       y:213.5, r:60.495, eff:121.98, sr:1.302, cw:true,  color:'#8b5cf6', label:'FAN\nFan' },
  IDR:{ x:-122,    y:235,   r:38.7,   eff:79.40,  sr:2.069, cw:false, color:'#a78bfa', label:'IDR\nIdler' },
  ALT:{ x:-255,    y:373.2, r:30.07,  eff:61.13,  sr:2.577, cw:true,  color:'#34d399', label:'ALT\nAlternator' },
  AC: { x:-265,    y:189,   r:59.655, eff:120.30, sr:1.320, cw:true,  color:'#f472b6', label:'AC\nA/C Comp.' },
  TEN:{ x:-153.25, y:96.0,  r:38.7,   eff:79.40,  sr:2.069, cw:false, color:'#60a5fa', label:'TEN\nTensioner' }
};

const PH_ORDER = ['CRK','FAN','IDR','ALT','AC','TEN'];
const PH_SPAN_TYPES = { CRK:'outer', FAN:'inner', IDR:'inner', ALT:'outer', AC:'inner', TEN:'inner' };

// ── PDF Baseline (reference) ──────────────────────────────────────────────────
const PDF_BASELINE = {
  CRK:{ T:2190, F:2658.9, dir:96,  wrap:166.5 },
  FAN:{ T:945,  F:2866.4, dir:258, wrap:127.6 },
  IDR:{ T:1044, F:1710.1, dir:77,  wrap:108.4 },
  ALT:{ T:712,  F:1678.1, dir:279, wrap:145.1 },
  AC: { T:498,  F:985.8,  dir:49,  wrap:105.7 },
  TEN:{ T:480,  F:608.5,  dir:237, wrap:76.4  }
};

// ── Load Table RPM → kW ───────────────────────────────────────────────────────
const PH_LOAD_TABLE = [
  { rpm:500,  P:{ CRK:3.30, FAN:0.50, IDR:0.10, ALT:1.60, AC:1.00, TEN:0.10 }},
  { rpm:800,  P:{ CRK:4.55, FAN:0.80, IDR:0.15, ALT:2.12, AC:1.33, TEN:0.15 }},
  { rpm:1000, P:{ CRK:6.54, FAN:1.80, IDR:0.17, ALT:2.67, AC:1.73, TEN:0.17 }},
  { rpm:1200, P:{ CRK:8.36, FAN:2.80, IDR:0.20, ALT:3.06, AC:2.10, TEN:0.20 }},
  { rpm:1400, P:{ CRK:10.69,FAN:4.60, IDR:0.22, ALT:3.23, AC:2.42, TEN:0.22 }},
  { rpm:1600, P:{ CRK:13.20,FAN:6.50, IDR:0.25, ALT:3.40, AC:2.80, TEN:0.25 }},
  { rpm:1800, P:{ CRK:18.17,FAN:10.80,IDR:0.27, ALT:3.55, AC:3.28, TEN:0.27 }},
  { rpm:2000, P:{ CRK:22.24,FAN:14.30,IDR:0.30, ALT:3.70, AC:3.64, TEN:0.30 }}
];

// ── Tensioner Positions ───────────────────────────────────────────────────────
const PH_TEN_POS = [
  { label:'FREE',    arm:32.0,  ix:-163.7, iy:119.7, T:286.3 },
  { label:'REPLACE', arm:24.3,  ix:-158.0, iy:109.0, T:381.2 },
  { label:'MAX',     arm:19.1,  ix:-154.9, iy:101.4, T:440.2 },
  { label:'MEAN',    arm:15.4,  ix:-153.2, iy:96.0,  T:480.0 },
  { label:'MIN',     arm:11.9,  ix:-151.9, iy:90.5,  T:519.2 },
  { label:'LOAD',    arm:358.7, ix:-150.0, iy:70.0,  T:677.9 }
];

// ── C&U WP Bearing Data ───────────────────────────────────────────────────────
const WP_BEARINGS = {
  ball:   { Cr:19035, p:3,     label:'Ball Bearing (Cr=19035 N)'  },
  roller: { Cr:38179, p:10/3,  label:'Roller Bearing (Cr=38179 N)'}
};

// ── Math Helpers ──────────────────────────────────────────────────────────────
const _r2d = r => r * 180 / Math.PI;
const _d2r = d => d * Math.PI / 180;

/** Interpolate PH_LOAD_TABLE at a given RPM. Returns {CRK,FAN,IDR,ALT,AC,TEN} in kW. */
function phInterp(rpm) {
  const t = PH_LOAD_TABLE;
  if (rpm <= t[0].rpm) return { ...t[0].P };
  if (rpm >= t[t.length-1].rpm) return { ...t[t.length-1].P };
  for (let i = 0; i < t.length - 1; i++) {
    if (rpm >= t[i].rpm && rpm <= t[i+1].rpm) {
      const f = (rpm - t[i].rpm) / (t[i+1].rpm - t[i].rpm);
      const P = {};
      for (const k of PH_ORDER) P[k] = t[i].P[k] + f * (t[i+1].P[k] - t[i].P[k]);
      return P;
    }
  }
  return { ...t[t.length-1].P };
}

/** Belt linear velocity in m/s. */
function phBeltVelocity(rpm, pulleys) {
  const d = pulleys || PULLEY_DEFAULTS;
  return Math.PI * d.CRK.eff * rpm / 60000;
}

// ── Geometry ──────────────────────────────────────────────────────────────────
/** External (outer) common tangent between two circles. */
function phOuterTangent(p1x, p1y, r1, p2x, p2y, r2) {
  const dx = p2x - p1x, dy = p2y - p1y;
  const d = Math.hypot(dx, dy);
  if (d < 0.001) return { t1:{x:p1x,y:p1y}, t2:{x:p2x,y:p2y}, len:0 };
  const gamma = Math.atan2(dy, dx);
  const cosA = Math.max(-1, Math.min(1, (r1 - r2) / d));
  const alpha = Math.acos(cosA);
  const phi = gamma - alpha;
  const t1 = { x: p1x + r1 * Math.cos(phi + Math.PI/2), y: p1y + r1 * Math.sin(phi + Math.PI/2) };
  const t2 = { x: p2x + r2 * Math.cos(phi + Math.PI/2), y: p2y + r2 * Math.sin(phi + Math.PI/2) };
  return { t1, t2, len: Math.hypot(t2.x - t1.x, t2.y - t1.y), phi: _r2d(phi + Math.PI/2) };
}

/** Internal (cross) tangent between two circles. */
function phInnerTangent(p1x, p1y, r1, p2x, p2y, r2) {
  const dx = p2x - p1x, dy = p2y - p1y;
  const d = Math.hypot(dx, dy);
  if (d < r1 + r2 + 0.001) return phOuterTangent(p1x, p1y, r1, p2x, p2y, r2);
  const gamma = Math.atan2(dy, dx);
  const cosA = Math.max(-1, Math.min(1, (r1 + r2) / d));
  const alpha = Math.acos(cosA);
  const phi = gamma - alpha;
  const t1 = { x: p1x + r1 * Math.cos(phi), y: p1y + r1 * Math.sin(phi) };
  const t2 = { x: p2x - r2 * Math.cos(phi), y: p2y - r2 * Math.sin(phi) };
  return { t1, t2, len: Math.hypot(t2.x - t1.x, t2.y - t1.y), phi: _r2d(phi) };
}

/** Get belt span between two pulleys using the correct tangent type. */
function phGetSpan(pulleys, nameA, nameB) {
  const A = pulleys[nameA], B = pulleys[nameB];
  return PH_SPAN_TYPES[nameA] === 'outer'
    ? phOuterTangent(A.x, A.y, A.r, B.x, B.y, B.r)
    : phInnerTangent(A.x, A.y, A.r, B.x, B.y, B.r);
}

// ── 1. Hub Load ───────────────────────────────────────────────────────────────
/**
 * Compute hub bearing loads at all 6 pulleys.
 * @param {object} pulleys - mutable pulley coordinate map
 * @param {number} rpm
 * @param {number} baseTension - static belt tension (N)
 * @param {number} tenIdx - tensioner position index 0-5
 * @param {object} conditions - {ac, regen, bas, highIdle, peakAccel, nightRun, coldStart}
 * @param {object} powerOverrides - {crk, fan, idr, alt, ac, ten} kW overrides
 * @returns {object} {results, spans, tensions, v}
 */
function phComputeAllHubLoads(pulleys, rpm, baseTension, tenIdx, conditions, powerOverrides) {
  // Apply tensioner position
  const tp = PH_TEN_POS[tenIdx] || PH_TEN_POS[3];
  const puls = JSON.parse(JSON.stringify(pulleys));
  puls.TEN.x = tp.ix; puls.TEN.y = tp.iy;

  const v = phBeltVelocity(rpm, puls);
  const P = phInterp(rpm);

  // Condition overrides
  if (!conditions.ac) P.AC = 0;
  else if (conditions.ac && powerOverrides.ac !== undefined) P.AC = powerOverrides.ac;
  if (conditions.nightRun) P.ALT = Math.max(P.ALT, 3.7);
  if (conditions.highIdle) { rpm = 800; }
  if (conditions.peakAccel) P.FAN = Math.min(P.FAN * Math.pow(2300/Math.max(rpm,300), 3), 25);

  // Apply user power overrides
  for (const n of PH_ORDER) {
    const key = n.toLowerCase();
    if (powerOverrides[key] !== undefined && powerOverrides[key] !== null && powerOverrides[key] !== '') {
      P[n] = parseFloat(powerOverrides[key]);
    }
  }

  // Scale tensions
  const scale = baseTension / 2500;
  const tensions = {};
  for (const n of PH_ORDER) tensions[n] = v > 0.01 ? (P[n] * 1000 / v) * scale : 0;

  // BAS: adds 5 kW / v extra tension on CRK tight side
  if (conditions.bas) tensions.CRK = (tensions.CRK || 0) + (v > 0.01 ? 5000/v : 0);
  // Regen: reverse ALT tension sign
  if (conditions.regen) tensions.ALT = -(tensions.ALT || 0);

  // Build spans
  const spans = {};
  for (let i = 0; i < PH_ORDER.length; i++) {
    const cur = PH_ORDER[i], nxt = PH_ORDER[(i+1) % PH_ORDER.length];
    spans[cur] = phGetSpan(puls, cur, nxt);
  }

  // Hub load computation
  const results = {};
  for (let i = 0; i < PH_ORDER.length; i++) {
    const name = PH_ORDER[i];
    const prevName = PH_ORDER[(i - 1 + 6) % 6];
    const spanIn  = spans[prevName];
    const spanOut = spans[name];
    const ux_in  = spanIn.t2.x  - spanIn.t1.x,  uy_in  = spanIn.t2.y  - spanIn.t1.y;
    const ux_out = spanOut.t2.x - spanOut.t1.x, uy_out = spanOut.t2.y - spanOut.t1.y;
    const lin  = Math.hypot(ux_in,  uy_in)  || 1;
    const lout = Math.hypot(ux_out, uy_out) || 1;
    const T_in  = tensions[prevName] || 0;
    const T_out = tensions[name]     || 0;
    const Fx = T_in*(ux_in/lin)  + T_out*(ux_out/lout);
    const Fy = T_in*(uy_in/lin)  + T_out*(uy_out/lout);
    results[name] = {
      T_in, T_out, Fx, Fy,
      F:   Math.hypot(Fx, Fy),
      dir: (_r2d(Math.atan2(Fy, Fx)) + 360) % 360,
      v, P_kW: P[name],
      pdf_F: PDF_BASELINE[name].F, pdf_dir: PDF_BASELINE[name].dir
    };
  }
  return { results, spans, tensions, v, pulleys: puls };
}

// ── 2. Belt Tension ───────────────────────────────────────────────────────────
/**
 * Compute per-span tensions: T_tight, T_slack, T_centrifugal.
 */
function phComputeBeltTension(pulleys, rpm, baseTension, tenIdx, conditions, powerOverrides) {
  const v = phBeltVelocity(rpm, pulleys);
  const T_c = BELT.linearMass * v * v;   // centrifugal tension N
  const P   = phInterp(rpm);
  if (!conditions.ac) P.AC = 0;
  for (const n of PH_ORDER) {
    const key = n.toLowerCase();
    if (powerOverrides[key] !== undefined && powerOverrides[key] !== '') P[n] = parseFloat(powerOverrides[key]);
  }
  const scale = baseTension / 2500;
  const result = {};
  for (const n of PH_ORDER) {
    const T_eff   = v > 0.01 ? (P[n] * 1000 / v) * scale : 0;
    const T_tight = baseTension + T_eff / 2;
    const T_slack = Math.max(baseTension - T_eff / 2, 0);
    result[n] = {
      T_eff, T_tight, T_slack,
      T_centrifugal: T_c,
      T_total_tight: T_tight + T_c,
      T_ratio: T_slack > 1 ? T_tight / T_slack : 99,
      P_kW: P[n], v
    };
  }
  return result;
}

// ── 3. Belt Slip Safety ───────────────────────────────────────────────────────
/**
 * Capstan equation slip safety factor per pulley.
 * SF = ln(T_tight/T_slack) / (mu * wrap_rad)
 */
function phComputeSlipSafety(tensionData, tenIdx) {
  const wrapAngles = {
    CRK: PDF_BASELINE.CRK.wrap,
    FAN: PDF_BASELINE.FAN.wrap,
    IDR: PDF_BASELINE.IDR.wrap,
    ALT: PDF_BASELINE.ALT.wrap,
    AC:  PDF_BASELINE.AC.wrap,
    TEN: Math.max(PDF_BASELINE.TEN.wrap + (tenIdx - 3) * (-3.5), 30)
  };
  const result = {};
  for (const n of PH_ORDER) {
    const d = tensionData[n];
    const wrap_rad = _d2r(wrapAngles[n]);
    const capstan_ratio = Math.exp(BELT.mu * wrap_rad);
    const actual_ratio  = d.T_slack > 1 ? d.T_tight / d.T_slack : 99;
    const SF = d.T_slack > 1 && d.T_tight > d.T_slack
      ? Math.log(actual_ratio) / (BELT.mu * wrap_rad)
      : 0;
    result[n] = {
      wrap_deg: wrapAngles[n],
      wrap_rad,
      capstan_ratio,
      actual_ratio,
      SF: isFinite(SF) ? SF : 0,
      status: SF < 1 ? 'SLIP' : SF < 1.3 ? 'MARGINAL' : 'OK'
    };
  }
  return result;
}

// ── 4. Belt Fatigue Life ──────────────────────────────────────────────────────
/**
 * Wöhler + Palmgren-Miner fatigue accumulation.
 * @param {object} tensionData - from phComputeBeltTension
 * @param {object} dutyCycle - {wltcLow, wltcMed, wltcHigh, wltcXHigh}
 */
function phComputeFatigueLife(tensionData, dutyCycle) {
  const total = (dutyCycle.wltcLow||25) + (dutyCycle.wltcMed||25) +
                (dutyCycle.wltcHigh||25) + (dutyCycle.wltcXHigh||25);
  const phases = [
    { label:'WLTC Low',        rpm:900,  w: (dutyCycle.wltcLow  ||25) / total },
    { label:'WLTC Medium',     rpm:1200, w: (dutyCycle.wltcMed  ||25) / total },
    { label:'WLTC High',       rpm:1600, w: (dutyCycle.wltcHigh ||25) / total },
    { label:'WLTC Extra-High', rpm:2000, w: (dutyCycle.wltcXHigh||25) / total }
  ];

  const pulleyLife = {};
  for (const n of PH_ORDER) {
    let miner_damage = 0;
    let domPhase = phases[0];
    for (const ph of phases) {
      const v_ph = Math.PI * PULLEY_DEFAULTS.CRK.eff * ph.rpm / 60000;
      const P_ph = phInterp(ph.rpm);
      const T_eff_ph = v_ph > 0.01 ? P_ph[n] * 1000 / v_ph : 0;
      // Scale to current static tension
      const T_base   = tensionData[n].T_slack > 0 ? (tensionData[n].T_tight + tensionData[n].T_slack)/2 : 2500;
      const T_tight_ph = T_base + T_eff_ph / 2;
      const T = Math.max(T_tight_ph, 1);
      const N_f = BELT.wohlerNref * Math.pow(BELT.wohlerTref / T, BELT.wohlerM);
      miner_damage += ph.w / N_f;
      if (ph.w > domPhase.w) domPhase = ph;
    }
    const beltLen_km = 1.577 / 1000;
    const life_km = miner_damage > 0 ? Math.min(beltLen_km / miner_damage, 500000) : 500000;
    pulleyLife[n] = {
      miner_damage,
      life_km,
      T_tight: tensionData[n].T_tight,
      T_eff:   tensionData[n].T_eff,
      dominant_phase: domPhase.label
    };
  }
  const overallLife_km = Math.min(...Object.values(pulleyLife).map(l => l.life_km));
  return { pulleyLife, overallLife_km };
}

// ── 5. WP Bearing Life (ISO 281) ──────────────────────────────────────────────
/**
 * L10 bearing life for water pump shaft bearings.
 * @param {object} hubResults - from phComputeAllHubLoads().results
 * @param {number} rpm - engine RPM
 */
function phComputeWPBearingLife(hubResults, rpm) {
  const wp_rpm   = rpm * 1.35;
  const F_ten    = hubResults.TEN ? hubResults.TEN.F : 608.5;
  const F_radial = 358; // C&U radial impeller force (N)
  const P_ball   = Math.hypot(F_ten * 0.30, F_radial);
  const P_roller = Math.hypot(F_ten * 0.70, F_radial);

  const lifeH = (brg, P) => {
    if (wp_rpm < 1 || P < 1) return 0;
    return Math.pow(brg.Cr / P, brg.p) * (1e6 / (60 * wp_rpm));
  };

  const L10A = lifeH(WP_BEARINGS.ball,   P_ball);
  const L10B = lifeH(WP_BEARINGS.roller, P_roller);
  const sumInv = Math.pow(1/Math.max(L10A,0.001), 9/8) + Math.pow(1/Math.max(L10B,0.001), 9/8);
  const L10_composite = 1 / Math.pow(sumInv, 8/9);

  return {
    wp_rpm, P_ball, P_roller,
    L10A, L10B, L10_composite,
    F_ten, F_radial,
    ref: { L10A:17820, L10B:3860, L10_composite:3305 }
  };
}

// ── 6. Frictional Power — Non-AC vs AC ───────────────────────────────────────
/**
 * Compute extra friction from engaging A/C compressor.
 * @param {object} pulleys
 * @param {number} rpm
 * @param {number} baseTension
 * @param {number} tenIdx
 * @param {number} P_ac_kW - AC power when engaged
 */
function phComputeFrictionalPower(pulleys, rpm, baseTension, tenIdx, P_ac_kW) {
  const v = phBeltVelocity(rpm, pulleys);
  const scale = baseTension / 2500;

  const P_noac = phInterp(rpm);
  P_noac.AC = 0;
  const tensions_noac = {};
  for (const n of PH_ORDER) tensions_noac[n] = v > 0.01 ? (P_noac[n]*1000/v)*scale : 0;

  const P_ac = phInterp(rpm);
  P_ac.AC = P_ac_kW;
  const tensions_ac = {};
  for (const n of PH_ORDER) tensions_ac[n] = v > 0.01 ? (P_ac[n]*1000/v)*scale : 0;

  const frictResult = {};
  let total_fric = 0;
  for (const n of PH_ORDER) {
    const p = PULLEY_DEFAULTS[n];
    const omega = (rpm * p.sr * 2 * Math.PI) / 60;
    const R = p.r / 1000; // m
    const delta_T = tensions_ac[n] - tensions_noac[n];
    const delta_F_hub = Math.abs(delta_T) * 1.8;
    const delta_P_friction = BELT.muBearing * delta_F_hub * omega * R;
    total_fric += delta_P_friction;
    frictResult[n] = {
      T_noac: tensions_noac[n],
      T_ac:   tensions_ac[n],
      delta_T,
      delta_F_hub,
      delta_P_friction,
      omega, R
    };
  }

  const total_P_noac = Object.values(P_noac).reduce((s,x)=>s+x,0);
  const total_P_ac   = Object.values(P_ac).reduce((s,x)=>s+x,0);

  return {
    frictResult,
    total_P_noac,
    total_P_ac,
    delta_P_accessory:      P_ac_kW,
    delta_P_friction_total: total_fric,
    delta_P_total:          P_ac_kW + total_fric,
    pct_overhead:           total_P_ac > 0 ? total_fric / total_P_ac * 100 : 0,
    v
  };
}
