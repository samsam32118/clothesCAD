/**
 * Pure 2D geometry helpers for pattern drafting.
 *
 * Conventions (see types.ts): centimetres, x grows right, y grows DOWN.
 * A "closed path" is a polygon whose last point is NOT a repeat of the first;
 * the closing segment (last -> first) is implicit.
 * In y-down space a visually clockwise polygon has a POSITIVE shoelace area
 * (see `signedArea`).
 */
import type { Path, Point } from './types';

export const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Deterministic short hash (cyrb53 variant) rendered as 12 lowercase hex chars.
 * Stable across platforms and runs; not cryptographic.
 */
export function hashString(s: string): string {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hi = (h2 >>> 0).toString(16).padStart(8, '0');
  const lo = (h1 >>> 0).toString(16).padStart(8, '0');
  return (hi + lo).slice(0, 12);
}

// ---------------------------------------------------------------------------
// Vector basics
// ---------------------------------------------------------------------------

export const pt = (x: number, y: number): Point => ({ x, y });
export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
export const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x;
export const len = (a: Point): number => Math.hypot(a.x, a.y);
export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export const mid = (a: Point, b: Point): Point => lerp(a, b, 0.5);

export function normalize(a: Point): Point {
  const l = len(a);
  return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** Unit direction from a to b. */
export const dir = (a: Point, b: Point): Point => normalize(sub(b, a));

/**
 * Left-hand normal of a direction in y-down space: for a clockwise polygon
 * (positive signedArea) this points OUTWARD of the polygon.
 */
export const outwardNormal = (d: Point): Point => normalize({ x: d.y, y: -d.x });

/** Rotate `p` by `angle` radians about `about` (positive = visually clockwise in y-down). */
export function rotate(p: Point, angle: number, about: Point = { x: 0, y: 0 }): Point {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = p.x - about.x;
  const dy = p.y - about.y;
  return { x: about.x + dx * c - dy * s, y: about.y + dx * s + dy * c };
}

/** Signed angle (radians) that rotates direction u onto direction v (using `rotate` convention). */
export function angleBetween(u: Point, v: Point): number {
  return Math.atan2(cross(u, v), dot(u, v));
}

export const round = (v: number, digits = 2): number => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// Path measures
// ---------------------------------------------------------------------------

/**
 * Length of a path.
 * - Without indices: length of the OPEN polyline p[0] -> p[n-1].
 * - With `from`/`to`: length along the path from index `from` to index `to`.
 *   If `to < from` the path is treated as CLOSED and the walk wraps through the
 *   implicit closing segment (this is how the last edge of a pattern piece,
 *   which ends at seamLine[0], is measured).
 */
export function pathLength(p: Path, from?: number, to?: number): number {
  const n = p.length;
  if (n < 2) return 0;
  if (from === undefined && to === undefined) {
    let s = 0;
    for (let i = 1; i < n; i++) s += dist(p[i - 1], p[i]);
    return s;
  }
  const a = from ?? 0;
  const b = to ?? n - 1;
  let s = 0;
  if (b >= a) {
    for (let i = a + 1; i <= b; i++) s += dist(p[i - 1], p[i]);
  } else {
    for (let i = a + 1; i < n; i++) s += dist(p[i - 1], p[i]);
    s += dist(p[n - 1], p[0]);
    for (let i = 1; i <= b; i++) s += dist(p[i - 1], p[i]);
  }
  return s;
}

/** Perimeter of a closed path (includes the implicit closing segment). */
export function closedPathLength(p: Path): number {
  if (p.length < 2) return 0;
  return pathLength(p) + dist(p[p.length - 1], p[0]);
}

/** Points of a closed path from index `from` to `to` inclusive (wrapping if to < from). */
export function slicePath(p: Path, from: number, to: number): Path {
  if (to >= from) return p.slice(from, to + 1);
  return [...p.slice(from), ...p.slice(0, to + 1)];
}

/** Shoelace area; positive for visually clockwise polygons in y-down space. */
export function signedArea(p: Path): number {
  let s = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Absolute polygon area (cm²). */
export function polygonArea(p: Path): number {
  return Math.abs(signedArea(p));
}

export function polygonCentroid(p: Path): Point {
  const a = signedArea(p);
  if (Math.abs(a) < EPS) {
    const b = pathBounds(p);
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const q = p[i];
    const r = p[(i + 1) % n];
    const f = q.x * r.y - r.x * q.y;
    cx += (q.x + r.x) * f;
    cy += (q.y + r.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function pathBounds(p: Path): { minX: number; minY: number; maxX: number; maxY: number } {
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
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

export function pointInPolygon(q: Point, poly: Path): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance from q to segment ab. */
export function distToSegment(q: Point, a: Point, b: Point): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < EPS) return dist(q, a);
  const t = clamp(dot(sub(q, a), ab) / l2, 0, 1);
  return dist(q, lerp(a, b, t));
}

/** Shortest distance from q to a closed polygon outline. */
export function distToPolygon(q: Point, poly: Path): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    d = Math.min(d, distToSegment(q, poly[i], poly[(i + 1) % poly.length]));
  }
  return d;
}

/**
 * A point well inside a polygon (approximate pole of inaccessibility via grid
 * search + refinement). Used to place labels.
 */
export function interiorPoint(poly: Path, avoid: Point[] = []): Point {
  const b = pathBounds(poly);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  let best = polygonCentroid(poly);
  let bestScore = pointInPolygon(best, poly) ? score(best) : -Infinity;
  function score(q: Point): number {
    let s = distToPolygon(q, poly);
    for (const a of avoid) s = Math.min(s, dist(q, a) * 0.8);
    return s;
  }
  const steps = 24;
  for (let i = 1; i < steps; i++) {
    for (let j = 1; j < steps; j++) {
      const q = { x: b.minX + (w * i) / steps, y: b.minY + (h * j) / steps };
      if (!pointInPolygon(q, poly)) continue;
      const s = score(q);
      if (s > bestScore) {
        bestScore = s;
        best = q;
      }
    }
  }
  // local refinement
  let step = Math.max(w, h) / steps / 2;
  for (let k = 0; k < 12; k++) {
    let improved = false;
    for (const [dx, dy] of [
      [step, 0],
      [-step, 0],
      [0, step],
      [0, -step],
    ]) {
      const q = { x: best.x + dx, y: best.y + dy };
      if (!pointInPolygon(q, poly)) continue;
      const s = score(q);
      if (s > bestScore) {
        bestScore = s;
        best = q;
        improved = true;
      }
    }
    if (!improved) step /= 2;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Path transforms
// ---------------------------------------------------------------------------

export const translatePath = (p: Path, dx: number, dy: number): Path =>
  p.map((q) => ({ x: q.x + dx, y: q.y + dy }));

export const rotatePath = (p: Path, angle: number, about: Point = { x: 0, y: 0 }): Path =>
  p.map((q) => rotate(q, angle, about));

/** Mirror across the vertical line x = x0. */
export const mirrorPathX = (p: Path, x0 = 0): Path => p.map((q) => ({ x: 2 * x0 - q.x, y: q.y }));

/** Mirror across the horizontal line y = y0. */
export const mirrorPathY = (p: Path, y0 = 0): Path => p.map((q) => ({ x: q.x, y: 2 * y0 - q.y }));

export const reversePath = (p: Path): Path => [...p].reverse();

/** Remove consecutive near-duplicate points (and a trailing repeat of the first point when closed). */
export function dedupe(p: Path, tol = 1e-6, closed = false): Path {
  const out: Path = [];
  for (const q of p) {
    if (out.length === 0 || dist(out[out.length - 1], q) > tol) out.push(q);
  }
  if (closed && out.length > 1 && dist(out[0], out[out.length - 1]) <= tol) out.pop();
  return out;
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * Insert points so no segment is longer than `maxSeg`, keeping every original
 * vertex (corners are preserved). Open polyline.
 */
export function densify(p: Path, maxSeg = 0.5): Path {
  if (p.length < 2) return [...p];
  const out: Path = [p[0]];
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    const d = dist(a, b);
    const n = Math.max(1, Math.ceil(d / maxSeg - 1e-9));
    for (let k = 1; k <= n; k++) out.push(lerp(a, b, k / n));
  }
  return out;
}

/**
 * Resample an open polyline to evenly spaced points by arc length with spacing
 * <= `spacing`. Endpoints are kept; interior corners may be smoothed slightly.
 */
export function resample(p: Path, spacing = 0.5): Path {
  const total = pathLength(p);
  if (p.length < 2 || total < EPS) return [...p];
  const n = Math.max(1, Math.ceil(total / spacing - 1e-9));
  const out: Path = [];
  for (let k = 0; k <= n; k++) out.push(pointAtLength(p, (total * k) / n).point);
  return out;
}

/** Point at arc length s along an open polyline (clamped), with segment index and local t. */
export function pointAtLength(p: Path, s: number): { point: Point; index: number; t: number } {
  if (p.length === 0) return { point: { x: 0, y: 0 }, index: 0, t: 0 };
  if (s <= 0) return { point: { ...p[0] }, index: 0, t: 0 };
  let acc = 0;
  for (let i = 1; i < p.length; i++) {
    const d = dist(p[i - 1], p[i]);
    if (acc + d >= s) {
      const t = d < EPS ? 0 : (s - acc) / d;
      return { point: lerp(p[i - 1], p[i], t), index: i - 1, t };
    }
    acc += d;
  }
  return { point: { ...p[p.length - 1] }, index: p.length - 2, t: 1 };
}

/** Unit tangent at arc length s. */
export function tangentAtLength(p: Path, s: number): Point {
  const { index } = pointAtLength(p, s);
  const i = clamp(index, 0, p.length - 2);
  return dir(p[i], p[i + 1]);
}

/** Split an open polyline at arc length s into [before, after] (both include the split point). */
export function splitAtLength(p: Path, s: number): [Path, Path] {
  const { point, index } = pointAtLength(p, s);
  const a = [...p.slice(0, index + 1), point];
  const b = [point, ...p.slice(index + 1)];
  return [dedupe(a), dedupe(b)];
}

/** Sub-polyline between arc lengths s0 < s1. */
export function subPath(p: Path, s0: number, s1: number): Path {
  const [, rest] = splitAtLength(p, s0);
  const [mid] = splitAtLength(rest, s1 - s0);
  return mid;
}

/**
 * Insert vertices at the given arc lengths (sorted or not) and return the new
 * path plus the index of each inserted vertex (in input order).
 */
export function insertAtLengths(p: Path, lengths: number[]): { path: Path; indices: number[] } {
  const order = lengths.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s);
  const path: Path = [p[0]];
  const indices = new Array<number>(lengths.length).fill(0);
  let acc = 0;
  let k = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    const d = dist(a, b);
    while (k < order.length && order[k].s <= acc + d + 1e-9) {
      const t = d < EPS ? 0 : clamp((order[k].s - acc) / d, 0, 1);
      const q = lerp(a, b, t);
      if (dist(path[path.length - 1], q) > 1e-6) path.push(q);
      indices[order[k].i] = path.length - 1;
      k++;
    }
    if (dist(path[path.length - 1], b) > 1e-6) path.push(b);
    acc += d;
  }
  while (k < order.length) {
    indices[order[k].i] = path.length - 1;
    k++;
  }
  return { path, indices };
}

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/** Cubic Bezier flattened to points <= maxSeg apart (arc-length even). */
export function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, maxSeg = 0.5): Path {
  const coarse = Math.max(16, Math.ceil((dist(p0, p1) + dist(p1, p2) + dist(p2, p3)) / 0.1));
  const pts: Path = [];
  for (let i = 0; i <= coarse; i++) {
    const t = i / coarse;
    const u = 1 - t;
    pts.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return resample(pts, maxSeg);
}

export function quadBezier(p0: Point, p1: Point, p2: Point, maxSeg = 0.5): Path {
  return cubicBezier(p0, lerp(p0, p1, 2 / 3), lerp(p2, p1, 2 / 3), p2, maxSeg);
}

/** Circular arc from angle a0 to a1 (radians, y-down convention) around center. */
export function arc(center: Point, r: number, a0: number, a1: number, maxSeg = 0.5): Path {
  const sweep = a1 - a0;
  const n = Math.max(2, Math.ceil((Math.abs(sweep) * r) / maxSeg));
  const out: Path = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  return out;
}

/**
 * Smooth curve through `points` (cubic Hermite / Catmull-Rom). Optional unit
 * end tangents fix the direction at the first / last point.
 */
export function splineThrough(
  points: Point[],
  opts: { startTangent?: Point; endTangent?: Point; maxSeg?: number; tension?: number } = {},
): Path {
  const maxSeg = opts.maxSeg ?? 0.5;
  const k = opts.tension ?? 0.5;
  const n = points.length;
  if (n < 2) return [...points];
  const tangents: Point[] = points.map((_p, i) => {
    if (i === 0) {
      const chord = dist(points[0], points[1]);
      return opts.startTangent ? scale(normalize(opts.startTangent), chord) : sub(points[1], points[0]);
    }
    if (i === n - 1) {
      const chord = dist(points[n - 2], points[n - 1]);
      return opts.endTangent ? scale(normalize(opts.endTangent), chord) : sub(points[n - 1], points[n - 2]);
    }
    const t = sub(points[i + 1], points[i - 1]);
    return scale(t, k);
  });
  const out: Path = [points[0]];
  for (let i = 0; i < n - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const c1 = add(a, scale(tangents[i], 1 / 3));
    const c2 = sub(b, scale(tangents[i + 1], 1 / 3));
    const seg = cubicBezier(a, c1, c2, b, maxSeg);
    out.push(...seg.slice(1));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Intersections
// ---------------------------------------------------------------------------

/** Intersection of infinite lines p + t*d and q + s*e; null if parallel. */
export function lineIntersection(p: Point, d: Point, q: Point, e: Point): Point | null {
  const den = cross(d, e);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross(sub(q, p), e) / den;
  return add(p, scale(d, t));
}

/** Intersection point of segments ab and cd (inclusive of endpoints), or null. */
export function segmentIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-12) return null;
  const qp = sub(c, a);
  const t = cross(qp, s) / den;
  const u = cross(qp, r) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return add(a, scale(r, t));
}

function onSegment(p: Point, q: Point, r: Point): boolean {
  return (
    Math.min(p.x, r.x) - 1e-12 <= q.x &&
    q.x <= Math.max(p.x, r.x) + 1e-12 &&
    Math.min(p.y, r.y) - 1e-12 <= q.y &&
    q.y <= Math.max(p.y, r.y) + 1e-12
  );
}

function orient(p: Point, q: Point, r: Point): number {
  const v = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  if (Math.abs(v) < 1e-12) return 0;
  return v > 0 ? 1 : 2;
}

/** True when segments ab and cd touch or cross (collinear overlap counts). */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, c, b)) return true;
  if (o2 === 0 && onSegment(a, d, b)) return true;
  if (o3 === 0 && onSegment(c, a, d)) return true;
  if (o4 === 0 && onSegment(c, b, d)) return true;
  return false;
}

