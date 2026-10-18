/**
 * Trouser block (Aldrich-style women's trouser).
 *
 * Front frame: waist at y = 0, side seam near x = 0, centre front at
 * x ≈ hip/4. Back frame: centre back on the left, side on the right.
 * - Body rise + fit ease gives the crotch line; the hip line sits at the
 *   measured waist-to-hip depth.
 * - Crotch extensions: front ≈ hip/16, back ≈ hip/8 − 2.5 cm (enlarged if the
 *   thigh needs more room).
 * - The back seat seam is angled (centre back raised and moved in) for the
 *   seat; the back crotch point is dropped until front and back inseams have
 *   equal length; the back side-waist height is solved so side seams match.
 * - Legs hang from crease lines centred on each panel; knee and hem widths are
 *   split front −1 cm / back +1 cm.
 * - Waist suppression (hip − waist) is shared so that no side seam swings in
 *   more than SIDE_SUPPRESSION_MAX (front 3 cm, back 3.5 cm): a deeper side
 *   curve turns the hip into a jodhpur bulge and makes an in-seam pocket gape.
 *   The rest goes into two front pleats (or darts) and two back darts.
 * - A prominent seat gets a steeper, higher centre-back seat seam (about
 *   10–12°, 3.5 cm in and up) so the back does not pull down when sitting.
 */
import type { Dart, FitPreference, Path, Point } from '../../types';
import {
  add,
  clamp,
  cubicBezier,
  dir,
  dist,
  insertAtLengths,
  normalize,
  pathLength,
  pointAtLength,
  scale,
  solveMonotone,
  splineThrough,
  sub,
  tangentAtLength,
  outwardNormal,
  dedupe,
} from '../../geometry';

export interface TrouserInput {
  waistF: number;
  hipF: number;
  thighF: number;
  kneeLeg: number; // finished leg circumference at the knee
  hemLeg: number; // finished leg opening
  rise: number; // body rise + ease
  hipDepth: number;
  waistToKnee: number;
  inseam: number; // crotch level to hem
  fit: FitPreference;
  noDarts?: boolean; // elastic waist
  /** Front waist intake as pleats (classic wide legs) instead of darts. */
  frontPleats?: boolean;
  /** Full / prominent seat: steeper, higher centre-back seat seam. */
  prominentSeat?: boolean;
}

/** Most a trouser side seam may be taken in from hip to waist, per panel (cm). */
export const SIDE_SUPPRESSION_MAX = { front: 3, back: 3.5 } as const;
/** Most intake per front dart / per front pleat / per back dart (cm). */
export const INTAKE_MAX = { frontDart: 2.5, frontPleat: 3.5, backDart: 3 } as const;
/** Smallest intake worth sewing as a dart or pleat (cm). */
const MIN_INTAKE = 1;

/** A pleat folded at the waist and released below it; `at` is the arc length from the side along the waist. */
export interface Pleat {
  id: string;
  at: number;
  intakeCm: number;
}

export interface TrouserHalf {
  waist: Path;
  crotch: Path; // front: CF waist -> crotch point; back: crotch point -> CB waist
  inseam: Path; // front: crotch -> hem; back: hem -> crotch
  hem: Path;
  side: Path; // front: hem -> waist; back: waist -> hem
  darts: Dart[];
  /** Front only: waist pleats (the waist edge includes their intake). */
  pleats: Pleat[];
  /** Back only: straight seat seam from the hip line up to the CB waist (gets a let-out allowance). */
  seat?: Path;
}

export interface TrouserBlock {
  front: TrouserHalf;
  back: TrouserHalf;
  crotchLevel: number;
  hemY: number;
  /** Leg circumference at a given y (pattern y, below crotch level). */
  legCircAt(y: number): number;
  /** Side-seam arc length from the waist to the hip line (front). */
  sideWaistToHip: number;
}

