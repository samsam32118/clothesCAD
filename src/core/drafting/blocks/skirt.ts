/**
 * Skirt block (Aldrich-style close-fitting skirt) and derived shapes.
 *
 * Each half is drafted with its centre line at x = 0 and the side seam at
 * x > 0, y down from the centre-front waist. Path order is clockwise:
 *   waist (centre -> side), side (waist -> hem), hem (side -> centre),
 *   centre (hem -> waist).
 *
 * Waist suppression (hip minus waist) is shared between the side seams and
 * waist darts; darts are sized from the waist-hip difference (more at the
 * back for the seat), the side seam follows a curved hip line that also
 * clears the high hip. Front and back side seams are the same curve
 * translated sideways, so their lengths match exactly.
 */
import type { Dart, Path, Point } from '../../types';
import {
  add,
  angleBetween,
  clamp,
  cubicBezier,
  dir,
  dist,
  insertAtLengths,
  normalize,
  outwardNormal,
  pathLength,
  pointAtLength,
  rotate,
  rotatePath,
  scale,
  solveMonotone,
  sub,
  tangentAtLength,
} from '../../geometry';

export interface SkirtBlockInput {
  /** Finished (darts closed) waist width of the front half piece, cm. */
  waistFront: number;
  /** Finished waist width of one back piece, cm. */
  waistBack: number;
  hipF: number;
  highHipF: number;
  hipDepth: number;
  highHipDepth: number;
  /** Centre-front waist to hem. */
  length: number;
  /** Total hem circumference for a tapered (pencil) skirt; omit for straight. */
  hemF?: number;
  /** Preferred distance of the first front dart from CF (≈ half bust-point distance). */
  frontDartX: number;
  /** Centre-back waist drop (cm) — 1 for a skirt on a waistband, ~0.5 at a dress waist seam. */
  cbDrop?: number;
  /** Disable darts (elastic / gathered waists): all suppression goes nowhere — waist = hip. */
  noDarts?: boolean;
}

export interface SkirtHalf {
  waist: Path;
  side: Path;
  hem: Path;
  center: Path;
  darts: Dart[];
  /** Arc length along the side seam from waist to the hip line (for notches / pockets). */
  sideToHip: number;
  hipY: number;
}

export interface SkirtBlock {
  front: SkirtHalf;
  back: SkirtHalf;
  sideSuppression: number;
}

interface DartPlan {
  count: number;
  intake: number; // per dart
}

function planDarts(total: number, maxPerDart: number): DartPlan {
  if (total < 0.6) return { count: 0, intake: 0 };
  const count = total <= maxPerDart ? 1 : 2;
  return { count, intake: Math.min(maxPerDart, total / count) };
}

/** Smooth hem from the side hem point (meeting the side seam at a right angle) to the centre (horizontal). */
export function hemCurve(side: Point, sideDown: Point, centre: Point): Path {
  const w = Math.abs(side.x - centre.x);
  // inward direction perpendicular to the side seam, pointing towards the centre
  let perp = { x: -sideDown.y, y: sideDown.x };
  if ((centre.x - side.x) * perp.x < 0) perp = scale(perp, -1);
  const c1 = add(side, scale(normalize(perp), w * 0.35));
  const c2 = { x: centre.x + (side.x > centre.x ? 1 : -1) * w * 0.35, y: centre.y };
  return cubicBezier(side, c1, c2, centre);
}

/** Path x at a given y (first crossing), for a monotone-in-y path. */
function xAtY(p: Path, y: number): number {
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    if ((a.y - y) * (b.y - y) <= 0 && a.y !== b.y) return a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
  }
  return p[p.length - 1].x;
}

function sideCurve(top: Point, hip: Point, k: number): Path {
  const h = hip.y - top.y;
  const c1 = { x: top.x + k * (hip.x - top.x), y: top.y + 0.38 * h };
  const c2 = { x: hip.x, y: hip.y - 0.42 * h };
  return cubicBezier(top, c1, c2, hip);
}

function waistCurve(centre: Point, sideTop: Point, sideTangent: Point): Path {
  const w = sideTop.x - centre.x;
  // arrive at the side perpendicular to the side seam
  let perp = { x: sideTangent.y, y: -sideTangent.x };
  if (perp.x < 0) perp = scale(perp, -1);
  const c1 = { x: centre.x + w * 0.45, y: centre.y };
  const c2 = sub(sideTop, scale(normalize(perp), w * 0.3));
  return cubicBezier(centre, c1, c2, sideTop);
}

interface HalfGeom {
  waistW: number; // horizontal width of waist edge incl. darts
  hipW: number;
  dartPlan: DartPlan;
  dartLen: number;
  maxDart: number;
}

