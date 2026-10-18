/**
 * Geometry helpers for the evaluation harness.
 *
 * Deliberately independent of `src/core/geometry.ts`: the eval is the
 * objective gate for the drafting engine, so it must not share (and inherit
 * the bugs of) the code it is judging. Polygon booleans go through
 * `clipper-lib` (integer coordinates, cm × 1000); everything else is small,
 * well-known computational geometry written out here.
 *
 * Conventions (types.ts): centimetres, x right, y DOWN; closed paths do not
 * repeat their first point; in y-down space a visually clockwise polygon has
 * a positive shoelace sum.
 */
import ClipperLib from 'clipper-lib';
import type { CuttingPlacement, Path, PatternEdge, Point } from '../src/core/types';

const SCALE = 1000;

export function isFinitePoint(p: Point): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Shoelace sum / 2. Positive = clockwise on screen (y down). */
export function signedArea(p: Path): number {
  let s = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function area(p: Path): number {
  return Math.abs(signedArea(p));
}

export function bounds(p: Path): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const q of p) {
    if (q.x < minX) minX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.x > maxX) maxX = q.x;
    if (q.y > maxY) maxY = q.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Length along a closed path from vertex `from` to vertex `to`, following the
 * path order and wrapping past the last vertex (so an edge ending at index 0
 * includes the implicit closing segment).
 */
export function edgeLength(p: Path, from: number, to: number): number {
  const n = p.length;
  if (n < 2) return 0;
  let s = 0;
  let i = from;
  for (let guard = 0; i !== to && guard < n; guard++) {
    const j = (i + 1) % n;
    s += distance(p[i], p[j]);
    i = j;
  }
  return s;
}

/** Number of segments an edge spans (from -> to, wrapping). */
export function edgeSpan(n: number, e: Pick<PatternEdge, 'from' | 'to'>): number {
  return (((e.to - e.from) % n) + n) % n;
}

/** Vertices of an edge, inclusive of both ends. */
export function edgePoints(p: Path, e: Pick<PatternEdge, 'from' | 'to'>): Path {
  const n = p.length;
  const out: Path = [];
  const span = edgeSpan(n, e);
  for (let k = 0; k <= span; k++) out.push(p[(e.from + k) % n]);
  return out;
}

function orient(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Point, b: Point, q: Point, eps: number): boolean {
  return (
    Math.min(a.x, b.x) - eps <= q.x &&
    q.x <= Math.max(a.x, b.x) + eps &&
    Math.min(a.y, b.y) - eps <= q.y &&
    q.y <= Math.max(a.y, b.y) + eps
  );
}

/** Closed-segment intersection test (touching and collinear overlap count). */
export function segmentsTouch(a: Point, b: Point, c: Point, d: Point): boolean {
  const scaleTol = 1e-9 * Math.max(1, Math.abs(a.x), Math.abs(a.y), Math.abs(c.x), Math.abs(c.y));
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  if (((d1 > scaleTol && d2 < -scaleTol) || (d1 < -scaleTol && d2 > scaleTol)) && ((d3 > scaleTol && d4 < -scaleTol) || (d3 < -scaleTol && d4 > scaleTol))) {
    return true;
  }
  const eps = 1e-7;
  if (Math.abs(d1) <= scaleTol && onSegment(c, d, a, eps)) return true;
  if (Math.abs(d2) <= scaleTol && onSegment(c, d, b, eps)) return true;
  if (Math.abs(d3) <= scaleTol && onSegment(a, b, c, eps)) return true;
  if (Math.abs(d4) <= scaleTol && onSegment(a, b, d, eps)) return true;
  return false;
}

export interface SimplicityReport {
  ok: boolean;
  /** Human-readable reasons (first few). */
  problems: string[];
}

/**
 * Is a closed polygon simple? Checks: >= 3 vertices, finite coordinates, no
 * zero-length segments, no zero-width spikes (a segment doubling straight back
 * on the previous one) and no two non-adjacent segments touching. Uses an
 * x-sorted sweep with y-interval pruning, O(n log n + k).
 */