/**
 * Pairs of non-adjacent segments of a closed polygon that intersect.
 * Sweep over x with bounding boxes; returns at most `limit` pairs.
 */
export function selfIntersections(p: Path, limit = 1): Array<[number, number]> {
  const n = p.length;
  const out: Array<[number, number]> = [];
  if (n < 4) return out;
  const segs = Array.from({ length: n }, (_, i) => {
    const a = p[i];
    const b = p[(i + 1) % n];
    return { i, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) };
  }).sort((s, t) => s.minX - t.minX);
  const active: typeof segs = [];
  for (const s of segs) {
    for (let k = active.length - 1; k >= 0; k--) {
      if (active[k].maxX < s.minX - 1e-12) active.splice(k, 1);
    }
    for (const t of active) {
      if (t.maxY < s.minY - 1e-12 || s.maxY < t.minY - 1e-12) continue;
      const i = s.i;
      const j = t.i;
      const adjacent = Math.abs(i - j) === 1 || Math.abs(i - j) === n - 1;
      if (adjacent || i === j) continue;
      if (segmentsIntersect(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) {
        out.push([Math.min(i, j), Math.max(i, j)]);
        if (out.length >= limit) return out;
      }
    }
    active.push(s);
  }
  return out;
}

/** True for a closed polygon with >= 3 distinct vertices, finite coordinates and no self-intersections. */
export function isSimplePolygon(p: Path): boolean {
  if (p.length < 3) return false;
  for (const q of p) if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) return false;
  for (let i = 0; i < p.length; i++) {
    if (dist(p[i], p[(i + 1) % p.length]) < 1e-9) return false;
  }
  if (polygonArea(p) < 1e-6) return false;
  return selfIntersections(p, 1).length === 0;
}