/** Draft the straight (or tapered) skirt block. */
export function draftSkirtBlock(inp: SkirtBlockInput): SkirtBlock {
  const D = inp.hipDepth;
  const hh = Math.min(inp.highHipDepth, D - 3);
  const halfHip = inp.hipF / 2;
  const T = halfHip - (inp.waistFront + inp.waistBack); // suppression for half the body
  let s: number;
  let df = 0;
  let db = 0;
  const maxF = 3;
  const maxB = 3.5;
  if (inp.noDarts || T <= 1.2) {
    s = T / 2;
  } else {
    s = clamp(0.22 * T, 0.5, 3);
    let R = T - 2 * s;
    df = 0.4 * R;
    db = 0.6 * R;
    const capF = 2 * maxF;
    const capB = 2 * maxB;
    let overflow = 0;
    if (df > capF) {
      overflow += df - capF;
      df = capF;
    }
    if (db > capB) {
      overflow += db - capB;
      db = capB;
    }
    s += overflow / 2;
    if (df < 0.6) {
      s += df / 2;
      df = 0;
    }
    if (db < 0.6) {
      s += db / 2;
      db = 0;
    }
    R = df + db;
  }
  const front: HalfGeom = {
    waistW: inp.waistFront + df,
    hipW: inp.waistFront + df + s,
    dartPlan: planDarts(df, maxF),
    dartLen: clamp(0.48 * D, 8, 11),
    maxDart: maxF,
  };
  const back: HalfGeom = {
    waistW: inp.waistBack + db,
    hipW: inp.waistBack + db + s,
    dartPlan: planDarts(db, maxB),
    dartLen: clamp(0.68 * D, 11, 15),
    maxDart: maxB,
  };
  const raise = s > 0 ? clamp(0.6 + 0.15 * s, 0.6, 1.5) : 0.3;

  // Choose hip-curve fullness so the high hip has its ease.
  const dartWidthAt = (g: HalfGeom, y: number) => {
    let w = 0;
    for (let i = 0; i < g.dartPlan.count; i++) {
      const L = g.dartLen - i * 1.5;
      if (y < L) w += g.dartPlan.intake * (1 - y / L);
    }
    return w;
  };
  const circAtHH = (k: number) => {
    const c = sideCurve({ x: front.waistW, y: -raise }, { x: front.hipW, y: D }, k);
    const xF = xAtY(c, hh);
    const xB = xF - (front.hipW - back.hipW);
    return 2 * (xF - dartWidthAt(front, hh) + xB - dartWidthAt(back, hh));
  };
  let k = 0.45;
  if (circAtHH(1) >= inp.highHipF && circAtHH(k) < inp.highHipF) {
    k = solveMonotone(circAtHH, inp.highHipF, k, 1);
  } else if (circAtHH(k) < inp.highHipF) {
    k = 1;
  }

  const taper = inp.hemF !== undefined ? Math.max(0, (inp.hipF - inp.hemF) / 4) : 0;
  const cbDrop = inp.cbDrop ?? 1;

  const build = (g: HalfGeom, isFront: boolean): SkirtHalf => {
    const top = { x: g.waistW, y: -raise };
    const hipPt = { x: g.hipW, y: D };
    const upper = sideCurve(top, hipPt, k);
    const hemSide = { x: g.hipW - taper, y: inp.length };
    const side: Path = [...upper, hemSide];
    const sideTan = dir(upper[0], upper[Math.min(upper.length - 1, 3)]);
    const centreTop = { x: 0, y: isFront ? 0 : cbDrop };
    let waist = waistCurve(centreTop, top, sideTan);
    const arc = pathLength(waist);
    // darts
    const n = g.dartPlan.count;
    const darts: Dart[] = [];
    if (n > 0) {
      const excess = arc - (isFront ? inp.waistFront : inp.waistBack) - n * g.dartPlan.intake;
      const intake = g.dartPlan.intake + excess / n;
      const centres: number[] = [];
      if (isFront) {
        const first = clamp(inp.frontDartX, 0.3 * arc, 0.55 * arc);
        centres.push(first);
        if (n === 2) centres.push(first + 0.5 * (arc - first) - 0.5);
      } else if (n === 1) {
        centres.push(0.5 * arc);
      } else {
        centres.push(0.36 * arc, 0.68 * arc);
      }
      const legLengths: number[] = [];
      centres.forEach((c) => legLengths.push(c - intake / 2, c + intake / 2));
      const ins = insertAtLengths(waist, legLengths);
      waist = ins.path;
      centres.forEach((c, i) => {
        const centrePt = pointAtLength(waist, c).point;
        const t = tangentAtLength(waist, c);
        const inward = scale(outwardNormal(t), -1);
        const axis = normalize(add(scale(inward, 0.5), { x: 0, y: 0.5 }));
        const L = g.dartLen - i * (isFront ? 1.5 : 1);
        darts.push({
          id: `${isFront ? 'front' : 'back'}-waist-dart-${i + 1}`,
          apex: add(centrePt, scale(axis, L)),
          legs: [waist[ins.indices[2 * i]], waist[ins.indices[2 * i + 1]]],
          intakeCm: dist(waist[ins.indices[2 * i]], waist[ins.indices[2 * i + 1]]),
          lengthCm: L,
        });
      });
    }
    const hemCentre = { x: 0, y: inp.length };
    const hem = hemCurve(hemSide, dir(hipPt, hemSide), hemCentre);
    const center: Path = [hemCentre, centreTop];
    return { waist, side, hem, center, darts, sideToHip: pathLength(upper), hipY: D };
  };
  return { front: build(front, true), back: build(back, false), sideSuppression: s };
}