export function checkSimple(p: Path, maxProblems = 3): SimplicityReport {
  const problems: string[] = [];
  const n = p.length;
  if (n < 3) return { ok: false, problems: [`only ${n} vertices`] };
  const bad = p.findIndex((q) => !isFinitePoint(q));
  if (bad >= 0) return { ok: false, problems: [`vertex ${bad} is not finite (${p[bad].x}, ${p[bad].y})`] };
  for (let i = 0; i < n && problems.length < maxProblems; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    if (distance(a, b) < 1e-6) problems.push(`zero-length segment at vertex ${i}`);
  }
  for (let i = 0; i < n && problems.length < maxProblems; i++) {
    const a = p[(i - 1 + n) % n];
    const b = p[i];
    const c = p[(i + 1) % n];
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const vx = c.x - b.x;
    const vy = c.y - b.y;
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    if (lu < 1e-6 || lv < 1e-6) continue;
    const cos = (ux * vx + uy * vy) / (lu * lv);
    if (cos < -0.99999) problems.push(`zero-width spike at vertex ${i} (${b.x.toFixed(2)}, ${b.y.toFixed(2)})`);
  }
  if (problems.length) return { ok: false, problems };

  const segs = Array.from({ length: n }, (_, i) => {
    const a = p[i];
    const b = p[(i + 1) % n];
    return { i, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) };
  }).sort((s, t) => s.minX - t.minX || s.i - t.i);
  let active: typeof segs = [];
  for (const s of segs) {
    active = active.filter((t) => t.maxX >= s.minX - 1e-9);
    for (const t of active) {
      if (t.maxY < s.minY - 1e-9 || s.maxY < t.minY - 1e-9) continue;
      const i = s.i;
      const j = t.i;
      const gap = Math.abs(i - j);
      if (gap === 0 || gap === 1 || gap === n - 1) continue;
      if (segmentsTouch(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) {
        const q = p[i];
        problems.push(`segments ${Math.min(i, j)} and ${Math.max(i, j)} cross near (${q.x.toFixed(2)}, ${q.y.toFixed(2)})`);
        if (problems.length >= maxProblems) return { ok: false, problems };
      }
    }
    active.push(s);
  }
  return { ok: problems.length === 0, problems };
}

/** Even-odd point-in-polygon. */
export function pointInPolygon(q: Point, poly: Path): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function distanceToSegment(q: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2));
  return Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy));
}

/** Distance from a point to an open polyline. */
export function distanceToPolyline(q: Point, line: Path): number {
  if (line.length === 1) return distance(q, line[0]);
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) best = Math.min(best, distanceToSegment(q, line[i], line[i + 1]));
  return best;
}

/** Distance from a point to the boundary of a closed polygon. */
export function distanceToBoundary(q: Point, poly: Path): number {
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) best = Math.min(best, distanceToSegment(q, poly[i], poly[(i + 1) % n]));
  return best;
}

/**
 * Horizontal extent of a polygon at height `y`: [min x, max x] of all boundary
 * crossings, or null if the line misses the polygon.
 */
export function extentAtY(poly: Path, y: number): { minX: number; maxX: number } | null {
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if ((a.y - y) * (b.y - y) > 0 || a.y === b.y) {
      if (a.y === y) {
        minX = Math.min(minX, a.x);
        maxX = Math.max(maxX, a.x);
      }
      continue;
    }
    const x = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  }
  return Number.isFinite(minX) ? { minX, maxX } : null;
}

// ---------------------------------------------------------------------------
// Clipper bridge
// ---------------------------------------------------------------------------

function toClipper(p: Path): ClipperLib.Path {
  return p.map((q) => ({ X: Math.round(q.x * SCALE), Y: Math.round(q.y * SCALE) }));
}

function solutionArea(sol: ClipperLib.Paths): number {
  // Holes come back with opposite orientation, so the signed sum is the net area.
  return Math.abs(sol.reduce((s, poly) => s + ClipperLib.Clipper.Area(poly), 0)) / (SCALE * SCALE);
}

function boolean(a: Path, b: Path, op: ClipperLib.ClipType): number {
  if (a.length < 3 || b.length < 3) return op === ClipperLib.ClipType.ctDifference ? area(a) : 0;
  const c = new ClipperLib.Clipper();
  c.AddPath(toClipper(a), ClipperLib.PolyType.ptSubject, true);
  c.AddPath(toClipper(b), ClipperLib.PolyType.ptClip, true);
  const sol: ClipperLib.Paths = [];
  c.Execute(op, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return solutionArea(sol);
}

/** Area (cm²) of a ∩ b. */
export function intersectionArea(a: Path, b: Path): number {
  return boolean(a, b, ClipperLib.ClipType.ctIntersection);
}

/** Area (cm²) of a \ b — the part of `a` lying outside `b`. */
export function differenceArea(a: Path, b: Path): number {
  return boolean(a, b, ClipperLib.ClipType.ctDifference);
}

/** Fast bounding-box rejection followed by an exact Clipper intersection. */
export function overlapArea(a: Path, b: Path): number {
  const ba = bounds(a);
  const bb = bounds(b);
  if (ba.maxX <= bb.minX || bb.maxX <= ba.minX || ba.maxY <= bb.minY || bb.maxY <= ba.minY) return 0;
  return intersectionArea(a, b);
}

// ---------------------------------------------------------------------------
// Cutting placements
// ---------------------------------------------------------------------------

/**
 * Placement transform documented on `CuttingPlacement`: mirror x when
 * `flipped`, rotate by `rotationDeg` about the origin (y-down), translate.
 */
export function applyPlacement(path: Path, pl: Pick<CuttingPlacement, 'x' | 'y' | 'rotationDeg' | 'flipped'>): Path {
  const rad = (pl.rotationDeg * Math.PI) / 180;
  const c = Math.round(Math.cos(rad));
  const s = Math.round(Math.sin(rad));
  return path.map((p) => {
    const fx = pl.flipped ? -p.x : p.x;
    return { x: fx * c - p.y * s + pl.x, y: fx * s + p.y * c + pl.y };
  });
}

/** Angle (degrees, 0..90) between a direction and the fabric's lengthwise (y) axis. */
export function angleToLengthwise(a: Point, b: Point): number {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}
