// Lai Long Follow Trend – lõi tính toán dùng chung cho Lai Long View và Lai Long Scanner.
// Port từ "Lai Long Follow Trend.pine" (Pine Script v6), không phụ thuộc thư viện.
// Bản gốc nằm ở E:\Lai Long Follow Trend\core\llft.js; hai app giữ bản sao giống hệt.
//
// Nến: { t (ms, giờ mở UTC), o, h, l, c, v, tb? } — tb là volume mua chủ động (taker buy), có thì delta là thật.
// Khác bản Pine: không có dữ liệu khung nhỏ (delta mức B); khung lớn lấy từ htfBars truyền vào hoặc gộp từ nến khung chart.

export const VERSION = '1.0.0';

export const DEFAULTS = {
  pivMode: 'fractal', majL: 10, majR: 10, zzMult: 2, atrLen: 14,
  rvLen: 20, erMin: 1.5, wickMin: 0.5, dMin: 0.1, holdN: 3,
  rvMin: 1.5, absMin: 50, wTol: 0.5, wReb: 1, zMinW: 0.25, zMaxW: 1, brkK: 0.25, expireN: 300, htfZones: true,
  regLen: 20, balMin: 10, htfReg: 40,
  rvBrk: 1.5, bodyMin: 0.6, closeK: 0.25, strongRV: 2, strongBody: 0.7, strongRng: 1.2,
  aBars: 5, retMin: 3, retMax: 20, lowRV: 0.8, baseMin: 5, baseMaxW: 2, cvBase: 0.5, brkExp: 40,
  slBuf: 0.5, rrMin: 1.5, gradeA: 75, gradeB: 60, showC: false, sigS: false,
};

const isNum = Number.isFinite;
const clamp01 = x => Math.min(Math.max(isNum(x) ? x : 0, 0), 1);
const HB = 5000;

// ───────────────────────── Khung lớn theo đặc tả

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/** Khung lớn cho một khung chart (ms): 1m→15m, 5m→1H, 15m/30m/1H→4H, 4H→D, D→W, W→M. */
export function htfFor(tfMs) {
  if (tfMs <= MIN) return { ms: 15 * MIN, unit: 'ms' };
  if (tfMs <= 5 * MIN) return { ms: HOUR, unit: 'ms' };
  if (tfMs <= HOUR) return { ms: 4 * HOUR, unit: 'ms' };
  if (tfMs <= 4 * HOUR) return { ms: DAY, unit: 'D' };
  if (tfMs <= DAY) return { ms: 7 * DAY, unit: 'W' };
  if (tfMs <= 7 * DAY) return { ms: 30 * DAY, unit: 'M' };
  return null;
}

function bucketOf(t, htf) {
  if (htf.unit === 'M') { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
  if (htf.unit === 'W') { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); }
  if (htf.unit === 'D') { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
  return Math.floor(t / htf.ms) * htf.ms;
}

/** Gộp nến khung chart thành nến khung lớn (giờ mở theo mốc UTC). */
export function resample(bars, htf) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const k = bucketOf(b.t, htf);
    if (!cur || cur.t !== k) {
      cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, tb: isNum(b.tb) ? b.tb : undefined };
      out.push(cur);
    } else {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v || 0;
      cur.tb = isNum(cur.tb) && isNum(b.tb) ? cur.tb + b.tb : undefined;
    }
  }
  return out;
}

// ───────────────────────── Hàm chuỗi cơ bản (cùng định nghĩa với Pine)

function atrArr(H, L, C, len) {
  const n = H.length, out = new Array(n).fill(NaN);
  let sum = 0, prev = NaN;
  for (let i = 0; i < n; i++) {
    const tr = i === 0 ? H[i] - L[i] : Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
    if (i < len) { sum += tr; if (i === len - 1) { prev = sum / len; out[i] = prev; } }
    else { prev = (prev * (len - 1) + tr) / len; out[i] = prev; }
  }
  return out;
}

function smaArr(src, len) {
  const n = src.length, out = new Array(n).fill(NaN);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += src[i];
    if (i >= len) s -= src[i - len];
    if (i >= len - 1) out[i] = s / len;
  }
  return out;
}

function stdevArr(src, len) {
  const n = src.length, out = new Array(n).fill(NaN);
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    s += src[i]; s2 += src[i] * src[i];
    if (i >= len) { s -= src[i - len]; s2 -= src[i - len] * src[i - len]; }
    if (i >= len - 1) { const m = s / len; out[i] = Math.sqrt(Math.max(s2 / len - m * m, 0)); }
  }
  return out;
}

function sumArr(src, len) {
  const n = src.length, out = new Array(n).fill(NaN);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += src[i];
    if (i >= len) s -= src[i - len];
    if (i >= len - 1) out[i] = s;
  }
  return out;
}

// ───────────────────────── Module 1: cấu trúc giá

/**
 * Chạy cấu trúc trên một chuỗi nến. Trả về mảng theo nến: trend (1/-1/0), swing gần nhất, sự kiện BOS/CHoCH,
 * gốc xu hướng và cờ pivot mới. Xu hướng: CHoCH đưa về trung tính, BOS từ trung tính mới xác lập xu hướng.
 */
