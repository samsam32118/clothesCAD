/**
 * Small numeric helpers shared by the 3D body and garment builders.
 * Pure functions, no three.js and no DOM: safe in Node and the browser.
 *
 * Angle convention for every cross-section in this module: a point at angle
 * `phi` and radius `r` sits at (u, w) = (r·sin phi, r·cos phi), where w is the
 * "front" axis. For vertical parts u = +x and w = +z (the figure faces +z), so
 * phi = 0 is centre front, phi = π/2 the figure's left side (+x), phi = π centre back.
 */

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  let x = a % TAU;
  if (x <= -Math.PI) x += TAU;
  else if (x > Math.PI) x -= TAU;
  return x;
}

// ---------------------------------------------------------------------------
// Ellipses
// ---------------------------------------------------------------------------

/** Ramanujan's (first) approximation of an ellipse perimeter; error < 0.04 % for b/a >= 0.3. */
export function ellipsePerimeter(a: number, b: number): number {
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

/**
 * Semi-axes of an ellipse with the given perimeter and depth ratio
 * (depth / width = b / a). Solved in closed form from Ramanujan's formula,
 * which is homogeneous of degree 1 in (a, b).
 */
export function ellipseFromPerimeter(perimeter: number, depthRatio: number): { a: number; b: number } {
  const k = clamp(depthRatio, 0.2, 1.5);
  const unit = Math.PI * (3 * (1 + k) - Math.sqrt((3 + k) * (1 + 3 * k)));
  const a = Math.max(perimeter, 0) / unit;
  return { a, b: a * k };
}

/** Radius of a centred ellipse (semi-axis a along u, b along w) in direction phi. */
export function ellipseRadial(a: number, b: number, phi: number): number {
  if (a <= 0 || b <= 0) return 0;
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  return 1 / Math.sqrt((s * s) / (a * a) + (c * c) / (b * b));
}

/**
 * Far intersection distance of the ray o + t·dir (dir = (du, dw), unit) with the
 * ellipse centred at (cu, cw) with semi-axes (a, b). Returns -Infinity when the
 * ray misses (or the ellipse is behind the origin).
 */
export function rayEllipseFar(
  ou: number,
  ow: number,
  du: number,
  dw: number,
  cu: number,
  cw: number,
  a: number,
  b: number,
): number {
  if (a <= 0 || b <= 0) return -Infinity;
  const pu = (ou - cu) / a;
  const pw = (ow - cw) / b;
  const qu = du / a;
  const qw = dw / b;
  const A = qu * qu + qw * qw;
  const B = 2 * (pu * qu + pw * qw);
  const C = pu * pu + pw * pw - 1;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return -Infinity;
  const t = (-B + Math.sqrt(disc)) / (2 * A);
  return t >= 0 ? t : -Infinity;
}

// ---------------------------------------------------------------------------
// 2D polygons (convex hull, perimeter, radial queries)
// ---------------------------------------------------------------------------

export type Vec2 = [number, number];

/** Andrew's monotone chain. Returns the hull counter-clockwise, without the closing point. */
export function convexHull(points: Vec2[]): Vec2[] {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((p, q) => (p[0] === q[0] ? p[1] - q[1] : p[0] - q[0]));
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export function polygonPerimeter(poly: Vec2[]): number {
  let p = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    p += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return p;
}

/**
 * Distance from origin (ou, ow) along direction phi to the farthest crossing of
 * the closed polygon boundary. For a convex polygon containing the origin this
 * is its radial function. Returns 0 when the ray misses.
 */
export function polygonRadial(poly: Vec2[], ou: number, ow: number, phi: number): number {
  const du = Math.sin(phi);
  const dw = Math.cos(phi);
  let best = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const eu = b[0] - a[0];
    const ew = b[1] - a[1];
    const den = du * ew - dw * eu;
    if (Math.abs(den) < 1e-12) continue;
    const au = a[0] - ou;
    const aw = a[1] - ow;
    const t = (au * ew - aw * eu) / den;
    const s = (au * dw - aw * du) / den;
    if (t >= 0 && s >= -1e-9 && s <= 1 + 1e-9 && t > best) best = t;
  }
  return best;
}

// ---------------------------------------------------------------------------
// 1D interpolation
// ---------------------------------------------------------------------------

/**
 * Monotonicity-preserving cubic interpolation through (x, y) knots: a
 * non-uniform Catmull-Rom spline whose tangents are limited with the
 * Fritsch-Carlson rule, so the curve never overshoots between landmarks
 * (no bulges below a narrow waist, no dips inside a smooth flare).
 * Knots may be given in any order; values outside the range are clamped.
 */
export class SmoothCurve {
  private readonly xs: number[];
  private readonly ys: number[];
  private readonly ms: number[];

  constructor(xs: readonly number[], ys: readonly number[]) {
    if (xs.length !== ys.length || xs.length === 0) throw new Error('SmoothCurve needs matching, non-empty knots');
    const order = xs.map((_, i) => i).sort((i, j) => xs[i]! - xs[j]!);
    const sx: number[] = [];
    const sy: number[] = [];
    for (const i of order) {
      const x = xs[i]!;
      if (sx.length && Math.abs(x - sx[sx.length - 1]!) < 1e-9) {
        sy[sy.length - 1] = (sy[sy.length - 1]! + ys[i]!) / 2;
        continue;
      }
      sx.push(x);
      sy.push(ys[i]!);
    }
    this.xs = sx;
    this.ys = sy;
    const n = sx.length;
    const ms = new Array<number>(n).fill(0);
    if (n >= 2) {
      const d: number[] = [];
      for (let i = 0; i < n - 1; i++) d.push((sy[i + 1]! - sy[i]!) / (sx[i + 1]! - sx[i]!));
      ms[0] = d[0]!;
      ms[n - 1] = d[n - 2]!;
      for (let i = 1; i < n - 1; i++) {
        // Non-uniform Catmull-Rom tangent = secant over the neighbouring knots.
        ms[i] = (sy[i + 1]! - sy[i - 1]!) / (sx[i + 1]! - sx[i - 1]!);
      }
      for (let i = 0; i < n - 1; i++) {
        const di = d[i]!;
        if (Math.abs(di) < 1e-12) {
          ms[i] = 0;
          ms[i + 1] = 0;
          continue;
        }
        if (Math.sign(ms[i]!) !== Math.sign(di)) ms[i] = 0;
        if (Math.sign(ms[i + 1]!) !== Math.sign(di)) ms[i + 1] = 0;
        const al = ms[i]! / di;
        const be = ms[i + 1]! / di;
        const h = al * al + be * be;
        if (h > 9) {
          const tau = 3 / Math.sqrt(h);
          ms[i] = tau * al * di;
          ms[i + 1] = tau * be * di;
        }
      }
      // Local extrema (sign change of the secants) get a flat tangent.
      for (let i = 1; i < n - 1; i++) {
        if (d[i - 1]! * d[i]! <= 0) ms[i] = 0;
      }
    }
    this.ms = ms;
  }

  get min(): number {
    return this.xs[0]!;
  }

  get max(): number {
    return this.xs[this.xs.length - 1]!;
  }

  at(x: number): number {
    const xs = this.xs;
    const n = xs.length;
    if (n === 1 || x <= xs[0]!) return this.ys[0]!;
    if (x >= xs[n - 1]!) return this.ys[n - 1]!;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid]! <= x) lo = mid;
      else hi = mid;
    }
    const h = xs[hi]! - xs[lo]!;
    const t = (x - xs[lo]!) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * this.ys[lo]! +
      (t3 - 2 * t2 + t) * h * this.ms[lo]! +
      (-2 * t3 + 3 * t2) * this.ys[hi]! +
      (t3 - t2) * h * this.ms[hi]!
    );
  }
}

/** Deterministic hash → [0, 1) for small per-design variations (fold phase). */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}
