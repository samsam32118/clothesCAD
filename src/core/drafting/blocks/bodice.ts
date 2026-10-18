/**
 * Bodice block (close-fitting, Armstrong/Aldrich style) with optional
 * extension to hip and hem for one-piece garments, and conversion to
 * princess panels.
 *
 * Frame: y = 0 at the high point shoulder (HPS) level, y grows down; centre
 * front / centre back at x = 0, side seam at x > 0.
 *
 * Key construction rules
 * - Back: nape 2 cm below HPS level; CB waist at nape + back waist length.
 * - Shoulder slope from shoulder width vs shoulder length (14°–26° back,
 *   +4° front); back shoulder is longer by the shoulder ease, eased onto the
 *   front.
 * - Chest (armhole depth) line at bust/10 + 11.5 cm below the nape, plus fit
 *   ease, always above the bust point.
 * - Front/back widths at the chest line: bust/4 ± 0.75 cm.
 * - Bust apex from shoulder-to-bust-point and bust-point distance; the bust
 *   dart intake equals how much longer the front is than the back over the
 *   bust (front waist length vs back waist length). The dart sits level with
 *   the apex in the side seam so its legs are equal.
 * - Waist suppression (bust - waist) is shared by side seams and waist darts
 *   (front dart under the apex, back dart under the shoulder blade).
 * - The side seam profile is drafted once (back) and the front is the same
 *   curve shifted 1.5 cm wider, with the bust dart intake inserted, so side
 *   seams match exactly once the dart is sewn.
 */
import type { Dart, FitPreference, Neckline, Path, Point, ResolvedMeasurements } from '../../types';
import {
  add,
  angleBetween,
  rotate,
  clamp,
  cubicBezier,
  dist,
  mid,
  normalize,
  pathLength,
  rotatePath,
  scale,
  splineThrough,
  splitAtLength,
  sub,
  translatePath,
  dedupe,
} from '../../geometry';
import { apexDrop } from '../../measurements';
import { hemCurve } from './skirt';

export interface LowerInput {
  hipF: number;
  highHipF: number;
  hipDepth: number;
  highHipDepth: number;
  /** Waist to hem, measured at the side. */
  belowWaist: number;
  hemF: number;
  /** Princess only: extra flare at each princess seam at the hem (cm, per seam side). */
  princessFlare?: number;
}

export interface BodiceInput {
  r: ResolvedMeasurements;
  bustF: number;
  waistF: number;
  fit: FitPreference;
  knit: boolean;
  sleeveless: boolean;
  neckline: Neckline;
  /** Minimum total neck opening (pull-over garments). */
  minNeckOpening?: number;
  /** Take waist suppression with darts (else side seams only). */
  waistDarts: boolean;
  lower?: LowerInput;
}

export interface BodiceHalf {
  neck: Path; // centre -> HPS
  shoulder: Path; // HPS -> shoulder point
  armhole: Path; // shoulder point -> underarm
  side: Path; // underarm -> bottom side
  bottom: Path; // side -> centre (waist or hem)
  center: Path; // bottom centre -> neck centre
  darts: Dart[];
}

export interface BodiceFrame {
  inp: BodiceInput;
  dx: number; // front-back width offset
  chestY: number;
  apex: Point;
  backWaistY: number;
  frontWaistY: number;
  bustDart: number; // intake I
  dartFront: number; // front waist dart / fisheye intake
  dartBack: number;
  backDartX: number;
  sideSuppression: number;
  hpsF: Point;
  hpsB: Point;
  spF: Point;
  spB: Point;
  thetaF: number;
  thetaB: number;
  neckF: Path;
  neckB: Path;
  armF: Path;
  armB: Path;
  /** Back-frame side profile from underarm down to the bottom (waist or hem). */
  profile: Path;
  /** Arc length on the profile where the bust dart sits. */
  dartS: number;
  bottomBackY: number;
  hemSideBack: Point;
  lower?: LowerInput;
  shoulderEase: number;
  neckOpening: number;
}

const DEG = Math.PI / 180;

interface NeckParams {
  widen: number;
  fd: number;
  bd: number;
}

