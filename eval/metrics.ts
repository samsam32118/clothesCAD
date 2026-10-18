/**
 * Evaluation metrics for clothesCAD design packages.
 *
 * Every scorer returns `{ id, score 0..1, weight, details[] }`.
 *
 * Scoring model (strict and explainable):
 *  - A metric is made of named *aspects* (e.g. geometry → "simple"). Each
 *    aspect runs a number of checks (one per piece, seam, placement, …).
 *  - An aspect scores `max(0, 1 − failures × penalty)`; the default penalty is
 *    0.34, so three failures zero an aspect no matter how many checks passed.
 *    One broken piece is a broken pattern, not "94 % fine".
 *  - The metric score is the weighted mean of its applicable aspects.
 *  - A result is `clean` when no *major* aspect failed (aspects flagged
 *    `minor`, e.g. marking cosmetics, still cost score but not cleanliness).
 *    The report blends mean score and clean rate (see report.ts).
 *  - `details` lists every failure as "[aspect] concrete message" (capped per
 *    aspect), so a fix round knows exactly what to repair.
 *
 * Scorers only use the public contract (`types.ts`) and the exports listed in
 * ARCHITECTURE.md; geometry is recomputed independently in `./geom`.
 */
import type {
  DesignPackage,
  DesignRequest,
  GarmentType,
  PatternEdge,
  PatternPiece,
  PieceRole,
  SilhouetteRing,
} from '../src/core/types';
import { design } from '../src/core/design';
import { GARMENTS, MATERIALS, STYLES, getGarment, getMaterial, getStyle, recommend } from '../src/core/presets';
import { renderInstructionsMarkdown } from '../src/core/instructions';
import { renderCuttingLayoutSVG, renderPatternSheetSVG, renderPieceSVG, renderTiledPrintPages } from '../src/core/svg';
import { exportOBJ, validateMeshes } from '../src/three';
import {
  angleToLengthwise,
  applyPlacement,
  area,
  bounds,
  checkSimple,
  differenceArea,
  distanceToBoundary,
  distanceToPolyline,
  edgeLength,
  edgePoints,
  edgeSpan,
  extentAtY,
  isFinitePoint,
  overlapArea,
  pointInPolygon,
  signedArea,
} from './geom';
import { lengthMm, parseXml, walk, type XmlElement } from './xml';

// ---------------------------------------------------------------------------
// Result types and the aspect-based scorer
// ---------------------------------------------------------------------------

export type MetricId =
  | 'geometry'
  | 'seams'
  | 'fit'
  | 'wearability'
  | 'proportion'
  | 'layout'
  | 'instructions'
  | 'presets'
  | 'mesh3d'
  | 'determinism'
  | 'svg';

export interface MetricResult {
  id: MetricId;
  score: number;
  weight: number;
  details: string[];
  /** Number of individual checks run, and how many failed. */
  checks: number;
  failed: number;
  /** False when no aspect applied (e.g. no seams of that kind); excluded from averages. */
  applicable: boolean;
  /** No failures in any major aspect. */
  clean: boolean;
}

/** Relative importance of each metric in the overall 0–100 score (sums to 100). */
export const METRIC_WEIGHTS: Record<MetricId, number> = {
  geometry: 14,
  seams: 12,
  fit: 12,
  wearability: 10,
  proportion: 8,
  layout: 12,
  instructions: 10,
  presets: 4,
  mesh3d: 8,
  determinism: 5,
  svg: 5,
};

export const METRIC_LABELS: Record<MetricId, string> = {
  geometry: 'Pattern geometry',
  seams: 'Seam matching',
  fit: 'Fit & ease',
  wearability: 'Wearability',
  proportion: 'Proportion',
  layout: 'Cutting layout & BOM',
  instructions: 'Instructions',
  presets: 'Preset integrity',
  mesh3d: '3D model',
  determinism: 'Determinism',
  svg: 'SVG & print',
};

const MAX_DETAILS_PER_ASPECT = 6;

interface Aspect {
  weight: number;
  penalty: number;
  minor: boolean;
  checks: number;
  failures: string[];
}

export class MetricBuilder {
  private readonly aspects = new Map<string, Aspect>();
  private readonly notes: string[] = [];

  constructor(readonly id: MetricId) {}

  /** Declare an aspect's weight/penalty (optional; aspects are created on first check). */
  aspect(name: string, opts: { weight?: number; penalty?: number; minor?: boolean } = {}): this {
    const a = this.get(name);
    if (opts.weight !== undefined) a.weight = opts.weight;
    if (opts.penalty !== undefined) a.penalty = opts.penalty;
    if (opts.minor !== undefined) a.minor = opts.minor;
    return this;
  }

  /** Record one check. `message` is only built on failure. */
  check(aspect: string, ok: boolean, message: string | (() => string)): boolean {
    const a = this.get(aspect);
    a.checks++;
    if (!ok) a.failures.push(typeof message === 'function' ? message() : message);
    return ok;
  }

  fail(aspect: string, message: string): void {
    this.check(aspect, false, message);
  }

  note(text: string): void {
    this.notes.push(text);
  }

  private get(name: string): Aspect {
    let a = this.aspects.get(name);
    if (!a) {
      a = { weight: 1, penalty: 0.34, minor: false, checks: 0, failures: [] };
      this.aspects.set(name, a);
    }
    return a;
  }

  result(): MetricResult {
    let wsum = 0;
    let ssum = 0;
    let checks = 0;
    let failed = 0;
    let clean = true;
    const details: string[] = [];
    for (const [name, a] of this.aspects) {
      if (a.checks === 0) continue;
      if (a.failures.length && !a.minor) clean = false;
      const s = Math.max(0, 1 - a.failures.length * a.penalty);
      wsum += a.weight;
      ssum += a.weight * s;
      checks += a.checks;
      failed += a.failures.length;
      for (const f of a.failures.slice(0, MAX_DETAILS_PER_ASPECT)) details.push(`[${name}] ${f}`);
      if (a.failures.length > MAX_DETAILS_PER_ASPECT) details.push(`[${name}] …and ${a.failures.length - MAX_DETAILS_PER_ASPECT} more`);
    }
    details.push(...this.notes);
    const applicable = wsum > 0;
    return {
      id: this.id,
      score: applicable ? round3(ssum / wsum) : 1,
      weight: METRIC_WEIGHTS[this.id],
      details,
      checks,
      failed,
      applicable,
      clean,
    };
  }
}

/** Result for a metric that could not run at all (exception in the code under test). */
export function crashedMetric(id: MetricId, err: unknown): MetricResult {
  return { id, score: 0, weight: METRIC_WEIGHTS[id], details: [`crashed: ${errorText(err)}`], checks: 1, failed: 1, applicable: true, clean: false };
}

export function errorText(err: unknown): string {
  if (err instanceof Error) {
    const where = err.stack?.split('\n').find((l) => l.includes('/src/'))?.trim();
    return `${err.message}${where ? ` (${where.replace(/^at\s+/, '')})` : ''}`;
  }
  return String(err);
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const f1 = (v: number) => (Number.isFinite(v) ? (Math.round(v * 10) / 10).toString() : String(v));
const f2 = (v: number) => (Number.isFinite(v) ? (Math.round(v * 100) / 100).toString() : String(v));

// ---------------------------------------------------------------------------
// Shared helpers (contract-level knowledge only)
// ---------------------------------------------------------------------------

/** Roles that form the garment shell around the torso / legs. */
const BODY_ROLES: ReadonlySet<PieceRole> = new Set<PieceRole>([
  'front-bodice',
  'back-bodice',
  'front-skirt',
  'back-skirt',
  'front-dress',
  'back-dress',
  'front-leg',
  'back-leg',
  'skirt-panel',
]);
const BODICE_ROLES: ReadonlySet<PieceRole> = new Set<PieceRole>(['front-bodice', 'back-bodice', 'front-dress', 'back-dress']);

/** Physical copies of a drafted outline in the finished garment (a cut-on-fold piece is two halves). */
export function multiplicity(p: PatternPiece): number {
  return (p.cutOnFold ? 2 : 1) * p.cutCount;
}

function edgeOf(pkg: DesignPackage, ref: { pieceId: string; edgeId: string } | undefined): { piece: PatternPiece; edge: PatternEdge } | null {
  if (!ref) return null;
  const piece = pkg.pieces.find((p) => p.id === ref.pieceId);
  const edge = piece?.edges.find((e) => e.id === ref.edgeId);
  return piece && edge ? { piece, edge } : null;
}

/** Stitch-line length of an edge, recomputed from the path (never trusts `lengthCm`). */
function measuredLength(piece: PatternPiece, edge: PatternEdge): number {
  return edgeLength(piece.seamLine, edge.from, edge.to);
}

const ZIP_TYPES = new Set(['zip-invisible', 'zip-lapped']);
const HEM_TYPES = new Set(['hem-blind', 'hem-double-fold', 'hem-rolled', 'topstitch']);

/** Height (cm from floor) at which a silhouette ring stack has circumference c(h), linearly interpolated. */
export function ringCircumferenceAt(rings: SilhouetteRing[], h: number): number | null {
  if (rings.length === 0) return null;
  const sorted = [...rings].sort((a, b) => b.heightCm - a.heightCm);
  if (h > sorted[0].heightCm + 1e-6 || h < sorted[sorted.length - 1].heightCm - 1e-6) return null;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (h <= a.heightCm && h >= b.heightCm) {
      const t = a.heightCm === b.heightCm ? 0 : (a.heightCm - h) / (a.heightCm - b.heightCm);
      return a.circumferenceCm + t * (b.circumferenceCm - a.circumferenceCm);
    }
  }
  return sorted[sorted.length - 1].circumferenceCm;
}

/** Smallest garment circumference over a height band (cm from floor); null if not covered. */
function minCircumference(rings: SilhouetteRing[], lo: number, hi: number): { c: number; h: number } | null {
  const pts: Array<{ c: number; h: number }> = [];
  for (const r of rings) if (r.heightCm >= lo - 1e-6 && r.heightCm <= hi + 1e-6) pts.push({ c: r.circumferenceCm, h: r.heightCm });
  for (const h of [lo, hi]) {
    const c = ringCircumferenceAt(rings, h);
    if (c !== null) pts.push({ c, h });
  }
  if (!pts.length) return null;
  return pts.reduce((m, x) => (x.c < m.c ? x : m));
}

/**
 * Y coordinate (pattern space) of the natural waist on a piece: a notch
 * labelled "waist", else the mean of the end points of an edge called "waist".
 */
function waistY(p: PatternPiece): number | null {
  const notches = p.notches.filter((n) => /waist/i.test(n.label ?? ''));
  if (notches.length) return notches.reduce((s, n) => s + n.at.y, 0) / notches.length;
  const e = p.edges.find((x) => x.id === 'waist');
  if (!e || e.from >= p.seamLine.length || e.to >= p.seamLine.length) return null;
  return (p.seamLine[e.from].y + p.seamLine[e.to].y) / 2;
}

/**
 * Garment circumference measured on the flat pattern: the sum over body
 * pieces of their horizontal width at `depth` cm below their waist line,
 * times the number of physical copies. Takes the maximum over a ±band so the
 * fullest level is found even if the drafted landmark is a little higher or
 * lower than the body landmark. Returns null if any piece does not reach.
 */
