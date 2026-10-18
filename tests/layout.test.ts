import { describe, expect, it } from 'vitest';
import { layoutPieces } from '../src/core/layout';
import type { CuttingLayout, Path, PatternEdge, PatternPiece } from '../src/core/types';
import { applyPlacement, bounds, overlapArea } from '../eval/geom';
import { scoreLayout } from '../eval/metrics';
import { ALL_GARMENTS, designFor, expectAspectsPass } from './helpers';

/**
 * A w × h rectangle piece with a 1.5 cm allowance; when `fold`, its left edge
 * (x = 0) is a fold with no allowance. Stitch line clockwise in y-down space.
 */
function rectPiece(id: string, w: number, h: number, opts: { cutCount?: number; fold?: boolean; mirror?: boolean } = {}): PatternPiece {
  const sa = 1.5;
  const seamLine: Path = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  const left = opts.fold ? 0 : -sa;
  const cutLine: Path = [
    { x: left, y: -sa },
    { x: w + sa, y: -sa },
    { x: w + sa, y: h + sa },
    { x: left, y: h + sa },
  ];
  const edges: PatternEdge[] = [
    { id: 'top', from: 0, to: 1, lengthCm: w, kind: 'seam' },
    { id: 'side', from: 1, to: 2, lengthCm: h, kind: 'seam' },
    { id: 'hem', from: 2, to: 3, lengthCm: w, kind: 'hem' },
    { id: opts.fold ? 'cf' : 'cb', from: 3, to: 0, lengthCm: h, kind: opts.fold ? 'fold' : 'seam' },
  ];
  return {
    id,
    role: 'front-skirt',
    name: id,
    layer: 'self',
    cutCount: opts.cutCount ?? 1,
    cutOnFold: !!opts.fold,
    mirrorPair: !!opts.mirror,
    seamLine,
    cutLine,
    edges,
    grainline: [
      { x: w / 2, y: h * 0.2 },
      { x: w / 2, y: h * 0.8 },
    ],
    notches: [],
    darts: [],
    labels: [],
    seamAllowanceCm: sa,
    bounds: bounds(cutLine),
  };
}

/** Physical pieces a layout yields per piece id (see the CuttingLayout fold semantics). */
function yields(l: CuttingLayout, pieces: PatternPiece[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of pieces) {
    const pls = l.placements.filter((x) => x.pieceId === p.id);
    let n: number;
    if (l.fold === 'folded') n = pls.reduce((s, pl) => s + (p.cutOnFold || pl.singleLayer ? 1 : 2), 0);
    else n = p.cutOnFold ? new Set(pls.map((x) => x.copy)).size : pls.length;
    out.set(p.id, n);
  }
  return out;
}

function expectValidLayout(l: CuttingLayout, pieces: PatternPiece[]): void {
  const usable = l.fold === 'folded' ? l.fabricWidthCm / 2 : l.fabricWidthCm;
  const polys = l.placements.map((pl) => applyPlacement(pieces.find((p) => p.id === pl.pieceId)!.cutLine, pl));
  for (const poly of polys) {
    const b = bounds(poly);
    expect(b.minX).toBeGreaterThanOrEqual(-0.05);
    expect(b.maxX).toBeLessThanOrEqual(usable + 0.05);
    expect(b.minY).toBeGreaterThanOrEqual(-0.05);
    expect(b.maxY).toBeLessThanOrEqual(l.lengthCm + 0.05);
  }
  for (let i = 0; i < polys.length; i++) for (let j = i + 1; j < polys.length; j++) expect(overlapArea(polys[i], polys[j])).toBeLessThanOrEqual(0.05);
  // fabric keeps its grain; interfacing has none and may turn across the width
  for (const pl of l.placements) expect(l.layer === 'interfacing' ? [0, 90, 180, 270] : [0, 180]).toContain(pl.rotationDeg);
  const y = yields(l, pieces);
  for (const p of pieces) expect(y.get(p.id), `${p.id}: yields vs cutCount ${p.cutCount}`).toBe(p.cutCount);
  expect(l.efficiency).toBeGreaterThan(0);
  expect(l.efficiency).toBeLessThanOrEqual(1);
}