function neckParams(n: Neckline, jewelF: number, A: Point, k: number, shoulderLen: number): NeckParams {
  let p: NeckParams;
  switch (n) {
    case 'jewel':
      p = { widen: 0, fd: jewelF, bd: 2 };
      break;
    case 'scoop':
      p = { widen: 2, fd: jewelF + 0.3 * (A.y - jewelF), bd: 3.5 };
      break;
    case 'v':
      p = { widen: 1.5, fd: Math.max(jewelF + 7, A.y - 7), bd: 2.5 };
      break;
    case 'boat':
      p = { widen: Math.min(4.5, 0.4 * shoulderLen), fd: 2.5, bd: 1.5 };
      break;
    case 'square':
      p = { widen: 3, fd: jewelF + 4.5, bd: 3 };
      break;
    case 'sweetheart':
      p = { widen: 3, fd: A.y - 3.5, bd: 3 };
      break;
  }
  if (k > 0) {
    p = {
      widen: Math.min(0.55 * shoulderLen, p.widen + k),
      fd: Math.min(A.y - 4, p.fd + 1.5 * k),
      bd: Math.min(10, p.bd + k),
    };
  }
  return p;
}

function frontNeckPath(n: Neckline, fd: number, hps: Point, theta: number, A: Point): Path {
  const cf = { x: 0, y: fd };
  const perp = { x: -Math.sin(theta), y: Math.cos(theta) };
  switch (n) {
    case 'v':
      return cubicBezier(cf, { x: 0.3 * hps.x, y: fd - 0.33 * (fd - hps.y) }, add(hps, scale(perp, 0.3 * (fd - hps.y))), hps);
    case 'square': {
      const cx = Math.max(1, hps.x - 0.6);
      return [cf, { x: cx, y: fd }, ...cubicBezier({ x: cx, y: fd }, { x: cx, y: fd - 0.5 * (fd - hps.y) }, add(hps, scale(perp, 0.25 * (fd - hps.y))), hps).slice(1)];
    }
    case 'sweetheart': {
      const peak = { x: Math.min(hps.x - 0.5, A.x * 0.9), y: Math.max(hps.y + 4, A.y - 9) };
      const a = cubicBezier(cf, { x: 0.15 * A.x, y: fd - 3 }, { x: peak.x - 0.4 * A.x, y: peak.y }, peak);
      const b = cubicBezier(peak, { x: peak.x + 0.6 * (hps.x - peak.x), y: peak.y }, add(hps, scale(perp, 0.4 * (peak.y - hps.y))), hps);
      return [...a, ...b.slice(1)];
    }
    case 'boat':
      return cubicBezier(cf, { x: 0.6 * hps.x, y: fd }, add(hps, scale(perp, 0.25 * Math.max(0.5, fd - hps.y))), hps);
    default:
      return cubicBezier(cf, { x: 0.55 * hps.x, y: fd }, add(hps, scale(perp, 0.45 * (fd - hps.y))), hps);
  }
}

function backNeckPath(bd: number, hps: Point, theta: number): Path {
  const cb = { x: 0, y: bd };
  const perp = { x: -Math.sin(theta), y: Math.cos(theta) };
  return cubicBezier(cb, { x: 0.6 * hps.x, y: bd }, add(hps, scale(perp, 0.4 * Math.max(0.5, bd - hps.y))), hps);
}

function armholePath(sp: Point, theta: number, pitchX: number, pitchFrac: number, s: Point): Path {
  const perp = { x: -Math.sin(theta), y: Math.cos(theta) };
  const p = { x: pitchX, y: sp.y + pitchFrac * (s.y - sp.y) };
  const dy1 = p.y - sp.y;
  const dy2 = s.y - p.y;
  const a = cubicBezier(sp, add(sp, scale(perp, 0.35 * dy1)), { x: p.x, y: p.y - 0.35 * dy1 }, p);
  const b = cubicBezier(p, { x: p.x, y: p.y + 0.5 * dy2 }, { x: s.x - 0.55 * (s.x - p.x), y: s.y }, s);
  return [...a, ...b.slice(1)];
}

/** Arc length along a monotone-in-y path to height y. */
function sAtY(p: Path, y: number): number {
  let acc = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    const d = dist(a, b);
    if ((a.y - y) * (b.y - y) <= 0 && a.y !== b.y) return acc + d * ((y - a.y) / (b.y - a.y));
    acc += d;
  }
  return acc;
}