function patternCircumference(pkg: DesignPackage, roles: ReadonlySet<PieceRole>, depth: number, band: number): { cm: number; pieces: number } | null {
  const pieces = pkg.pieces.filter((p) => p.layer === 'self' && roles.has(p.role));
  if (!pieces.length) return null;
  const waists = pieces.map(waistY);
  if (waists.some((w) => w === null)) return null;
  let best = -Infinity;
  for (let dy = -band; dy <= band + 1e-9; dy += 0.5) {
    let total = 0;
    for (let i = 0; i < pieces.length; i++) {
      const ex = extentAtY(pieces[i].seamLine, (waists[i] as number) + depth + dy);
      if (!ex) return null;
      total += (ex.maxX - ex.minX) * multiplicity(pieces[i]);
    }
    best = Math.max(best, total);
  }
  return { cm: best, pieces: pieces.length };
}

// ---------------------------------------------------------------------------
// (1) Geometry
// ---------------------------------------------------------------------------

export function scoreGeometry(pkg: DesignPackage): MetricResult {
  const m = new MetricBuilder('geometry');
  m.aspect('allowance', { penalty: 0.2, weight: 0.5 });
  m.aspect('markings', { penalty: 0.2, weight: 0.5, minor: true });
  m.aspect('orientation', { weight: 0.25, minor: true });
  const ids = new Set<string>();
  for (const p of pkg.pieces) {
    m.check('ids', !ids.has(p.id), `duplicate piece id "${p.id}"`);
    ids.add(p.id);
    const n = p.seamLine.length;

    // closed + finite
    const finite = p.seamLine.every(isFinitePoint) && p.cutLine.every(isFinitePoint);
    m.check('closed', finite && n >= 3 && p.cutLine.length >= 3, `${p.id}: stitch/cut line has non-finite points or < 3 vertices`);
    if (!finite || n < 3) continue;
    const firstLast = Math.hypot(p.seamLine[0].x - p.seamLine[n - 1].x, p.seamLine[0].y - p.seamLine[n - 1].y);
    m.check('closed', firstLast > 1e-6, `${p.id}: seamLine repeats its first point at the end (closing segment must be implicit)`);

    // simple
    const s1 = checkSimple(p.seamLine);
    m.check('simple', s1.ok, () => `${p.id}: stitch line is not simple — ${s1.problems.join('; ')}`);
    const s2 = checkSimple(p.cutLine);
    m.check('simple', s2.ok, () => `${p.id}: cut line is not simple — ${s2.problems.join('; ')}`);

    // area + orientation
    const aSeam = area(p.seamLine);
    const aCut = area(p.cutLine);
    m.check('area', aSeam >= 1, `${p.id}: stitch-line area ${f2(aSeam)} cm² is not positive`);
    m.check('area', aCut > aSeam, `${p.id}: cut area ${f1(aCut)} cm² is not larger than stitch area ${f1(aSeam)} cm²`);
    m.check('orientation', signedArea(p.seamLine) > 0, `${p.id}: stitch line is counter-clockwise (contract: clockwise in SVG space)`);

    // cut line encloses stitch line
    const outside = differenceArea(p.seamLine, p.cutLine);
    const strayPts = p.seamLine.filter((q) => !pointInPolygon(q, p.cutLine) && distanceToBoundary(q, p.cutLine) > 0.02).length;
    m.check(
      'encloses',
      outside <= Math.max(0.05, aSeam * 1e-4) && strayPts === 0,
      `${p.id}: ${f2(outside)} cm² of the stitch area (${strayPts} vertices) lies outside the cut line`,
    );

    // edges: valid indices, chain closes the loop, unique ids, stored lengths
    const edgeIds = new Set<string>();
    let span = 0;
    let indicesOk = true;
    p.edges.forEach((e, i) => {
      const valid = Number.isInteger(e.from) && Number.isInteger(e.to) && e.from >= 0 && e.to >= 0 && e.from < n && e.to < n && e.from !== e.to;
      m.check('edges', valid, `${p.id}.${e.id}: invalid indices ${e.from}→${e.to} (seamLine has ${n} points)`);
      if (!valid) {
        indicesOk = false;
        return;
      }
      m.check('edges', !edgeIds.has(e.id), `${p.id}: duplicate edge id "${e.id}"`);
      edgeIds.add(e.id);
      span += edgeSpan(n, e);
      const next = p.edges[(i + 1) % p.edges.length];
      m.check('edges', next.from === e.to, `${p.id}: edge ${e.id} ends at ${e.to} but next edge ${next.id} starts at ${next.from}`);
      const L = measuredLength(p, e);
      m.check('edges', Math.abs(L - e.lengthCm) <= 0.05, `${p.id}.${e.id}: stored length ${f2(e.lengthCm)} ≠ measured ${f2(L)} cm`);
    });
    if (indicesOk) m.check('edges', span === n, `${p.id}: edges cover ${span} of ${n} segments (outline not fully described)`);

    // seam allowance: zero on fold edges, a real allowance everywhere else
    for (const e of p.edges) {
      if (!indicesOk) break;
      const d = allowanceAt(p, e);
      if (e.kind === 'fold') m.check('allowance', d <= 0.05, `${p.id}.${e.id}: fold edge is ${f2(d)} cm inside the cut line (must be 0)`);
      else if (e.kind === 'facing') m.check('allowance', d <= 8, `${p.id}.${e.id}: facing edge allowance ${f2(d)} cm exceeds 8 cm`);
      else m.check('allowance', d >= 0.3 && d <= 8, `${p.id}.${e.id}: ${e.kind} allowance ${f2(d)} cm is outside 0.3–8 cm`);
    }

    // bounds
    const b = bounds(p.cutLine);
    const bOk = Math.abs(b.minX - p.bounds.minX) < 0.01 && Math.abs(b.maxX - p.bounds.maxX) < 0.01 && Math.abs(b.minY - p.bounds.minY) < 0.01 && Math.abs(b.maxY - p.bounds.maxY) < 0.01;
    m.check('bounds', bOk, `${p.id}: stored bounds differ from the cut line bounds`);

    // markings
    const [g0, g1] = p.grainline;
    m.check('markings', pointInPolygon(g0, p.cutLine) && pointInPolygon(g1, p.cutLine), `${p.id}: grainline leaves the piece`);
    m.check('markings', Math.hypot(g1.x - g0.x, g1.y - g0.y) >= 3, `${p.id}: grainline shorter than 3 cm`);
    for (const no of p.notches) {
      const e = p.edges.find((x) => x.id === no.edgeId);
      const d = e && indicesOk ? distanceToPolyline(no.at, edgePoints(p.seamLine, e)) : Infinity;
      m.check('markings', d <= 0.6, `${p.id}: notch on "${no.edgeId}" is ${e ? `${f2(d)} cm off its edge` : 'on an unknown edge'}`);
    }
    for (const d of p.darts) {
      const onLine = d.legs.every((l) => distanceToBoundary(l, p.seamLine) <= 0.1);
      m.check('markings', onLine, `${p.id}/${d.id}: dart legs are not on the stitch line`);
      m.check('markings', pointInPolygon(d.apex, p.seamLine), `${p.id}/${d.id}: dart point lies outside the piece`);
      m.check('markings', d.intakeCm > 0 && d.intakeCm <= 10 && d.lengthCm > 0, `${p.id}/${d.id}: implausible dart (intake ${d.intakeCm}, length ${d.lengthCm})`);
    }
  }
  if (!pkg.pieces.length) m.fail('closed', 'package has no pattern pieces');
  return m.result();
}

// ---------------------------------------------------------------------------
// (2) Seam matching
// ---------------------------------------------------------------------------

export const SEAM_TOLERANCE_CM = 0.3;

/** Seam allowance at the middle of an edge: distance from its stitch line to the cut line. */
export function allowanceAt(piece: PatternPiece, edge: PatternEdge): number {
  const pts = edgePoints(piece.seamLine, edge);
  return distanceToBoundary(pts[Math.floor(pts.length / 2)], piece.cutLine);
}

/** Sleeve-cap ease range (cm, total over the cap): wovens 1–5, knits 0–3. */
export function capEaseRange(construction: 'woven' | 'knit'): [number, number] {
  return construction === 'knit' ? [0, 3] : [1, 5];
}

export function scoreSeams(pkg: DesignPackage): MetricResult {
  const m = new MetricBuilder('seams');
  m.aspect('coverage', { penalty: 0.15, weight: 0.5 });
  m.aspect('hems', { penalty: 0.25, weight: 0.5, minor: true });
  m.aspect('order', { penalty: 0.25, weight: 0.5 });
  m.aspect('allowance-match', { penalty: 0.25, weight: 0.75 });
  const seamIds = new Set<string>();
  const capEase = new Map<string, number>();
  for (const s of pkg.seams) {
    m.check('ids', !seamIds.has(s.id), `duplicate seam id "${s.id}"`);
    seamIds.add(s.id);
    const A = edgeOf(pkg, s.a);
    const B = s.b ? edgeOf(pkg, s.b) : null;
    m.check('references', !!A, `${s.id}: side A ${s.a.pieceId}.${s.a.edgeId} does not exist`);
    if (s.b) m.check('references', !!B, `${s.id}: side B ${s.b.pieceId}.${s.b.edgeId} does not exist`);
    m.check('references', Number.isFinite(s.intendedEaseCm) && s.intendedEaseCm >= 0 && Number.isFinite(s.stage), `${s.id}: intendedEaseCm ${s.intendedEaseCm} / stage ${s.stage} invalid`);
    if (!A || (s.b && !B)) continue;
    if (B) {
      const la = measuredLength(A.piece, A.edge);
      const lb = measuredLength(B.piece, B.edge);
      const diff = Math.abs(la - lb);
      m.check(
        'lengths',
        Math.abs(diff - s.intendedEaseCm) <= SEAM_TOLERANCE_CM,
        `${s.id}: ${A.piece.id}.${A.edge.id} ${f2(la)} vs ${B.piece.id}.${B.edge.id} ${f2(lb)} cm → difference ${f2(diff)}, intended ${f2(s.intendedEaseCm)} ±${SEAM_TOLERANCE_CM}`,
      );
      if (A.edge.kind !== 'fold' && B.edge.kind !== 'fold') {
        const da = allowanceAt(A.piece, A.edge);
        const db = allowanceAt(B.piece, B.edge);
        m.check('allowance-match', Math.abs(da - db) <= 0.15, `${s.id}: seam allowances differ (${A.piece.id}.${A.edge.id} ${f2(da)} cm vs ${B.piece.id}.${B.edge.id} ${f2(db)} cm) so the raw edges cannot be lined up`);
      }
      if (s.type === 'set-in-sleeve') {
        const sleeve = A.piece.role === 'sleeve' ? A : B.piece.role === 'sleeve' ? B : null;
        const body = sleeve === A ? B : A;
        m.check('sleeve-cap', !!sleeve, `${s.id}: set-in-sleeve seam has no sleeve piece`);
        if (sleeve) capEase.set(sleeve.piece.id, (capEase.get(sleeve.piece.id) ?? 0) + measuredLength(sleeve.piece, sleeve.edge) - measuredLength(body.piece, body.edge));
      }
    }
  }
  const [lo, hi] = capEaseRange(pkg.material.construction);
  for (const [sleeveId, ease] of capEase) {
    m.check('sleeve-cap', ease >= lo - 1e-6 && ease <= hi + 1e-6, `${sleeveId}: sleeve cap ease ${f2(ease)} cm outside ${lo}–${hi} cm for a ${pkg.material.construction}`);
  }
  for (const p of pkg.pieces) {
    if (p.role === 'sleeve' && !capEase.has(p.id) && p.layer === 'self') m.fail('sleeve-cap', `${p.id}: sleeve is never set into an armhole (no set-in-sleeve seam)`);
  }

  // coverage: every cut edge is sewn, hemmed or finished by some seam
  const used = new Set<string>();
  for (const s of pkg.seams) {
    used.add(`${s.a.pieceId}.${s.a.edgeId}`);
    if (s.b) used.add(`${s.b.pieceId}.${s.b.edgeId}`);
  }
  for (const p of pkg.pieces) {
    if (p.layer === 'interfacing') continue;
    for (const e of p.edges) {
      if (e.kind === 'fold' || e.kind === 'facing') continue;
      m.check('coverage', used.has(`${p.id}.${e.id}`), `${p.id}.${e.id} (${e.kind}) is never sewn, hemmed or finished`);
    }
    for (const e of p.edges.filter((x) => x.kind === 'hem')) {
      const hemmed = pkg.seams.some((s) => !s.b && HEM_TYPES.has(s.type) && s.a.pieceId === p.id && s.a.edgeId === e.id);
      const joined = pkg.seams.some((s) => s.b && ((s.a.pieceId === p.id && s.a.edgeId === e.id) || (s.b.pieceId === p.id && s.b.edgeId === e.id)));
      m.check('hems', hemmed || joined, `${p.id}.${e.id}: hem edge has no hem operation`);
    }
  }

  // order: darts on an edge are sewn before that edge is joined to another piece
  for (const d of pkg.seams.filter((s) => s.type === 'dart')) {
    for (const s of pkg.seams) {
      if (!s.b || s.type === 'dart') continue;
      const touches = (s.a.pieceId === d.a.pieceId && s.a.edgeId === d.a.edgeId) || (s.b.pieceId === d.a.pieceId && s.b.edgeId === d.a.edgeId);
      if (touches) m.check('order', d.stage < s.stage, `dart ${d.id} (stage ${d.stage}) is not sewn before seam ${s.id} (stage ${s.stage})`);
    }
  }
  if (!pkg.seams.length) m.fail('references', 'package has no seams');
  return m.result();
}

