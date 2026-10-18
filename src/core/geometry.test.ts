import { describe, expect, it } from 'vitest';
import {
  cleanPolygon,
  cubicBezier,
  cubicBezierLength,
  hashString,
  isSimplePolygon,
  offsetClosedPath,
  offsetClosedPathVariable,
  pathLength,
  polygonArea,
  polygonIntersectionArea,
  polygonsOverlap,
  signedArea,
} from './geometry';
import type { Path } from './types';

const square = (s: number, x = 0, y = 0): Path => [
  { x, y },
  { x: x + s, y },
  { x: x + s, y: y + s },
  { x, y: y + s },
];

describe('geometry', () => {
  it('hashes deterministically', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
    expect(hashString('x')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('measures open and wrapping closed paths', () => {
    const sq = square(10);
    expect(pathLength(sq)).toBeCloseTo(30);
    expect(pathLength(sq, 2, 0)).toBeCloseTo(20); // 2 -> 3 -> 0 through the closing segment
  });

  it('flattens cubics evenly and matches the exact bezier length', () => {
    const p = cubicBezier({ x: 0, y: 0 }, { x: 5, y: 10 }, { x: 15, y: -10 }, { x: 20, y: 0 }, 0.5);
    const exact = cubicBezierLength({ x: 0, y: 0 }, { x: 5, y: 10 }, { x: 15, y: -10 }, { x: 20, y: 0 });
    expect(pathLength(p)).toBeCloseTo(exact, 1);
    for (let i = 1; i < p.length; i++) expect(Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y)).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it('offsets uniformly outward and inward with clipper, keeping orientation', () => {
    const out = offsetClosedPath(square(10), 1);
    expect(polygonArea(out)).toBeCloseTo(144, 1);
    expect(Math.sign(signedArea(out))).toBe(Math.sign(signedArea(square(10))));
    expect(polygonArea(offsetClosedPath(square(10), -1))).toBeCloseTo(64, 1);
  });

  it('offsets per edge, leaving zero-allowance (fold) edges in place', () => {
    const sq = square(10);
    const out = offsetClosedPathVariable(sq, [1, 1, 1, 0]); // left edge x=0 is a fold
    expect(isSimplePolygon(out)).toBe(true);
    expect(Math.min(...out.map((p) => p.x))).toBeCloseTo(0, 6);
    expect(polygonArea(out)).toBeCloseTo(11 * 12, 1);
  });

  it('removes swallow-tail loops from offsets of concave shapes', () => {
    // L-shape with a tight concave notch
    const L: Path = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4.2, y: 4 },
      { x: 4.2, y: 4.3 },
      { x: 10, y: 4.3 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const out = offsetClosedPathVariable(L, new Array(L.length).fill(1));
    expect(isSimplePolygon(out)).toBe(true);
    expect(isSimplePolygon(cleanPolygon(out))).toBe(true);
  });

  it('detects polygon overlap but allows edge contact', () => {
    expect(polygonsOverlap(square(10), square(10, 5, 5))).toBe(true);
    expect(polygonIntersectionArea(square(10), square(10, 5, 5))).toBeCloseTo(25, 3);
    expect(polygonsOverlap(square(10), square(10, 10, 0))).toBe(false);
  });

  it('rejects self-intersecting polygons', () => {
    const bow: Path = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    expect(isSimplePolygon(bow)).toBe(false);
    expect(isSimplePolygon(square(3))).toBe(true);
  });
});