function legPath(top: Point, knee: Point, hem: Point): Path {
  const d = sub(knee, top);
  const c1 = add(top, { x: 0.15 * d.x, y: 0.35 * d.y });
  const c2 = sub(knee, scale(dir(knee, hem), 0.3 * Math.hypot(d.x, d.y)));
  const upper = cubicBezier(top, c1, c2, knee);
  return [...upper, hem];
}

/**
 * Split a waist intake into n equal folds (1 or 2) of at most `max` each;
 * returns the intake per fold (0 if under MIN_INTAKE) and the count.
 */
function splitIntake(intake: number, max: number): { n: number; each: number } {
  if (intake < MIN_INTAKE) return { n: 0, each: 0 };
  const n = intake > max ? 2 : 1;
  return { n, each: Math.min(max, intake / n) };
}

/**
 * Share a panel's waist excess between its side seam (at most `sideMax`,
 * ideally about half) and up to two folds of at most `foldMax` each. Whatever
 * the folds cannot take falls back to the side seam.
 */
function shareSuppression(excess: number, sideMax: number, foldMax: number): { side: number; folds: { n: number; each: number } } {
  if (excess <= 0) return { side: excess, folds: { n: 0, each: 0 } };
  const wanted = excess - Math.min(sideMax, 0.5 * excess);
  const folds = splitIntake(Math.min(wanted, 2 * foldMax), foldMax);
  return { side: excess - folds.n * folds.each, folds };
}

function placeDarts(waist: Path, centres: number[], intake: number, length: number, prefix: string): { waist: Path; darts: Dart[] } {
  if (centres.length === 0 || intake <= 0) return { waist, darts: [] };
  const legs: number[] = [];
  centres.forEach((c) => legs.push(c - intake / 2, c + intake / 2));
  const ins = insertAtLengths(waist, legs);
  const w = ins.path;
  const darts: Dart[] = centres.map((c, i) => {
    const p = pointAtLength(w, c).point;
    const t = tangentAtLength(w, c);
    const inward = scale(outwardNormal(t), -1);
    const axis = normalize(add(scale(inward, 0.4), { x: 0, y: 0.6 }));
    const L = length - i;
    const l0 = w[ins.indices[2 * i]];
    const l1 = w[ins.indices[2 * i + 1]];
    return { id: `${prefix}-dart-${i + 1}`, apex: add(p, scale(axis, L)), legs: [l0, l1], intakeCm: dist(l0, l1), lengthCm: L };
  });
  return { waist: w, darts };
}