// ---------------------------------------------------------------------------
// (3) Fit & ease
// ---------------------------------------------------------------------------

/** Garments whose waist is shaped to the body (others may skim it). */
const WAIST_FITTED: ReadonlySet<GarmentType> = new Set<GarmentType>([
  'a-line-skirt',
  'pencil-skirt',
  'circle-skirt',
  'wide-leg-trousers',
  'tapered-trousers',
  'sheath-dress',
  'wrap-dress',
  'column-gown',
  'ball-gown',
]);
/** Garments that fall straight or close at the hip (pattern hip must equal the plan). */
const HIP_STRAIGHT: ReadonlySet<GarmentType> = new Set<GarmentType>([
  'pencil-skirt',
  'wide-leg-trousers',
  'tapered-trousers',
  'shift-dress',
  'sheath-dress',
  'column-gown',
]);
/** Garments with an overlapping front: flat-pattern circumference counts the overlap twice. */
const OVERLAPPING: ReadonlySet<GarmentType> = new Set<GarmentType>(['wrap-dress']);

type EaseKey = 'bust' | 'waist' | 'hip' | 'upperArm' | 'thigh';

/**
 * Sensible woven ease ranges (cm of circumference) by fit preference, from
 * standard flat-pattern references (fitted bodice ≈ 5–8 cm bust ease, …).
 * Knits may go down to −15 % of the body (negative ease). The style's ease
 * modifier widens the range in its direction.
 */
export function easeRange(key: EaseKey, pkg: DesignPackage): [number, number] {
  const fit = pkg.fit.fit;
  const tables: Record<EaseKey, Record<typeof fit, [number, number]>> = {
    bust: { fitted: [2.5, 12], regular: [4, 16], relaxed: [7, 30] },
    hip: { fitted: [2.5, 10], regular: [3.5, 14], relaxed: [5, 24] },
    waist: WAIST_FITTED.has(pkg.garment.id)
      ? { fitted: [0.5, 8], regular: [1, 10], relaxed: [1.5, 16] }
      : { fitted: [0, 45], regular: [0, 45], relaxed: [0, 50] },
    upperArm: { fitted: [3, 12], regular: [4, 14], relaxed: [5, 20] },
    thigh: { fitted: [4, 16], regular: [5, 22], relaxed: [7, 30] },
  };
  let [lo, hi] = tables[key][fit];
  const mod = pkg.style.silhouette.easeModifierCm;
  if (mod > 0) hi += mod;
  if (mod < 0) lo += mod;
  if (pkg.material.construction === 'knit') {
    const body: Record<EaseKey, number> = {
      bust: pkg.measurements.bustCm,
      waist: pkg.measurements.waistCm,
      hip: pkg.measurements.hipCm,
      upperArm: pkg.measurements.upperArmCm,
      thigh: pkg.measurements.thighCm,
    };
    lo = -0.15 * body[key];
  }
  return [round3(lo), round3(hi)];
}

export function scoreFit(pkg: DesignPackage): MetricResult {
  const m = new MetricBuilder('fit');
  m.aspect('silhouette', { weight: 0.5 });
  const r = pkg.measurements;
  const f = pkg.fit.finished;
  const e = pkg.fit.ease;
  const cat = pkg.garment.category;
  const lower = cat === 'skirt' || cat === 'trousers';
  const elastic = pkg.fit.options.closure === 'elastic';

  // arithmetic: finished - body = ease
  const triples: Array<[EaseKey, number | undefined, number]> = [
    ['bust', f.bust, r.bustCm],
    ['waist', f.waist, r.waistCm],
    ['hip', f.hip, r.hipCm],
  ];
  for (const [k, fin, body] of triples) {
    if (fin === undefined) continue;
    m.check('arithmetic', Math.abs(fin - body - e[k]) <= 0.5, `finished ${k} ${f1(fin)} − body ${f1(body)} = ${f1(fin - body)} cm but fit.ease.${k} = ${f1(e[k])}`);
  }
  if (!lower) m.check('arithmetic', f.bust !== undefined, 'bodiced garment has no finished bust');
  m.check('arithmetic', f.waist !== undefined && f.hip !== undefined, 'finished waist/hip missing');
  if (!Object.values(e).every(Number.isFinite)) m.fail('arithmetic', `non-finite ease values ${JSON.stringify(e)}`);

  // ranges
  const ranged: EaseKey[] = [];
  if (!lower) ranged.push('bust');
  if (!elastic) ranged.push('waist');
  if (!(cat === 'top' && f.hip === undefined)) ranged.push('hip');
  if (pkg.fit.options.sleeve !== 'none' && pkg.pieces.some((p) => p.role === 'sleeve')) ranged.push('upperArm');
  if (cat === 'trousers') ranged.push('thigh');
  for (const k of ranged) {
    const [lo, hi] = easeRange(k, pkg);
    m.check('ranges', e[k] >= lo && e[k] <= hi, `${k} ease ${f1(e[k])} cm outside ${f1(lo)}…${f1(hi)} cm for a ${pkg.fit.fit} ${pkg.material.construction} ${pkg.garment.id}`);
  }

  // A woven gown bodice carries a heavy skirt: it must be close-fitting.
  if (cat === 'gown' && pkg.material.construction === 'woven') {
    m.check('ranges', e.bust <= 5.05, `gown bodice bust ease ${f1(e.bust)} cm > 5 cm: the bodice would slide down under the skirt's weight`);
    m.check('ranges', e.waist <= 2.05, `gown waist ease ${f1(e.waist)} cm > 2 cm: the waist seam would drop`);
  }
  // Knits with real stretch are drafted on the knit block: near-zero ease, no darts.
  if (pkg.material.construction === 'knit' && pkg.material.stretchPct >= 20 && !lower) {
    if (pkg.fit.fit !== 'relaxed') m.check('ranges', e.bust <= 2.05 + Math.max(0, pkg.style.silhouette.easeModifierCm), `${pkg.material.stretchPct} % stretch knit has ${f1(e.bust)} cm bust ease (knit block: ≤ 2 cm plus the style's relaxed room)`);
    const bodiceDarts = pkg.pieces.filter((p) => p.layer === 'self').flatMap((p) => p.darts);
    m.check('ranges', bodiceDarts.length === 0, `${pkg.material.stretchPct} % stretch knit still has ${bodiceDarts.length} woven dart(s)`);
  }
  // No sliver darts: anything under 1 cm intake cannot be sewn meaningfully.
  for (const p of pkg.pieces) {
    for (const d of p.darts) m.check('pattern', d.intakeCm >= 0.95, `${p.id}: ${d.id} takes in only ${f1(d.intakeCm)} cm (sliver dart)`);
  }

  // pattern-measured circumferences
  const L = pkg.body.landmarks;
  if (f.hip !== undefined && !OVERLAPPING.has(pkg.garment.id)) {
    const roles = cat === 'top' ? BODICE_ROLES : BODY_ROLES;
    const pc = patternCircumference(pkg, roles, L.waist - L.hip, 1.5);
    if (pc) {
      if (HIP_STRAIGHT.has(pkg.garment.id)) {
        m.check('pattern', Math.abs(pc.cm - f.hip) <= 1, `pattern hip ${f1(pc.cm)} cm ≠ planned finished hip ${f1(f.hip)} (±1)`);
      } else {
        m.check('pattern', pc.cm >= f.hip - 1, `pattern hip ${f1(pc.cm)} cm is smaller than the planned finished hip ${f1(f.hip)}`);
      }
    }
  }
  if (f.bust !== undefined && !OVERLAPPING.has(pkg.garment.id)) {
    const pc = patternCircumference(pkg, BODICE_ROLES, -(L.bust - L.waist), 2.5);
    if (pc) m.check('pattern', Math.abs(pc.cm - f.bust) <= 1, `pattern bust ${f1(pc.cm)} cm ≠ planned finished bust ${f1(f.bust)} (±1)`);
    else m.fail('pattern', 'bust level could not be located on the bodice pieces (no waist notch/edge or pieces do not reach the bust)');
  }
  if (f.waist !== undefined && !elastic && !OVERLAPPING.has(pkg.garment.id)) {
    const band = pkg.pieces.find((p) => p.role === 'waistband' && p.layer === 'self');
    if (band) {
      const joined = pkg.seams
        .filter((s) => s.b && ((s.a.pieceId === band.id && s.b.pieceId !== band.id) || (s.b.pieceId === band.id && s.a.pieceId !== band.id)))
        .map((s) => (s.a.pieceId === band.id ? s.a : s.b!))
        .map((ref) => band.edges.find((x) => x.id === ref.edgeId))
        .filter((x): x is PatternEdge => !!x)
        .reduce((sum, x) => sum + measuredLength(band, x), 0);
      m.check('pattern', Math.abs(joined - f.waist) <= 0.5, `waistband seam length ${f1(joined)} cm ≠ finished waist ${f1(f.waist)} (±0.5)`);
    } else if (!lower) {
      // Bodice pieces only: a skirt below a waist seam may be gathered or flared into it.
      const pc = patternCircumference(pkg, BODICE_ROLES, 0, 0);
      if (pc) m.check('pattern', Math.abs(pc.cm - f.waist) <= 1, `pattern waist ${f1(pc.cm)} cm ≠ planned finished waist ${f1(f.waist)} (±1)`);
    }
  }

  // silhouette (3D input) agrees with the plan where it covers the landmark
  const rings = pkg.silhouette.torso;
  const knit = pkg.material.construction === 'knit';
  const bodyRings = rings.map((x) => ({ ...x, circumferenceCm: x.bodyCircumferenceCm }));
  const check3d = (name: string, h: number, fin: number | undefined, tol: number) => {
    if (fin === undefined || h > pkg.silhouette.topHeightCm || h < pkg.silhouette.hemHeightCm) return;
    const c = ringCircumferenceAt(rings, h);
    if (c === null) return;
    // A knit with negative ease is stretched onto the body when worn: it cannot be smaller than the body there.
    const bodyC = ringCircumferenceAt(bodyRings, h) ?? 0;
    const expected = knit ? Math.max(fin, bodyC) : fin;
    m.check('silhouette', Math.abs(c - expected) <= tol, `silhouette ring at the ${name} (${f1(h)} cm) is ${f1(c)} cm but the worn garment there should be ${f1(expected)} cm${knit && bodyC > fin ? ' (knit stretched to the body)' : ''}`);
  };
  if (!OVERLAPPING.has(pkg.garment.id)) {
    check3d('bust', L.bust, f.bust, 2);
    if (!elastic) check3d('waist', L.waist, f.waist, 2);
    if (HIP_STRAIGHT.has(pkg.garment.id)) check3d('hip', L.hip, f.hip, 2);
  }
  return m.result();
}