export function bodiceFrame(inp: BodiceInput): BodiceFrame {
  const r = inp.r;
  const dx = 1.5;
  const nw = r.neckCm / 6 + 0.3;
  const jewelF = r.neckCm / 6 + 1.2;
  const shoulderEase = inp.knit ? 0 : inp.fit === 'relaxed' ? 0.5 : 0.8;
  const Lb = r.shoulderLengthCm + shoulderEase;
  const Lf = r.shoulderLengthCm;
  const cosB = clamp((r.shoulderWidthCm / 2 - 0.7 - nw) / Lb, Math.cos(26 * DEG), Math.cos(14 * DEG));
  const thetaB = Math.acos(cosB);
  const thetaF = thetaB + 4 * DEG;
  const hpsB0 = { x: nw, y: 0 };
  const hpsF0 = { x: nw, y: 0 };
  const spB = add(hpsB0, scale({ x: Math.cos(thetaB), y: Math.sin(thetaB) }, Lb));
  const spF = add(hpsF0, scale({ x: Math.cos(thetaF), y: Math.sin(thetaF) }, Lf));

  const A = { x: r.bustPointDistanceCm / 2, y: apexDrop(r) };
  const fitAdd = { fitted: 0, regular: 1, relaxed: 2 }[inp.fit];
  let chestY = 2 + 0.1 * r.bustCm + 11.5 + fitAdd + (inp.sleeveless ? -0.5 : 0) + (inp.knit ? -1 : 0);
  chestY = clamp(chestY, Math.max(spB.y, spF.y) + 12, A.y - 1.5);

  const xsF = inp.bustF / 4 + dx / 2;
  const xsB = inp.bustF / 4 - dx / 2;
  const acF = Math.min(spF.x - 1.5, xsF - 3);
  const acB = Math.min(spB.x - 0.8, xsB - 3.5);
  const sF = { x: xsF, y: chestY };
  const sB = { x: xsB, y: chestY };
  const armF = armholePath(spF, thetaF, acF, 0.55, sF);
  const armB = armholePath(spB, thetaB, acB, 0.45, sB);

  const backWaistY = 2 + r.backWaistLengthCm;
  let frontWaistY = A.y + (r.frontWaistLengthCm - r.shoulderToBustPointCm);
  let I = frontWaistY - backWaistY;
  I = clamp(I, 0, 7);
  if (I < 0.8) I = 0;
  frontWaistY = backWaistY + I;

  // waist suppression
  const T = (inp.bustF - inp.waistF) / 2;
  let s: number;
  let dF = 0;
  let dB = 0;
  if (inp.waistDarts && T > 2) {
    s = clamp(0.2 * T, 0, 2.5);
    const R = T - 2 * s;
    dF = 0.45 * R;
    dB = 0.55 * R;
    let over = 0;
    if (dF > 4.5) {
      over += dF - 4.5;
      dF = 4.5;
    }
    if (dB > 4) {
      over += dB - 4;
      dB = 4;
    }
    s += over / 2;
    if (dF < 0.6) {
      s += dF / 2;
      dF = 0;
    }
    if (dB < 0.6) {
      s += dB / 2;
      dB = 0;
    }
  } else {
    s = T / 2;
  }
  const xwB = xsB - s;
  const backDartX = clamp(0.48 * (xwB - dB), 6, xwB - dB / 2 - 3);

  // neck (with pull-over enlargement)
  let neckF: Path = [];
  let neckB: Path = [];
  let hpsF = hpsF0;
  let hpsB = hpsB0;
  let opening = 0;
  for (let k = 0; k <= 8; k++) {
    const np = neckParams(inp.neckline, jewelF, A, k, r.shoulderLengthCm);
    hpsF = add(hpsF0, scale({ x: Math.cos(thetaF), y: Math.sin(thetaF) }, np.widen));
    hpsB = add(hpsB0, scale({ x: Math.cos(thetaB), y: Math.sin(thetaB) }, np.widen));
    const fd = Math.max(np.fd, hpsF.y + 1.5);
    const bd = Math.max(np.bd, hpsB.y + 1);
    neckF = frontNeckPath(inp.neckline, fd, hpsF, thetaF, A);
    neckB = backNeckPath(bd, hpsB, thetaB);
    opening = 2 * (pathLength(neckF) + pathLength(neckB));
    if (!inp.minNeckOpening || opening >= inp.minNeckOpening) break;
  }

  // side profile (back frame)
  const yBk = Math.max(chestY + 1.5, A.y + 0.5);
  const Bk = { x: xsB, y: yBk };
  const W = { x: xwB, y: backWaistY };
  let profile: Path;
  let bottomBackY = backWaistY;
  let hemSideBack = W;
  const lower = inp.lower;
  if (!lower) {
    profile = [sB, ...splineThrough([Bk, W], { startTangent: { x: 0, y: 1 } })];
  } else {
    const hipY = backWaistY + lower.hipDepth;
    const hhY = backWaistY + Math.min(lower.highHipDepth, lower.hipDepth - 3);
    const fishF = (y: number) => {
      // front fisheye width at depth below waist (princess garments only)
      const end = lower.hipDepth - 3;
      const t = y - backWaistY;
      return inp.waistDarts && t < end ? dF * (1 - t / end) : 0;
    };
    const fishB = (y: number) => {
      const end = lower.hipDepth - 2;
      const t = y - backWaistY;
      return inp.waistDarts && t < end ? dB * (1 - t / end) : 0;
    };
    const xh = (lower.hipF / 2 - dx) / 2;
    const xhhTarget = (lower.highHipF / 2 - dx + fishF(hhY) + fishB(hhY)) / 2;
    const lin = W.x + ((xh - W.x) * (hhY - backWaistY)) / (hipY - backWaistY);
    const xhh = Math.max(xhhTarget, Math.min(lin, Math.max(W.x, xh)));
    const H = { x: xh, y: hipY };
    const HH = { x: xhh, y: hhY };
    bottomBackY = backWaistY + lower.belowWaist;
    const xhem = (lower.hemF / 2 - dx) / 2 - (lower.princessFlare ?? 0) * 2;
    hemSideBack = { x: Math.max(xhem, 3), y: bottomBackY };
    // keep only shaping points clearly above the hem (tops can end above the hip line)
    const knots = [Bk, W, HH, H].filter((p, i) => i === 0 || p.y < bottomBackY - 2);
    const curve =
      knots.length >= 2
        ? splineThrough(knots, { startTangent: { x: 0, y: 1 }, endTangent: knots[knots.length - 1] === H ? { x: 0, y: 1 } : undefined })
        : [Bk];
    profile = [sB, ...curve, hemSideBack];
  }
  profile = dedupe(profile, 1e-6);
  let dartS = 0;
  if (I > 0) {
    const yUpper = Math.max(chestY + 1.5, A.y - I / 2);
    dartS = sAtY(profile, Math.min(yUpper, yBk));
  }
  return {
    inp,
    dx,
    chestY,
    apex: A,
    backWaistY,
    frontWaistY,
    bustDart: I,
    dartFront: inp.waistDarts ? dF : 0,
    dartBack: inp.waistDarts ? dB : 0,
    backDartX,
    sideSuppression: s,
    hpsF,
    hpsB,
    spF,
    spB,
    thetaF,
    thetaB,
    neckF,
    neckB,
    armF,
    armB,
    profile,
    dartS,
    bottomBackY,
    hemSideBack,
    lower,
    shoulderEase,
    neckOpening: opening,
  };
}

