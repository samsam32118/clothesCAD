/**
 * Silhouette rings for the 3D renderer: the finished garment's circumference
 * at heights from the top edge down to the hem (every ~2.5 cm, plus every
 * body landmark), with the body circumference at the same height. A garment
 * can never be inside the body: wovens keep ≥ 1 cm clearance, knits with
 * negative ease are worn stretched to the body (+0.5 cm).
 */
import type { Neckline, ResolvedMeasurements, Silhouette, SilhouetteRing, BodyLandmarks } from '../types';
import { bodyProfile } from '../fit/profile';

export interface Knot {
  h: number;
  c: number;
}

function interp(knots: Knot[], h: number): number {
  const k = [...knots].sort((a, b) => b.h - a.h);
  if (h >= k[0].h) return k[0].c;
  for (let i = 1; i < k.length; i++) {
    if (h >= k[i].h) {
      const t = (k[i - 1].h - h) / Math.max(1e-6, k[i - 1].h - k[i].h);
      return k[i - 1].c + (k[i].c - k[i - 1].c) * t;
    }
  }
  return k[k.length - 1].c;
}

function heights(top: number, bottom: number, L: BodyLandmarks, step = 2.5): number[] {
  const hs = new Set<number>();
  const n = Math.max(1, Math.ceil((top - bottom) / step));
  for (let i = 0; i <= n; i++) hs.add(Math.round((top - ((top - bottom) * i) / n) * 100) / 100);
  for (const v of Object.values(L)) if (v < top - 0.5 && v > bottom + 0.5) hs.add(Math.round(v * 100) / 100);
  return [...hs].sort((a, b) => b - a);
}

export interface SilhouetteInput {
  r: ResolvedMeasurements;
  L: BodyLandmarks;
  knit: boolean;
  topHeight: number;
  hemHeight: number;
  /** Garment circumference key points (any order). */
  knots: Knot[];
  neckline: Neckline | null;
  sleeve?: Silhouette['sleeve'];
  /** Trousers: per-leg garment circumference from the crotch down to the hem. */
  leg?: { top: number; bottom: number; at: (h: number) => number };
}

export function buildSilhouette(inp: SilhouetteInput): Silhouette {
  const prof = bodyProfile(inp.r, inp.L);
  const clearance = inp.knit ? 0.5 : 1;
  const ring = (h: number, garment: number, body: number, bodyDepth: number): SilhouetteRing => {
    const c = Math.max(garment, body + clearance);
    const excess = Math.max(0, (c - body) / c);
    const depthRatio = Math.min(1, bodyDepth + (1 - bodyDepth) * Math.min(1, excess * 1.6));
    return {
      heightCm: Math.round(h * 100) / 100,
      circumferenceCm: Math.round(c * 100) / 100,
      bodyCircumferenceCm: Math.round(body * 100) / 100,
      depthRatio: Math.round(depthRatio * 1000) / 1000,
    };
  };
  const torsoBottom = inp.leg ? Math.max(inp.hemHeight, inp.leg.top) : inp.hemHeight;
  const torso = heights(inp.topHeight, torsoBottom, inp.L).map((h) => ring(h, interp(inp.knots, h), prof.torsoAt(h), prof.torsoDepthAt(h)));
  const out: Silhouette = {
    torso,
    neckline: inp.neckline,
    topHeightCm: Math.round(inp.topHeight * 100) / 100,
    hemHeightCm: Math.round(inp.hemHeight * 100) / 100,
  };
  if (inp.leg) {
    const legTop = inp.leg.top - 1;
    out.leg = heights(legTop, inp.leg.bottom, inp.L).map((h) => ring(h, inp.leg!.at(h), prof.legAt(h), 0.95));
  }
  if (inp.sleeve) out.sleeve = inp.sleeve;
  return out;
}