// ---------------------------------------------------------------------------
// (4) Wearability
// ---------------------------------------------------------------------------

/** Usable stretch of a fabric for getting dressed (80 % of its mechanical stretch). */
function stretchFactor(pkg: DesignPackage): number {
  return pkg.material.construction === 'knit' ? 1 + 0.8 * (pkg.material.stretchPct / 100) : 1;
}

/** Soft-tissue and fabric give allowed when pulling a closed tube over the hips (cm). */
export const HIP_PASS_GIVE_CM = 1;

/** Minimum neck opening to pass the head without a fastening (cm). */
export const HEAD_PASS_CM = 56;

/** Heel–instep girth estimate (cm): the foot must pass a trouser hem. */
export function footPassCm(heightCm: number, ankleCm: number): number {
  return Math.max(0.195 * heightCm, 1.38 * ankleCm);
}

/** Hem circumference needed to walk a relaxed stride (60 % of a full step) without a vent. */
export function strideNeedCm(pkg: DesignPackage, hemHeight: number): number {
  const L = pkg.body.landmarks;
  if (hemHeight >= L.knee) return 0;
  const step = 0.413 * pkg.measurements.heightCm * 0.6;
  const spread = step * Math.min(1, (L.crotch - hemHeight) / L.crotch);
  const legAtHem = hemHeight <= L.calf ? pkg.measurements.calfCm : pkg.measurements.kneeCm;
  return 2 * spread + legAtHem;
}

export function scoreWearability(pkg: DesignPackage): MetricResult {
  const m = new MetricBuilder('wearability');
  const r = pkg.measurements;
  const L = pkg.body.landmarks;
  const cat = pkg.garment.category;
  const closure = pkg.fit.options.closure;
  const k = stretchFactor(pkg);
  const rings = pkg.silhouette.torso;
  const top = pkg.silhouette.topHeightCm;
  const bodiced = cat !== 'skirt' && cat !== 'trousers';
  // One zip may run through several pieces (e.g. bodice and skirt of a gown): sum its distinct edges.
  const zipSeams = pkg.seams.filter((s) => ZIP_TYPES.has(s.type));
  const zip = zipSeams[0];
  const zipEdges = new Map<string, number>();
  for (const s of zipSeams) {
    const e = edgeOf(pkg, s.a);
    if (e) zipEdges.set(`${e.piece.id}.${e.edge.id}`, measuredLength(e.piece, e.edge));
  }
  const zipLen = [...zipEdges.values()].reduce((a, b) => a + b, 0);
  const fullOpening = closure === 'wrap-tie' || closure === 'buttons';

  m.check('closure', !(closure === 'invisible-zip' || closure === 'lapped-zip') || !!zip, `closure is "${closure}" but no zip seam exists`);
  if (zip) m.check('closure', zipLen >= 12, `zip opening is only ${f1(zipLen)} cm long`);

  const hemH = pkg.silhouette.hemHeightCm;
  // Pulling over the head (garment ends above the hip): the bust must pass every closed level from the hem up.
  if (hemH >= L.hip && bodiced && !fullOpening) {
    const openFrom = zip ? L.nape - zipLen : top;
    const closedTop = Math.min(top, openFrom, L.bust);
    if (closedTop > hemH) {
      const narrowest = minCircumference(rings, hemH, closedTop);
      if (narrowest) {
        m.check('bust-pass', narrowest.c * k >= r.bustCm - HIP_PASS_GIVE_CM, `narrowest closed level ${f1(narrowest.c)} cm at ${f1(narrowest.h)} cm from the floor cannot pass over the ${f1(r.bustCm)} cm bust when pulling the top on`);
      } else m.fail('bust-pass', 'silhouette does not cover the hem-to-bust band, opening cannot be verified');
    }
  }
  // Getting in: everything that ends up above the hip line must pass over the hips.
  if (top > L.hip && hemH < L.hip && !fullOpening) {
    let openFrom = top;
    // A dress zip starts at the centre-back neck; a skirt/trouser zip at the waist seam below the waistband.
    if (zip) openFrom = (bodiced ? L.nape : Math.min(top, L.waist)) - zipLen;
    if (closure === 'elastic') {
      const band = pkg.pieces.find((p) => p.role === 'waistband');
      const casing = band
        ? pkg.seams
            .filter((s) => s.b && (s.a.pieceId === band.id) !== (s.b.pieceId === band.id))
            .map((s) => (s.a.pieceId === band.id ? s.a : s.b!))
            .map((ref) => band.edges.find((x) => x.id === ref.edgeId))
            .filter((x): x is PatternEdge => !!x)
            .reduce((sum, x) => sum + measuredLength(band, x), 0)
        : 0;
      m.check('hip-pass', casing * k >= r.hipCm + 2, `elastic waist casing ${f1(casing)} cm cannot be pulled over the ${f1(r.hipCm)} cm hips (needs hip + 2 cm)`);
      // The elastic band itself stretches open; the fabric below the band must still pass the hips.
      openFrom = Math.min(openFrom, L.waist - 5);
    }
    const closedTop = Math.min(top, openFrom);
    if (closedTop > L.hip) {
      const narrowest = narrowestCapacity(pkg, L.hip, closedTop);
      if (narrowest) {
        m.check(
          'hip-pass',
          narrowest.c * k >= r.hipCm - HIP_PASS_GIVE_CM,
          `opening circumference ${f1(narrowest.c)} cm at ${f1(narrowest.h)} cm from the floor${k > 1 ? ` (×${f2(k)} stretch)` : ''} is smaller than the ${f1(r.hipCm)} cm hip; ${zip ? `the ${f1(zipLen)} cm zip ends too high` : 'there is no opening'}`,
        );
      } else m.fail('hip-pass', 'silhouette does not cover the hip-to-top band, opening cannot be verified');
    }
  }

  // Head: a bodice without any fastening must pass over the head.
  if (bodiced && !fullOpening) {
    const neck = pkg.pieces
      .filter((p) => p.layer === 'self' && BODICE_ROLES.has(p.role))
      .flatMap((p) => p.edges.filter((x) => x.id.startsWith('neck')).map((x) => measuredLength(p, x) * multiplicity(p)))
      .reduce((a, b) => a + b, 0);
    if (neck > 0) {
      const zipFromNeck = zip ? Math.min(zipLen, 15) * 2 : 0;
      const opening = neck * k + zipFromNeck;
      m.check('head-pass', opening >= HEAD_PASS_CM, `neck opening ${f1(neck)} cm${zip ? ` + zip` : ' with no fastening'} = ${f1(opening)} cm cannot pass the head (≥ ${HEAD_PASS_CM} cm)`);
    } else if (closure === 'none') m.fail('head-pass', 'pull-on bodice has no neck edge to verify the head opening');
  }

  // Feet through trouser legs.
  if (cat === 'trousers') {
    const legs = pkg.pieces.filter((p) => p.layer === 'self' && (p.role === 'front-leg' || p.role === 'back-leg'));
    const hem = legs.reduce((s, p) => s + p.edges.filter((x) => x.kind === 'hem').reduce((a, x) => a + measuredLength(p, x), 0), 0);
    const need = footPassCm(r.heightCm, r.ankleCm);
    m.check('foot-pass', hem * k >= need, `trouser leg opening ${f1(hem)} cm is too small for the foot (≈ ${f1(need)} cm heel–instep)`);
  }

  // Walking: hems below the knee need width or a vent / slit / opening edge.
  if (cat !== 'top' && cat !== 'trousers' && pkg.fit.finished.hem !== undefined) {
    const hasVent = fullOpening || pkg.pieces.some((p) => p.edges.some((x) => x.kind === 'opening' || /vent|slit/.test(x.id)));
    const need = strideNeedCm(pkg, pkg.fit.hemHeightFromFloorCm);
    if (need > 0 && !hasVent) {
      m.check('stride', pkg.fit.finished.hem * k >= need, `hem circumference ${f1(pkg.fit.finished.hem)} cm is too narrow to walk (needs ≈ ${f1(need)} cm) and there is no vent or slit`);
    } else m.check('stride', true, '');
  }

  // Sleeves: must fit the upper arm.
  const sleeve = pkg.silhouette.sleeve;
  if (sleeve && pkg.pieces.some((p) => p.role === 'sleeve')) {
    m.check('arm', sleeve.topCircumferenceCm * k >= r.upperArmCm + (k > 1 ? 0 : 2), `sleeve width ${f1(sleeve.topCircumferenceCm)} cm is too tight for the ${f1(r.upperArmCm)} cm upper arm`);
  }

  // Sitting: woven hip ease must allow sitting in hip-hugging garments.
  if (pkg.material.construction === 'woven' && pkg.fit.finished.hip !== undefined && cat !== 'top') {
    m.check('sit', pkg.fit.ease.hip >= 2.5, `woven hip ease ${f1(pkg.fit.ease.hip)} cm is too little to sit down (≥ 2.5 cm)`);
  }
  return m.result();
}

/** Roles below the waist whose cut width is the fabric available to pass the hips. */
const LOWER_ROLES: ReadonlySet<PieceRole> = new Set<PieceRole>(['front-skirt', 'back-skirt', 'skirt-panel', 'front-leg', 'back-leg', 'front-dress', 'back-dress']);

/**
 * Narrowest closed circumference of the garment between two heights. Below
 * the waist it is measured on the flat pattern (a gathered or flared skirt
 * can open to its full cut width); elsewhere, or where the pattern cannot be
 * sliced, the 3D silhouette rings are used.
 */
function narrowestCapacity(pkg: DesignPackage, lo: number, hi: number): { c: number; h: number } | null {
  const L = pkg.body.landmarks;
  let best: { c: number; h: number } | null = null;
  for (let h = lo; h <= hi + 1e-9; h += 0.5) {
    let c: number | null = null;
    if (h < L.waist - 0.25) c = patternCircumference(pkg, LOWER_ROLES, L.waist - h, 0)?.cm ?? null;
    if (c === null) c = ringCircumferenceAt(pkg.silhouette.torso, h);
    if (c === null) continue;
    if (!best || c < best.c) best = { c, h };
  }
  return best ?? minCircumference(pkg.silhouette.torso, lo, hi);
}