function runStructure(H, L, C, T, atr, p) {
  const n = H.length, pL = p.majL, pR = p.majR, zz = p.pivMode === 'zigzag', zzK = p.zzMult;
  const out = {
    trend: new Int8Array(n), ev: new Int8Array(n), evP: new Float64Array(n).fill(NaN), evB: new Int32Array(n).fill(-1),
    sh: new Float64Array(n).fill(NaN), shB: new Int32Array(n).fill(-1), sl: new Float64Array(n).fill(NaN), slB: new Int32Array(n).fill(-1),
    oDir: new Int8Array(n), oP: new Float64Array(n).fill(NaN), oB: new Int32Array(n).fill(-1), oNew: new Uint8Array(n),
    newH: new Uint8Array(n), newL: new Uint8Array(n),
  };
  let trend = 0, prevT = 0, sh = NaN, shB = -1, shX = true, sl = NaN, slB = -1, slX = true;
  let cHP = NaN, cHB = -1, cLP = NaN, cLB = -1, oDir = 0, oP = NaN, oB = -1;
  let zDir = 1, zHi = NaN, zHB = -1, zLo = NaN, zLB = -1;

  for (let i = 0; i < n; i++) {
    let nH = NaN, nHB = -1, nL = NaN, nLB = -1;
    if (zz) {
      if (!isNum(zHi)) { zHi = H[i]; zHB = i; zLo = L[i]; zLB = i; }
      else if (zDir === 1) {
        if (H[i] >= zHi) { zHi = H[i]; zHB = i; }
        else if (zHi - L[i] >= zzK * atr[i]) { nH = zHi; nHB = zHB; zDir = -1; zLo = L[i]; zLB = i; }
      } else {
        if (L[i] <= zLo) { zLo = L[i]; zLB = i; }
        else if (H[i] - zLo >= zzK * atr[i]) { nL = zLo; nLB = zLB; zDir = 1; zHi = H[i]; zHB = i; }
      }
    } else {
      const q = i - pR;
      if (q - pL >= 0) {
        let isH = true, isL = true;
        for (let j = q - pL; j <= i; j++) {
          if (j === q) continue;
          if (j < q ? H[j] >= H[q] : H[j] > H[q]) isH = false;
          if (j < q ? L[j] <= L[q] : L[j] < L[q]) isL = false;
          if (!isH && !isL) break;
        }
        if (isH) { nH = H[q]; nHB = q; }
        if (isL) { nL = L[q]; nLB = q; }
      }
    }

    // Phá cấu trúc: chỉ tính giá đóng cửa, mỗi swing chỉ bị phá một lần
    let ev = 0, evP = NaN, evB = -1, oNew = 0;
    if (isNum(sh) && !shX && C[i] > sh) {
      shX = true; evP = sh; evB = shB;
      if (trend === -1) { ev = 2; prevT = -1; trend = 0; cLP = sl; cLB = slB; cHP = NaN; }
      else {
        ev = 1;
        if (trend === 0) {
          trend = 1;
          if (!(prevT === 1 && oDir === 1)) {
            const pp = isNum(cLP) ? cLP : sl;
            if (isNum(pp)) { oP = pp; oB = isNum(cLP) ? cLB : slB; oDir = 1; oNew = 1; }
          }
          cHP = NaN; cLP = NaN;
        }
      }
    } else if (isNum(sl) && !slX && C[i] < sl) {
      slX = true; evP = sl; evB = slB;
      if (trend === 1) { ev = -2; prevT = 1; trend = 0; cHP = sh; cHB = shB; cLP = NaN; }
      else {
        ev = -1;
        if (trend === 0) {
          trend = -1;
          if (!(prevT === -1 && oDir === -1)) {
            const pp = isNum(cHP) ? cHP : sh;
            if (isNum(pp)) { oP = pp; oB = isNum(cHP) ? cHB : shB; oDir = -1; oNew = 1; }
          }
          cHP = NaN; cLP = NaN;
        }
      }
    }

    // Ghi nhận pivot mới (pivot luôn ở nến quá khứ nên không thể bị phá ngay trong nến xác nhận)
    if (isNum(nH)) {
      sh = nH; shB = nHB; shX = false;
      if (trend === 0 && (!isNum(cHP) || nH > cHP)) { cHP = nH; cHB = nHB; }
    }
    if (isNum(nL)) {
      sl = nL; slB = nLB; slX = false;
      if (trend === 0 && (!isNum(cLP) || nL < cLP)) { cLP = nL; cLB = nLB; }
    }

    out.trend[i] = trend; out.ev[i] = ev; out.evP[i] = evP; out.evB[i] = evB;
    out.sh[i] = sh; out.shB[i] = shB; out.sl[i] = sl; out.slB[i] = slB;
    out.oDir[i] = oDir; out.oP[i] = oP; out.oB[i] = oB; out.oNew[i] = oNew;
    out.newH[i] = isNum(nH) ? 1 : 0; out.newL[i] = isNum(nL) ? 1 : 0;
  }
  return out;
}

// ───────────────────────── Module 5: các thành phần đo trạng thái

/** Hiệu quả giá, CV volume, volume chân đẩy/chân hồi (theo trend), dịch chuyển giá trị (×ATR, theo trend). */
function regimeParts(H, L, C, O, V, atr, trendArr, n) {
  const len = H.length, h = Math.max(Math.floor(n / 2), 2);
  const absD = C.map((c, i) => (i ? Math.abs(c - C[i - 1]) : 0));
  const path = sumArr(absD, n), vma = smaArr(V, n), vsd = stdevArr(V, n);
  const upV = sumArr(C.map((c, i) => (c > O[i] ? V[i] : 0)), n), dnV = sumArr(C.map((c, i) => (c < O[i] ? V[i] : 0)), n);
  const tp = C.map((c, i) => (H[i] + L[i] + c) / 3);
  const sv = sumArr(V, h), spv = sumArr(tp.map((x, i) => x * V[i]), h), smaP = smaArr(tp, h);
  const vwNow = tp.map((_, i) => (sv[i] > 0 ? spv[i] / sv[i] : smaP[i]));
  const er = new Float64Array(len).fill(0), cv = new Float64Array(len).fill(NaN), imp = new Float64Array(len).fill(NaN), mig = new Float64Array(len).fill(0);
  for (let i = 0; i < len; i++) {
    er[i] = i >= n && path[i] > 0 ? Math.abs(C[i] - C[i - n]) / path[i] : 0;
    cv[i] = vma[i] > 0 ? vsd[i] / vma[i] : NaN;
    const tr = trendArr[i];
    imp[i] = tr === 1 ? (dnV[i] > 0 ? upV[i] / dnV[i] : 2) : tr === -1 ? (upV[i] > 0 ? dnV[i] / upV[i] : 2) : NaN;
    mig[i] = tr !== 0 && atr[i] > 0 && i >= h && isNum(vwNow[i - h]) && isNum(vwNow[i]) ? ((vwNow[i] - vwNow[i - h]) / atr[i]) * tr : 0;
  }
  return { er, cv, imp, mig };
}

/** Điểm trạng thái 0–100: 5 tiêu chí × 20. Từ 60 là Xu hướng, dưới 40 là Cân bằng. */
export function regimeScore(tr, bsBOS, effR, side, slope, cvR, imp, mig) {
  const s1 = (tr === 1 || tr === -1 ? 10 : 0) + (isNum(bsBOS) && bsBOS <= 30 ? 10 : 0);
  const s2 = 20 * clamp01((effR - 0.15) / 0.3);
  const s3 = 12 * clamp01((side - 0.5) / 0.5) + 8 * clamp01(slope / 0.5);
  const s4 = 10 * clamp01((0.9 - (isNum(cvR) ? cvR : 0.9)) / 0.5) + 10 * clamp01(((isNum(imp) ? imp : 1) - 1) / 0.3);
  const s5 = 20 * clamp01(mig);
  return s1 + s2 + s3 + s4 + s5;
}

export const regimeLabel = s => (s >= 60 ? 'trend' : s < 40 ? 'balance' : 'transition');

// ───────────────────────── Phân tích khung lớn (chạy trên nến khung lớn, dùng giá trị của nến đã đóng)