/**
 * Remove small self-intersection loops from a closed polygon (as produced by
 * offsetting around reflex corners or tight concave curves). Keeps the larger
 * outer part. `window` bounds how many vertices a removable loop may span.
 */
export function removeLocalLoops(poly: Path, window = 120): Path {
  let p = [...poly];
  for (let guard = 0; guard < 200; guard++) {
    const n = p.length;
    if (n < 4) return p;
    let fixed = false;
    outer: for (let i = 0; i < n; i++) {
      const a = p[i];
      const b = p[(i + 1) % n];
      const maxOff = Math.min(window, n - 2);
      for (let off = 2; off <= maxOff; off++) {
        const j = (i + off) % n;
        if ((j + 1) % n === i) continue;
        const c = p[j];
        const d = p[(j + 1) % n];
        const x = segmentIntersection(a, b, c, d);
        if (!x) continue;
        // Two candidate polygons: drop the loop i+1..j, or keep only the loop.
        // Keep whichever has the larger area (the spurious loop is the small one).
        const loop: Path = [];
        for (let k = (i + 1) % n; ; k = (k + 1) % n) {
          loop.push(p[k]);
          if (k === j) break;
        }
        const rest: Path = [];
        for (let k = (j + 1) % n; ; k = (k + 1) % n) {
          rest.push(p[k]);
          if (k === i) break;
        }
        const next: Path = polygonArea([x, ...rest]) >= polygonArea([x, ...loop]) ? [x, ...rest] : [x, ...loop];
        p = dedupe(next, 1e-7, true);
        fixed = true;
        break outer;
      }
    }
    if (!fixed) return p;
  }
  return p;
}