// ---------------------------------------------------------------------------
// (5) Proportion & rationale
// ---------------------------------------------------------------------------

/** Plausible hem heights (cm from floor) for each length preset on this body. */
export function lengthBand(pkg: DesignPackage): [number, number] | null {
  const L = pkg.body.landmarks;
  const trousers = pkg.garment.category === 'trousers';
  switch (pkg.fit.options.length) {
    case 'mini':
      return [L.knee + 0.3 * (L.crotch - L.knee), L.crotch - 2];
    case 'above-knee':
      return [L.knee + 1, L.knee + 0.55 * (L.crotch - L.knee)];
    case 'knee':
      return [L.knee - 6, L.knee + 4];
    case 'midi':
      return trousers ? [L.ankle + 4, L.knee - 2] : [L.ankle + 8, L.knee - 1];
    case 'ankle':
      return [L.ankle - 3, L.ankle + 10];
    case 'floor': {
      // Floor length is judged in the shoes it was drafted for: barefoot the hem
      // sits lower by the heel height.
      const heel = pkg.fit.shoeHeelCm ?? 0;
      return [-heel, 4 - heel];
    }
  }
}

export function scoreProportion(pkg: DesignPackage): MetricResult {
  const m = new MetricBuilder('proportion');
  const L = pkg.body.landmarks;
  const cat = pkg.garment.category;
  const hemH = pkg.fit.hemHeightFromFloorCm;
  const heel = pkg.fit.shoeHeelCm ?? 0;
  m.check('hem', Number.isFinite(hemH) && hemH + heel >= 0 && hemH < L.waist, `hem height ${hemH} cm (${f1(hemH + heel)} cm in ${f1(heel)} cm heels) is not between floor and waist`);
  if (pkg.garment.id === 'wide-leg-trousers' && pkg.fit.options.length === 'floor') {
    m.check('length', hemH + heel <= 3, `floor-length wide leg ends ${f1(hemH + heel)} cm from the floor in the planned shoes (≤ 3 cm expected)`);
  }
  if (pkg.garment.id === 'wide-leg-trousers' && pkg.request.options?.length === undefined) {
    m.check('length', pkg.fit.options.length === pkg.garment.defaults.length, `wide-leg trousers default to "${pkg.garment.defaults.length}" but the plan chose "${pkg.fit.options.length}" without being asked`);
  }
  if (cat === 'skirt' || cat === 'dress' || cat === 'gown') {
    m.check('calf', Math.abs(hemH - L.calf) > 3, `hem at ${f1(hemH)} cm cuts across the widest part of the calf (${f1(L.calf)} cm ±3)`);
  }
  if (cat !== 'top') {
    const band = lengthBand(pkg);
    if (band) {
      m.check('length', hemH >= band[0] - 0.01 && hemH <= band[1] + 0.01, `"${pkg.fit.options.length}" hem at ${f1(hemH)} cm is outside the expected ${f1(band[0])}–${f1(band[1])} cm`);
    }
    if (pkg.fit.finished.lengthFromWaist !== undefined) {
      m.check('length', Math.abs(L.waist - hemH - pkg.fit.finished.lengthFromWaist) <= 0.5, `lengthFromWaist ${f1(pkg.fit.finished.lengthFromWaist)} ≠ waist ${f1(L.waist)} − hem ${f1(hemH)}`);
    }
  } else {
    m.check('length', hemH < L.waist - 5 && hemH > L.crotch, `top hem at ${f1(hemH)} cm should fall between crotch and 5 cm below the waist`);
    if (pkg.body.shape === 'pear') m.check('length', Math.abs(hemH - L.hip) > 2, `top hem at ${f1(hemH)} cm sits on the fullest hip line (${f1(L.hip)} cm) of a pear figure`);
  }
  m.check('length', Math.abs(pkg.silhouette.hemHeightCm - hemH) <= 0.5, `silhouette hem ${f1(pkg.silhouette.hemHeightCm)} cm ≠ planned hem ${f1(hemH)} cm`);

  // pattern pieces are as long as the plan says
  const lengthPieces = pkg.pieces.filter((p) => p.layer === 'self' && (p.role === 'front-skirt' || p.role === 'back-skirt' || p.role === 'front-leg' || p.role === 'back-leg' || p.role === 'skirt-panel'));
  const lfw = pkg.fit.finished.lengthFromWaist;
  if (lfw !== undefined && lengthPieces.length && !pkg.pieces.some((p) => BODICE_ROLES.has(p.role) && p.layer === 'self' && p.role.endsWith('dress'))) {
    for (const p of lengthPieces) {
      const b = bounds(p.seamLine);
      const extent = b.maxY - b.minY;
      const lo = lfw - 2;
      const hi = lfw + (cat === 'trousers' ? 8 : 4);
      if (!HIP_STRAIGHT.has(pkg.garment.id)) {
        // Flared skirt pieces fan out, so their vertical extent can exceed the centre-front length.
        m.check('pattern-length', extent >= lo, `${p.id}: piece is ${f1(extent)} cm long but the skirt should be ${f1(lfw)} cm`);
      } else {
        m.check('pattern-length', extent >= lo && extent <= hi, `${p.id}: piece is ${f1(extent)} cm long, expected ${f1(lfw)} cm (−2/+${f1(hi - lfw)})`);
      }
    }
  }

  // rationale: present, specific (numbers), about this body
  const rat = pkg.fit.rationale;
  m.check('rationale', rat.length >= 3, `only ${rat.length} rationale lines (≥ 3 expected)`);
  const numeric = rat.filter((x) => /\d/.test(x) && /\bcm\b|%|×/.test(x));
  m.check('rationale', numeric.length >= 2, `only ${numeric.length} rationale lines quote measurements (≥ 2 expected)`);
  const r = pkg.measurements;
  const bodyNums = [r.bustCm, r.waistCm, r.hipCm, L.calf, L.knee, L.waist, hemH].map((v) => String(Math.round(v * 10) / 10));
  m.check('rationale', rat.some((x) => bodyNums.some((n) => x.includes(n))), 'rationale never quotes this body\'s own measurements or landmark heights');
  m.check('rationale', new Set(rat).size === rat.length, 'rationale repeats itself');
  m.check('rationale', rat.every((x) => x.trim().length >= 25 && /[.!)]$/.test(x.trim())), 'rationale contains fragments (too short or unterminated sentences)');
  const shapeWord = pkg.body.shape.replace('-', ' ');
  m.check('rationale', [...rat, ...pkg.body.notes].some((x) => x.toLowerCase().includes(shapeWord) || x.toLowerCase().includes(pkg.body.shape)) || pkg.body.notes.length >= 2, `neither rationale nor body notes explain the ${shapeWord} shape`);
  m.check('rationale', pkg.body.notes.length >= 2, `only ${pkg.body.notes.length} body-shape notes`);
  return m.result();
}

// ---------------------------------------------------------------------------
// (6) Layout + BOM
// ---------------------------------------------------------------------------

const BOM_KIND_FOR_LAYER = { self: 'fabric', lining: 'lining', interfacing: 'interfacing' } as const;

function bomMetres(qty: number, unit: string): number {
  return unit === 'm' ? qty : unit === 'cm' ? qty / 100 : NaN;
}

