/**
 * Continuous body model: circumference of the torso (and of both legs taken
 * together, as a skirt sees them) at any height from the floor, plus single-leg
 * circumference for trousers. Used by the fit planner (hem placement, walking
 * ease) and by the silhouette builder (clipping checks for 3D).
 */
import type { BodyLandmarks, ResolvedMeasurements } from '../types';
import { hpsHeight } from '../measurements';

interface Knot {
  h: number;
  c: number;
  depth: number;
}

/** Convex hull perimeter of two touching circles of circumference c: c * (1 + 2/π). */
export const TWO_LEG_HULL = 1 + 2 / Math.PI;

function interp(knots: Knot[], h: number, key: 'c' | 'depth'): number {
  // knots sorted by descending height
  if (h >= knots[0].h) return knots[0][key];
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1];
    const b = knots[i];
    if (h >= b.h) {
      const t = (a.h - h) / Math.max(1e-6, a.h - b.h);
      return a[key] + (b[key] - a[key]) * t;
    }
  }
  return knots[knots.length - 1][key];
}

function uniqueDesc(knots: Knot[]): Knot[] {
  const sorted = [...knots].sort((a, b) => b.h - a.h);
  const out: Knot[] = [];
  for (const k of sorted) {
    if (out.length && out[out.length - 1].h - k.h < 0.5) continue;
    out.push(k);
  }
  return out;
}

export interface BodyProfile {
  /** Torso circumference above the crotch; both legs' convex hull below it (skirt view). */
  torsoAt(h: number): number;
  /** Front-back depth / width ratio of the torso (or two-leg hull) cross-section. */
  torsoDepthAt(h: number): number;
  /** One leg's circumference (below crotch). */
  legAt(h: number): number;
  hps: number;
  chest: number; // underarm level height
  landmarks: BodyLandmarks;
}

export function bodyProfile(r: ResolvedMeasurements, L: BodyLandmarks): BodyProfile {
  const hps = hpsHeight(r);
  const chest = L.bust + 0.35 * (L.shoulder - L.bust);
  const legKnots: Knot[] = uniqueDesc([
    { h: L.crotch, c: r.thighCm, depth: 0.95 },
    { h: L.crotch - 0.45 * (L.crotch - L.knee), c: r.thighCm - 0.55 * (r.thighCm - r.kneeCm), depth: 0.95 },
    { h: L.knee, c: r.kneeCm, depth: 0.95 },
    { h: L.calf, c: r.calfCm, depth: 0.95 },
    { h: L.ankle, c: r.ankleCm, depth: 0.95 },
    { h: 0, c: r.ankleCm * 1.05, depth: 0.95 },
  ]);
  const legAt = (h: number) => interp(legKnots, Math.min(h, L.crotch), 'c');
  const crotchHull = Math.min(r.hipCm * 0.98, Math.max(TWO_LEG_HULL * r.thighCm, 0.9 * r.hipCm));
  const torsoKnots: Knot[] = uniqueDesc([
    { h: hps, c: r.neckCm, depth: 0.85 },
    { h: L.shoulder, c: Math.max(r.neckCm + 10, 0.9 * r.bustCm), depth: 0.6 },
    { h: chest, c: 0.97 * r.bustCm, depth: 0.68 },
    { h: L.bust, c: r.bustCm, depth: 0.72 },
    { h: L.underbust, c: r.underbustCm, depth: 0.74 },
    { h: L.waist, c: r.waistCm, depth: 0.76 },
    { h: L.highHip, c: r.highHipCm, depth: 0.74 },
    { h: L.hip, c: r.hipCm, depth: 0.72 },
    { h: L.crotch, c: crotchHull, depth: 0.62 },
  ]);
  const hullBelow = (h: number) => TWO_LEG_HULL * legAt(h);
  const torsoAt = (h: number): number => {
    if (h >= L.crotch) return interp(torsoKnots, h, 'c');
    // blend from crotch hull to the pure two-leg hull over 4 cm
    const t = Math.min(1, (L.crotch - h) / 4);
    return crotchHull * (1 - t) + hullBelow(h) * t;
  };
  const torsoDepthAt = (h: number): number => (h >= L.crotch ? interp(torsoKnots, h, 'depth') : 0.55);
  return { torsoAt, torsoDepthAt, legAt, hps, chest, landmarks: L };
}