/** Front side seam: back profile shifted by dx, with the bust dart intake inserted. Returns path + dart legs. */
function frontSide(f: BodiceFrame): { side: Path; legs?: [Point, Point] } {
  if (f.bustDart <= 0) return { side: translatePath(f.profile, f.dx, 0) };
  const [up, low] = splitAtLength(f.profile, f.dartS);
  const upper = translatePath(up, f.dx, 0);
  const lower = translatePath(low, f.dx, f.bustDart);
  return { side: [...upper, ...lower], legs: [upper[upper.length - 1], lower[0]] };
}

/** Plain block halves (side bust dart; waist darts when waist-length and enabled). */
export function blockHalves(f: BodiceFrame): { front: BodiceHalf; back: BodiceHalf } {
  const A = f.apex;
  const { side: fSide, legs } = frontSide(f);
  const frontBottomY = f.bottomBackY + f.bustDart;
  const darts: Dart[] = [];
  if (legs) {
    const m = mid(legs[0], legs[1]);
    const stop = f.bustDart > 4 ? 3 : 2.5;
    const apex = add(A, scale(normalize(sub(m, A)), stop));
    darts.push({ id: 'bust-dart', apex, legs, intakeCm: dist(legs[0], legs[1]), lengthCm: dist(apex, m) });
  }
  const fSideEnd = fSide[fSide.length - 1];
  let fBottom: Path;
  let bBottom: Path;
  const bSide = f.profile;
  const bSideEnd = bSide[bSide.length - 1];
  const backDarts: Dart[] = [];
  if (!f.lower) {
    fBottom = [fSideEnd, { x: 0, y: frontBottomY }];
    bBottom = [bSideEnd, { x: 0, y: f.bottomBackY }];
    if (f.dartFront > 0) {
      const l0 = { x: A.x + f.dartFront / 2, y: frontBottomY };
      const l1 = { x: A.x - f.dartFront / 2, y: frontBottomY };
      fBottom = [fSideEnd, l0, l1, { x: 0, y: frontBottomY }];
      darts.push({ id: 'front-waist-dart', apex: { x: A.x, y: A.y + 2.5 }, legs: [l0, l1], intakeCm: f.dartFront, lengthCm: frontBottomY - A.y - 2.5 });
    }
    if (f.dartBack > 0) {
      const l0 = { x: f.backDartX + f.dartBack / 2, y: f.bottomBackY };
      const l1 = { x: f.backDartX - f.dartBack / 2, y: f.bottomBackY };
      bBottom = [bSideEnd, l0, l1, { x: 0, y: f.bottomBackY }];
      const apexY = Math.max(f.chestY + 1, f.bottomBackY - 16);
      backDarts.push({ id: 'back-waist-dart', apex: { x: f.backDartX, y: apexY }, legs: [l0, l1], intakeCm: f.dartBack, lengthCm: f.bottomBackY - apexY });
    }
  } else {
    const hipFront = { x: fSide[fSide.length - 2].x, y: fSide[fSide.length - 2].y };
    const hipBack = bSide[bSide.length - 2];
    fBottom = hemCurve(fSideEnd, normalize(sub(fSideEnd, hipFront)), { x: 0, y: frontBottomY });
    bBottom = hemCurve(bSideEnd, normalize(sub(bSideEnd, hipBack)), { x: 0, y: f.bottomBackY });
  }
  const neckFStart = f.neckF[0];
  const neckBStart = f.neckB[0];
  const front: BodiceHalf = {
    neck: f.neckF,
    shoulder: [f.hpsF, f.spF],
    armhole: f.armF,
    side: fSide,
    bottom: fBottom,
    center: [{ x: 0, y: frontBottomY }, neckFStart],
    darts,
  };
  const back: BodiceHalf = {
    neck: f.neckB,
    shoulder: [f.hpsB, f.spB],
    armhole: f.armB,
    side: bSide,
    bottom: bBottom,
    center: [{ x: 0, y: f.bottomBackY }, neckBStart],
    darts: backDarts,
  };
  return { front, back };
}