export function scoreLayout(pkg: DesignPackage): MetricResult {
  const m = new MetricBuilder('layout');
  m.aspect('nap', { penalty: 0.5, weight: 0.5 });
  m.aspect('efficiency', { weight: 0.25, minor: true });
  m.aspect('bom-waste', { weight: 0.25, penalty: 0.5, minor: true });
  const byId = new Map(pkg.pieces.map((p) => [p.id, p]));
  const layers = [...new Set(pkg.pieces.map((p) => p.layer))];
  for (const layer of layers) m.check('coverage', pkg.layouts.some((l) => l.layer === layer), `no cutting layout for the ${layer} layer`);
  const directional = pkg.material.sheen === 'lustrous' || pkg.material.sheen === 'high' || /\bnap\b|\bpile\b|one[- ]way/i.test(pkg.material.description);

  for (const l of pkg.layouts) {
    const usable = l.fold === 'folded' ? l.fabricWidthCm / 2 : l.fabricWidthCm;
    m.check('coverage', Number.isFinite(l.lengthCm) && l.lengthCm > 0 && usable > 0, `${l.layer}: invalid layout length ${l.lengthCm} / width ${l.fabricWidthCm}`);
    m.check('efficiency', l.efficiency > 0 && l.efficiency <= 1, `${l.layer}: efficiency ${l.efficiency} outside (0, 1]`);
    if (l.layer === 'interfacing') {
      // Interfacing has no grain: strips should lie across the width, not waste metres along it.
      // bounding-box area: curved facings cannot nest perfectly, straight strips can
      const area = l.placements.reduce((a, pl) => {
        const b = bounds(byId.get(pl.pieceId)?.cutLine ?? []);
        return a + (b.maxX - b.minX) * (b.maxY - b.minY);
      }, 0);
      // a strip longer than the width cannot be turned: it needs its own length
      const need = Math.max(
        0,
        ...l.placements.map((pl) => {
          const b = bounds(byId.get(pl.pieceId)?.cutLine ?? []);
          const long = Math.max(b.maxX - b.minX, b.maxY - b.minY);
          const short = Math.min(b.maxX - b.minX, b.maxY - b.minY);
          return long <= usable ? short : long;
        }),
      );
      const limit = Math.max((2.5 * area) / usable + 20, need + 5);
      m.check('efficiency', l.lengthCm <= limit, `interfacing layout is ${f1(l.lengthCm)} cm long for ${f1(area)} cm² of piece bounding boxes (≤ ${f1(limit)} cm expected: turn strips across the width)`);
    }
    const placed: Array<{ key: string; poly: ReturnType<typeof applyPlacement>; pieceId: string; copy: number }> = [];
    for (const pl of l.placements) {
      const p = byId.get(pl.pieceId);
      m.check('coverage', !!p && p.layer === l.layer, `${l.layer}: placement of unknown or foreign piece "${pl.pieceId}"`);
      if (!p) continue;
      // Interfacing (non-woven fusible / sew-in) has no grain and may be turned.
      if (l.layer !== 'interfacing') {
        m.check('grain', pl.rotationDeg === 0 || pl.rotationDeg === 180, `${p.id} #${pl.copy}: rotated ${pl.rotationDeg}° — grainline no longer parallel to the selvedge`);
        const [g0, g1] = applyPlacement(p.grainline, pl);
        const ang = angleToLengthwise(g0, g1);
        m.check('grain', ang <= 1, `${p.id} #${pl.copy}: grainline is ${f1(ang)}° off the lengthwise grain`);
      }
      const poly = applyPlacement(p.cutLine, pl);
      const b = bounds(poly);
      m.check(
        'inside',
        b.minX >= -0.05 && b.maxX <= usable + 0.05 && b.minY >= -0.05 && b.maxY <= l.lengthCm + 0.05,
        `${p.id} #${pl.copy}: spans x ${f1(b.minX)}…${f1(b.maxX)} / y ${f1(b.minY)}…${f1(b.maxY)} outside the ${f1(usable)} × ${f1(l.lengthCm)} cm ${l.layer} fabric`,
      );
      placed.push({ key: `${p.id} #${pl.copy}`, poly, pieceId: p.id, copy: pl.copy });
    }
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const ov = overlapArea(placed[i].poly, placed[j].poly);
        m.check('overlap', ov <= 0.05, `${placed[i].key} overlaps ${placed[j].key} by ${f1(ov)} cm² on the ${l.layer} layout`);
      }
    }
    if (directional && l.layer === 'self') {
      const rots = new Set(l.placements.map((pl) => pl.rotationDeg));
      m.check('nap', rots.size <= 1, `${pkg.material.name} has a one-way sheen/nap but pieces are laid in both directions (${[...rots].join('° and ')}°): colours will look different`);
    }

    // copies: every piece yields exactly cutCount physical pieces
    for (const p of pkg.pieces.filter((x) => x.layer === l.layer)) {
      const pls = l.placements.filter((x) => x.pieceId === p.id);
      const foldEdges = p.edges.filter((e) => e.kind === 'fold');
      let yieldCount = 0;
      if (l.fold === 'folded') {
        for (const pl of pls) {
          if (p.cutOnFold) {
            const pts = foldEdges.flatMap((e) => applyPlacement(edgePoints(p.seamLine, e), pl));
            const onFold = pts.length > 0 && pts.every((q) => Math.abs(q.x) <= 0.05);
            m.check('fold', onFold, `${p.id} #${pl.copy}: "cut on fold" piece is not placed with its fold edge on the fabric fold`);
            yieldCount += 1;
          } else yieldCount += pl.singleLayer ? 1 : 2;
        }
        // An odd copy cut through both layers would give an extra piece: it must be marked single-layer.
        const ok = yieldCount === p.cutCount;
        m.check('copies', ok, `${p.id}: folded layout yields ${yieldCount} pieces but cutCount is ${p.cutCount}`);
      } else {
        if (p.cutOnFold) {
          const copies = new Map<number, typeof pls>();
          for (const pl of pls) copies.set(pl.copy, [...(copies.get(pl.copy) ?? []), pl]);
          for (const [copy, halves] of copies) {
            const okHalves = halves.length === 2 && halves[0].flipped !== halves[1].flipped;
            m.check('fold', okHalves, `${p.id} #${copy}: opened-out fold piece needs two mirrored halves, has ${halves.length}`);
            if (okHalves && foldEdges.length) {
              const a = foldEdges.flatMap((e) => applyPlacement(edgePoints(p.seamLine, e), halves[0]));
              const bLine = foldEdges.flatMap((e) => applyPlacement(edgePoints(p.seamLine, e), halves[1]));
              const gap = Math.max(...a.map((q) => distanceToPolyline(q, bLine)));
              m.check('fold', gap <= 0.1, `${p.id} #${copy}: the two halves do not meet at the fold line (gap ${f2(gap)} cm)`);
            }
          }
          yieldCount = copies.size;
        } else {
          yieldCount = pls.length;
          if (p.mirrorPair && p.cutCount % 2 === 0) {
            const flipped = pls.filter((x) => x.flipped).length;
            m.check('mirror', flipped === p.cutCount / 2, `${p.id}: mirror pair has ${flipped} of ${pls.length} copies flipped (left/right mismatch)`);
          }
        }
        const copyNums = new Set(pls.map((x) => x.copy));
        m.check('copies', yieldCount === p.cutCount && [...copyNums].every((c) => c >= 1 && c <= p.cutCount), `${p.id}: single layout yields ${yieldCount} pieces (copies ${[...copyNums].join(',')}) but cutCount is ${p.cutCount}`);
      }
    }

    // BOM covers the layout (plus pre-wash shrinkage on the main fabric)
    const kind = BOM_KIND_FOR_LAYER[l.layer];
    const items = pkg.bom.filter((b) => b.kind === kind);
    const metres = items.reduce((s, b) => s + bomMetres(b.quantity, b.unit), 0);
    const shrink = l.layer === 'self' ? pkg.material.shrinkagePct / 100 : 0;
    const need = (l.lengthCm / 100) * (1 + shrink);
    m.check('bom-waste', !(metres > need * 1.3 + 0.4), `BOM buys ${f2(metres)} m of ${kind} for a ${f2(need)} m layout (more than 30 % + 0.4 m spare)`);
    m.check('bom', items.length > 0 && Number.isFinite(metres) && metres + 0.005 >= need, `BOM buys ${f2(metres)} m of ${kind} but the ${l.layer} layout needs ${f2(need)} m${shrink ? ` (incl. ${pkg.material.shrinkagePct}% shrinkage)` : ''}`);
  }

  // BOM notions
  const text = (b: { name: string; spec?: string }) => `${b.name} ${b.spec ?? ''}`.toLowerCase();
  for (const b of pkg.bom) m.check('bom', Number.isFinite(b.quantity) && b.quantity > 0 && (b.estCostEur === undefined || b.estCostEur >= 0), `BOM item "${b.name}" has quantity ${b.quantity} / cost ${b.estCostEur}`);
  m.check('bom', pkg.bom.some((b) => b.kind === 'thread'), 'BOM lists no thread');
  if (pkg.seams.some((s) => ZIP_TYPES.has(s.type))) m.check('bom', pkg.bom.some((b) => b.kind === 'notion' && /zip/.test(text(b))), 'pattern has a zip but the BOM lists none');
  if (pkg.fit.options.closure === 'elastic') m.check('bom', pkg.bom.some((b) => /elastic/.test(text(b))), 'elastic waist but no elastic in the BOM');
  if (pkg.fit.options.closure === 'buttons') m.check('bom', pkg.bom.some((b) => /button/.test(text(b))), 'button closure but no buttons in the BOM');
  return m.result();
}

// ---------------------------------------------------------------------------
// (7) Instructions
// ---------------------------------------------------------------------------

/** Sewing jargon a beginner cannot be expected to know; each must be in the glossary if used. */
export const JARGON: ReadonlyArray<{ term: string; re: RegExp }> = [
  { term: 'staystitch', re: /\bstay-?stitch(?:es|ed|ing)?\b/i },
  { term: 'understitch', re: /\bunder-?stitch(?:es|ed|ing)?\b/i },
  { term: 'grainline', re: /\bgrain ?lines?\b/i },
  { term: 'selvedge', re: /\bselv[ae]ges?\b/i },
  { term: 'notch', re: /\bnotch(?:es|ed)?\b/i },
  { term: 'baste', re: /\bbast(?:e|es|ed|ing)\b/i },
  { term: 'clip', re: /\bclip(?:s|ped|ping)?\b/i },
  { term: 'grade', re: /\bgrad(?:e|es|ed|ing)\b/i },
  { term: 'ease', re: /\beas(?:e|es|ed|ing)\b/i },
  { term: 'dart', re: /\bdarts?\b/i },
  { term: 'facing', re: /\bfacings?\b/i },
  { term: 'interfacing', re: /\binterfacing\b/i },
  { term: 'bias', re: /\bbias\b/i },
  { term: 'topstitch', re: /\btop-?stitch(?:es|ed|ing)?\b/i },
  { term: 'edgestitch', re: /\bedge-?stitch(?:es|ed|ing)?\b/i },
  { term: 'overlock', re: /\boverlock(?:er|ed|ing)?\b|\bserger\b/i },
  { term: 'French seam', re: /\bfrench seams?\b/i },
  { term: 'slip stitch', re: /\bslip[- ]?stitch(?:es|ed|ing)?\b/i },
  { term: 'blind hem', re: /\bblind[- ]hem(?:s|med|ming)?\b/i },
  { term: "tailor's tack", re: /\btailor'?s? tacks?\b/i },
  { term: 'nap', re: /\bnap\b/i },
  { term: 'seam allowance', re: /\bseam allowances?\b/i },
  { term: 'muslin', re: /\bmuslin\b|\btoile\b/i },
  { term: 'apex', re: /\bapex\b/i },
];

const PHASE_ORDER = ['prepare', 'cut', 'mark', 'construct', 'fit', 'finish', 'press'] as const;

/** Sentences of a step body; each line and list item counts on its own. */
export function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''))
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9"(])/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function words(s: string): number {
  return s.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;
}

