/**
 * Regression tests for defects found while integrating the modules end to end
 * (eval harness findings): stage-ordered fit basting, binding seam allowances,
 * short binding grainlines, with-nap layouts and silhouette rationale.
 */
import { describe, expect, it } from 'vitest';
import { design } from '../src/core/design';
import { isOneWayFabric } from '../src/core/layout';
import { getMaterial } from '../src/core/presets';
import type { DesignPackage, DesignRequest, PatternPiece } from '../src/core/types';

const BODY = { heightCm: 165, bustCm: 90, waistCm: 72, hipCm: 98 };

function make(req: Partial<DesignRequest> & Pick<DesignRequest, 'garment' | 'styleId' | 'materialId'>): DesignPackage {
  return design({ measurements: BODY, ...req });
}

function edgeAllowance(p: PatternPiece, edgeId: string): number {
  // Distance from the edge midpoint on the seam line to the cut line, which is
  // the allowance at that edge.
  const e = p.edges.find((x) => x.id === edgeId)!;
  const n = p.seamLine.length;
  const pts = [];
  for (let i = e.from; ; i = (i + 1) % n) {
    pts.push(p.seamLine[i]!);
    if (i === e.to) break;
  }
  const mid = pts[Math.floor(pts.length / 2)]!;
  let best = Infinity;
  for (let i = 0; i < p.cutLine.length; i++) {
    const a = p.cutLine[i]!;
    const b = p.cutLine[(i + 1) % p.cutLine.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((mid.x - a.x) * dx + (mid.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(a.x + t * dx - mid.x, a.y + t * dy - mid.y));
  }
  return best;
}

describe('instructions follow seam.stage with interleaved fit seams', () => {
  for (const garment of ['wide-leg-trousers', 'tapered-trousers', 'ball-gown'] as const) {
    it(`${garment}: every seam first appears in stage order and basting precedes the try-on`, () => {
      const pkg = make({ garment, styleId: 'italian-sartorial', materialId: garment === 'ball-gown' ? 'silk-mikado' : 'wool-crepe', options: { pockets: true } });
      const first = new Map<string, number>();
      pkg.instructions.forEach((s, i) => s.seamIds.forEach((id) => first.has(id) || first.set(id, i)));
      for (const a of pkg.seams) {
        for (const b of pkg.seams) {
          if (a.stage < b.stage) expect(first.get(a.id)!, `${a.id} (${a.stage}) before ${b.id} (${b.stage})`).toBeLessThanOrEqual(first.get(b.id)!);
        }
      }
      const baste = pkg.instructions.findIndex((s) => /^Baste the main seams/.test(s.title));
      const tryOn = pkg.instructions.findIndex((s) => s.phase === 'fit');
      expect(baste).toBeGreaterThanOrEqual(0);
      expect(tryOn).toBeGreaterThan(baste);
    });
  }
});

describe('bindings', () => {
  it('a sleeveless woven shell top has matching allowances on the binding join and a usable grainline', () => {
    const pkg = make({ garment: 'shell-top', styleId: 'mediterranean-summer', materialId: 'lyocell-twill', options: { sleeve: 'none' } });
    const binding = pkg.pieces.find((p) => p.id === 'armhole-binding');
    expect(binding).toBeDefined();
    for (const s of pkg.seams.filter((x) => x.id.startsWith('armhole-binding-join'))) {
      const a = pkg.pieces.find((p) => p.id === s.a.pieceId)!;
      const b = pkg.pieces.find((p) => p.id === s.b!.pieceId)!;
      expect(edgeAllowance(a, s.a.edgeId)).toBeCloseTo(edgeAllowance(b, s.b!.edgeId), 1);
    }
    const [g0, g1] = binding!.grainline;
    expect(Math.hypot(g1.x - g0.x, g1.y - g0.y)).toBeGreaterThanOrEqual(3);
  });
});

describe('with-nap layout', () => {
  it('lustrous fabrics are laid with every piece pointing the same way', () => {
    const mat = getMaterial('silk-mikado');
    expect(isOneWayFabric(mat)).toBe(true);
    const pkg = make({ garment: 'sheath-dress', styleId: 'european-couture-evening', materialId: mat.id });
    const self = pkg.layouts.find((l) => l.layer === 'self')!;
    expect(new Set(self.placements.map((p) => p.rotationDeg))).toEqual(new Set([0]));
  });

  it('matte fabrics may still use 180° turns', () => {
    expect(isOneWayFabric(getMaterial('belgian-linen-midweight'))).toBe(false);
  });
});

describe('fit rationale', () => {
  it('a pencil skirt explains why its straight silhouette suits the body', () => {
    const pkg = make({ garment: 'pencil-skirt', styleId: 'parisian-chic', materialId: 'wool-crepe', options: { length: 'midi' } });
    expect(pkg.fit.rationale.length).toBeGreaterThanOrEqual(3);
    expect(pkg.fit.rationale.some((r) => r.startsWith('Silhouette:'))).toBe(true);
  });
});
