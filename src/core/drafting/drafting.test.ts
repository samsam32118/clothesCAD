import { describe, expect, it } from 'vitest';
import { design } from '../design';
import { GARMENTS } from '../presets';
import { isSimplePolygon, pathLength, polygonsOverlap } from '../geometry';
import { placePath } from '../layout';
import { renderTiledPrintPages } from '../svg';
import type { DesignPackage, GarmentType } from '../types';

const body = { heightCm: 166, bustCm: 92, waistCm: 74, hipCm: 100 };

function make(garment: GarmentType, materialId = 'wool-crepe'): DesignPackage {
  return design({ measurements: body, garment, styleId: 'parisian-chic', materialId });
}

describe.each(GARMENTS.map((g) => g.id))('%s', (garment) => {
  const material = garment.includes('gown') ? 'silk-duchesse-satin' : 'wool-crepe';
  const pkg = make(garment, material);

  it('passes every error-level self check', () => {
    expect(pkg.quality.filter((q) => !q.ok && q.severity === 'error')).toEqual([]);
  });

  it('has simple seam and cut lines with correct edge bookkeeping', () => {
    for (const p of pkg.pieces) {
      expect(isSimplePolygon(p.seamLine), `${p.id} seam`).toBe(true);
      expect(isSimplePolygon(p.cutLine), `${p.id} cut`).toBe(true);
      expect(p.edges[0].from).toBe(0);
      expect(p.edges[p.edges.length - 1].to).toBe(0);
      for (const e of p.edges) expect(pathLength(p.seamLine, e.from, e.to)).toBeCloseTo(e.lengthCm, 1);
    }
  });

  it('joins seams whose lengths differ only by the intended ease', () => {
    const edge = (id: string, eid: string) => pkg.pieces.find((p) => p.id === id)!.edges.find((e) => e.id === eid)!;
    for (const s of pkg.seams.filter((x) => x.b)) {
      const diff = Math.abs(edge(s.a.pieceId, s.a.edgeId).lengthCm - edge(s.b!.pieceId, s.b!.edgeId).lengthCm);
      expect(Math.abs(diff - s.intendedEaseCm), s.id).toBeLessThanOrEqual(0.3);
    }
  });

  it('keeps the garment outside the body at every silhouette ring', () => {
    for (const r of [...pkg.silhouette.torso, ...(pkg.silhouette.leg ?? [])]) {
      expect(r.circumferenceCm).toBeGreaterThanOrEqual(r.bodyCircumferenceCm + 0.99);
    }
  });

  it('lays out every piece inside the fabric without overlaps', () => {
    for (const l of pkg.layouts) {
      const usable = l.fold === 'folded' ? l.fabricWidthCm / 2 : l.fabricWidthCm;
      const polys = l.placements.map((pl) => placePath(pkg.pieces.find((p) => p.id === pl.pieceId)!.cutLine, pl));
      for (const poly of polys) for (const q of poly) expect(q.x).toBeGreaterThanOrEqual(-0.01), expect(q.x).toBeLessThanOrEqual(usable + 0.01);
      for (let i = 0; i < polys.length; i++) for (let j = i + 1; j < polys.length; j++) expect(polygonsOverlap(polys[i], polys[j])).toBe(false);
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(make(garment, material).pieces)).toBe(JSON.stringify(pkg.pieces));
  });

  it('prints tiled pages labelled from A1 with a test square', () => {
    const pages = renderTiledPrintPages(pkg, { paper: 'A4' });
    expect(pages[0]).toContain('page A1');
    expect(pages[0]).toContain('width="50" height="50"');
    expect(pages[0]).toMatch(/width="210mm" height="297mm"/);
  });
});

describe('fit planning', () => {
  it('uses negative ease for a fitted knit', () => {
    const pkg = design({ measurements: body, garment: 'sheath-dress', styleId: 'stockholm-minimal', materialId: 'ponte-knit', options: { fit: 'fitted' } });
    expect(pkg.fit.ease.hip).toBeLessThan(0);
  });
  it('keeps a midi hem clear of the widest calf and explains it', () => {
    const pkg = design({ measurements: body, garment: 'a-line-skirt', styleId: 'parisian-chic', materialId: 'wool-crepe', options: { length: 'midi' } });
    const L = pkg.body.landmarks;
    expect(Math.abs(pkg.fit.hemHeightFromFloorCm - L.calf)).toBeGreaterThanOrEqual(3);
    expect(pkg.fit.rationale.some((r) => /Midi hem/.test(r))).toBe(true);
  });
  it('drafts a sleeve cap with 2–4 cm of ease for wovens', () => {
    const pkg = design({ measurements: body, garment: 'shift-dress', styleId: 'parisian-chic', materialId: 'wool-crepe', options: { sleeve: 'long' } });
    const cap = pkg.seams.filter((s) => s.type === 'set-in-sleeve').reduce((a, s) => a + s.intendedEaseCm, 0);
    expect(cap).toBeGreaterThanOrEqual(2);
    expect(cap).toBeLessThanOrEqual(4);
  });
});