export function scoreInstructions(pkg: DesignPackage): MetricResult {
  const m = new MetricBuilder('instructions');
  m.aspect('readability', { weight: 0.75, minor: true });
  m.aspect('order', { penalty: 0.25 });
  const steps = pkg.instructions;
  m.check('steps', steps.length >= 8, `only ${steps.length} instruction steps`);
  steps.forEach((s, i) => {
    m.check('steps', s.n === i + 1, `step ${i + 1} is numbered ${s.n}`);
    m.check('steps', s.title.trim().length >= 3 && s.body.trim().length >= 20, `step ${s.n}: missing title or body too short`);
    m.check('steps', Number.isFinite(s.minutes) && s.minutes > 0, `step ${s.n}: invalid duration ${s.minutes}`);
  });

  // coverage
  const seamIds = new Set(pkg.seams.map((s) => s.id));
  const pieceIds = new Set(pkg.pieces.map((p) => p.id));
  const coveredSeams = new Set(steps.flatMap((s) => s.seamIds));
  const cutPieces = new Set(steps.filter((s) => s.phase === 'cut').flatMap((s) => s.pieceIds));
  for (const id of seamIds) m.check('coverage', coveredSeams.has(id), `seam "${id}" is not covered by any step`);
  for (const id of pieceIds) m.check('coverage', cutPieces.has(id), `piece "${id}" is not in any cut step`);
  for (const s of steps) {
    for (const id of s.seamIds) m.check('coverage', seamIds.has(id), `step ${s.n} references unknown seam "${id}"`);
    for (const id of s.pieceIds) m.check('coverage', pieceIds.has(id), `step ${s.n} references unknown piece "${id}"`);
  }

  // phase order: prepare < cut < mark < construction; fittings during/after construction; ends finishing
  const idx = (ph: string) => PHASE_ORDER.indexOf(ph as (typeof PHASE_ORDER)[number]);
  const lastOf = (ph: string) => steps.reduce((acc, s, i) => (s.phase === ph ? i : acc), -1);
  const firstOf = (ph: string) => steps.findIndex((s) => s.phase === ph);
  for (const s of steps) m.check('order', idx(s.phase) >= 0, `step ${s.n}: unknown phase "${s.phase}"`);
  const pairs: Array<[string, string]> = [
    ['prepare', 'cut'],
    ['cut', 'mark'],
    ['cut', 'construct'],
    ['mark', 'construct'],
  ];
  for (const [a, b] of pairs) {
    const la = lastOf(a);
    const fb = firstOf(b);
    if (la >= 0 && fb >= 0) m.check('order', la < fb, `a "${a}" step (#${la + 1}) comes after the first "${b}" step (#${fb + 1})`);
  }
  for (const ph of ['prepare', 'cut', 'construct'] as const) m.check('order', firstOf(ph) >= 0, `no "${ph}" phase`);
  const firstFit = firstOf('fit');
  m.check('order', firstFit > firstOf('construct'), firstFit < 0 ? 'no try-on ("fit") step' : 'a try-on step comes before any construction');
  const last = steps[steps.length - 1];
  m.check('order', !!last && (last.phase === 'finish' || last.phase === 'press'), `last step is "${last?.phase}", expected finish or press`);
  // seams follow their assembly stage
  const firstStep = new Map<string, number>();
  steps.forEach((s, i) => s.seamIds.forEach((id) => firstStep.has(id) || firstStep.set(id, i)));
  const staged = pkg.seams.filter((s) => firstStep.has(s.id)).sort((a, b) => a.stage - b.stage);
  let inversions = 0;
  let example = '';
  for (let i = 0; i < staged.length; i++) {
    for (let j = i + 1; j < staged.length; j++) {
      if (staged[i].stage < staged[j].stage && firstStep.get(staged[i].id)! > firstStep.get(staged[j].id)!) {
        inversions++;
        if (!example) example = `${staged[i].id} (stage ${staged[i].stage}) is sewn after ${staged[j].id} (stage ${staged[j].stage})`;
      }
    }
  }
  m.check('order', inversions === 0, `${inversions} seam pairs out of assembly order, e.g. ${example}`);
  m.check('checkpoints', steps.filter((s) => s.checkpoint && s.checkpoint.trim().length > 15).length >= 1, 'no try-on checkpoints');

  // glossary
  const gloss = new Map(Object.entries(pkg.glossary).map(([k, v]) => [k.toLowerCase(), v]));
  for (const [k, v] of gloss) m.check('glossary', typeof v === 'string' && v.trim().length >= 15, `glossary entry "${k}" has no real definition`);
  const missingTerms = new Set<string>();
  for (const s of steps) for (const t of s.terms) if (!gloss.has(t.toLowerCase())) missingTerms.add(t);
  for (const t of missingTerms) m.fail('glossary', `term "${t}" is tagged on a step but not defined in the glossary`);
  const allText = steps.map((s) => [s.title, s.body, ...s.tips, ...s.warnings, s.checkpoint ?? ''].join(' ')).join('\n');
  for (const j of JARGON) {
    if (!j.re.test(allText)) continue;
    const defined = [...gloss.keys()].some((k) => j.re.test(k));
    m.check('glossary', defined, `"${j.term}" is used in the instructions but not explained in the glossary`);
  }

  // readability
  const sents = steps.flatMap((s) => sentences(s.body));
  const wc = sents.map(words);
  const avg = wc.length ? wc.reduce((a, b) => a + b, 0) / wc.length : 0;
  m.check('readability', avg > 0 && avg <= 22, `average sentence length ${f1(avg)} words (beginner text should stay ≤ 22)`);
  const long = wc.filter((w) => w > 40).length;
  m.check('readability', long <= Math.max(1, Math.floor(0.05 * wc.length)), `${long} of ${wc.length} sentences exceed 40 words`);

  // novice safety nets (critic findings): things a first-time sewer gets wrong
  m.aspect('novice', { weight: 0.75 });
  const tools = pkg.bom.filter((b) => b.kind === 'tool').map((b) => b.name.toLowerCase());
  m.check('novice', tools.some((t) => /sewing machine/.test(t)), 'the tools list never says a sewing machine is needed');
  m.check('novice', tools.some((t) => /printer|paper/.test(t)), 'the tools list does not mention printing the pattern pages');
  m.check('novice', /needle/i.test(steps.flatMap((s) => s.warnings).join(' ')) && /iron/i.test(steps.flatMap((s) => s.warnings).join(' ')), 'no safety warning about the needle and the iron');
  const selfLayout = pkg.layouts.find((l) => l.layer === 'self');
  if (selfLayout?.fold === 'folded') {
    for (const p of pkg.pieces.filter((x) => x.layer === 'self' && !x.cutOnFold && x.cutCount % 2 === 1)) {
      const said = steps.some((st) => st.phase === 'cut' && new RegExp(`${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: cut[^\n]*ONE layer`, 'i').test(st.body));
      m.check('novice', said, `${p.name} is cut ${p.cutCount}× from folded fabric but the cut step never says to cut through one layer only`);
    }
  }
  for (const st of steps) {
    if (/\bhem\b/i.test(st.title)) m.check('novice', !/before pressing open|press(ing)? (the seam )?open/i.test(st.body), `step ${st.n} (${st.title}) tells you to press a hem "open"`);
    const pressAt = st.body.search(/press the seam allowances open/i);
    const finishAt = st.body.search(/Seam finish\b/);
    if (pressAt >= 0 && finishAt >= 0) m.check('novice', finishAt < pressAt, `step ${st.n}: the seam finish comes after pressing the seam open`);
  }
  const zipSeam = pkg.seams.find((s) => ZIP_TYPES.has(s.type));
  if (zipSeam) {
    for (const s of pkg.seams.filter((x) => x.b && x.a.pieceId === zipSeam.a.pieceId && x.a.edgeId === x.b.edgeId && x.a.pieceId === x.b.pieceId && /^(cb|cf)$/.test(x.a.edgeId))) {
      const st = steps.find((x) => x.seamIds.includes(s.id));
      m.check('novice', !st || !/^sew\b/i.test(st.title), `the ${s.a.edgeId} seam below the zip is sewn again in step ${st?.n} after the zip step already closed it`);
    }
  }
  const zipBom = pkg.bom.find((b) => /zip/i.test(b.name) && b.kind === 'notion');
  const zipNote = pkg.seams.map((s) => s.note ?? '').find((n) => /\b(\d+) cm (invisible|regular)/.test(n));
  if (zipBom && zipNote) {
    const drafted = /\b(\d+) cm (?:invisible|regular)/.exec(zipNote)![1];
    m.check('novice', (zipBom.spec ?? '').startsWith(`${drafted} cm`), `the pattern says to use a ${drafted} cm zip but the shopping list buys "${zipBom.spec}"`);
  }
  if (pkg.garment.id === 'ball-gown') {
    const bom = pkg.bom.map((b) => `${b.name} ${b.spec ?? ''}`).join(' ').toLowerCase();
    for (const need of ['horsehair', 'boning', 'petersham', 'petticoat']) m.check('novice', bom.includes(need), `the gown's shopping list has no ${need}`);
  }
  if (pkg.pieces.some((p) => p.edges.some((e) => e.id === 'wrap-edge'))) {
    m.check('novice', /wrap edge/i.test(allText) && pkg.bom.some((b) => /stay tape|clear elastic/i.test(b.name)), 'the bias wrap edge is never stayed (no stay tape step or notion)');
  }

  // material-specific handling appears in the steps
  const needle = pkg.material.handling.needle.toLowerCase();
  m.check('material', allText.toLowerCase().includes(needle) || allText.toLowerCase().includes(pkg.material.name.toLowerCase()), `instructions never mention ${pkg.material.name} or its needle (${pkg.material.handling.needle})`);
  m.check('effort', Number.isFinite(pkg.effort.minutes) && pkg.effort.minutes > 0 && pkg.effort.difficulty >= 1 && pkg.effort.difficulty <= 5, `effort ${JSON.stringify(pkg.effort)} invalid`);

  // markdown export carries every step
  const md = renderInstructionsMarkdown(pkg);
  const missingTitles = steps.filter((s) => !md.includes(s.title)).length;
  m.check('markdown', md.length > 200 && missingTitles === 0, `markdown export is missing ${missingTitles} step titles`);
  return m.result();
}

// ---------------------------------------------------------------------------
// (8) Presets integrity (global)
// ---------------------------------------------------------------------------

/** Trademarks / brand names that must never appear in presets (generic descriptions only). */
export const BRAND_NAMES: readonly string[] = [
  'tencel', 'lyocell®', 'lycra', 'gore-tex', 'goretex', 'polartec', 'thinsulate', 'coolmax', 'cordura', 'supplex', 'ultrasuede', 'alcantara',
  'bemberg', 'ecovero', 'lenzing', 'viyella', 'harris tweed', 'liberty', 'marimekko', 'unikko', 'chanel', 'dior', 'hermès', 'hermes', 'loro piana',
  'zegna', 'prada', 'gucci', 'armani', 'valentino', 'fendi', 'burberry', 'barbour', 'max mara', 'acne studios', 'ganni', 'filippa k', 'arket',
  'tiger of sweden', 'h&m', 'zara', 'iittala', 'dacron', 'terylene', 'crimplene', 'orlon', 'sensil', 'repreve', 'econyl', '™', '®',
];

const HEX = /^#[0-9a-f]{6}$/i;

export function scorePresets(): MetricResult {
  const m = new MetricBuilder('presets');
  const allTypes: GarmentType[] = ['a-line-skirt', 'pencil-skirt', 'circle-skirt', 'wide-leg-trousers', 'tapered-trousers', 'shell-top', 'shift-dress', 'sheath-dress', 'wrap-dress', 'column-gown', 'ball-gown'];
  const uniq = (label: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      m.check('ids', !seen.has(id), `duplicate ${label} id "${id}"`);
      seen.add(id);
    }
  };
  uniq('garment', GARMENTS.map((g) => g.id));
  uniq('material', MATERIALS.map((x) => x.id));
  uniq('style', STYLES.map((x) => x.id));
  for (const t of allTypes) m.check('coverage', GARMENTS.some((g) => g.id === t), `garment type ${t} has no definition`);
  m.check('coverage', MATERIALS.length >= 16, `only ${MATERIALS.length} materials (≥ 16)`);
  m.check('coverage', STYLES.length >= 8, `only ${STYLES.length} styles (≥ 8)`);
  for (const region of ['european', 'scandinavian'] as const) {
    m.check('coverage', STYLES.some((s) => s.region === region), `no ${region} style`);
    m.check('coverage', MATERIALS.some((x) => x.regions.includes(region)), `no ${region} material`);
  }

  const materialIds = new Set(MATERIALS.map((x) => x.id));
  for (const s of STYLES) {
    for (const id of s.recommendedMaterials) m.check('references', materialIds.has(id), `style ${s.id} recommends unknown material "${id}"`);
    for (const g of s.recommendedGarments) m.check('references', allTypes.includes(g), `style ${s.id} recommends unknown garment "${g}"`);
    m.check('palette', s.palette.length >= 3, `style ${s.id} palette has ${s.palette.length} colours (≥ 3)`);
    for (const c of s.palette) m.check('palette', HEX.test(c.hex) && c.name.trim().length > 0, `style ${s.id} colour "${c.name}" has invalid hex "${c.hex}"`);
    m.check('values', s.silhouette.hemFlareBias >= -1 && s.silhouette.hemFlareBias <= 1 && Math.abs(s.silhouette.easeModifierCm) <= 8, `style ${s.id} silhouette values out of range`);
  }
  for (const x of MATERIALS) {
    for (const g of x.suitableFor) m.check('references', allTypes.includes(g), `material ${x.id} lists unknown garment "${g}"`);
    m.check(
      'values',
      x.weightGsm > 0 && x.widthCm >= 90 && x.stiffness >= 0 && x.stiffness <= 1 && x.stretchPct >= 0 && x.stretchPct <= 100 && x.shrinkagePct >= 0 && x.shrinkagePct < 15 && x.pricePerMeterEur[0] <= x.pricePerMeterEur[1],
      `material ${x.id} has out-of-range numbers`,
    );
    m.check('values', HEX.test(x.render.baseColor), `material ${x.id} render colour "${x.render.baseColor}" is not #rrggbb`);
    m.check('values', x.construction !== 'knit' || x.stretchPct > 0, `knit ${x.id} has no stretch`);
  }
  for (const g of GARMENTS) {
    for (const key of ['length', 'sleeve', 'neckline', 'closure'] as const) {
      const allowed = g.allowed[key] as readonly string[];
      if (allowed.length) m.check('values', allowed.includes(g.defaults[key] as string), `garment ${g.id} default ${key} "${g.defaults[key]}" not in allowed list`);
    }
    for (const region of ['european', 'scandinavian'] as const) {
      const ok = MATERIALS.some((x) => x.regions.includes(region) && x.suitableFor.includes(g.id) && g.fabricTypes.includes(x.construction));
      m.check('coverage', ok, `no ${region} material suitable for ${g.id} in its fabric types (${g.fabricTypes.join('/')})`);
    }
  }

  // brand names anywhere in the catalogue
  const corpus = JSON.stringify({ GARMENTS, MATERIALS, STYLES }).toLowerCase();
  for (const b of BRAND_NAMES) {
    const re = new RegExp(`(^|[^a-z])${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`);
    m.check('brands', !re.test(corpus), `brand or trademark "${b}" appears in the presets`);
  }

  // lookups
  let threw = '';
  try {
    getGarment('no-such-garment');
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  m.check('lookups', threw.includes('a-line-skirt'), 'getGarment(unknown) does not throw an error listing the valid ids');
  try {
    getMaterial(MATERIALS[0].id);
    getStyle(STYLES[0].id);
  } catch (e) {
    m.fail('lookups', `lookup of a valid id threw: ${errorText(e)}`);
  }
  try {
    const rec = recommend({ garment: 'a-line-skirt' });
    m.check('lookups', rec.materials.length > 0 && rec.styles.length > 0 && rec.reasons.length > 0, 'recommend() returned empty results');
  } catch (e) {
    m.fail('lookups', `recommend() threw: ${errorText(e)}`);
  }
  return m.result();
}