// ---------------------------------------------------------------------------
// Princess panels
// ---------------------------------------------------------------------------

export interface PrincessPanel {
  /** Edges in clockwise order with ids. */
  edges: Array<{ id: string; points: Path }>;
}

export interface PrincessResult {
  centreFront: PrincessPanel; // edges: neck, shoulder, armhole, princess, bottom, center
  sideFront: PrincessPanel; // edges: armhole, side, bottom, princess
  centreBack: PrincessPanel;
  sideBack: PrincessPanel;
  frontArmholeUpper: number;
  frontArmholeLower: number;
  backArmholeUpper: number;
  backArmholeLower: number;
}

/** Replace a corner at vertex index i with a smooth cubic over ±r cm. */
function smoothCorner(p: Path, i: number, r: number): Path {
  let sIdx = 0;
  for (let k = 1; k <= i; k++) sIdx += dist(p[k - 1], p[k]);
  const total = pathLength(p);
  const s0 = Math.max(0.01, sIdx - r);
  const s1 = Math.min(total - 0.01, sIdx + r);
  const [before] = splitAtLength(p, s0);
  const [, after] = splitAtLength(p, s1);
  const a = before[before.length - 1];
  const b = after[0];
  const ta = normalize(sub(a, before[Math.max(0, before.length - 2)]));
  const tb = normalize(sub(after[Math.min(after.length - 1, 1)], b));
  const k = dist(a, b) * 0.4;
  const curve = cubicBezier(a, add(a, scale(ta, k)), sub(b, scale(tb, k)), b);
  return [...before, ...curve.slice(1, -1), ...after];
}

