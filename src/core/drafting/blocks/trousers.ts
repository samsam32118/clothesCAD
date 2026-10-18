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
}

export interface TrouserHalf {
  waist: Path;
  crotch: Path; // front: CF waist -> crotch point; back: crotch point -> CB waist
  inseam: Path; // front: crotch -> hem; back: hem -> crotch
  hem: Path;
  side: Path; // front: hem -> waist; back: waist -> hem
  darts: Dart[];
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
  let dartF = inp.noDarts ? 0 : clamp(0.4 * excessF, 0, 2.5);
  if (dartF < 0.8) dartF = 0;
  const sideWaistF = { x: excessF - dartF, y: 0 };
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
  const fd = placeDarts(frontWaist, dartF > 0 ? [Math.max(dartF, creaseF - sideWaistF.x)] : [], dartF, clamp(0.45 * D, 7, 10), 'front');
  frontWaist = fd.waist;
  const frontSideLen = pathLength(frontSide);
  const frontInseamLen = pathLength(frontInseam);

  // -------------------------------------------------------------- back
  const finB = inp.waistF / 4 - 0.5;
  const cbIn = inp.fit === 'relaxed' ? 2 : 2.75;
  const cbRaise = inp.fit === 'relaxed' ? 2 : 2.75;
  const cbWaist = { x: cbIn, y: -cbRaise };
  const excessB = hb - cbIn - finB;
  let dartsB = inp.noDarts ? 0 : clamp(0.55 * excessB, 0, 5);
  if (dartsB < 0.8) dartsB = 0;
  const nB = dartsB > 2.6 ? 2 : dartsB > 0 ? 1 : 0;
  const sideB = excessB - dartsB;
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
    return dedupe([...[...curve].reverse(), cbWaist]); // crotch point -> CB waist
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

  const front: TrouserHalf = { waist: frontWaist, crotch: frontCrotch, inseam: frontInseam, hem: frontHem, side: frontSide, darts: fd.darts };
  const back: TrouserHalf = { waist: backWaist, crotch: backCrotch, inseam: backInseam, hem: backHem, side: backSide, darts: bd.darts };

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