// ---------------------------------------------------------------------------
// Offsetting
// ---------------------------------------------------------------------------

/**
 * Offset a closed polygon outward with a distance per segment
 * (segment i runs p[i] -> p[i+1 mod n]). Distances may be 0 (e.g. fold lines).
 * Works for either orientation. Corners are mitred (bevelled beyond
 * `miterLimit` x distance) and local loops are removed.
 */
export function offsetClosedPathVariable(p: Path, dists: number[], miterLimit = 4): Path {
  const n = p.length;
  if (n < 3) return [...p];
  const orientation = signedArea(p) >= 0 ? 1 : -1;
  const dirs: Point[] = [];
  const normals: Point[] = [];
  for (let i = 0; i < n; i++) {
    const d = dir(p[i], p[(i + 1) % n]);
    dirs.push(d);
    normals.push(scale(outwardNormal(d), orientation));
  }
  const out: Path = [];
  for (let j = 0; j < n; j++) {
    const iPrev = (j - 1 + n) % n;
    const d0 = dists[iPrev] ?? 0;
    const d1 = dists[j] ?? 0;
    const v = p[j];
    if (d0 === 0 && d1 === 0) {
      out.push({ ...v });
      continue;
    }
    const a = add(v, scale(normals[iPrev], d0)); // end of offset prev segment
    const b = add(v, scale(normals[j], d1)); // start of offset next segment
    const turn = cross(dirs[iPrev], dirs[j]);
    const parallel = Math.abs(turn) < 1e-6 && dot(dirs[iPrev], dirs[j]) > 0;
    if (parallel) {
      if (Math.abs(d0 - d1) < 1e-9) out.push(a);
      else out.push(a, b);
      continue;
    }
    const x = lineIntersection(a, dirs[iPrev], b, dirs[j]);
    // A zero-width side (fold line, unfinished facing edge) must be met exactly,
    // so the cut line never crosses it: allow a much longer miter there.
    const lim = (d0 === 0 || d1 === 0 ? 8 * miterLimit : miterLimit) * Math.max(d0, d1, 0.1);
    if (x && dist(x, v) <= lim) {
      out.push(x);
    } else {
      out.push(a, b);
    }
  }
  return removeLocalLoops(dedupe(out, 1e-7, true));
}