function analyzeHtf(bars, p) {
  const n = bars.length;
  const H = bars.map(b => b.h), L = bars.map(b => b.l), C = bars.map(b => b.c), O = bars.map(b => b.o), V = bars.map(b => (b.v > 0 ? b.v : 0)), T = bars.map(b => b.t);
  const atr = atrArr(H, L, C, p.atrLen);
  const st = runStructure(H, L, C, T, atr, p);
  const rp = regimeParts(H, L, C, O, V, atr, st.trend, p.regLen);
  const bs = new Float64Array(n).fill(NaN);
  let last = -1;
  for (let i = 0; i < n; i++) { if (st.ev[i] !== 0) last = i; bs[i] = last >= 0 ? i - last : NaN; }

  // Vùng khung lớn: pivot Fractal, delta mức C (3 dấu hiệu × 33.3), chỉ dạng V
  const zs = [];
  if (p.htfZones && p.pivMode !== 'zigzag') {
    const vma = smaArr(V, p.rvLen);
    const rv = V.map((v, i) => (vma[i] > 0 ? v / vma[i] : NaN));
    const rg = H.map((h, i) => Math.max(h - L[i], Math.abs(C[i]) * 1e-9));
    const er = rv.map((r, i) => (isNum(r) && isNum(atr[i]) ? r / (rg[i] / atr[i]) : NaN));
    const lw = H.map((_, i) => (Math.min(O[i], C[i]) - L[i]) / rg[i]), uw = H.map((h, i) => (h - Math.max(O[i], C[i])) / rg[i]);
    const pR = p.majR, hN = p.holdN, w3 = 100 / 3;
    for (let i = 0; i < n; i++) {
      const isPH = st.newH[i] && st.shB[i] === i - pR, isPL = st.newL[i] && st.slB[i] === i - pR;
      if (!isPH && !isPL) continue;
      let bS = 0, bR = 0, mRV = 0;
      for (let k = Math.max(pR - 2, 0); k <= pR + 2; k++) {
        const b = i - k;
        if (b < 0) continue;
        mRV = Math.max(mRV, isNum(rv[b]) ? rv[b] : 0);
        if (k < hN) continue;
        const e = er[b] >= p.erMin ? w3 : 0;
        let minC = Infinity, maxC = -Infinity;
        for (let j = b + 1; j <= b + hN; j++) { minC = Math.min(minC, C[j]); maxC = Math.max(maxC, C[j]); }
        bS = Math.max(bS, e + (lw[b] >= p.wickMin ? w3 : 0) + (minC >= L[b] ? w3 : 0));
        bR = Math.max(bR, e + (uw[b] >= p.wickMin ? w3 : 0) + (maxC <= H[b] ? w3 : 0));
      }
      if (!isNum(atr[i]) || mRV < p.rvMin) continue;
      const rvPts = 25 * clamp01((mRV - 1) / 1.5), q = i - pR;
      if (isPL && bS >= p.absMin) {
        const w = Math.min(Math.max(Math.min(O[q], C[q]) - L[q], p.zMinW * atr[i]), p.zMaxW * atr[i]);
        zs.push({ at: i, side: 1, t: T[q], top: L[q] + w, bot: L[q], base: rvPts + 0.25 * bS });
      }
      if (isPH && bR >= p.absMin) {
        const w = Math.min(Math.max(H[q] - Math.max(O[q], C[q]), p.zMinW * atr[i]), p.zMaxW * atr[i]);
        zs.push({ at: i, side: -1, t: T[q], top: H[q], bot: H[q] - w, base: rvPts + 0.25 * bR });
      }
    }
  }
  return { T, st, rp, bs, zs, atr };
}

// ───────────────────────── Tính toàn bộ chỉ báo

/**
 * @param {Array} bars nến khung chart, cũ → mới
 * @param {{ htfBars?: Array, htf?: object, tfMs?: number, params?: object }} opts
 */
