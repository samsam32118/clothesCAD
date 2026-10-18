/**
 * Set-in sleeve block.
 *
 * The cap is an S-curve (concave at the underarm, convex over the shoulder)
 * whose height is solved so the cap length equals the armhole length plus the
 * planned cap ease (2–4 cm for wovens, ~0 for knits). The cap is split into
 * edges matching each armhole edge it is sewn to (front and back, or the
 * front/back princess panels), with the ease placed only in the upper
 * sections between the notches. Underarm seams have equal length.
 *
 * Frame: cap top near (0, 0), bicep line at y = capHeight, front on the left
 * (x < 0), back on the right, hem at y = sleeve length.
 */
import type { Path, Point } from '../../types';
import { cubicBezier, pathLength, solveMonotone, splitAtLength } from '../../geometry';

export interface ArmholeSegment {
  /** Edge id the cap section will get, e.g. 'cap-front'. */
  capEdgeId: string;
  /** The armhole edge it joins. */
  pieceId: string;
  edgeId: string;
  length: number;
  /** Upper sections receive cap ease; underarm sections do not. */
  upper: boolean;
  side: 'front' | 'back';
}

export interface SleeveInput {
  /** Ordered from the front underarm, over the cap, to the back underarm. */
  segments: ArmholeSegment[];
  upperArmF: number;
  capEase: number;
  /** Average vertical armhole depth (shoulder point to chest line), cm. */
  armholeDepth: number;
  /** Cap top to hem. */
  length: number;
  hemCirc: number;
  /** Distance from cap top to the elbow (for a notch on long sleeves). */
  elbowFromTop?: number;
}

export interface SleeveDraft {
  capSections: Array<{ id: string; points: Path; ease: number; segment: ArmholeSegment }>;
  underarmBack: Path;
  hem: Path;
  underarmFront: Path;
  capHeight: number;
  capLength: number;
  totalEase: number;
  /** Notches: on cap sections at the matching armhole distances. */
  notches: Array<{ edgeId: string; at: number; fromEnd?: boolean; count: 1 | 2; label?: string }>;
  widthAtBicep: number;
}

function capCurves(wf: number, wb: number, h: number): { front: Path; back: Path } {
  const F: Point = { x: -wf, y: h };
  const B: Point = { x: wb, y: h };
  const T: Point = { x: 0, y: 0 };
  const front = cubicBezier(F, { x: -wf + 0.5 * wf, y: h - 0.15 * h }, { x: -0.45 * wf, y: 0 }, T);
  const back = cubicBezier(T, { x: 0.5 * wb, y: 0 }, { x: wb - 0.45 * wb, y: h - 0.12 * h }, B);
  return { front, back };
}

export function draftSleeve(inp: SleeveInput): SleeveDraft {
  const armTotal = inp.segments.reduce((a, s) => a + s.length, 0);
  const target = armTotal + inp.capEase;
  let wf = inp.upperArmF / 2 - 0.6;
  let wb = inp.upperArmF / 2 + 0.6;
  const capLen = (h: number, k = 1) => {
    const c = capCurves(wf * k, wb * k, h);
    return pathLength(c.front) + pathLength(c.back);
  };
  const lo = 0.3 * inp.armholeDepth;
  const hi = 0.95 * inp.armholeDepth;
  let h: number;
  if (capLen(hi) < target) {
    h = hi;
    const k = solveMonotone((x) => capLen(h, x), target, 1, 1.8);
    wf *= k;
    wb *= k;
  } else if (capLen(lo) > target) {
    h = lo;
    const k = solveMonotone((x) => capLen(h, x), target, 0.6, 1);
    wf *= k;
    wb *= k;
  } else {
    h = solveMonotone((x) => capLen(x), target, lo, hi);
  }
  const { front, back } = capCurves(wf, wb, h);
  const cap: Path = [...front, ...back.slice(1)];
  const capLength = pathLength(cap);

  // distribute the ease over upper sections, weighted by length, front 45 % / back 55 %
  const ease = capLength - armTotal;
  const fronts = inp.segments.filter((s) => s.side === 'front' && s.upper);
  const backs = inp.segments.filter((s) => s.side === 'back' && s.upper);
  const share = (s: ArmholeSegment) => {
    const group = s.side === 'front' ? fronts : backs;
    const otherEmpty = (s.side === 'front' ? backs : fronts).length === 0;
    const gShare = otherEmpty ? 1 : s.side === 'front' ? 0.45 : 0.55;
    const glen = group.reduce((a, x) => a + x.length, 0);
    return s.upper && glen > 0 ? (ease * gShare * s.length) / glen : 0;
  };
  const anyUpper = fronts.length + backs.length > 0;
  const sections: SleeveDraft['capSections'] = [];
  let rest = cap;
  inp.segments.forEach((seg, i) => {
    const e = anyUpper ? share(seg) : (ease * seg.length) / armTotal;
    const l = seg.length + e;
    if (i === inp.segments.length - 1) {
      sections.push({ id: seg.capEdgeId, points: rest, ease: pathLength(rest) - seg.length, segment: seg });
    } else {
      const [a, b] = splitAtLength(rest, l);
      sections.push({ id: seg.capEdgeId, points: a, ease: e, segment: seg });
      rest = b;
    }
  });

  const len = Math.max(inp.length, h + 2.5);
  const delta = Math.max(0, (wf + wb - inp.hemCirc) / 2);
  const F = cap[0];
  const B = cap[cap.length - 1];
  const hb = { x: wb - delta, y: len };
  const hf = { x: -wf + delta, y: len };
  const notches: SleeveDraft['notches'] = [];
  // shoulder notch at the front/back boundary
  const lastFront = [...sections].reverse().find((s) => s.segment.side === 'front');
  if (lastFront) notches.push({ edgeId: lastFront.id, at: 0, fromEnd: true, count: 1, label: 'shoulder' });
  // balance notches: front single, back double at 35 % of the first section from each underarm
  const firstFront = sections.find((s) => s.segment.side === 'front');
  const lastBack = [...sections].reverse().find((s) => s.segment.side === 'back');
  if (firstFront && firstFront.segment.upper) notches.push({ edgeId: firstFront.id, at: 0.35 * firstFront.segment.length, count: 1, label: 'front' });
  if (lastBack && lastBack.segment.upper) notches.push({ edgeId: lastBack.id, at: 0.35 * lastBack.segment.length, fromEnd: true, count: 2, label: 'back' });
  if (inp.elbowFromTop && inp.elbowFromTop < len - 2 && inp.elbowFromTop > h + 2) {
    notches.push({ edgeId: 'underarm-back', at: inp.elbowFromTop - h, count: 1, label: 'elbow' });
  }
  return {
    capSections: sections,
    underarmBack: [B, hb],
    hem: [hb, hf],
    underarmFront: [hf, F],
    capHeight: h,
    capLength,
    totalEase: ease,
    notches,
    widthAtBicep: wf + wb,
  };
}