export function draftTrousers(inp: TrouserInput): TrouserBlock {
  const rise = inp.rise;
  const D = Math.min(inp.hipDepth, rise - 4);
  const hf = inp.hipF / 4 - 0.5;
  const hb = inp.hipF / 4 + 0.5;
  let extF = inp.hipF / 16;
  let extB = inp.hipF / 8 - 2.5 + (inp.fit === 'relaxed' ? 1 : 0);
  const legAtCrotch = inp.hipF / 2 + extF + extB;
  if (legAtCrotch < inp.thighF + 2) {
    const k = (inp.thighF + 2 - inp.hipF / 2) / (extF + extB);
    extF *= k;
    extB *= k;
  }
  const yKnee = Math.max(rise + 8, inp.waistToKnee);
  const yHem = rise + inp.inseam;
  const kneeLeg = Math.max(inp.kneeLeg, inp.hemLeg * 0.9);

  // ------------------------------------------------------------- front
  const finF = inp.waistF / 4 + 0.5;
  const cfWaist = { x: hf - 1, y: 0 };
  const excessF = cfWaist.x - finF;
  const shareF = inp.noDarts
    ? { side: excessF, folds: { n: 0, each: 0 } }
    : shareSuppression(excessF, SIDE_SUPPRESSION_MAX.front, inp.frontPleats ? INTAKE_MAX.frontPleat : INTAKE_MAX.frontDart);
  const sideWaistF = { x: shareF.side, y: 0 };
  const hipSideF = { x: 0, y: D };
  const crotchF = { x: hf + extF, y: rise };
  const creaseF = (hf + extF) / 2;
  const kneeInF = { x: creaseF + kneeLeg / 4 - 0.5, y: yKnee };
  const kneeOutF = { x: creaseF - (kneeLeg / 4 - 0.5), y: yKnee };
  const hemInF = { x: creaseF + inp.hemLeg / 4 - 0.5, y: yHem };
  const hemOutF = { x: creaseF - (inp.hemLeg / 4 - 0.5), y: yHem };
  const frontCrotch = dedupe([
    cfWaist,
    ...cubicBezier({ x: hf, y: D }, { x: hf, y: D + 0.6 * (rise - D) }, { x: hf + 0.45 * extF, y: rise }, crotchF),
  ]);
  const frontInseam = legPath(crotchF, kneeInF, hemInF);
  const frontHem: Path = [hemInF, hemOutF];
  const sideLowerF = splineThrough([hemOutF, kneeOutF, { x: 0.3, y: rise }, hipSideF], { endTangent: { x: 0, y: -1 } });
  const hipCurveF = cubicBezier(hipSideF, { x: 0, y: D * 0.55 }, { x: sideWaistF.x * 0.6, y: D * 0.2 }, sideWaistF);
  const frontSide = dedupe([...sideLowerF, ...hipCurveF.slice(1)]);
  let frontWaist: Path = [sideWaistF, cfWaist];
  const waistLenF = dist(sideWaistF, cfWaist);
  const nF = shareF.folds.n;
  const eachF = shareF.folds.each;
  // First fold on the crease line; the second towards the side (a pleat 4 cm
  // away, a dart 3.5 cm), kept clear of the side seam and the fly.
  const creaseAt = clamp(creaseF - sideWaistF.x, 2.5 + eachF * 1.5, waistLenF - 4 - eachF / 2);
  const centresF = nF === 2 ? [Math.max(2 + eachF / 2, creaseAt - (inp.frontPleats ? 4 : 3.5)), creaseAt] : nF === 1 ? [creaseAt] : [];
  let fd: { waist: Path; darts: Dart[] } = { waist: frontWaist, darts: [] };
  const pleats: Pleat[] = [];
  if (inp.frontPleats) {
    centresF.forEach((c, i) => pleats.push({ id: `front-pleat-${i + 1}`, at: c, intakeCm: eachF }));
  } else {
    fd = placeDarts(frontWaist, centresF, eachF, clamp(0.45 * D, 7, 10), 'front');
  }
  frontWaist = fd.waist;
  const frontSideLen = pathLength(frontSide);
  const frontInseamLen = pathLength(frontInseam);

  // -------------------------------------------------------------- back
  const finB = inp.waistF / 4 - 0.5;
  const seatExtra = inp.prominentSeat ? 1 : 0;
  const cbIn = (inp.fit === 'relaxed' ? 2.5 : 2.75) + seatExtra;
  const cbRaise = (inp.fit === 'relaxed' ? 2.5 : 2.75) + seatExtra;
  const cbWaist = { x: cbIn, y: -cbRaise };
  const excessB = hb - cbIn - finB;
  const shareB = inp.noDarts ? { side: excessB, folds: { n: 0, each: 0 } } : shareSuppression(excessB, SIDE_SUPPRESSION_MAX.back, INTAKE_MAX.backDart);
  const nB = shareB.folds.n;
  const dartsB = nB * shareB.folds.each;
  const sideB = shareB.side;
  const creaseB = (hb - extB) / 2;
  const kneeInB = { x: creaseB - (kneeLeg / 4 + 0.5), y: yKnee };
  const kneeOutB = { x: creaseB + kneeLeg / 4 + 0.5, y: yKnee };
  const hemInB = { x: creaseB - (inp.hemLeg / 4 + 0.5), y: yHem };
  const hemOutB = { x: creaseB + inp.hemLeg / 4 + 0.5, y: yHem };
  const seatDir = dir(cbWaist, { x: 0, y: D });

  const buildBackCrotch = (drop: number): Path => {
    const cp = { x: -extB, y: rise + drop };
    const start = { x: 0, y: D };
    const c1 = add(start, scale(seatDir, 0.55 * (rise - D)));
    const c2 = { x: cp.x + 0.45 * extB, y: cp.y };
    const curve = cubicBezier(start, c1, c2, cp);
    return dedupe([...curve].reverse()); // crotch point -> hip line at CB
  };
  const inseamFor = (drop: number) => legPath({ x: -extB, y: rise + drop }, kneeInB, hemInB);
  const drop = solveMonotone((d) => -pathLength(inseamFor(d)), -frontInseamLen, -1.5, 4);
  const backCrotch = buildBackCrotch(drop);
  const backInseam = [...inseamFor(drop)].reverse(); // hem -> crotch

  const sideFor = (ySide: number): Path => {
    const sw = { x: hb - sideB, y: ySide };
    const hip = { x: hb, y: D };
    const hipCurve = cubicBezier(sw, { x: sw.x + 0.4 * (hip.x - sw.x), y: sw.y + 0.25 * (D - sw.y) }, { x: hb, y: D * 0.55 }, hip);
    const lower = splineThrough([hip, { x: hb - 0.3, y: rise }, kneeOutB, hemOutB], { startTangent: { x: 0, y: 1 } });
    return dedupe([...hipCurve, ...lower.slice(1)]);
  };
  const ySide = solveMonotone((y) => -pathLength(sideFor(y)), -frontSideLen, -3, 3);
  const backSide = sideFor(ySide);
  let backWaist: Path = cubicBezier(cbWaist, add(cbWaist, scale({ x: -seatDir.y, y: seatDir.x }, -(hb - sideB - cbIn) * 0.35)), { x: hb - sideB - 3, y: ySide }, backSide[0]);
  // ensure the waist leaves the CB at a right angle to the seat seam
  const bw = pathLength(backWaist);
  const centresB = nB === 2 ? [0.36 * bw, 0.68 * bw] : nB === 1 ? [0.5 * bw] : [];
  const bd = placeDarts(backWaist, centresB, nB > 0 ? dartsB / nB : 0, clamp(0.65 * D, 11, 14), 'back');
  backWaist = bd.waist;
  const backHem: Path = [hemOutB, hemInB];

  const front: TrouserHalf = { waist: frontWaist, crotch: frontCrotch, inseam: frontInseam, hem: frontHem, side: frontSide, darts: fd.darts, pleats };
  const back: TrouserHalf = {
    waist: backWaist,
    crotch: backCrotch,
    seat: [{ x: 0, y: D }, cbWaist],
    inseam: backInseam,
    hem: backHem,
    side: backSide,
    darts: bd.darts,
    pleats: [],
  };

  const widthAt = (p1: Path, p2: Path, y: number) => {
    const x = (p: Path) => {
      for (let i = 1; i < p.length; i++) {
        const a = p[i - 1];
        const b = p[i];
        if ((a.y - y) * (b.y - y) <= 0 && a.y !== b.y) return a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
      }
      return NaN;
    };
    return Math.abs(x(p1) - x(p2));
  };
  const legCircAt = (y: number) => {
    const yy = clamp(y, rise + Math.max(0.5, drop + 0.5), yHem);
    const wf = widthAt(frontInseam, frontSide, yy);
    const wb = widthAt(backInseam, backSide, yy);
    return (Number.isFinite(wf) ? wf : 0) + (Number.isFinite(wb) ? wb : 0);
  };
  return {
    front,
    back,
    crotchLevel: rise,
    hemY: yHem,
    legCircAt,
    sideWaistToHip: pathLength(hipCurveF),
  };
}