describe('layoutPieces (synthetic pieces)', () => {
  const pieces = [
    rectPiece('front', 30, 60, { fold: true }),
    rectPiece('back', 25, 60, { cutCount: 2, mirror: true }),
    rectPiece('band', 8, 40, { cutCount: 1 }),
  ];

  it('packs every copy inside the fabric without overlaps, on grain', () => {
    const l = layoutPieces(pieces, 150, 'self');
    expect(l.layer).toBe('self');
    expect(l.fabricWidthCm).toBe(150);
    expectValidLayout(l, pieces);
  });

  it('places cut-on-fold pieces against the fold in a folded layout', () => {
    const l = layoutPieces(pieces, 150, 'self');
    if (l.fold === 'folded') {
      for (const pl of l.placements.filter((x) => x.pieceId === 'front')) {
        const placed = applyPlacement(pieces[0].seamLine, pl);
        const foldPts = [placed[3], placed[0]];
        for (const q of foldPts) expect(Math.abs(q.x)).toBeLessThanOrEqual(0.05);
      }
    }
  });

  it('needs more length on narrower fabric', () => {
    const wide = layoutPieces(pieces, 150, 'self');
    const narrow = layoutPieces(pieces, 90, 'self');
    expectValidLayout(narrow, pieces);
    expect(narrow.lengthCm).toBeGreaterThanOrEqual(wide.lengthCm);
  });

  it('falls back to a single layer when a piece is wider than half the fabric', () => {
    // 'wide' (63 cm cut) cannot fit in half of 110 cm, so the fabric is used single layer and the
    // cut-on-fold 'front' is cut opened out as two mirrored halves.
    const big = [rectPiece('wide', 60, 40), rectPiece('front', 20, 50, { fold: true }), rectPiece('back', 25, 60, { cutCount: 2, mirror: true })];
    const l = layoutPieces(big, 110, 'self');
    expectValidLayout(l, big);
    expect(l.fold).toBe('single');
    const halves = l.placements.filter((x) => x.pieceId === 'front');
    expect(halves.length).toBe(2);
    expect(halves[0].flipped).not.toBe(halves[1].flipped);
    const backs = l.placements.filter((x) => x.pieceId === 'back');
    expect(backs.filter((x) => x.flipped).length).toBe(1);
  });

  it('cuts an odd copy on folded fabric through one layer only', () => {
    const l = layoutPieces(pieces, 150, 'self');
    expect(l.fold).toBe('folded');
    const band = l.placements.filter((x) => x.pieceId === 'band');
    expect(band).toHaveLength(1);
    expect(band[0]!.singleLayer).toBe(true);
    expect(l.placements.filter((x) => x.pieceId !== 'band').every((x) => !x.singleLayer)).toBe(true);
  });

  it('turns interfacing strips across the width instead of along the length', () => {
    const strip = [{ ...rectPiece('band-if', 8, 80, { cutCount: 1 }), layer: 'interfacing' as const }];
    const l = layoutPieces(strip, 90, 'interfacing');
    expect(l.placements[0]!.rotationDeg % 180).toBe(90);
    expect(l.lengthCm).toBeLessThan(15);
    // the same strip in fabric keeps its grain and runs along the length
    const f = layoutPieces([{ ...strip[0]!, layer: 'self' }], 90, 'self');
    expect(f.lengthCm).toBeGreaterThan(80);
  });

  it('is deterministic', () => {
    expect(layoutPieces(pieces, 140, 'self')).toEqual(layoutPieces(pieces, 140, 'self'));
  });

  it('covers the summed piece area', () => {
    const l = layoutPieces(pieces, 150, 'self');
    const usable = l.fold === 'folded' ? 75 : 150;
    const pieceArea = pieces.reduce((s, p) => s + (p.bounds.maxX - p.bounds.minX) * (p.bounds.maxY - p.bounds.minY) * p.cutCount, 0);
    const layers = l.fold === 'folded' ? 2 : 1;
    expect(usable * l.lengthCm * layers).toBeGreaterThanOrEqual(pieceArea * 0.99);
  });
});

describe('cutting layouts of designed garments', () => {
  it.each(ALL_GARMENTS)('%s: placements inside the fabric, no overlaps, exact copies, BOM covers the layout', (g) => {
    for (const pid of ['petite-hourglass', 'round-54']) {
      const pkg = designFor(g, pid, 'eu');
      expectAspectsPass(scoreLayout(pkg), ['coverage', 'grain', 'inside', 'overlap', 'copies', 'fold', 'mirror', 'bom'], `${g}/${pid}`);
      for (const l of pkg.layouts) {
        expectValidLayout(
          l,
          pkg.pieces.filter((p) => p.layer === l.layer),
        );
      }
    }
  });
});