export function compute(bars, opts = {}) {
  const p = { ...DEFAULTS, ...(opts.params || {}) };
  const n = bars.length;
  const H = bars.map(b => b.h), L = bars.map(b => b.l), C = bars.map(b => b.c), O = bars.map(b => b.o), T = bars.map(b => b.t);
  const V = bars.map(b => (b.v > 0 ? b.v : 0));
  const hasVol = V.some(v => v > 0);
  const hasTaker = bars.some(b => isNum(b.tb));
  const atr = atrArr(H, L, C, p.atrLen);

  // Module 2: volume, delta, dấu hiệu hấp thụ trong nến
  const vma = smaArr(V, p.rvLen), vsd = stdevArr(V, p.rvLen);
  const rng = H.map((h, i) => Math.max(h - L[i], Math.abs(C[i]) * 1e-9));
  const rvol = V.map((v, i) => (vma[i] > 0 ? v / vma[i] : NaN));
  const cvV = V.map((_, i) => (vma[i] > 0 ? vsd[i] / vma[i] : NaN));
  const er = rvol.map((r, i) => (isNum(r) && isNum(atr[i]) ? r / (rng[i] / atr[i]) : NaN));
  const lwR = H.map((_, i) => (Math.min(O[i], C[i]) - L[i]) / rng[i]), uwR = H.map((h, i) => (h - Math.max(O[i], C[i])) / rng[i]);
  const clv = C.map((c, i) => (c - L[i]) / rng[i]);
  const real = bars.map(b => isNum(b.tb));
  const dPct = bars.map((b, i) => {
    if (real[i]) return b.v > 0 ? (2 * b.tb - b.v) / b.v : 0;
    const buy = H[i] > L[i] ? V[i] * (C[i] - L[i]) / (H[i] - L[i]) : V[i] / 2;
    return V[i] > 0 ? (2 * buy - V[i]) / V[i] : 0;
  });
  const wSig = real.map(r => (r ? 25 : 100 / 3));
  const sSup = H.map((_, i) => (er[i] >= p.erMin ? wSig[i] : 0) + (lwR[i] >= p.wickMin ? wSig[i] : 0) + (real[i] && dPct[i] <= -p.dMin && clv[i] >= 0.5 ? wSig[i] : 0));
  const sRes = H.map((_, i) => (er[i] >= p.erMin ? wSig[i] : 0) + (uwR[i] >= p.wickMin ? wSig[i] : 0) + (real[i] && dPct[i] >= p.dMin && clv[i] <= 0.5 ? wSig[i] : 0));

  // Điểm hấp thụ của nến b xét tại nến cur: cộng dấu hiệu "giữ mức" trong tối đa holdN nến sau b
  const absScore = (b, side, cur) => {
    if (b < 0 || b > cur) return NaN;
    let s = side === 1 ? sSup[b] : sRes[b];
    const last = Math.min(b + p.holdN, cur);
    if (last > b) {
      let hold = true;
      for (let j = b + 1; j <= last; j++) if (side === 1 ? C[j] < L[b] : C[j] > H[b]) { hold = false; break; }
      if (hold) s += wSig[b];
    }
    return s;
  };

  // Module 4: tổng tích lũy cho VWAP neo
  const tp = C.map((c, i) => (H[i] + L[i] + c) / 3);
  const cPV = new Float64Array(n + 1), cV = new Float64Array(n + 1), cP2V = new Float64Array(n + 1), cP = new Float64Array(n + 1), cP2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    cPV[i + 1] = cPV[i] + tp[i] * V[i]; cV[i + 1] = cV[i] + V[i]; cP2V[i + 1] = cP2V[i] + tp[i] * tp[i] * V[i];
    cP[i + 1] = cP[i] + tp[i]; cP2[i + 1] = cP2[i] + tp[i] * tp[i];
  }
  const avwap = (a, i) => {
    const sV = cV[i + 1] - cV[a];
    if (hasVol && sV > 0) {
      const m = (cPV[i + 1] - cPV[a]) / sV;
      return [m, Math.sqrt(Math.max((cP2V[i + 1] - cP2V[a]) / sV - m * m, 0))];
    }
    const k = i - a + 1, m = (cP[i + 1] - cP[a]) / k;
    return [m, Math.sqrt(Math.max((cP2[i + 1] - cP2[a]) / k - m * m, 0))];
  };

  const st = runStructure(H, L, C, T, atr, p);
  const bsBOSArr = new Float64Array(n).fill(NaN);
  { let last = -1; for (let i = 0; i < n; i++) { if (st.ev[i] !== 0) last = i; bsBOSArr[i] = last >= 0 ? i - last : NaN; } }
  const rpNow = regimeParts(H, L, C, O, V, atr, st.trend, p.regLen);

  // Khung lớn
  const htf = opts.htf || (opts.tfMs ? htfFor(opts.tfMs) : null);
  const htfBars = opts.htfBars || (htf ? resample(bars, htf) : null);
  const HT = htfBars && htfBars.length >= 30 ? analyzeHtf(htfBars, p) : null;
  const htfMs = htf ? htf.ms : 0;
  // Nến chart i dùng giá trị của nến khung lớn đã đóng trước nến khung lớn chứa nó (tương đương [1] + lookahead_on)
  const hk = new Int32Array(n).fill(-1);
  if (HT) {
    let k = 0;
    for (let i = 0; i < n; i++) {
      while (k + 1 < HT.T.length && HT.T[k + 1] <= T[i]) k++;
      hk[i] = HT.T[k] <= T[i] ? k - 1 : -1;
    }
  }

  // Tìm nến chart chứa đỉnh/đáy của một nến khung lớn
  const findBar = (cur, t0, t1, isHigh, target) => {
    let best = -1, bD = Infinity;
    for (let j = cur; j >= 0 && cur - j < HB - 100; j--) {
      if (T[j] < t0) break;
      if (T[j] < t1) { const d = Math.abs((isHigh ? H[j] : L[j]) - target); if (d <= bD) { bD = d; best = j; } }
    }
    return best;
  };

  // Kết quả
  const trendArr = st.trend, hTrendArr = new Int8Array(n), regArr = new Float64Array(n).fill(NaN), regHtfArr = new Float64Array(n).fill(NaN);
  const vOArr = new Float64Array(n).fill(NaN), vOHArr = new Float64Array(n).fill(NaN);
  const vwapOrigin = [], vwapOriginHtf = [];
  const segments = [], signals = [], traps = [], sweeps = [], balance = [], bos = [];
  const pivs = [];
  let orig = null, origSeg = null, hOrig = null, hOrigSeg = null, prevHOT = NaN, prevZsT = NaN, prevZrT = NaN, htfZi = 0;
  const zones = [], brks = [];
  let lastSig = null;
  const dbg = opts.debug ? { brk: 0, aligned: 0, aFollow: 0, aOk: 0, retest: 0, b1Setup: 0, b1Trig: 0, b2Trig: 0, rejDir: 0, rejReg: 0, rejRR: 0, rejGrade: 0, weak: 0, fake: 0 } : null;
  const aboveO = new Uint8Array(n), aboveH = new Uint8Array(n);
  let balRun = 0, balFrom = 0, balOn = false, balStart = 0, balTop = NaN, balBot = NaN, balTopL = null, balBotL = null, balRec = null;

  const zoneScore = (z, vw) => {
    let s = z.base + (z.held ? 10 : 0) - 10 * Math.max(z.tests - 2, 0);
    let htfC = z.htf;
    if (!htfC) for (const q of zones) if (q.htf && !q.dead && q.dir === z.dir && q.bot <= z.top && q.top >= z.bot) { htfC = true; break; }
    let vwC = false;
    for (const v of vw) if (v >= z.bot - 0.25 * atr[curI] && v <= z.top + 0.25 * atr[curI]) { vwC = true; break; }
    return Math.min(Math.max(s + (htfC ? 15 : 0) + (vwC ? 10 : 0), 0), 100);
  };
  const drawSeg = (z, i) => { if (z.kind <= 2) segments.push({ i0: z.i0, i1: i, top: z.top, bot: z.bot, dir: z.dir, kind: z.kind, htf: z.htf, flipped: z.flipped, born: z.born }); };
  let curI = 0;

  for (let i = 0; i < n; i++) {
    curI = i;
    const a = atr[i];

    // Pivot lớn
    if (st.newH[i]) pivs.push({ bar: st.shB[i], price: st.sh[i], dir: 1, vol: V[st.shB[i]] });
    if (st.newL[i]) pivs.push({ bar: st.slB[i], price: st.sl[i], dir: -1, vol: V[st.slB[i]] });
    if (st.ev[i] !== 0) bos.push({ i, dir: st.ev[i] > 0 ? 1 : -1, choch: Math.abs(st.ev[i]) === 2, from: st.evB[i], price: st.evP[i] });

    // VWAP gốc xu hướng
    if (st.oNew[i] && st.oB[i] >= 0 && i - st.oB[i] < HB) {
      if (origSeg) origSeg.i1 = i - 1;
      orig = { bar: st.oB[i], dir: st.oDir[i] === 1 ? -1 : 1 };
      origSeg = { i0: orig.bar, i1: n - 1, dir: st.oDir[i], vals: null };
      vwapOrigin.push(origSeg);
    }

    // Khung lớn
    const k = hk[i];
    const hTrend = HT && k >= 0 ? HT.st.trend[k] : 0;
    hTrendArr[i] = hTrend;
    if (HT && k >= 0) {
      const hOT = HT.st.oB[k] >= 0 ? HT.T[HT.st.oB[k]] : NaN;
      if (isNum(hOT) && hOT !== prevHOT) {
        const dirO = HT.st.oDir[k];
        const b = findBar(i, hOT, hOT + Math.floor(htfMs * 1.1), dirO === -1, HT.st.oP[k]);
        if (b >= 0) {
          if (hOrigSeg) hOrigSeg.i1 = i - 1;
          hOrig = { bar: b, dir: dirO === 1 ? -1 : 1 };
          hOrigSeg = { i0: b, i1: n - 1, dir: dirO, vals: null };
          vwapOriginHtf.push(hOrigSeg);
        }
        prevHOT = hOT;
      }
    }

    const [vO] = orig ? avwap(orig.bar, i) : [NaN];
    const [vOH, dOH] = hOrig ? avwap(hOrig.bar, i) : [NaN, NaN];
    vOArr[i] = vO; vOHArr[i] = vOH;
    const vwCur = [vO, vOH].filter(isNum);

    // Module 5: trạng thái
    aboveO[i] = isNum(vO) && C[i] > vO ? 1 : 0;
    aboveH[i] = isNum(vOH) && C[i] > vOH ? 1 : 0;
    let upO = 0, upH = 0;
    for (let j = Math.max(0, i - p.regLen + 1); j <= i; j++) { upO += aboveO[j]; upH += aboveH[j]; }
    const sideO = isNum(vO) ? (C[i] > vO ? upO : p.regLen - upO) / p.regLen : 0.5;
    const slopeO = isNum(vO) && i >= 10 && isNum(vOArr[i - 10]) && isNum(a) ? Math.abs(vO - vOArr[i - 10]) / a : 0;
    const regNow = regimeScore(trendArr[i], bsBOSArr[i], rpNow.er[i], sideO, slopeO, rpNow.cv[i], rpNow.imp[i], rpNow.mig[i]);
    const sideH = isNum(vOH) ? (C[i] > vOH ? upH : p.regLen - upH) / p.regLen : 0.5;
    const slopeH = isNum(vOH) && i >= p.regLen && isNum(vOHArr[i - p.regLen]) && isNum(a) ? Math.abs(vOH - vOHArr[i - p.regLen]) / a : 0;
    const regHTF = HT && k >= 0 ? regimeScore(hTrend, HT.bs[k], HT.rp.er[k], sideH, slopeH, HT.rp.cv[k], HT.rp.imp[k], HT.rp.mig[k]) : 0;
    regArr[i] = regNow; regHtfArr[i] = regHTF;
    const htfRegOK = regHTF >= p.htfReg;

    // Chấm điểm tín hiệu theo đặc tả và chặn cứng
    const evalSignal = (dir, entry, sl, absV, zsc, strong, rv, pen, lvTop, lvBot) => {
      const risk = Math.abs(entry - sl);
      if (!(dir === hTrend && htfRegOK && risk > 0)) { if (dbg) { if (dir !== hTrend) dbg.rejDir++; else dbg.rejReg++; } return null; }
      let tH = NaN, tA = NaN;
      for (const z of zones) {
        if (z.kind > 2 || z.dead || z.dir !== -dir) continue;
        const fr = dir === 1 ? z.bot : z.top;
        if (dir === 1 ? fr > entry : fr < entry) {
          tA = !isNum(tA) ? fr : dir === 1 ? Math.min(tA, fr) : Math.max(tA, fr);
          if (z.htf) tH = !isNum(tH) ? fr : dir === 1 ? Math.min(tH, fr) : Math.max(tH, fr);
        }
      }
      let tgt = isNum(tH) ? tH : tA;
      const band = isNum(vOH) && isNum(dOH) ? vOH + 2 * dOH * dir : NaN;
      if (isNum(band) && (dir === 1 ? band > entry : band < entry)) tgt = !isNum(tgt) ? band : dir === 1 ? Math.min(tgt, band) : Math.max(tgt, band);
      if (!isNum(tgt)) tgt = entry + 2 * risk * dir;
      const rr = Math.abs(tgt - entry) / risk;
      const vwLv = vwCur.some(v => v >= lvBot - 0.25 * a && v <= lvTop + 0.25 * a);
      const score = Math.min(
        10 + (isNum(vOH) && (dir === 1 ? C[i] > vOH : C[i] < vOH) ? 10 : 0)
        + (strong ? 8 : 0) + 6 * clamp01((rv - 1.5) / 0.5) + 6 * clamp01(pen / 0.5)
        + 20 * clamp01(absV / 70) + 15 * clamp01(zsc / 100)
        + (vwLv ? 5 : 0) + (isNum(vO) && (dir === 1 ? C[i] > vO : C[i] < vO) ? 5 : 0)
        + (rr >= 2 ? 10 : rr >= p.rrMin ? 5 : 0) + (regHTF >= 75 ? 5 : 0), 100);
      const grade = score >= p.gradeA ? 'A' : score >= p.gradeB ? 'B' : 'C';
      if (rr < p.rrMin || (grade === 'C' && !p.showC)) { if (dbg) { if (rr < p.rrMin) dbg.rejRR++; else dbg.rejGrade++; } return null; }
      return { score, grade, tp: tgt, rr };
    };
    const emit = (dir, type, entry, sl, r) => {
      const s = { i, t: T[i], dir, type, grade: r.grade, score: Math.round(r.score), entry, sl, tp: r.tp, rr: r.rr };
      signals.push(s); lastSig = s;
    };

    // Module 3 + 6: bộ lọc nến phá theo CMT
    const bodyR = Math.abs(C[i] - O[i]) / rng[i];
    const upBody = C[i] > O[i] && bodyR >= p.bodyMin && clv[i] >= 1 - p.closeK;
    const dnBody = C[i] < O[i] && bodyR >= p.bodyMin && clv[i] <= p.closeK;
    const strongK = isNum(rvol[i]) && rvol[i] >= p.strongRV && bodyR >= p.strongBody && H[i] - L[i] >= p.strongRng * a;
    const upStrong = C[i] > O[i] && strongK, dnStrong = C[i] < O[i] && strongK;

    const preAbsorb = (z, bd, b0) => {
      let cnt = 0;
      for (let b = Math.max(b0 - 20, 0); b <= b0 - 1; b++) if ((bd === 1 ? H[b] >= z.bot : L[b] <= z.top) && rvol[b] >= p.rvMin) cnt++;
      return cnt >= 2;
    };
    const breakZone = (z, valid) => {
      const bd = -z.dir;
      if (valid && !(z.flipped && z.kind <= 2)) {
        if (dbg) { dbg.brk++; if (bd === hTrend) dbg.aligned++; }
        brks.push({ dir: bd, top: z.top, bot: z.bot, kind: z.kind, htf: z.htf, z, brkBar: z.pendBar, cfm: i, rv: rvol[z.pendBar] || 0, strong: z.pendStrong, pen: z.pendPen, preAbs: preAbsorb(z, bd, z.pendBar), zsc: z.kind <= 2 ? zoneScore(z, vwCur) : 30, state: 1, early: false, far: true, postAbs: false, absBest: 0, retBar: -1, trig: NaN, trigBar: -1, outOK: true, inCnt: 0, done: false });
      }
      drawSeg(z, i);
      if (z.kind <= 2 && !z.flipped) {
        z.flipped = true; z.dir = -z.dir; z.i0 = i; z.tests = 0; z.held = false; z.inside = L[i] <= z.top && H[i] >= z.bot; z.lastTouch = i; z.pend = 0;
      } else z.dead = true;
    };

    // Vòng đời các mức
    for (let zi = zones.length - 1; zi >= 0; zi--) {
      const z = zones[zi], bd = -z.dir;
      const outBuf = bd === 1 ? C[i] > z.top + p.brkK * a : C[i] < z.bot - p.brkK * a;
      const outC = bd === 1 ? C[i] > z.top : C[i] < z.bot;
      if (z.pend === 0 && outBuf) {
        z.pend = 1; z.pendBar = i;
        z.pendOk = rvol[i] >= p.rvBrk && (bd === 1 ? upBody : dnBody);
        z.pendStrong = bd === 1 ? upStrong : dnStrong;
        z.pendPen = isNum(a) ? (bd === 1 ? C[i] - z.top : z.bot - C[i]) / a : 0;
        if (z.pendOk && z.pendStrong) breakZone(z, true);
      } else if (z.pend > 0) {
        if (outC) {
          z.pend++;
          if (z.pendOk && z.pend >= 2) breakZone(z, true);
          else if (!z.pendOk && z.pend >= 3) { if (dbg) dbg.weak++; breakZone(z, false); }
        } else { if (dbg) dbg.fake++; z.pend = 0; }
      } else {
        const inZ = L[i] <= z.top && H[i] >= z.bot;
        if (inZ) { if (!z.inside) z.tests++; z.lastTouch = i; }
        else if (z.inside && z.tests === 1 && (z.dir === 1 ? C[i] > z.top : C[i] < z.bot)) z.held = true;
        z.inside = inZ;
        const swept = z.kind <= 2 && (z.dir === 1 ? L[i] < z.bot - p.brkK * a && C[i] > z.bot : H[i] > z.top + p.brkK * a && C[i] < z.top) && rvol[i] >= p.rvMin && (z.dir === 1 ? sSup[i] : sRes[i]) >= p.absMin;
        if (swept && i - z.sweepBar > 3) {
          z.sweepBar = i;
          sweeps.push({ i, dir: z.dir, price: z.dir === 1 ? L[i] : H[i] });
          if (p.sigS && z.dir === hTrend) {
            const slS = z.dir === 1 ? L[i] - p.slBuf * a : H[i] + p.slBuf * a;
            const r = evalSignal(z.dir, C[i], slS, z.dir === 1 ? sSup[i] : sRes[i], zoneScore(z, vwCur), false, rvol[i] || 0, 0, z.top, z.bot);
            if (r) emit(z.dir, 'S', C[i], slS, r);
          }
        }
        if (i - z.lastTouch > p.expireN) { drawSeg(z, i); z.dead = true; }
      }
      if (z.dead) zones.splice(zi, 1);
    }

    // Sinh vùng mới tại pivot lớn vừa xác nhận; pivot không đủ hấp thụ vẫn được theo dõi như một mức
    const tryZone = (pBar, pPrice, side) => {
      if (!isNum(a) || i - pBar >= HB - 10) return false;
      let maxRV = 0, maxAbs = 0, maxVol = -1, vBar = pBar;
      for (let b = Math.max(pBar - 2, 0); b <= Math.min(pBar + 2, i); b++) {
        maxRV = Math.max(maxRV, isNum(rvol[b]) ? rvol[b] : 0);
        const s = absScore(b, side, i);
        maxAbs = Math.max(maxAbs, isNum(s) ? s : 0);
        if (V[b] > maxVol) { maxVol = V[b]; vBar = b; }
      }
      const ok = maxRV >= p.rvMin && maxAbs >= p.absMin;
      const want = side === 1 ? -1 : 1;
      let prev = null;
      for (let q = pivs.length - 1; q >= 0; q--) if (pivs[q].dir === want && pivs[q].bar < pBar) { prev = pivs[q]; break; }
      let isW = false;
      if (prev && Math.abs(pPrice - prev.price) <= p.wTol * a) {
        let mid = NaN;
        for (let b = prev.bar; b <= pBar; b++) mid = !isNum(mid) ? (side === 1 ? H[b] : L[b]) : side === 1 ? Math.max(mid, H[b]) : Math.min(mid, L[b]);
        const swing = side === 1 ? mid - Math.max(pPrice, prev.price) : Math.min(pPrice, prev.price) - mid;
        isW = swing >= p.wReb * a;
      }
      const wBonus = isW && (maxAbs >= p.absMin || V[pBar] < prev.vol);
      const wick = pPrice;
      const edge = side === 1 ? Math.min(O[pBar], C[pBar]) : Math.max(O[pBar], C[pBar]);
      const w = Math.min(Math.max(Math.abs(edge - wick), p.zMinW * a), p.zMaxW * a);
      void vBar;
      let prevZ = null;
      if (isW) for (const z of zones) if (!z.dead && !z.flipped && !z.htf && z.kind <= 2 && z.dir === side && z.pivBar === prev.bar) { prevZ = z; break; }
      if (prevZ) {
        prevZ.kind = 2;
        if (side === 1) { prevZ.bot = Math.min(prevZ.bot, wick); prevZ.top = Math.min(Math.max(prevZ.top, wick + w), prevZ.bot + p.zMaxW * a); }
        else { prevZ.top = Math.max(prevZ.top, wick); prevZ.bot = Math.max(Math.min(prevZ.bot, wick - w), prevZ.top - p.zMaxW * a); }
        if (wBonus) prevZ.base = Math.min(prevZ.base + 15, 65);
        prevZ.pivBar = pBar;
        return true;
      }
      if (!ok) return false;
      let top = side === 1 ? wick + w : wick, bot = side === 1 ? wick : wick - w, i0 = pBar;
      if (isW) {
        if (side === 1) { bot = Math.min(wick, prev.price); top = Math.min(Math.max(wick, prev.price) + w, bot + p.zMaxW * a); }
        else { top = Math.max(wick, prev.price); bot = Math.max(Math.min(wick, prev.price) - w, top - p.zMaxW * a); }
        i0 = prev.bar;
      }
      for (const z of zones) if (!z.dead && !z.htf && z.kind <= 2 && z.dir === side && z.bot <= top && z.top >= bot) return false;
      for (const z of zones) if (z.kind === 3 && !z.dead && z.dir === side && z.bot <= top && z.top >= bot) z.dead = true;
      const base = 25 * clamp01((maxRV - 1) / 1.5) + 0.25 * maxAbs + (wBonus ? 15 : 0);
      zones.push(newZone(top, bot, side, isW ? 2 : 1, false, pBar, i0, i, L[i] <= top && H[i] >= bot, base));
      return true;
    };
    const addLevel = (price, side, pBar) => {
      if (!isNum(a)) return;
      const top = side === 1 ? price + p.zMinW * a : price, bot = side === 1 ? price : price - p.zMinW * a;
      for (const z of zones) if (!z.dead && z.dir === side && z.bot <= top && z.top >= bot) return;
      zones.push(newZone(top, bot, side, 3, false, pBar, pBar, i, L[i] <= top && H[i] >= bot, 0));
    };
    if (st.newL[i] && !tryZone(st.slB[i], st.sl[i], 1)) addLevel(st.sl[i], 1, st.slB[i]);
    if (st.newH[i] && !tryZone(st.shB[i], st.sh[i], -1)) addLevel(st.sh[i], -1, st.shB[i]);

    // Vùng khung lớn: hiện ở nến chart thuộc nến khung lớn ngay sau nến khung lớn sinh ra nó
    if (HT && k >= 0) {
      while (htfZi < HT.zs.length && HT.zs[htfZi].at <= k) {
        const e = HT.zs[htfZi++];
        if (e.side === 1 ? e.t === prevZsT : e.t === prevZrT) continue;
        if (e.side === 1) prevZsT = e.t; else prevZrT = e.t;
        let i0 = i;
        while (i0 > 0 && T[i0 - 1] >= e.t) i0--;
        zones.push(newZone(e.top, e.bot, e.side, 1, true, -1, i0, i, L[i] <= e.top && H[i] >= e.bot, e.base));
      }
    }

    // Hộp cân bằng: Cân bằng liên tục từ balMin nến; hai cạnh hộp là mức breakout
    if (regNow < 40) { if (balRun === 0) balFrom = i; balRun++; } else balRun = 0;
    const frozen = (balTopL && (balTopL.pend > 0 || balTopL.dead)) || (balBotL && (balBotL.pend > 0 || balBotL.dead));
    if (balOn && (balRun === 0 || frozen)) { balOn = false; balRec.i1 = i; }
    else if (balOn) {
      balTop = Math.max(balTop, H[i]); balBot = Math.min(balBot, L[i]);
      balTopL.top = balTop; balTopL.bot = balTop - p.zMinW * a; balBotL.top = balBot + p.zMinW * a; balBotL.bot = balBot;
      balRec.top = balTop; balRec.bot = balBot; balRec.i1 = i;
    } else if (balRun >= p.balMin && isNum(a)) {
      balOn = true; balStart = balFrom; balTop = H[i]; balBot = L[i];
      for (let b = balStart; b <= i; b++) { balTop = Math.max(balTop, H[b]); balBot = Math.min(balBot, L[b]); }
      balTopL = newZone(balTop, balTop - p.zMinW * a, -1, 4, false, -1, balStart, i, true, 0);
      balBotL = newZone(balBot + p.zMinW * a, balBot, 1, 4, false, -1, balStart, i, true, 0);
      zones.push(balTopL, balBotL);
      balRec = { i0: balStart, i1: i, top: balTop, bot: balBot, shape: '' };
      balance.push(balRec);
    }
    while (zones.length > 150) { drawSeg(zones[0], i); zones.shift(); }

    // Breakout đã xác nhận: A, B1, B2, bẫy
    for (let bi = brks.length - 1; bi >= 0; bi--) {
      const kb = brks[bi];
      if (i > kb.cfm) {
        const age = i - kb.cfm, mid = (kb.top + kb.bot) / 2;
        kb.inCnt = (kb.dir === 1 ? C[i] < mid : C[i] > mid) ? kb.inCnt + 1 : 0;
        if (kb.inCnt >= 2) {
          kb.done = true;
          traps.push({ i, dir: kb.dir, price: kb.dir === 1 ? L[i] : H[i] });
          const zr = kb.z;
          if (zr && !zr.dead && zr.flipped && zr.kind <= 2) { zr.flipped = false; zr.dir = -zr.dir; zr.i0 = i; zr.tests = 0; zr.held = false; zr.pend = 0; zr.lastTouch = i; }
        } else {
          const touch = kb.dir === 1 ? L[i] <= kb.top : H[i] >= kb.bot;
          const outC = kb.dir === 1 ? C[i] > kb.top : C[i] < kb.bot;
          const sAbN = kb.dir === 1 ? sSup[i] : sRes[i];
          const slZ = kb.dir === 1 ? kb.bot - p.slBuf * a : kb.top + p.slBuf * a;
          if (kb.state === 1) {
            if (age <= p.aBars) {
              if (touch) kb.early = true;
              if ((kb.dir === 1 ? C[i] - kb.top : kb.bot - C[i]) < p.brkK * a) kb.far = false;
              if (sAbN >= p.absMin && rvol[i] >= p.rvMin) { kb.postAbs = true; kb.absBest = Math.max(kb.absBest, sAbN); }
              if (dbg && age === p.aBars && !kb.early && kb.far) dbg.aFollow++;
              if (age === p.aBars && !kb.early && kb.far && (kb.preAbs || kb.postAbs)) {
                if (dbg) dbg.aOk++;
                kb.done = true;
                const r = evalSignal(kb.dir, C[i], slZ, Math.max(kb.absBest, kb.preAbs ? 50 : 0), kb.zsc, kb.strong, kb.rv, kb.pen, kb.top, kb.bot);
                if (r) emit(kb.dir, 'A', C[i], slZ, r);
              }
            }
            if (!kb.done && touch && age >= p.retMin && age <= p.retMax) { if (dbg) dbg.retest++; kb.state = 2; kb.retBar = i; kb.outOK = true; }
            if (!kb.done && kb.state === 1 && age > p.retMax) kb.done = true;
          }
          if (!kb.done && kb.state === 2) {
            if (i > kb.retBar && !outC) kb.outOK = false;
            if (touch && outC && (sAbN >= p.absMin || rvol[i] < p.lowRV)) { if (dbg && !isNum(kb.trig)) dbg.b1Setup++; kb.trig = kb.dir === 1 ? H[i] : L[i]; kb.trigBar = i; kb.absBest = Math.max(kb.absBest, sAbN); }
            if (isNum(kb.trig) && i > kb.trigBar && (kb.dir === 1 ? C[i] > kb.trig : C[i] < kb.trig)) {
              kb.done = true;
              if (dbg) dbg.b1Trig++;
              const r = evalSignal(kb.dir, C[i], slZ, kb.absBest, kb.zsc, kb.strong, kb.rv, kb.pen, kb.top, kb.bot);
              if (r) emit(kb.dir, 'B1', C[i], slZ, r);
            }
            if (!kb.done && i - kb.retBar >= p.baseMin) {
              let bHi = -Infinity, bLo = Infinity, sv = 0, sv2 = 0, nb = 0, spk = false, bAbs = 0;
              for (let b = kb.retBar; b <= i - 1; b++) {
                bHi = Math.max(bHi, H[b]); bLo = Math.min(bLo, L[b]); sv += V[b]; sv2 += V[b] * V[b]; nb++;
                if ((kb.dir === 1 ? C[b] < O[b] : C[b] > O[b]) && rvol[b] >= p.strongRV) spk = true;
                bAbs = Math.max(bAbs, kb.dir === 1 ? sSup[b] : sRes[b]);
              }
              const mean = sv / nb, cvB = nb > 1 && mean > 0 ? Math.sqrt(Math.max(sv2 / nb - mean * mean, 0)) / mean : 9;
              const baseOk = bHi - bLo <= p.baseMaxW * a && cvB <= p.cvBase && !spk && kb.outOK;
              const trigB2 = kb.dir === 1 ? C[i] > bHi + p.brkK * a : C[i] < bLo - p.brkK * a;
              if (baseOk && trigB2 && rvol[i] >= p.rvBrk) {
                kb.done = true;
                if (dbg) dbg.b2Trig++;
                const slB2 = kb.dir === 1 ? bLo - p.slBuf * a : bHi + p.slBuf * a;
                const r = evalSignal(kb.dir, C[i], slB2, Math.max(kb.absBest, bAbs), kb.zsc, kb.strong, rvol[i] || 0, (kb.dir === 1 ? C[i] - bHi : bLo - C[i]) / a, kb.top, kb.bot);
                if (r) emit(kb.dir, 'B2', C[i], slB2, r);
              }
            }
            if (!kb.done && age > p.brkExp) kb.done = true;
          }
        }
      }
      if (kb.done) brks.splice(bi, 1);
    }
    while (brks.length > 30) brks.shift();
  }

  // Giá trị các đoạn VWAP neo
  for (const sg of vwapOrigin) sg.vals = segVals(sg, avwap);
  for (const sg of vwapOriginHtf) sg.vals = segVals(sg, avwap);

  // Hình dạng phân bố volume của các hộp cân bằng
  for (const b of balance) b.shape = profShape(b, H, L, C, V);

  // Trạng thái ở nến cuối
  const last = n - 1;
  curI = last;
  const vwLast = [vOArr[last], vOHArr[last]].filter(isNum);
  const active = zones.filter(z => !z.dead && z.kind <= 2).map(z => ({
    top: z.top, bot: z.bot, dir: z.dir, kind: z.kind, htf: z.htf, i0: z.i0, tests: z.tests, flipped: z.flipped, born: z.born,
    score: Math.round(zoneScore(z, vwLast)), dist: n ? Math.abs((z.top + z.bot) / 2 - C[last]) : NaN,
  })).sort((x, y) => x.dist - y.dist);
  let stage = null;
  for (let bi = brks.length - 1; bi >= 0; bi--) {
    const kb = brks[bi];
    if (kb.dir !== hTrendArr[last]) continue;
    stage = { dir: kb.dir, stage: kb.state === 1 ? 'wait' : isNum(kb.trig) ? 'b1' : 'base', age: last - kb.cfm, top: kb.top, bot: kb.bot };
    break;
  }
  return {
    version: VERSION, params: p, debug: dbg, n, hasVolume: hasVol, delta: hasTaker ? 'A' : 'C', htf: htf || null, htfBars: htfBars ? htfBars.length : 0,
    trend: trendArr, htfTrend: hTrendArr, regime: regArr, regimeHtf: regHtfArr, vwapOriginNow: vOArr, vwapOriginHtfNow: vOHArr,
    vwapOrigin, vwapOriginHtf, zones: active, segments, signals, traps, sweeps, balance, bos,
    last: n ? {
      trend: trendArr[last], htfTrend: hTrendArr[last], regime: regArr[last], regimeHtf: regHtfArr[last],
      vwapOrigin: vOArr[last], vwapOriginHtf: vOHArr[last], close: C[last], atr: atr[last],
      support: active.find(z => z.dir === 1) || null, resistance: active.find(z => z.dir === -1) || null,
      breakout: stage, signal: lastSig ? { ...lastSig, barsAgo: last - lastSig.i } : null,
    } : null,
  };
}

