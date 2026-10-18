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
  lineIntersection,
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
  /** Stretch knits: no darts, the whole waist suppression is taken at the side seams. */
  sideOnly?: boolean;
}

export interface SkirtHalf {
  /** Waist seam line, darts included (each dart span carries a dart cap). */
  waist: Path;
  /** Finished waist width of this half (waist length minus dart spans), cm. */
  waistFinished: number;
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

/** Smallest dart intake worth sewing (cm); less is moved to the side seam or the curve. */
export const MIN_DART_INTAKE = 1;

function planDarts(total: number, maxPerDart: number): DartPlan {
  if (total < MIN_DART_INTAKE) return { count: 0, intake: 0 };
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

/**
 * Waist seam from the centre (square to the centre line, so the waist runs
 * smoothly across the fold) to the side (square to the side seam, so front and
 * back meet without a peak). `k` scales both Bézier handles (1 = standard).
 */
function waistCurve(centre: Point, sideTop: Point, sideTangent: Point, k = 1): Path {
  const w = sideTop.x - centre.x;
  // arrive at the side perpendicular to the side seam
  let perp = { x: sideTangent.y, y: -sideTangent.x };
  if (perp.x < 0) perp = scale(perp, -1);
  const c1 = { x: centre.x + w * 0.45 * k, y: centre.y };
  const c2 = sub(sideTop, scale(normalize(perp), w * 0.3 * k));
  return cubicBezier(centre, c1, c2, sideTop);
}

/**
 * Trued waist of a given total length between fixed end points and end
 * directions: the Bézier handle lengths are solved so the curve is exactly
 * `target` long (clamped to what a smooth curve can reach).
 */
export function waistCurveOfLength(centre: Point, sideTop: Point, sideTangent: Point, target: number): Path {
  const lenAt = (k: number) => pathLength(waistCurve(centre, sideTop, sideTangent, k));
  const lo = 0.15;
  const hi = 2.2;
  const k = target <= lenAt(lo) ? lo : target >= lenAt(hi) ? hi : solveMonotone(lenAt, target, lo, hi, 30);
  return waistCurve(centre, sideTop, sideTangent, k);
}

export interface DartSpec {
  id: string;
  /** Arc length along the waist (from the centre) of the dart centre. */
  centre: number;
  intake: number;
  length: number;
  /** Unit direction from the waist into the piece, towards the dart point. */
  axis?: Point;
}

/**
 * Dart cap: the little peak on the seam line between the dart legs that,
 * once the dart is sewn and pressed towards `towards` (the leg the flap
 * lies against), makes the folded edge continue the seam line exactly.
 */
export function dartCap(apex: Point, legNear: Point, legFar: Point, towards: Point): Point | null {
  const u = normalize(sub(legNear, apex));
  const w = normalize(sub(towards, legNear));
  const wr = sub(scale(u, 2 * (w.x * u.x + w.y * u.y)), w); // w reflected across the stitch line
  const b = normalize(add(normalize(sub(legNear, apex)), normalize(sub(legFar, apex))));
  const c = lineIntersection(legNear, wr, apex, b);
  if (!c) return null;
  const mid = { x: (legNear.x + legFar.x) / 2, y: (legNear.y + legFar.y) / 2 };
  return dist(c, mid) <= dist(legNear, legFar) ? c : null;
}

/**
 * Insert darts into a waist path (centre -> side): legs at centre ± intake/2,
 * apex along `axis` (default: between the inward normal and straight down),
 * and a dart cap between the legs for darts pressed towards the centre.
 */
export function placeDarts(waist: Path, specs: DartSpec[]): { waist: Path; darts: Dart[] } {
  if (!specs.length) return { waist, darts: [] };
  const sorted = [...specs].sort((a, b) => a.centre - b.centre);
  const legLengths: number[] = [];
  sorted.forEach((d) => legLengths.push(d.centre - d.intake / 2, d.centre + d.intake / 2));
  const ins = insertAtLengths(waist, legLengths);
  const path = ins.path;
  const darts: Dart[] = [];
  const caps: Array<{ i0: number; i1: number; cap: Point | null }> = [];
  sorted.forEach((d, i) => {
    const i0 = ins.indices[2 * i];
    const i1 = ins.indices[2 * i + 1];
    const centrePt = pointAtLength(path, d.centre).point;
    const t = tangentAtLength(path, d.centre);
    const inward = scale(outwardNormal(t), -1);
    const axis = d.axis ?? normalize(add(scale(inward, 0.5), { x: 0, y: 0.5 }));
    const apex = add(centrePt, scale(axis, d.length));
    const legs: [Point, Point] = [path[i0], path[i1]];
    darts.push({ id: d.id, apex, legs, intakeCm: dist(legs[0], legs[1]), lengthCm: d.length });
    const towards = i0 > 0 ? path[i0 - 1] : { x: legs[0].x - 1, y: legs[0].y };
    caps.push({ i0, i1, cap: dartCap(apex, legs[0], legs[1], towards) });
  });
  // rebuild the path with [leg0, cap, leg1] across every dart span
  const out: Path = [];
  let k = 0;
  for (const c of caps) {
    while (k <= c.i0) out.push(path[k++]);
    if (c.cap) out.push(c.cap);
    k = c.i1;
  }
  while (k < path.length) out.push(path[k++]);
  return { waist: out, darts };
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
  if (inp.noDarts || inp.sideOnly || T <= 1.2) {
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
    if (df < MIN_DART_INTAKE) {
      s += df / 2;
      df = 0;
    }
    if (db < MIN_DART_INTAKE) {
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
    const finished = isFront ? inp.waistFront : inp.waistBack;
    let waist = waistCurve(centreTop, top, sideTan);
    const arc = pathLength(waist);
    // darts
    const n = g.dartPlan.count;
    let darts: Dart[] = [];
    if (n > 0) {
      const excess = arc - finished - n * g.dartPlan.intake;
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
      const placed = placeDarts(
        waist,
        centres.map((c, i) => ({ id: `${isFront ? 'front' : 'back'}-waist-dart-${i + 1}`, centre: c, intake, length: g.dartLen - i * (isFront ? 1.5 : 1) })),
      );
      waist = placed.waist;
      darts = placed.darts;
    }
    const hemCentre = { x: 0, y: inp.length };
    const hem = hemCurve(hemSide, dir(hipPt, hemSide), hemCentre);
    const center: Path = [hemCentre, centreTop];
    return { waist, waistFinished: n > 0 ? finished : arc, side, hem, center, darts, sideToHip: pathLength(upper), hipY: D };
  };
  return { front: build(front, true), back: build(back, false), sideSuppression: s };
}

/** Total hem circumference of a skirt made of a front-on-fold half and a back pair. */
export function skirtHemCircumference(front: SkirtHalf, back: SkirtHalf): number {
  return 2 * pathLength(front.hem) + 2 * pathLength(back.hem);
}

/** Path length between two points that lie on a path (the dart span). */
function spanLength(p: Path, a: Point, b: Point): number {
  const ia = p.findIndex((q) => dist(q, a) < 1e-6);
  const ib = p.findIndex((q) => dist(q, b) < 1e-6);
  if (ia < 0 || ib < 0) return dist(a, b);
  return pathLength(p.slice(Math.min(ia, ib), Math.max(ia, ib) + 1));
}

/** Arc length along a path to the vertex closest to q. */
function arcTo(p: Path, q: Point): number {
  let best = 0;
  let bd = Infinity;
  let acc = 0;
  for (let i = 0; i < p.length; i++) {
    if (i > 0) acc += dist(p[i - 1], p[i]);
    const d = dist(p[i], q);
    if (d < bd) {
      bd = d;
      best = acc;
    }
  }
  return best;
}

/**
 * A-line by slash-and-spread: close `closeFraction` of the dart nearest the
 * centre by rotating the side section about the dart point (opening the hem),
 * then swing the side seam below the hip by `extraAngle` radians (positive =
 * outwards, negative = inwards).
 *
 * After the rotation the waist is TRUED: it is redrawn as one smooth curve
 * from the centre (square to the fold) to the side (square to the side seam)
 * at the same finished length, the remaining darts are re-placed on it with
 * dart caps, and darts that would be slivers (< 1 cm) are dropped into the
 * curve. Below the hip the side seam continues the hip curve tangentially, so
 * there is no corner at the hip notch. Both rotations and the side curve are
 * rigid / intrinsic, so front and back side seams keep equal lengths.
 */
export function flareSkirtHalf(h: SkirtHalf, closeFraction: number, extraAngle: number, opts: { hemOnly?: boolean } = {}): SkirtHalf {
  let side = h.side;
  let darts = h.darts.map((d) => ({ ...d, legs: [d.legs[0], d.legs[1]] as [Point, Point] }));
  const centreHem = h.hem[h.hem.length - 1];
  const centreTop = h.waist[0];
  const oldArc = pathLength(h.waist);
  let rotatedSideTop = h.waist[h.waist.length - 1];
  let changedWaist = false;

  if (darts.length > 0 && closeFraction > 0) {
    const d0 = darts[0];
    const theta = angleBetween(sub(d0.legs[1], d0.apex), sub(d0.legs[0], d0.apex)) * closeFraction;
    side = rotatePath(side, theta, d0.apex);
    rotatedSideTop = rotate(rotatedSideTop, theta, d0.apex);
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
    changedWaist = true;
  }

  let waist = h.waist;
  let outDarts: Dart[] = h.darts;
  if (changedWaist && !opts.hemOnly) {
    // remaining darts: keep their relative position and direction, drop slivers
    const kept = darts.filter((d) => d.intakeCm >= MIN_DART_INTAKE - 1e-9);
    const keptIntake = kept.reduce((a, d) => a + d.intakeCm, 0);
    const sideTan = dir(side[0], side[Math.min(side.length - 1, 3)]);
    const trued = waistCurveOfLength(centreTop, rotatedSideTop, sideTan, h.waistFinished + keptIntake);
    const newArc = pathLength(trued);
    const specs: DartSpec[] = kept.map((d) => {
      const mid = { x: (d.legs[0].x + d.legs[1].x) / 2, y: (d.legs[0].y + d.legs[1].y) / 2 };
      const oldCentre = d === darts[0] && closeFraction < 0.999 ? arcTo(h.waist, h.darts[0].legs[0]) + d.intakeCm / 2 : arcTo(h.waist, mid);
      return {
        id: d.id,
        centre: (oldCentre / Math.max(1e-6, oldArc)) * newArc,
        intake: d.intakeCm,
        length: d.lengthCm,
        axis: normalize(sub(d.apex, mid)),
      };
    });
    const placed = placeDarts(trued, specs);
    waist = placed.waist;
    outDarts = placed.darts;
  }

  // Extra flare below the hip: a curve leaving the hip along the hip curve's
  // tangent and arriving at the swung hem point.
  const hipIdx = side.length - 2; // side = [...upper curve, hemSide]
  const hipPt = side[hipIdx];
  let hemSide = side[side.length - 1];
  let hemDir = dir(hipPt, hemSide);
  if (Math.abs(extraAngle) > 1e-9) {
    const cand = rotate(hemSide, extraAngle, hipPt);
    const cand2 = rotate(hemSide, -extraAngle, hipPt);
    const outward = cand.x > cand2.x ? cand : cand2;
    const inward = cand.x > cand2.x ? cand2 : cand;
    hemSide = extraAngle > 0 ? outward : inward;
    const upper = side.slice(0, hipIdx + 1);
    const tHip = dir(upper[Math.max(0, upper.length - 4)], hipPt);
    const drop = dist(hipPt, hemSide);
    hemDir = dir(hipPt, hemSide);
    const c1 = add(hipPt, scale(tHip, 0.4 * drop));
    const c2 = sub(hemSide, scale(hemDir, 0.3 * drop));
    const lower = cubicBezier(hipPt, c1, c2, hemSide);
    hemDir = dir(lower[Math.max(0, lower.length - 3)], hemSide);
    side = [...upper, ...lower.slice(1)];
  }
  const hem = hemCurve(hemSide, hemDir, centreHem);
  const waistFinished = pathLength(waist) - outDarts.reduce((a, d) => a + spanLength(waist, d.legs[0], d.legs[1]), 0);
  return { ...h, waist, waistFinished, side, hem, darts: outDarts };
}

/**
 * Find the dart-closing fraction and extra side flare that give the requested
 * total hem for a front-on-fold + back-pair skirt. Partial closures that
 * would leave a sliver dart (< 1 cm) close it completely instead, and the
 * side seam then swings in slightly to keep the planned hem.
 */
export function flareToHem(front: SkirtHalf, back: SkirtHalf, targetHem: number): { front: SkirtHalf; back: SkirtHalf } {
  // the hem does not depend on the trued waist, so the solver skips truing
  const hemOnly = { hemOnly: true };
  const hemFor = (c: number, a: number) => skirtHemCircumference(flareSkirtHalf(front, c, a, hemOnly), flareSkirtHalf(back, c, a, hemOnly));
  const base = hemFor(0, 0);
  if (targetHem <= base + 0.5) return { front, back };
  const smallestFirstDart = Math.min(front.darts[0]?.intakeCm ?? Infinity, back.darts[0]?.intakeCm ?? Infinity);
  let c = 1;
  let a = 0;
  if (Number.isFinite(smallestFirstDart) && hemFor(1, 0) >= targetHem) {
    c = solveMonotone((x) => hemFor(x, 0), targetHem, 0, 1, 40);
    const leftover = (1 - c) * smallestFirstDart;
    if (leftover < MIN_DART_INTAKE) {
      // close the dart fully, then bring the side seam in a little
      c = 1;
      const over = hemFor(1, 0) - targetHem;
      if (over > 0.5) a = solveMonotone((x) => hemFor(1, x), targetHem, -0.35, 0, 40);
    } else if (c * smallestFirstDart < 0.5) {
      // barely any closing: keep the darts whole and flare at the side instead
      c = 0;
      a = solveMonotone((x) => hemFor(0, x), targetHem, 0, 0.9, 40);
    }
  } else {
    c = Number.isFinite(smallestFirstDart) ? 1 : 0;
    a = solveMonotone((x) => hemFor(c, x), targetHem, 0, 0.9, 40);
  }
  return { front: flareSkirtHalf(front, c, a), back: flareSkirtHalf(back, c, a) };
}