/** Offset a closed path outward by a uniform distance (negative = inward). */
export function offsetClosedPath(p: Path, d: number): Path {
  if (d >= 0) return offsetClosedPathVariable(p, new Array(p.length).fill(d));
  return offsetClosedPathVariable(reversePath(p), new Array(p.length).fill(-d));
}

/** Offset an OPEN polyline sideways by d (positive = left-hand normal in y-down, i.e. outward for clockwise shapes). */
export function offsetOpenPath(p: Path, d: number): Path {
  const n = p.length;
  if (n < 2) return [...p];
  const out: Path = [];
  for (let i = 0; i < n; i++) {
    let nrm: Point;
    if (i === 0) nrm = outwardNormal(dir(p[0], p[1]));
    else if (i === n - 1) nrm = outwardNormal(dir(p[n - 2], p[n - 1]));
    else {
      const n0 = outwardNormal(dir(p[i - 1], p[i]));
      const n1 = outwardNormal(dir(p[i], p[i + 1]));
      const m = normalize(add(n0, n1));
      const c = dot(m, n0);
      nrm = scale(m, c > 0.2 ? 1 / c : 5);
    }
    out.push(add(p[i], scale(nrm, d)));
  }
  return out;
}

/** Closest point on an open polyline to q, with its arc length. */
export function closestOnPath(p: Path, q: Point): { point: Point; s: number; d: number } {
  let best = { point: p[0], s: 0, d: Infinity };
  let acc = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    const t = l2 < EPS ? 0 : clamp(dot(sub(q, a), ab) / l2, 0, 1);
    const c = lerp(a, b, t);
    const d = dist(c, q);
    if (d < best.d) best = { point: c, s: acc + Math.sqrt(l2) * t, d };
    acc += Math.sqrt(l2);
  }
  return best;
}

/**
 * Horizontal chord width of a closed polygon at height y: total length of the
 * inside portions of the line y = const.
 */
export function widthAtY(poly: Path, y: number): number {
  const xs: number[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if (a.y > y !== b.y > y) {
      xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
  }
  xs.sort((u, v) => u - v);
  let w = 0;
  for (let k = 0; k + 1 < xs.length; k += 2) w += xs[k + 1] - xs[k];
  return w;
}

/** Ramanujan approximation of an ellipse perimeter with semi-axes a, b. */
export function ellipsePerimeter(a: number, b: number): number {
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

/** Monotone bisection solve of f(x) = target over [lo, hi]. */
export function solveMonotone(f: (x: number) => number, target: number, lo: number, hi: number, iterations = 60): number {
  let a = lo;
  let b = hi;
  const fa = f(a) - target;
  const increasing = f(b) - target > fa;
  for (let i = 0; i < iterations; i++) {
    const m = (a + b) / 2;
    const v = f(m) - target;
    if (v > 0 === increasing) b = m;
    else a = m;
  }
  return (a + b) / 2;
}