function newZone(top, bot, dir, kind, htf, pivBar, i0, lastTouch, inside, base) {
  return { top, bot, dir, born: dir, kind, htf, pivBar, i0, lastTouch, tests: 0, inside, held: false, flipped: false, dead: false, base, pend: 0, pendBar: -1, pendOk: false, pendStrong: false, pendPen: 0, sweepBar: -1 };
}

function segVals(sg, avwap) {
  const out = new Float64Array(Math.max(sg.i1 - sg.i0 + 1, 0));
  for (let i = sg.i0; i <= sg.i1; i++) out[i - sg.i0] = avwap(sg.i0, i)[0];
  return out;
}

function profShape(b, H, L, C, V) {
  const rg = b.top - b.bot;
  if (!(rg > 0)) return 'even';
  let lo = 0, mi = 0, hi = 0;
  for (let i = b.i0; i <= b.i1; i++) {
    const f = ((H[i] + L[i] + C[i]) / 3 - b.bot) / rg;
    if (f < 1 / 3) lo += V[i]; else if (f < 2 / 3) mi += V[i]; else hi += V[i];
  }
  const tot = lo + mi + hi;
  if (!(tot > 0)) return 'even';
  const sl = lo / tot, sm = mi / tot, shh = hi / tot;
  return sm >= 0.45 ? 'bell' : sm < 0.25 && sl >= 0.3 && shh >= 0.3 ? 'edges' : shh >= 0.5 ? 'upper' : sl >= 0.5 ? 'lower' : 'even';
}

