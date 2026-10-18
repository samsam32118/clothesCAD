/**
 * Garment surfaces lofted from `pkg.silhouette`.
 *
 * Every garment part (torso/skirt tube, trouser legs, sleeves) is described as
 * a "garment tube": a lattice of radii over (s along an axis, angle phi) that
 * is computed against the parametric body so the fabric never enters the
 * body (radius >= body radius + clearance at every lattice sample), then
 * meshed with a shaped top edge (neckline / armholes / sleeve cap) and a
 * turned-hem lip that gives the hem visible thickness.
 *
 * Fitted areas follow the body's convex cross-section offset outward so that
 * the garment girth equals the silhouette circumference; free-hanging areas
 * become ellipses with the silhouette depth ratio and gain soft drape folds
 * whose amplitude grows with flare, falls with fabric stiffness, is zero at
 * the waist/top and maximal at the hem.
 *
 * Units: centimetres. No DOM access.
 */
import type { BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type {
  BodyLandmarks,
  GarmentDefinition,
  MaterialPreset,
  Neckline,
  ResolvedMeasurements,
  Silhouette,
  SilhouetteRing,
} from '../core/types';
import { BodyModel, DEFAULT_ARM_ABDUCTION_DEG, type Frame, type TubePart, type Vec3 } from './bodyModel';
import { bodyGeometryFromModel } from './body';
import { gridGeometry } from './grid';
import {
  SmoothCurve,
  TAU,
  clamp,
  ellipseFromPerimeter,
  ellipseRadial,
  hash01,
  lerp,
  polygonPerimeter,
  polygonRadial,
  smoothstep,
  wrapAngle,
  convexHull,
  type Vec2,
} from './math';

/** The subset of a DesignPackage the 3D module needs (a DesignPackage satisfies it). */
export interface FigureSource {
  id?: string;
  name?: string;
  measurements: ResolvedMeasurements;
  body: { landmarks: BodyLandmarks };
  silhouette: Silhouette;
  material: Pick<MaterialPreset, 'render' | 'stiffness' | 'weightGsm' | 'sheen'> &
    Partial<Pick<MaterialPreset, 'id' | 'name' | 'fiber' | 'construction' | 'stretchPct'>>;
  /** Garment type (optional): a ball gown is rendered as worn over a supporting petticoat. */
  garment?: Partial<Pick<GarmentDefinition, 'id' | 'category'>>;
}

/** Minimum radial gap between fabric and body that the validator enforces (cm). */
export const MIN_CLEARANCE_CM = 0.5;
/** Clearance used while building (adds a safety margin for interpolation). */
const BUILD_CLEARANCE_CM = MIN_CLEARANCE_CM + 0.2;

export type GarmentTubeKind = 'torso' | 'leg' | 'sleeve';

/** A garment part as a radius lattice over (s, phi) in an axis frame. */
export interface GarmentTube {
  name: string;
  kind: GarmentTubeKind;
  frame: Frame;
  mirrored: boolean;
  /** Section centre offset (u, w) from the frame axis at s. */
  centreOffset: (s: number) => [number, number];
  cols: number;
  sMin: number;
  step: number;
  nS: number;
  /** nS * cols radii (cm), row-major in s. */
  radius: Float32Array;
  /** Per column: s at which the fabric starts (top edge: neckline, armhole, waist, sleeve cap). */
  start: Float32Array;
  /** s of the hem. */
  end: number;
  /** Hem lip thickness and depth (0 = open edge without lip). */
  lip: number;
  lipLength: number;
  /** Body parts this tube is built to clear. */
  clearParts: TubePart[];
  /** Per column: 1 when the column carries no fabric (e.g. sleeve underside pressed into the armpit). */
  omitted?: Uint8Array;
}

export interface FigurePlan {
  model: BodyModel;
  armAbductionDeg: number;
  tubes: GarmentTube[];
}

// ---------------------------------------------------------------------------
// Lattice helpers
// ---------------------------------------------------------------------------

function tubeRadiusAt(t: GarmentTube, s: number, phi: number): number {
  const fs = clamp((s - t.sMin) / t.step, 0, t.nS - 1);
  const i0 = Math.min(Math.floor(fs), t.nS - 2 < 0 ? 0 : t.nS - 2);
  const i1 = Math.min(i0 + 1, t.nS - 1);
  const ts = fs - i0;
  let fc = ((phi % TAU) + TAU) % TAU;
  fc = (fc / TAU) * t.cols;
  const j0 = Math.floor(fc) % t.cols;
  const j1 = (j0 + 1) % t.cols;
  const tc = fc - Math.floor(fc);
  const r = t.radius;
  const c = t.cols;
  const a = lerp(r[i0 * c + j0]!, r[i0 * c + j1]!, tc);
  const b = lerp(r[i1 * c + j0]!, r[i1 * c + j1]!, tc);
  return lerp(a, b, ts);
}

function tubeStartAt(t: GarmentTube, phi: number): number {
  let fc = ((phi % TAU) + TAU) % TAU;
  fc = (fc / TAU) * t.cols;
  const j0 = Math.floor(fc) % t.cols;
  const j1 = (j0 + 1) % t.cols;
  return lerp(t.start[j0]!, t.start[j1]!, fc - Math.floor(fc));
}

function tubePoint(t: GarmentTube, s: number, phi: number, r: number): Vec3 {
  const { origin: o, d, u, w } = t.frame;
  const [ou, ow] = t.centreOffset(s);
  const su = ou + Math.sin(phi) * r;
  const sw = ow + Math.cos(phi) * r;
  return [o[0] + s * d[0] + su * u[0] + sw * w[0], o[1] + s * d[1] + su * u[1] + sw * w[1], o[2] + s * d[2] + su * u[2] + sw * w[2]];
}

/**
 * How far a world point sits inside the garment tube's enclosed volume
 * (> 0 = inside the fabric shell, within the garment's vertical extent).
 */
export function insideTube(t: GarmentTube, p: Vec3, margin: number): number {
  const { origin: o, d, u, w } = t.frame;
  const rel: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  const s = rel[0] * d[0] + rel[1] * d[1] + rel[2] * d[2];
  if (s > t.end) return -Infinity;
  const [ou, ow] = t.centreOffset(s);
  const pu = rel[0] * u[0] + rel[1] * u[1] + rel[2] * u[2] - ou;
  const pw = rel[0] * w[0] + rel[1] * w[1] + rel[2] * w[2] - ow;
  const phi = Math.atan2(pu, pw);
  if (s < tubeStartAt(t, phi)) return -Infinity;
  return tubeRadiusAt(t, s, phi) + margin - Math.hypot(pu, pw);
}

// ---------------------------------------------------------------------------
// Silhouette interpolation
// ---------------------------------------------------------------------------

interface RingCurves {
  circ: SmoothCurve;
  depth: SmoothCurve;
  top: number;
  bottom: number;
}

function ringCurves(rings: SilhouetteRing[]): RingCurves | null {
  const valid = rings.filter(
    (r) => Number.isFinite(r.heightCm) && Number.isFinite(r.circumferenceCm) && r.circumferenceCm > 0,
  );
  if (valid.length < 2) return null;
  const hs = valid.map((r) => r.heightCm);
  return {
    circ: new SmoothCurve(hs, valid.map((r) => r.circumferenceCm)),
    depth: new SmoothCurve(
      hs,
      valid.map((r) => (Number.isFinite(r.depthRatio) && r.depthRatio > 0 ? clamp(r.depthRatio, 0.4, 1.2) : 0.8)),
    ),
    top: Math.max(...hs),
    bottom: Math.min(...hs),
  };
}

// ---------------------------------------------------------------------------
// Top-edge profiles (neckline, armholes)
// ---------------------------------------------------------------------------

function necklineShape(neckline: Neckline | null, t: number): number {
  // 0 at centre front (lowest point), 1 where the neckline meets the shoulder.
  const x = clamp(t, 0, 1);
  switch (neckline) {
    case 'v':
      return x;
    case 'square':
      return x < 0.82 ? 0.06 * (x / 0.82) : lerp(0.06, 1, smoothstep(0.82, 1, x));
    case 'boat':
      return smoothstep(0, 1, x);
    case 'sweetheart':
      return x < 0.4 ? 0.55 * (1 - (1 - x / 0.4) ** 2) : 0.55 + 0.45 * smoothstep(0.4, 1, x);
    case 'jewel':
    case 'scoop':
    default:
      return 1 - Math.sqrt(1 - x * x);
  }
}

function neckWidthAngle(neckline: Neckline | null): number {
  switch (neckline) {
    case 'jewel':
      return 0.36;
    case 'scoop':
      return 0.55;
    case 'v':
      return 0.42;
    case 'boat':
      return 0.95;
    case 'square':
      return 0.62;
    case 'sweetheart':
      return 0.6;
    default:
      return 0.4;
  }
}

/** Top-edge height (cm from floor) per column of the torso garment. */
function torsoTopProfile(sil: Silhouette, curves: RingCurves, model: BodyModel, cols: number, hem: number): Float32Array {
  const T = curves.top;
  const F = clamp(Number.isFinite(sil.topHeightCm) ? sil.topHeightCm : T, hem + 2, T);
  const out = new Float32Array(cols);
  // Garment reaches the shoulders (has straps): cut a neckline and armholes.
  // Also any garment with sleeves or a (non-strapless) neckline reaches the shoulders,
  // even when the drafted rings stop lower.
  const bodice =
    T > (model.underarmHeight + model.shoulderHeight) / 2 ||
    (sil.sleeve !== undefined && sil.sleeve.lengthCm > 0) ||
    (sil.neckline !== null && sil.neckline !== 'sweetheart');
  const armBottom = Math.max(hem + 2, model.underarmHeight - 1.5);
  const armC = Math.PI / 2 + 0.08;
  const armW = 0.42; // the posed arm subtends roughly ±0.3 rad from the torso axis
  const nF = Math.min(neckWidthAngle(sil.neckline), armC - armW - 0.12);
  const nB = Math.PI - (sil.neckline === 'boat' ? 0.85 : 0.42);
  // Bodices are carried over the shoulder slope (the strap / shoulder seam
  // region), so the fabric wraps the top of the shoulder instead of ending in points.
  const strapTop = bodice ? Math.max(T, model.shoulderHeight + 0.6 * (model.hps - model.shoulderHeight)) : T;
  const backDrop = Math.min(sil.neckline === 'boat' ? 3 : 2, Math.max(0.5, strapTop - F));
  for (let j = 0; j < cols; j++) {
    const phi = Math.abs(wrapAngle((j / cols) * TAU)); // symmetric, 0..π
    let top = T;
    if (bodice) {
      top = strapTop;
      if (phi < nF) top = F + (strapTop - F) * necklineShape(sil.neckline, phi / nF);
      else if (Math.abs(phi - armC) < armW) {
        const x = Math.abs(phi - armC) / armW;
        top = strapTop - (strapTop - armBottom) * (1 - smoothstep(0.45, 1, x));
      } else if (phi > nB) {
        const x = (phi - nB) / (Math.PI - nB);
        top = strapTop - backDrop * (1 - Math.sqrt(Math.max(0, 1 - x * x)));
      }
    } else {
      if (F < T - 0.5) {
        const span = 1.2;
        if (phi < span) top = F + (T - F) * necklineShape(sil.neckline ?? 'sweetheart', phi / span);
      }
      // Strapless / high-waisted tops: the edge dips under the arms.
      if (T > armBottom) {
        const sideW = 0.95;
        const x = Math.abs(phi - armC) / sideW;
        if (x < 1) top = Math.min(top, T - (T - armBottom) * Math.pow(1 - x * x, 0.7));
      }
    }
    out[j] = top;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drape folds
// ---------------------------------------------------------------------------

interface FoldSpec {
  count: number;
  /** Fraction of its cut stand-off that free-hanging fabric keeps (gravity). */
  hang: number;
  phase: number;
  /** Upper bound of fold depth (cm): soft fabric folds deeper relative to its fold spacing. */
  maxDepth: number;
  /** Secondary harmonic used to make fold spacing and depth irregular. */
  warpCount: number;
}

/** Garments worn over a supporting petticoat / crinoline keep their bell shape. */
const SUPPORTED_GARMENTS = new Set<string>(['ball-gown']);

/**
 * How much of its designed stand-off a free-hanging skirt keeps: crisp cloth
 * (taffeta, mikado, heavy linen) holds its cut shape, fluid cloth (viscose,
 * charmeuse) falls close to the body and turns the spare width into folds.
 */
function drapeHang(src: FigureSource): number {
  const stiff = clamp(src.material.stiffness, 0, 1);
  const weight = clamp((src.material.weightGsm - 150) / 250, 0, 1);
  const hang = clamp(0.22 + 0.7 * Math.pow(stiff, 0.8) - 0.06 * weight, 0.2, 0.95);
  return src.garment?.id !== undefined && SUPPORTED_GARMENTS.has(src.garment.id) ? Math.max(hang, 0.88) : hang;
}

/** Visible fold spacing at the hem (cm): crisp and heavy cloth forms wider, rounder folds. */
function foldWavelength(src: FigureSource): number {
  return 14 + 18 * clamp(src.material.stiffness, 0, 1) + clamp(src.material.weightGsm, 40, 600) / 40;
}

/**
 * Estimated perimeter of the hem once the fabric hangs (cm), used to choose
 * the fold count before the full lattice is built.
 */
function hungHemPerimeter(src: FigureSource, curves: RingCurves, rings: SilhouetteRing[], hem: number): number {
  const bodyMax = rings.reduce((m, r) => (Number.isFinite(r.bodyCircumferenceCm) ? Math.max(m, r.bodyCircumferenceCm) : m), 0);
  const designed = curves.circ.at(hem);
  if (!(bodyMax > 0) || designed <= bodyMax) return designed;
  return bodyMax + (designed - bodyMax) * drapeHang(src);
}

function foldSpec(src: FigureSource, hungPerimeter: number, salt: string): FoldSpec {
  const stiff = clamp(src.material.stiffness, 0, 1);
  const wavelength = foldWavelength(src);
  const count = Math.round(clamp(hungPerimeter / wavelength, 6, 40));
  return {
    count,
    hang: drapeHang(src),
    phase: hash01(`${src.id ?? src.name ?? 'design'}:${salt}`) * TAU,
    maxDepth: (0.16 + 0.22 * (1 - stiff)) * wavelength,
    warpCount: Math.max(2, Math.round(count / 3.2)),
  };
}

function ringPerimeter(r: ArrayLike<number>, phis: number[]): number {
  let p = 0;
  const n = phis.length;
  let px = r[n - 1]! * Math.sin(phis[n - 1]!);
  let pz = r[n - 1]! * Math.cos(phis[n - 1]!);
  for (let j = 0; j < n; j++) {
    const x = r[j]! * Math.sin(phis[j]!);
    const z = r[j]! * Math.cos(phis[j]!);
    p += Math.hypot(x - px, z - pz);
    px = x;
    pz = z;
  }
  return p;
}

/** Fold depth (cm, before per-column weighting) that restores the designed ring length. */
function solveFoldDepth(
  hung: Float64Array,
  weight: Float64Array,
  cap: Float64Array,
  phis: number[],
  folds: FoldSpec,
  v: number,
  target: number,
  scratch: Float64Array,
): number {
  const n = phis.length;
  let anyFree = false;
  for (let j = 0; j < n; j++) if (weight[j]! > 1e-3 && cap[j]! > 1e-3) anyFree = true;
  if (!anyFree) return 0;
  const lengthAt = (a: number) => {
    for (let j = 0; j < n; j++) scratch[j] = hung[j]! + Math.min(a * weight[j]!, cap[j]!) * foldWave(folds, phis[j]!, v);
    return ringPerimeter(scratch, phis);
  };
  if (lengthAt(0) >= target) return 0;
  let lo = 0;
  let hi = 40;
  if (lengthAt(hi) <= target) return hi;
  for (let it = 0; it < 22; it++) {
    const mid = (lo + hi) / 2;
    if (lengthAt(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Drape fold profile around the ring, in [-1, 1]-ish. Fold spacing is warped
 * by a slow harmonic (real folds are not evenly spaced), the depth varies from
 * fold to fold, and the warp drifts with `v` (0 at the top edge, 1 at the hem)
 * so folds wander slightly instead of running as perfectly straight pleats.
 */
function foldWave(spec: FoldSpec, phi: number, v = 1): number {
  const n = spec.count;
  const m = spec.warpCount;
  const p = spec.phase;
  // Phase warp amplitude keeps the local frequency positive: n + a·m·cos(..) > 0.45 n.
  const a = (0.5 * n) / m;
  const theta = n * phi + a * Math.sin(m * phi + 1.3 * p) + 0.35 * a * v * Math.sin((m + 1) * phi + 2.1 * p);
  const depth = 0.68 + 0.32 * Math.sin((m - 1 || 1) * phi + 0.7 * p);
  return Math.sin(theta) * depth + 0.1 * Math.sin(2 * theta + 0.5);
}

// ---------------------------------------------------------------------------
// Vertical garment tubes (torso/skirt, trouser legs)
// ---------------------------------------------------------------------------

interface VerticalTubeSpec {
  name: string;
  kind: 'torso' | 'leg';
  curves: RingCurves;
  /** Drape fold parameters (chosen with the column count). */
  folds: FoldSpec;
  top: Float32Array; // per column, height
  hem: number;
  cols: number;
  mirrored: boolean;
  /** Centre (x, z) of the garment section at height h. */
  centre: (h: number) => [number, number];
  clearParts: TubePart[];
  /** For trouser legs: keep the fabric on this side of x = 0 (sign of the leg). */
  midplaneSide: 0 | 1 | -1;
  lip: number;
  lipLength: number;
  /**
   * Below this height the fabric falls from the fullest point above instead of
   * following body concavities (cumulative max of the body outline going down).
   */
  envelopeBelow?: number;
  /** Trouser legs: outline (x, z) of the torso garment's bottom edge on this leg's side, to blend into. */
  topOutline?: Vec2[];
  blendLength?: number;
  /** Extra parts to clear above a height (bodice carried over the posed shoulders/arms). */
  extraClear?: { parts: TubePart[]; above: number };
}

/** In-place Gaussian blur of each lattice column along s (sigma in rows), edges clamped. */
function smoothLatticeVertically(radius: Float32Array, nS: number, cols: number, sigmaRows: number): void {
  if (sigmaRows <= 0 || nS < 3) return;
  const half = Math.max(1, Math.ceil(sigmaRows * 2.5));
  const kernel: number[] = [];
  let sum = 0;
  for (let k = -half; k <= half; k++) {
    const w = Math.exp(-0.5 * (k / sigmaRows) ** 2);
    kernel.push(w);
    sum += w;
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] = kernel[k]! / sum;
  const col = new Float64Array(nS);
  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < nS; i++) col[i] = radius[i * cols + j]!;
    for (let i = 0; i < nS; i++) {
      let acc = 0;
      for (let k = -half; k <= half; k++) acc += kernel[k + half]! * col[clamp(i + k, 0, nS - 1)]!;
      radius[i * cols + j] = acc;
    }
  }
}

function buildVerticalTube(model: BodyModel, spec: VerticalTubeSpec): GarmentTube {
  const { cols, curves } = spec;
  let topMax = -Infinity;
  for (const v of spec.top) topMax = Math.max(topMax, v);
  const refTop = topMax;
  const step = 0.5;
  const nS = Math.max(2, Math.ceil((refTop - spec.hem) / step) + 1);
  const radius = new Float32Array(nS * cols);
  const phis = Array.from({ length: cols }, (_, j) => (j / cols) * TAU);
  const sinP = phis.map(Math.sin);
  // World-space direction of a column: mirrored frames flip the u (x) axis.
  const worldPhi = (phi: number) => (spec.mirrored ? -phi : phi);
  const hAt = (i: number) => Math.max(spec.hem, refTop - i * step);

  // Body outline per lattice row: the true hull (for clearance) and the drape
  // reference (hull, or below the fullest point the envelope of everything above).
  const bodyR = new Float32Array(nS * cols);
  const hullR = new Float32Array(nS * cols);
  const hullP = new Float32Array(nS);
  const envelopeBelow = spec.envelopeBelow ?? -Infinity;
  const ring: Vec2[] = new Array(cols);
  for (let i = 0; i < nS; i++) {
    const h = hAt(i);
    const hull = model.hullAt(h, spec.clearParts);
    const [cx, cz] = spec.centre(h);
    for (let j = 0; j < cols; j++) {
      const wp = worldPhi(phis[j]!);
      const raw = hull.length >= 3 ? polygonRadial(hull, cx, cz, wp) : 0;
      bodyR[i * cols + j] = raw;
      const prev = i > 0 && h < envelopeBelow ? hullR[(i - 1) * cols + j]! : 0;
      const ref = Math.max(raw, prev);
      hullR[i * cols + j] = ref;
      ring[j] = [cx + ref * Math.sin(wp), cz + ref * Math.cos(wp)];
    }
    hullP[i] = hull.length >= 3 || h < envelopeBelow ? polygonPerimeter(ring) : 0;
  }
  // Rows above the silhouette's top ring (bodice carried over the shoulder
  // slope): keep the ease of the top ring instead of extrapolating its girth.
  let topOffset = 0.8;
  {
    const iTop = clamp(Math.round((refTop - curves.top) / step), 0, nS - 1);
    if (hullP[iTop]! > 0) topOffset = clamp((curves.circ.at(curves.top) - hullP[iTop]!) / TAU, 0.3, 1.5);
  }
  const topH = spec.top.reduce((a, b) => Math.max(a, b), -Infinity);

  const folds = spec.folds;
  const vSpan = Math.max(curves.top - spec.hem, 1);
  const columnTop = spec.top;

  const rowBase = new Float64Array(cols);
  const rowWeight = new Float64Array(cols);
  const rowFree = new Float64Array(cols);
  const rowHung = new Float64Array(cols);
  const rowCap = new Float64Array(cols);
  const rowR = new Float64Array(cols);
  const prevBase = new Float64Array(cols);
  let prevC = -Infinity;
  for (let i = 0; i < nS; i++) {
    const h = hAt(i);
    const C = curves.circ.at(h);
    const k = curves.depth.at(h);
    const ell = ellipseFromPerimeter(C, k);
    const P = hullP[i]!;
    const aboveTop = h > curves.top + 1e-6;
    const offset = aboveTop ? topOffset : P > 0 ? (C - P) / TAU : 0;
    const wEll = aboveTop ? 0 : P > 0 ? smoothstep(2.5, 7, offset) : 1;
    const [cx, czRow] = spec.centre(h);
    const blendW =
      spec.topOutline && spec.blendLength ? 1 - smoothstep(0, spec.blendLength, topH - h) : 0;
    const falling = i > 0 && h < envelopeBelow && C >= prevC - 1e-6;
    // Designed shape of this ring, and how freely each column hangs.
    for (let j = 0; j < cols; j++) {
      const hb = hullR[i * cols + j]!;
      const fitted = hb + offset;
      const free = ellipseRadial(ell.a, ell.b, phis[j]!);
      let r = lerp(fitted, free, wEll);
      if (blendW > 0 && spec.topOutline) {
        const rTop = polygonRadial(spec.topOutline, cx, czRow, worldPhi(phis[j]!));
        if (rTop > 0) r = lerp(r, rTop, blendW);
      }
      const colTop = columnTop[j]!;
      const v = clamp((colTop - h) / Math.max(colTop - spec.hem, 1), 0, 1);
      // Below the fullest point, fabric that is not being tapered falls straight.
      if (falling) r = Math.max(r, prevBase[j]!);
      // Free = the fabric stands off the body here (gravity acts on it); folds
      // additionally fade out toward the top edge (none at the waist, deepest at the hem).
      rowFree[j] = smoothstep(1.5, 6, r - hb);
      rowWeight[j] = rowFree[j]! * Math.pow(smoothstep(0, 1, v), 1.3);
      rowBase[j] = r;
    }
    prevBase.set(rowBase);
    prevC = C;
    // Gravity: soft fabric hangs closer to the body than its cut shape...
    const designed = ringPerimeter(rowBase, phis);
    for (let j = 0; j < cols; j++) {
      const hb = hullR[i * cols + j]!;
      rowHung[j] = hb + (rowBase[j]! - hb) * (1 - (1 - folds.hang) * rowFree[j]!);
      rowCap[j] = Math.min(0.6 * (rowHung[j]! - hb), folds.maxDepth);
    }
    // ...and the spare length goes into drape folds: solve the fold depth so
    // the ring keeps the designed fabric length (circumference).
    const vRow = clamp((curves.top - h) / vSpan, 0, 1);
    const foldDepth = solveFoldDepth(rowHung, rowWeight, rowCap, phis, folds, vRow, designed, rowR);
    for (let j = 0; j < cols; j++) {
      radius[i * cols + j] = rowHung[j]! + Math.min(foldDepth * rowWeight[j]!, rowCap[j]!) * foldWave(folds, phis[j]!, vRow);
    }
  }

  // Silhouette rings are dense and the monotone spline flattens at every
  // small local extremum; a light vertical Gaussian removes the resulting
  // slope kinks (visible as shading bands) without touching the drape folds.
  smoothLatticeVertically(radius, nS, cols, 1.25 / step);

  // Final pass: trouser midplane, body clearance (hull test along the ray,
  // then each part's own radial clearance, which is what the validator measures).
  for (let i = 0; i < nS; i++) {
    const h = hAt(i);
    const [cx, cz] = spec.centre(h);
    const margin = BUILD_CLEARANCE_CM + (h <= spec.hem + spec.lipLength + 1 ? spec.lip : 0);
    for (let j = 0; j < cols; j++) {
      let r = radius[i * cols + j]!;
      if (spec.midplaneSide !== 0) {
        const sx = sinP[j]! * (spec.mirrored ? -1 : 1); // world x direction of this column
        const towardMid = spec.midplaneSide > 0 ? sx < 0 : sx > 0;
        if (towardMid && Math.abs(sx) > 1e-6) {
          const limit = (Math.abs(cx) - 0.05) / Math.abs(sx);
          if (r > limit) r = limit;
        }
      }
      const hRaw = bodyR[i * cols + j]!;
      r = Math.max(r, hRaw > 0 ? hRaw + margin : 0.5);
      const wp = worldPhi(phis[j]!);
      for (let iter = 0; iter < 40; iter++) {
        const p: Vec3 = [cx + r * Math.sin(wp), h, cz + r * Math.cos(wp)];
        let depth = -Infinity;
        for (const part of spec.clearParts) depth = Math.max(depth, part.penetration(p, margin));
        if (spec.extraClear && h >= spec.extraClear.above) {
          for (const part of spec.extraClear.parts) depth = Math.max(depth, part.penetration(p, margin));
        }
        if (depth <= 0) break;
        r += depth + 0.02;
      }
      radius[i * cols + j] = r;
    }
  }

  const start = new Float32Array(cols);
  for (let j = 0; j < cols; j++) start[j] = refTop - columnTop[j]!;
  const frame: Frame = {
    origin: [0, refTop, 0],
    d: [0, -1, 0],
    u: [spec.mirrored ? -1 : 1, 0, 0],
    w: [0, 0, 1],
  };
  return {
    name: spec.name,
    kind: spec.kind,
    frame,
    mirrored: spec.mirrored,
    centreOffset: (s: number) => {
      const [cx, cz] = spec.centre(refTop - s);
      return [spec.mirrored ? -cx : cx, cz];
    },
    cols,
    sMin: 0,
    step,
    nS,
    radius,
    start,
    end: refTop - spec.hem,
    lip: spec.lip,
    lipLength: spec.lipLength,
    clearParts: spec.clearParts,
  };
}

// ---------------------------------------------------------------------------
// Sleeves
// ---------------------------------------------------------------------------

function buildSleeveTube(
  model: BodyModel,
  arm: TubePart,
  sleeve: NonNullable<Silhouette['sleeve']>,
  lip: number,
): GarmentTube | null {
  const len = Math.min(sleeve.lengthCm, model.armSpec.length + 2);
  if (!(len > 2)) return null;
  const cols = 64;
  const topR = model.armSpec.topRadius;
  const sMin = -topR;
  const step = 0.5;
  const nS = Math.max(2, Math.ceil((len - sMin) / step) + 1);
  const radius = new Float32Array(nS * cols);
  const k = 1.0;
  for (let i = 0; i < nS; i++) {
    const s = Math.min(len, sMin + i * step);
    const C = lerp(sleeve.topCircumferenceCm, sleeve.bottomCircumferenceCm, clamp(s / len, 0, 1));
    const ell = ellipseFromPerimeter(Math.max(C, 1), k);
    const blend = smoothstep(-topR, 0.4 * topR, s);
    for (let j = 0; j < cols; j++) {
      const phi = (j / cols) * TAU;
      const ar = arm.radial(s, phi);
      const hug = ar + BUILD_CLEARANCE_CM + lip;
      const free = ellipseRadial(ell.a, ell.b, phi);
      radius[i * cols + j] = lerp(hug, Math.max(free, hug), blend);
    }
  }
  const tube: GarmentTube = {
    name: arm.name.replace('arm', 'sleeve'),
    kind: 'sleeve',
    frame: arm.frame,
    mirrored: arm.mirrored,
    centreOffset: (s: number) => {
      const sec = arm.section(s);
      return [sec.ou, sec.ow];
    },
    cols,
    sMin,
    step,
    nS,
    radius,
    start: new Float32Array(cols),
    end: len,
    lip,
    lipLength: Math.min(2, len / 4),
    clearParts: [arm, model.torso],
  };
  // Sleeve cap: high over the shoulder, lower toward the underarm, and never inside the torso.
  for (let j = 0; j < cols; j++) {
    const phi = (j / cols) * TAU;
    // Cap covers the deltoid: near the top of the shoulder on the outside, lower toward the underarm.
    const base = lerp(0.3, -0.92, Math.pow((1 + Math.sin(phi)) / 2, 0.35)) * topR;
    // The upper arm overlaps the torso near the armpit: start the fabric below
    // the last point that would sit inside the torso.
    let lastInside = -Infinity;
    for (let s = base; s <= len; s += 0.25) {
      const p = tubePoint(tube, s, phi, tubeRadiusAt(tube, s, phi));
      if (model.torso.penetration(p, BUILD_CLEARANCE_CM) > 0) lastInside = s;
    }
    const start = Math.max(base, lastInside + 0.25);
    if (start > len - 0.75) {
      // The arm is embedded in the torso all the way down here: no fabric in this column.
      tube.omitted ??= new Uint8Array(cols);
      tube.omitted[j] = 1;
      tube.start[j] = len;
    } else tube.start[j] = start;
  }
  if (tube.omitted && tube.omitted.every((v) => v === 1)) return null;
  return tube;
}

// ---------------------------------------------------------------------------
// Arm pose
// ---------------------------------------------------------------------------

/** Smallest arm abduction (deg) that keeps arms and hands outside every hanging garment tube. */
function solveArmAbduction(src: FigureSource, tubes: GarmentTube[]): number {
  const vertical = tubes.filter((t) => t.kind !== 'sleeve');
  if (vertical.length === 0) return DEFAULT_ARM_ABDUCTION_DEG;
  const m = src.measurements;
  const L = src.body.landmarks;
  const clearance = MIN_CLEARANCE_CM + 0.3;
  for (let deg = DEFAULT_ARM_ABDUCTION_DEG; deg <= 60; deg += 1) {
    const model = new BodyModel(m, L, { armAbductionDeg: deg });
    let ok = true;
    for (const arm of model.arms) {
      for (let s = Math.max(arm.s0, 0); s <= arm.s1 && ok; s += 1) {
        for (let q = 0; q < 16 && ok; q++) {
          const p = arm.surfacePoint(s, (q / 16) * TAU);
          // The shoulder joint region above the armhole is handled by the armhole cut.
          if (p[1] > model.underarmHeight - 2) continue;
          for (const t of vertical) {
            if (insideTube(t, p, clearance) > 0) {
              ok = false;
              break;
            }
          }
        }
      }
      if (!ok) break;
    }
    if (ok) return deg;
  }
  return 60;
}

/**
 * Lower the torso garment's top edge wherever the posed upper arm would pass
 * through the fabric (armholes / strapless sides). The cut follows a smooth
 * U-shaped envelope and only ever lowers the edge.
 */
function adaptArmholes(t: GarmentTube, model: BodyModel): void {
  if (t.kind !== 'torso') return;
  const margin = MIN_CLEARANCE_CM + 0.2;
  const refTop = t.frame.origin[1];
  const floorH = model.underarmHeight - 6;
  const cols = t.cols;
  const req = new Float32Array(cols);
  let any = false;
  for (let j = 0; j < cols; j++) {
    const phi = (j / cols) * TAU;
    const colTop = refTop - t.start[j]!;
    req[j] = colTop;
    if (colTop < floorH) continue;
    let lowestHit = Infinity;
    for (let h = colTop; h >= floorH; h -= 0.5) {
      const sv = refTop - h;
      const p = tubePoint(t, sv, phi, tubeRadiusAt(t, sv, phi));
      for (const arm of model.arms) {
        if (arm.penetration(p, margin) > 0) {
          lowestHit = Math.min(lowestHit, h);
          break;
        }
      }
    }
    if (Number.isFinite(lowestHit)) {
      req[j] = lowestHit - 0.75;
      any = true;
    }
  }
  if (!any) return;
  const curvature = 300; // cm per rad² — keeps the cut a soft U, not a notch
  for (let j = 0; j < cols; j++) {
    let best = req[j]!;
    for (let k = 0; k < cols; k++) {
      let dphi = Math.abs(j - k) * (TAU / cols);
      if (dphi > Math.PI) dphi = TAU - dphi;
      const v = req[k]! + curvature * dphi * dphi;
      if (v < best) best = v;
    }
    const colTop = refTop - t.start[j]!;
    const top = Math.min(colTop, best);
    t.start[j] = Math.min(refTop - top, t.end - 2);
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function lipThickness(src: FigureSource): number {
  return clamp(0.18 + src.material.weightGsm / 1000, 0.2, 0.6);
}

/** Bottom edge of the torso garment on one side of the body midplane, as a convex outline (x, z). */
function torsoBottomOutline(t: GarmentTube, side: 1 | -1): Vec2[] {
  const pts: Vec2[] = [];
  for (let j = 0; j < t.cols; j++) {
    const phi = (j / t.cols) * TAU;
    const p = tubePoint(t, t.end, phi, tubeRadiusAt(t, t.end, phi));
    if (p[0] * side >= 0) {
      pts.push([p[0], p[2]]);
      pts.push([0, p[2]]);
    }
  }
  return pts.length >= 3 ? convexHull(pts) : [];
}

function planTubes(src: FigureSource, model: BodyModel): GarmentTube[] {
  const sil = src.silhouette;
  const tubes: GarmentTube[] = [];
  const lip = lipThickness(src);
  const torsoRings = [...(sil.torso ?? [])].sort((a, b) => b.heightCm - a.heightCm);
  const legRings = [...(sil.leg ?? [])].sort((a, b) => b.heightCm - a.heightCm);
  const torsoCurves = ringCurves(torsoRings);
  const legCurves = ringCurves(legRings);
  const hasLegs = legCurves !== null;
  if (torsoCurves) {
    const hem = Math.max(0.3, torsoCurves.bottom);
    const folds = foldSpec(src, hungHemPerimeter(src, torsoCurves, torsoRings, hem), 'torso');
    const cols = Math.round(clamp(folds.count * 12, 128, 384) / 4) * 4;
    const top = torsoTopProfile(sil, torsoCurves, model, cols, hem);
    tubes.push(
      buildVerticalTube(model, {
        name: 'garment-torso',
        kind: 'torso',
        curves: torsoCurves,
        folds,
        top,
        hem,
        cols,
        mirrored: false,
        centre: (h) => [0, model.centreZAt(h)],
        clearParts: model.trunkParts,
        midplaneSide: 0,
        lip: hasLegs ? 0 : lip,
        lipLength: hasLegs ? 0 : Math.min(2.5, (torsoCurves.top - hem) / 4),
        envelopeBelow: src.body.landmarks.hip,
        extraClear: { parts: model.arms, above: model.shoulderHeight - 5 },
      }),
    );
  }
  const torsoTube = tubes.find((t) => t.kind === 'torso');

  if (legCurves) {
    const hem = Math.max(0.3, legCurves.bottom);
    const hung = hungHemPerimeter(src, legCurves, legRings, hem);
    const cols = Math.round(clamp(foldSpec(src, hung, 'leg').count * 12, 64, 192) / 4) * 4;
    model.legs.forEach((leg, idx) => {
      const foot = model.feet[idx]!;
      const mirrored = leg.mirrored;
      const sideSign = mirrored ? -1 : 1;
      // Start the legs where the torso garment ends so there is no gap at the crotch.
      const torsoHem = torsoCurves?.bottom;
      const legTopH =
        torsoHem !== undefined && torsoHem > legCurves.top && torsoHem - legCurves.top < 8 ? torsoHem : legCurves.top;
      const top = new Float32Array(cols).fill(legTopH);
      const legSec = (h: number): [number, number] => {
        const s = clamp(leg.sAtHeight(h), leg.s0 + 2.5, leg.s1 - 0.7);
        const sec = leg.section(s);
        return [sideSign * sec.ou, sec.ow];
      };
      tubes.push(
        buildVerticalTube(model, {
          name: mirrored ? 'garment-leg-right' : 'garment-leg-left',
          kind: 'leg',
          curves: legCurves,
          folds: foldSpec(src, hung, mirrored ? 'leg-right' : 'leg-left'),
          top,
          hem,
          cols,
          mirrored,
          centre: legSec,
          clearParts: [leg, foot],
          midplaneSide: sideSign as 1 | -1,
          lip,
          lipLength: Math.min(2.5, (legCurves.top - hem) / 4),
          envelopeBelow: legCurves.top + 1,
          topOutline: torsoTube ? torsoBottomOutline(torsoTube, sideSign) : undefined,
          blendLength: 10,
        }),
      );
    });
  }
  return tubes;
}

/**
 * Plan the whole figure: body pose (arm abduction chosen so arms clear the
 * garment), garment tubes, and sleeves following the posed arms.
 */
export function planFigure(src: FigureSource): FigurePlan {
  const landmarks = src.body.landmarks;
  const base = new BodyModel(src.measurements, landmarks, { armAbductionDeg: DEFAULT_ARM_ABDUCTION_DEG });
  const first = planTubes(src, base);
  // The pose only depends on the garment below the armpit, which does not
  // depend on the pose; the part above the armpit (carried over the shoulders)
  // is then rebuilt around the final arms.
  const deg = solveArmAbduction(src, first);
  const model = deg === DEFAULT_ARM_ABDUCTION_DEG ? base : new BodyModel(src.measurements, landmarks, { armAbductionDeg: deg });
  const remapped: GarmentTube[] = model === base ? first : planTubes(src, model);
  for (const t of remapped) adaptArmholes(t, model);
  const sleeve = src.silhouette.sleeve;
  if (sleeve && sleeve.lengthCm > 2) {
    const lip = lipThickness(src);
    for (const arm of model.arms) {
      const t = buildSleeveTube(model, arm, sleeve, lip);
      if (t) remapped.push(t);
    }
  }
  return { model, armAbductionDeg: deg, tubes: remapped };
}

// ---------------------------------------------------------------------------
// Meshing
// ---------------------------------------------------------------------------

/**
 * Column each mesh column takes its geometry from: itself, or for omitted
 * columns the nearest carrying column (runs are split in half), so omitted
 * columns collapse onto existing hem points and add no visible surface.
 */
function columnSources(t: GarmentTube): Int32Array {
  const cols = t.cols;
  const src = new Int32Array(cols);
  for (let j = 0; j < cols; j++) src[j] = j;
  const om = t.omitted;
  if (!om) return src;
  for (let j = 0; j < cols; j++) {
    if (!om[j]) continue;
    let back = 1;
    while (back < cols && om[(j - back + cols) % cols]) back++;
    let fwd = 1;
    while (fwd < cols && om[(j + fwd) % cols]) fwd++;
    src[j] = back <= fwd ? (j - back + cols) % cols : (j + fwd) % cols;
  }
  return src;
}

function rowCount(t: GarmentTube): number {
  let minStart = Infinity;
  t.start.forEach((v, j) => {
    if (!t.omitted?.[j]) minStart = Math.min(minStart, v);
  });
  const span = t.end - minStart;
  const res = t.kind === 'sleeve' ? 0.7 : 0.8;
  return Math.max(4, Math.ceil(span / res) + 1);
}

/** Mesh one garment tube (outer shell + turned hem lip). */
export function garmentTubeGeometry(t: GarmentTube): BufferGeometry {
  const rows = rowCount(t);
  const cols = t.cols;
  const stride = cols + 1;
  const pos = new Float32Array(rows * stride * 3);
  const srcCol = columnSources(t);
  const omitted = (j: number) => (t.omitted?.[j] ?? 0) === 1;
  for (let i = 0; i < rows; i++) {
    const v = i / (rows - 1);
    for (let j = 0; j <= cols; j++) {
      const jj = srcCol[j % cols]!;
      const phi = (jj / cols) * TAU;
      const s0 = t.start[jj]!;
      const s = omitted(j % cols) ? t.end : lerp(s0, t.end, v);
      const p = tubePoint(t, s, phi, tubeRadiusAt(t, s, phi));
      const k = (i * stride + j) * 3;
      pos[k] = p[0];
      pos[k + 1] = p[1];
      pos[k + 2] = p[2];
    }
  }
  const shell = gridGeometry(rows, cols, pos, { flip: t.mirrored, name: t.name });
  let geo = shell;
  if (t.lip > 0 && t.lipLength > 0) {
    const lipPos = new Float32Array(3 * stride * 3);
    for (let j = 0; j <= cols; j++) {
      const jj = srcCol[j % cols]!;
      const phi = (jj / cols) * TAU;
      const rOuter = tubeRadiusAt(t, t.end, phi);
      // Columns too short for a turned hem (or omitted) get a zero-thickness lip.
      const hasLip = !omitted(j % cols) && t.end - t.start[jj]! >= t.lipLength + 0.5;
      const sUp = hasLip ? t.end - t.lipLength : t.end;
      const rUp = tubeRadiusAt(t, sUp, phi);
      const thick = hasLip ? t.lip : 0;
      const rings: Array<[number, number]> = [
        [t.end, rOuter],
        [t.end, Math.max(rOuter - thick, rOuter * 0.5)],
        [sUp, Math.max(rUp - thick, rUp * 0.5)],
      ];
      rings.forEach(([s, r], i) => {
        const p = tubePoint(t, s, phi, r);
        const k = (i * stride + j) * 3;
        lipPos[k] = p[0];
        lipPos[k + 1] = p[1];
        lipPos[k + 2] = p[2];
      });
    }
    const lipGeo = gridGeometry(3, cols, lipPos, { flip: t.mirrored });
    const merged = mergeGeometries([shell, lipGeo], false);
    shell.dispose();
    lipGeo.dispose();
    if (!merged) throw new Error(`clothesCAD 3D: failed to merge hem lip for ${t.name}`);
    geo = merged;
  }
  geo.name = t.name;
  geo.userData = { kind: 'garment', part: t.kind, name: t.name, shellRows: rows, cols };
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

export interface FigureGeometry {
  plan: FigurePlan;
  body: BufferGeometry;
  garments: BufferGeometry[];
}

/** Body (posed for the garment) + all garment geometries, in centimetres. */
export function buildFigureGeometry(src: FigureSource): FigureGeometry {
  const plan = planFigure(src);
  return {
    plan,
    body: bodyGeometryFromModel(plan.model),
    garments: plan.tubes.map(garmentTubeGeometry),
  };
}

/**
 * Garment surfaces for a design package (cm, y up, floor at 0, facing +z).
 * One geometry per garment part: torso/skirt, trouser legs, sleeves.
 */
export function buildGarmentGeometry(pkg: FigureSource): BufferGeometry[] {
  return planFigure(pkg).tubes.map(garmentTubeGeometry);
}