// ---------------------------------------------------------------------------
// (9) 3D sanity
// ---------------------------------------------------------------------------

export function scoreMesh3D(pkg: DesignPackage): MetricResult {
  const m = new MetricBuilder('mesh3d');
  m.aspect('silhouette', { weight: 0.5 });
  const rings = [...pkg.silhouette.torso, ...(pkg.silhouette.leg ?? [])];
  const woven = pkg.material.construction === 'woven';
  m.check('silhouette', pkg.silhouette.torso.length >= 3, `only ${pkg.silhouette.torso.length} torso rings`);
  let inside = 0;
  for (const ring of rings) {
    const finite = [ring.heightCm, ring.circumferenceCm, ring.bodyCircumferenceCm, ring.depthRatio].every(Number.isFinite);
    m.check('silhouette', finite && ring.depthRatio > 0.3 && ring.depthRatio <= 1.2, `ring at ${f1(ring.heightCm)} cm has invalid values`);
    if (woven && ring.circumferenceCm < ring.bodyCircumferenceCm - 0.5) inside++;
  }
  m.check('silhouette', inside === 0, `${inside} woven silhouette rings are smaller than the body (fabric would sit inside the body)`);
  const t = pkg.silhouette.torso;
  m.check('silhouette', t.every((r, i) => i === 0 || r.heightCm < t[i - 1].heightCm), 'torso rings are not ordered top to bottom');

  const v = validateMeshes(pkg);
  m.check('validate', v.issues.length === 0, () => `validateMeshes: ${v.issues.slice(0, 4).join(' | ')}${v.issues.length > 4 ? ` (+${v.issues.length - 4})` : ''}`);
  for (const w of v.warnings.slice(0, 3)) m.note(`(warning) ${w}`);
  m.check('validate', v.stats.garmentVertices > 0 && v.stats.bodyVertices > 0, 'no body or garment vertices');

  const obj = exportOBJ(pkg);
  const vCount = (obj.match(/^v /gm) ?? []).length;
  const fCount = (obj.match(/^f /gm) ?? []).length;
  m.check('export', obj.length > 0 && vCount > 0 && fCount > 0, `OBJ export has ${vCount} vertices and ${fCount} faces`);
  m.check('export', !/NaN|Infinity/.test(obj), 'OBJ export contains NaN/Infinity');
  return m.result();
}

// ---------------------------------------------------------------------------
// (10) Determinism
// ---------------------------------------------------------------------------

/** First differing path between two JSON-like values, or null if equal. */
export function firstDifference(a: unknown, b: unknown, path = ''): string | null {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return `${path || '(root)'}: ${JSON.stringify(a)?.slice(0, 60)} vs ${JSON.stringify(b)?.slice(0, 60)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return `${path || '(root)'}: ${ka.length} vs ${kb.length} keys`;
  for (const k of ka) {
    const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
    if (d) return d;
  }
  return null;
}

/** Deep copy with every object's keys in reverse order (same data, different insertion order). */
export function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .reverse()
        .map((k) => [k, reverseKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export function scoreDeterminism(request: DesignRequest, first: DesignPackage): MetricResult {
  const m = new MetricBuilder('determinism');
  const again = design(structuredClone(request));
  const diff = firstDifference(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(again)));
  m.check('repeat', diff === null, `design(request) twice differs at ${diff}`);
  m.check('id', first.id === again.id && /^[0-9a-z]{6,}$/i.test(first.id), `package id "${first.id}" is unstable or not a hash`);
  const reordered = design(reverseKeys(request) as DesignRequest);
  m.check('repeat', JSON.stringify(reordered.pieces) === JSON.stringify(first.pieces), 'pieces depend on the key order of the request object');
  return m.result();
}

// ---------------------------------------------------------------------------
// (11) SVG validity
// ---------------------------------------------------------------------------

const PAPER_MM = { A4: { w: 210, h: 297 }, letter: { w: 215.9, h: 279.4 } } as const;

function textOf(root: XmlElement): string {
  return (root.textContent ?? '').toLowerCase();
}

export function scoreSvg(pkg: DesignPackage): MetricResult {
  const m = new MetricBuilder('svg');
  const seen = new Set<string>();
  for (const p of pkg.pieces) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const r = parseXml(renderPieceSVG(p));
    m.check('pieces', r.ok, () => `${p.id}: piece SVG invalid — ${r.errors.slice(0, 2).join('; ')}`);
  }
  const sheet = parseXml(renderPatternSheetSVG(pkg));
  m.check('sheet', sheet.ok, () => `pattern sheet invalid — ${sheet.errors.slice(0, 2).join('; ')}`);
  if (sheet.root) {
    // Pieces with an identical outline (e.g. a facing and its interfacing) may share one drawing,
    // as long as the drawing's labels say which other layer is cut from it.
    const txt = textOf(sheet.root);
    const outline = (p: PatternPiece) => JSON.stringify(p.cutLine.map((q) => [Math.round(q.x * 10), Math.round(q.y * 10)]));
    const groups = new Map<string, PatternPiece[]>();
    for (const p of pkg.pieces) groups.set(outline(p), [...(groups.get(outline(p)) ?? []), p]);
    const missing: string[] = [];
    for (const group of groups.values()) {
      const labelled = group.filter((p) => txt.includes(p.name.toLowerCase()));
      for (const p of group) {
        if (labelled.includes(p)) continue;
        const sharedOk = labelled.length > 0 && (p.layer === labelled[0].layer || txt.includes(p.layer));
        if (!sharedOk) missing.push(p.id);
      }
    }
    m.check('sheet', missing.length === 0, `pattern sheet does not label pieces: ${missing.join(', ')}`);
  }
  for (const l of pkg.layouts) {
    const r = parseXml(renderCuttingLayoutSVG(pkg, l.layer));
    m.check('layout', r.ok, () => `${l.layer} cutting layout SVG invalid — ${r.errors.slice(0, 2).join('; ')}`);
  }

  const uniqueArea = [...new Map(pkg.pieces.map((p) => [p.id, p])).values()].reduce((s, p) => s + area(p.cutLine), 0) * 100; // mm²
  for (const paper of ['A4', 'letter'] as const) {
    const pages = renderTiledPrintPages(pkg, { paper });
    m.check('print', pages.length > 0, `${paper}: no print pages`);
    const size = PAPER_MM[paper];
    const printable = (size.w - 20) * (size.h - 20);
    const minPages = Math.ceil(uniqueArea / printable);
    m.check('print', pages.length >= minPages, `${paper}: ${pages.length} pages cannot hold ${f1(uniqueArea / 100)} cm² of pattern at 1:1 (≥ ${minPages} needed)`);
    let bad = 0;
    pages.forEach((page, i) => {
      const r = parseXml(page);
      if (!r.ok || !r.root) {
        bad++;
        if (bad === 1) m.fail('print', `${paper} page ${i + 1} invalid — ${r.errors.slice(0, 2).join('; ')}`);
        return;
      }
      const w = lengthMm(r.root.getAttribute('width'));
      const h = lengthMm(r.root.getAttribute('height'));
      const vb = (r.root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
      const okSize = Math.abs(w - size.w) < 0.5 && Math.abs(h - size.h) < 0.5 && vb.length === 4 && Math.abs(vb[2] - w) < 0.5 && Math.abs(vb[3] - h) < 0.5;
      if (!okSize && bad === 0) m.fail('scale', `${paper} page ${i + 1} is ${r.root.getAttribute('width')} × ${r.root.getAttribute('height')} with viewBox "${vb.join(' ')}" (expected ${size.w} × ${size.h} mm, 1 unit = 1 mm)`);
      if (i === 0) {
        let square = false;
        let scaled10 = false;
        walk(r.root, (el, s) => {
          if (el.tagName === 'rect') {
            const rw = Number(el.getAttribute('width')) * s;
            const rh = Number(el.getAttribute('height')) * s;
            if (Math.abs(rw - 50) < 0.01 && Math.abs(rh - 50) < 0.01) square = true;
          }
          if (Math.abs(s - 10) < 1e-6) scaled10 = true;
        });
        m.check('scale', square, `${paper} page 1 has no 50 × 50 mm (5 cm) test square`);
        m.check('scale', scaled10, `${paper} page 1 draws no pattern content at 1 cm = 10 mm`);
      }
    });
    if (bad > 1) m.fail('print', `${paper}: ${bad} of ${pages.length} pages are invalid XML`);
  }
  return m.result();
}

// ---------------------------------------------------------------------------
// Case scoring
// ---------------------------------------------------------------------------

export const CASE_METRICS: readonly MetricId[] = ['geometry', 'seams', 'fit', 'wearability', 'proportion', 'layout', 'instructions'];
export const DEEP_METRICS: readonly MetricId[] = ['mesh3d', 'determinism', 'svg'];

/** Run all per-case scorers on a package; a scorer that throws scores 0 with the error as detail. */
export function scorePackage(request: DesignRequest, pkg: DesignPackage, deep: boolean): MetricResult[] {
  const runners: Record<Exclude<MetricId, 'presets'>, () => MetricResult> = {
    geometry: () => scoreGeometry(pkg),
    seams: () => scoreSeams(pkg),
    fit: () => scoreFit(pkg),
    wearability: () => scoreWearability(pkg),
    proportion: () => scoreProportion(pkg),
    layout: () => scoreLayout(pkg),
    instructions: () => scoreInstructions(pkg),
    mesh3d: () => scoreMesh3D(pkg),
    determinism: () => scoreDeterminism(request, pkg),
    svg: () => scoreSvg(pkg),
  };
  const ids: MetricId[] = [...CASE_METRICS, ...(deep ? DEEP_METRICS : [])];
  return ids.map((id) => {
    try {
      return runners[id as Exclude<MetricId, 'presets'>]();
    } catch (err) {
      return crashedMetric(id, err);
    }
  });
}