/** Total hem circumference of a skirt made of a front-on-fold half and a back pair. */
export function skirtHemCircumference(front: SkirtHalf, back: SkirtHalf): number {
  return 2 * pathLength(front.hem) + 2 * pathLength(back.hem);
}

/**
 * A-line by slash-and-spread: close `closeFraction` of the dart nearest the
 * centre by rotating the side section about the dart point (opening the hem),
 * then swing the side seam below the hip outward by `extraAngle` radians.
 * Side seam length is preserved by both rotations.
 */
export function flareSkirtHalf(h: SkirtHalf, closeFraction: number, extraAngle: number): SkirtHalf {
  let waist = h.waist;
  let side = h.side;
  let darts = h.darts.map((d) => ({ ...d, legs: [d.legs[0], d.legs[1]] as [Point, Point] }));
  const centreHem = h.hem[h.hem.length - 1];

  if (darts.length > 0 && closeFraction > 0) {
    const d0 = darts[0];
    const theta = angleBetween(sub(d0.legs[1], d0.apex), sub(d0.legs[0], d0.apex)) * closeFraction;
    // split waist at the legs
    const iL = waist.findIndex((p) => dist(p, d0.legs[0]) < 1e-6);
    const iR = waist.findIndex((p) => dist(p, d0.legs[1]) < 1e-6);
    const left = waist.slice(0, iL + 1);
    const right = rotatePath(waist.slice(iR), theta, d0.apex);
    waist = closeFraction >= 0.999 ? [...left, ...right.slice(1)] : [...left, ...right];
    side = rotatePath(side, theta, d0.apex);
    const rest = darts.slice(1).map((d) => ({
      ...d,
      apex: rotate(d.apex, theta, d0.apex),
      legs: [rotate(d.legs[0], theta, d0.apex), rotate(d.legs[1], theta, d0.apex)] as [Point, Point],
    }));
    if (closeFraction >= 0.999) {
      darts = rest;
    } else {
      const newRight = rotate(d0.legs[1], theta, d0.apex);
      darts = [{ ...d0, legs: [d0.legs[0], newRight], intakeCm: dist(d0.legs[0], newRight) }, ...rest];
    }
  }

  // Extra flare: swing the straight part below the hip about the hip point.
  const hipIdx = side.length - 2; // side = [...upper curve, hemSide]
  const hipPt = side[hipIdx];
  let hemSide = side[side.length - 1];
  if (extraAngle !== 0) {
    const cand = rotate(hemSide, extraAngle, hipPt);
    const cand2 = rotate(hemSide, -extraAngle, hipPt);
    hemSide = cand.x > cand2.x ? cand : cand2;
    side = [...side.slice(0, -1), hemSide];
  }
  const hem = hemCurve(hemSide, dir(hipPt, hemSide), centreHem);
  return { ...h, waist, side, hem, darts };
}

/**
 * Find the dart-closing fraction and extra side flare that give the requested
 * total hem for a front-on-fold + back-pair skirt.
 */
export function flareToHem(front: SkirtHalf, back: SkirtHalf, targetHem: number): { front: SkirtHalf; back: SkirtHalf } {
  const hemFor = (c: number, a: number) => skirtHemCircumference(flareSkirtHalf(front, c, a), flareSkirtHalf(back, c, a));
  const base = hemFor(0, 0);
  if (targetHem <= base + 0.5) return { front, back };
  let c = 1;
  let a = 0;
  if (hemFor(1, 0) >= targetHem) {
    c = solveMonotone((x) => hemFor(x, 0), targetHem, 0, 1, 40);
    // avoid sliver darts: a dart under ~10 % of its intake is closed (or kept) entirely
    if (c > 0.9) c = 1;
    else if (c < 0.1) c = 0;
  } else {
    a = solveMonotone((x) => hemFor(1, x), targetHem, 0, 0.9, 40);
  }
  return { front: flareSkirtHalf(front, c, a), back: flareSkirtHalf(back, c, a) };
}