/** Tên vùng theo vai lúc sinh: V, W (hai đáy), M (hai đỉnh); KL = khung lớn. */
export function zoneName(z, lang = 'vi') {
  return (z.kind === 2 ? (z.born === 1 ? 'W' : 'M') : 'V') + (z.htf ? (lang === 'vi' ? ' KL' : ' HTF') : '');
}

export const TEXT = {
  vi: {
    trend: { 1: 'Tăng', '-1': 'Giảm', 0: 'Trung tính' },
    regime: { trend: 'Xu hướng', transition: 'Chuyển tiếp', balance: 'Cân bằng' },
    stage: { wait: 'chờ theo đà / retest', b1: 'B1 chờ kích hoạt', base: 'đã retest, chờ nền' },
    shape: { bell: 'hình chuông', edges: 'dày ở biên, mỏng ở giữa', upper: 'lệch trên', lower: 'lệch dưới', even: 'phân bố đều' },
  },
  en: {
    trend: { 1: 'Up', '-1': 'Down', 0: 'Neutral' },
    regime: { trend: 'Trend', transition: 'Transition', balance: 'Balance' },
    stage: { wait: 'awaiting follow-through / retest', b1: 'B1 awaiting trigger', base: 'retested, awaiting base' },
    shape: { bell: 'bell', edges: 'heavy edges, thin middle', upper: 'upper-heavy', lower: 'lower-heavy', even: 'even' },
  },
};