function indexOfPoint(p: Path, q: Point): number {
  let best = 0;
  let bd = Infinity;
  p.forEach((x, i) => {
    const d = dist(x, q);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

/**
 * Princess panels from the frame (frame must be built with waistDarts = true).
 * Front: armhole princess through the bust point; the side bust dart is
 * rotated out of the side panel (closing it) so its shaping becomes the curve
 * of the princess seam. Back: armhole princess through the shoulder-blade dart.
 */
export function princessPanels(f: BodiceFrame): PrincessResult {
  const A = f.apex;
  const lower = f.lower;
  const frontBottomY = f.bottomBackY + f.bustDart;
  const flare = lower?.princessFlare ?? 0;

  // ---------------- front
  const { side: fSide, legs } = frontSide(f);
  const armLen = pathLength(f.armF);
  const qS = armLen * 0.55; // from shoulder point
  const [armUpper, armLower] = splitAtLength(f.armF, qS);
  const Q = armUpper[armUpper.length - 1];
  const upperCurve = cubicBezier(Q, { x: Q.x - 0.3 * (Q.x - A.x), y: Q.y + 0.6 * (A.y - Q.y) }, { x: A.x, y: A.y - 0.35 * (A.y - Q.y) }, A);
  const wy = f.frontWaistY;
  const legL = { x: A.x - f.dartFront / 2, y: wy };
  const legR = { x: A.x + f.dartFront / 2, y: wy };
  let lowerLeft: Path;
  let lowerRight: Path;
  if (lower) {
    const endY = wy + lower.hipDepth - 3;
    const hemY = frontBottomY;
    lowerLeft = [A, ...splineThrough([A, legL, { x: A.x, y: endY }]).slice(1), { x: A.x + flare, y: hemY }];
    lowerRight = [A, ...splineThrough([A, legR, { x: A.x, y: endY }]).slice(1), { x: A.x - flare, y: hemY }];
  } else {
    lowerLeft = [A, legL];
    lowerRight = [A, legR];
  }
  // centre front princess: Q -> A -> down
  let cfPrincess = dedupe([...upperCurve, ...lowerLeft.slice(1)]);
  cfPrincess = smoothCorner(cfPrincess, indexOfPoint(cfPrincess, A), 2.5);
  const cfBottomStart = cfPrincess[cfPrincess.length - 1];
  const cfBottom: Path = lower
    ? hemCurve(cfBottomStart, normalize(sub(cfBottomStart, cfPrincess[Math.max(0, cfPrincess.length - 4)])), { x: 0, y: frontBottomY })
    : [cfBottomStart, { x: 0, y: frontBottomY }];
  const centreFront: PrincessPanel = {
    edges: [
      { id: 'neck', points: f.neckF },
      { id: 'shoulder', points: [f.hpsF, f.spF] },
      { id: 'armhole', points: armUpper },
      { id: 'princess', points: cfPrincess },
      { id: lower ? 'hem' : 'waist', points: cfBottom },
      { id: 'cf', points: [{ x: 0, y: frontBottomY }, f.neckF[0]] },
    ],
  };

  // side front: rotate the part above the bust dart about A to close the dart
  let sfArm: Path;
  let sfSide: Path;
  let sfUpperPrincess: Path; // A -> Q'
  if (legs) {
    const theta = angleBetween(sub(legs[0], A), sub(legs[1], A));
    const dartIdx = indexOfPoint(fSide, legs[0]);
    const sideUpper = fSide.slice(0, dartIdx + 1);
    const sideLower = fSide.slice(dartIdx + 1);
    // If the dart legs are not equidistant from the apex (dart pushed below the
    // chest line), the rotated upper leg misses the lower leg slightly; shift the
    // rotated part so the side seam stays continuous and keeps its exact length.
    // The small offset moves into the princess seam, where it is eased over the bust.
    const l1r = rotate(legs[0], theta, A);
    const shift = sub(legs[1], l1r);
    const move = (p: Path) => translatePath(rotatePath(p, theta, A), shift.x, shift.y);
    sfArm = move(armLower);
    const rotUpper = move(sideUpper);
    sfSide = dedupe([...rotUpper, ...sideLower], 1e-3);
    sfUpperPrincess = move([...upperCurve].reverse());
  } else {
    sfArm = armLower;
    sfSide = fSide;
    sfUpperPrincess = [...upperCurve].reverse();
  }
  const sfSideEnd = sfSide[sfSide.length - 1];
  const sfLowerUp = [...lowerRight].reverse(); // bottom -> A
  let sfPrincess = dedupe([...sfLowerUp, ...sfUpperPrincess.slice(1)]);
  sfPrincess = smoothCorner(sfPrincess, indexOfPoint(sfPrincess, A), 2.5);
  const sfPrincessStart = sfPrincess[0];
  const sfBottom: Path = lower
    ? hemCurve(sfSideEnd, normalize(sub(sfSideEnd, sfSide[sfSide.length - 2])), sfPrincessStart)
    : [sfSideEnd, sfPrincessStart];
  const sideFront: PrincessPanel = {
    edges: [
      { id: 'armhole', points: sfArm },
      { id: 'side', points: sfSide },
      { id: lower ? 'hem' : 'waist', points: sfBottom },
      { id: 'princess', points: sfPrincess },
    ],
  };

  // ---------------- back
  const bArmLen = pathLength(f.armB);
  const [bArmUpper, bArmLower] = splitAtLength(f.armB, bArmLen * 0.5);
  const Qb = bArmUpper[bArmUpper.length - 1];
  const Tb = { x: f.backDartX, y: Math.min(f.chestY + 1.5, f.backWaistY - 10) };
  const bCurve = cubicBezier(Qb, { x: Qb.x - 0.5 * (Qb.x - Tb.x), y: Qb.y + 0.2 * (Tb.y - Qb.y) }, { x: Tb.x, y: Tb.y - 0.4 * (Tb.y - Qb.y) }, Tb);
  const by = f.backWaistY;
  const bl = { x: f.backDartX - f.dartBack / 2, y: by };
  const br = { x: f.backDartX + f.dartBack / 2, y: by };
  let bLeft: Path;
  let bRight: Path;
  if (lower) {
    const endY = by + lower.hipDepth - 2;
    bLeft = [Tb, ...splineThrough([Tb, bl, { x: f.backDartX, y: endY }]).slice(1), { x: f.backDartX + flare, y: f.bottomBackY }];
    bRight = [Tb, ...splineThrough([Tb, br, { x: f.backDartX, y: endY }]).slice(1), { x: f.backDartX - flare, y: f.bottomBackY }];
  } else {
    bLeft = splineThrough([Tb, bl]);
    bRight = splineThrough([Tb, br]);
  }
  const cbPrincess = dedupe([...bCurve, ...bLeft.slice(1)]);
  const cbBottomStart = cbPrincess[cbPrincess.length - 1];
  const cbBottom: Path = lower
    ? hemCurve(cbBottomStart, normalize(sub(cbBottomStart, cbPrincess[Math.max(0, cbPrincess.length - 4)])), { x: 0, y: f.bottomBackY })
    : [cbBottomStart, { x: 0, y: f.bottomBackY }];
  const centreBack: PrincessPanel = {
    edges: [
      { id: 'neck', points: f.neckB },
      { id: 'shoulder', points: [f.hpsB, f.spB] },
      { id: 'armhole', points: bArmUpper },
      { id: 'princess', points: cbPrincess },
      { id: lower ? 'hem' : 'waist', points: cbBottom },
      { id: 'cb', points: [{ x: 0, y: f.bottomBackY }, f.neckB[0]] },
    ],
  };
  const sbSide = f.profile;
  const sbSideEnd = sbSide[sbSide.length - 1];
  const sbPrincess = dedupe([...[...bRight].reverse(), ...[...bCurve].reverse().slice(1)]);
  const sbBottom: Path = lower
    ? hemCurve(sbSideEnd, normalize(sub(sbSideEnd, sbSide[sbSide.length - 2])), sbPrincess[0])
    : [sbSideEnd, sbPrincess[0]];
  const sideBack: PrincessPanel = {
    edges: [
      { id: 'armhole', points: bArmLower },
      { id: 'side', points: sbSide },
      { id: lower ? 'hem' : 'waist', points: sbBottom },
      { id: 'princess', points: sbPrincess },
    ],
  };
  return {
    centreFront,
    sideFront,
    centreBack,
    sideBack,
    frontArmholeUpper: pathLength(armUpper),
    frontArmholeLower: pathLength(armLower),
    backArmholeUpper: pathLength(bArmUpper),
    backArmholeLower: pathLength(bArmLower),
  };
}
