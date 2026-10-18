/**
 * Regression tests for the round-1 critic findings: trouser lengths, heels,
 * gown structure, seam types, zips, knit block, wrap dress, A-line truing and
 * novice-facing instructions.
 */
import { describe, expect, it } from 'vitest';
import { design } from '../src/core/design';
import { frenchSeamBlocker, zipForOpening } from '../src/core/drafting/seams';
import { zipInfo, indexPieces } from '../src/core/instructions/shared';
import type { DesignPackage, DesignRequest, PatternPiece } from '../src/core/types';

const pear = { heightCm: 165, bustCm: 88, waistCm: 70, hipCm: 104 };
const tall = { heightCm: 178, bustCm: 92, waistCm: 78, hipCm: 98 };

function make(req: Omit<DesignRequest, 'measurements'> & { measurements?: DesignRequest['measurements'] }): DesignPackage {
  return design({ measurements: pear, ...req });
}

function edgePath(p: PatternPiece, id: string) {
  const e = p.edges.find((x) => x.id === id)!;
  const out = [];
  const n = p.seamLine.length;
  for (let k = e.from, g = 0; g <= n; g++, k = (k + 1) % n) {
    out.push(p.seamLine[k]!);
    if (k === e.to) break;
  }
  return out;
}

/** Largest change of direction (degrees) between consecutive segments of a path. */
function maxTurn(pts: Array<{ x: number; y: number }>): number {
  let max = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = Math.atan2(pts[i]!.y - pts[i - 1]!.y, pts[i]!.x - pts[i - 1]!.x);
    const b = Math.atan2(pts[i + 1]!.y - pts[i]!.y, pts[i + 1]!.x - pts[i]!.x);
    let d = Math.abs(b - a);
    if (d > Math.PI) d = 2 * Math.PI - d;
    max = Math.max(max, (d * 180) / Math.PI);
  }
  return max;
}

describe('fit plan', () => {
  it('keeps the floor-length wide leg whatever lengths the style prefers for skirts', () => {
    const pkg = make({ garment: 'wide-leg-trousers', styleId: 'parisian-chic', materialId: 'lyocell-twill' });
    expect(pkg.fit.options.length).toBe('floor');
    const heel = pkg.fit.shoeHeelCm ?? 0;
    expect(pkg.fit.hemHeightFromFloorCm + heel).toBeLessThanOrEqual(3);
    expect(pkg.fit.rationale.join(' ')).not.toMatch(/Cropped length/);
  });

  it('drafts floor-length gowns to clear the floor in the planned heels', () => {
    const pkg = make({ garment: 'column-gown', styleId: 'european-couture-evening', materialId: 'silk-charmeuse-como', shoeHeelCm: 9 });
    expect(pkg.fit.shoeHeelCm).toBe(9);
    expect(pkg.fit.hemHeightFromFloorCm).toBeCloseTo(1 - 9, 5);
    const flats = make({ garment: 'column-gown', styleId: 'european-couture-evening', materialId: 'silk-charmeuse-como', shoeHeelCm: 0 });
    expect(flats.fit.finished.lengthFromWaist! - pkg.fit.finished.lengthFromWaist!).toBeCloseTo(-9, 1);
    const text = pkg.fit.rationale.join(' ');
    expect(text).toMatch(/9 cm heels/);
    expect(text).not.toMatch(/still reaches the floor/);
  });

  it('keeps a ball-gown bodice close even with a relaxed style', () => {
    const pkg = design({ measurements: tall, garment: 'ball-gown', styleId: 'antwerp-avant-garde', materialId: 'silk-mikado' });
    expect(pkg.fit.ease.bust).toBeLessThanOrEqual(5);
    expect(pkg.fit.ease.waist).toBeLessThanOrEqual(2);
  });

  it('uses the knit block for stretch knits: near-zero ease and no darts', () => {
    const pkg = make({ garment: 'wrap-dress', styleId: 'stockholm-minimal', materialId: 'merino-jersey' });
    expect(pkg.fit.ease.bust).toBeLessThanOrEqual(2);
    expect(pkg.pieces.flatMap((p) => p.darts)).toHaveLength(0);
  });
});

describe('drafting', () => {
  it('trues the A-line waist: no sliver darts and a smooth waist outside the dart caps', () => {
    const pkg = make({ garment: 'a-line-skirt', styleId: 'parisian-chic', materialId: 'belgian-linen-midweight' });
    for (const p of pkg.pieces.filter((x) => x.role === 'front-skirt' || x.role === 'back-skirt')) {
      for (const d of p.darts) expect(d.intakeCm).toBeGreaterThanOrEqual(0.95);
      const waist = edgePath(p, 'waist');
      // away from the darts the waist bends by only a few degrees per vertex
      const far = waist.filter((q) => p.darts.every((d) => Math.hypot(q.x - (d.legs[0].x + d.legs[1].x) / 2, q.y - (d.legs[0].y + d.legs[1].y) / 2) > d.intakeCm));
      expect(maxTurn(far)).toBeLessThan(12);
      // no corner at the hip on the side seam
      expect(maxTurn(edgePath(p, 'side'))).toBeLessThan(8);
    }
  });

  it('draws sheath princess seams without corners at bust or hip', () => {
    const pkg = make({ garment: 'sheath-dress', styleId: 'italian-sartorial', materialId: 'wool-crepe' });
    for (const id of ['front-centre', 'front-side', 'back-centre', 'back-side']) {
      const p = pkg.pieces.find((x) => x.id === id)!;
      expect(maxTurn(edgePath(p, 'princess')), id).toBeLessThan(15);
    }
  });

  it('only keeps French seams where a French seam can be sewn', () => {
    const pkg = make({ garment: 'shell-top', styleId: 'parisian-chic', materialId: 'silk-crepe-de-chine' });
    for (const s of pkg.seams.filter((x) => x.type === 'french')) expect(frenchSeamBlocker(s, pkg.pieces, pkg.seams), s.id).toBeNull();
    for (const id of ['neck-front', 'neck-back', 'facing-shoulders']) {
      const s = pkg.seams.find((x) => x.id === id);
      if (s) expect(s.type, id).toBe('plain');
    }
    expect(pkg.quality.find((q) => q.id === 'seam-types')?.ok).toBe(true);
  });

  it('gives a light silk shell a short neck zip that matches the shopping list', () => {
    const pkg = make({ garment: 'shell-top', styleId: 'parisian-chic', materialId: 'silk-crepe-de-chine', options: { closure: 'invisible-zip' } });
    const zip = zipInfo(pkg, indexPieces(pkg.pieces));
    if (pkg.fit.options.closure === 'invisible-zip') {
      expect(zip).not.toBeNull();
      expect(zip!.zipLengthCm).toBeLessThanOrEqual(25);
      expect(pkg.bom.find((b) => /zip/i.test(b.name))!.spec).toMatch(new RegExp(`^${zip!.zipLengthCm} cm`));
    }
  });

  it('runs one standard zip from a gown bodice into the skirt and buys exactly that zip', () => {
    const pkg = design({ measurements: tall, garment: 'ball-gown', styleId: 'european-couture-evening', materialId: 'cotton-poplin' });
    const zip = zipInfo(pkg, indexPieces(pkg.pieces))!;
    expect(pkg.seams.filter((s) => s.type === 'zip-invisible').length).toBeGreaterThanOrEqual(2);
    expect(zipForOpening(zip.openingCm, 'zip-invisible')).toBe(zip.zipLengthCm);
    expect(pkg.quality.find((q) => q.id === 'zip-length')?.ok).toBe(true);
    const note = pkg.seams.find((s) => s.id === 'bodice-cb-zip')!.note!;
    expect(note).toContain(`${zip.zipLengthCm} cm`);
  });

  it('puts the ball-gown CB gore on the straight grain and keeps waist fullness modest', () => {
    const pkg = design({ measurements: tall, garment: 'ball-gown', styleId: 'european-couture-evening', materialId: 'cotton-poplin' });
    const cb = pkg.pieces.find((p) => p.id === 'skirt-cb')!;
    const pts = [...edgePath(cb, 'cb'), ...(cb.edges.some((e) => e.id === 'cb-zip') ? edgePath(cb, 'cb-zip') : [])];
    const dx = Math.abs(pts[pts.length - 1]!.x - pts[0]!.x);
    expect(dx).toBeLessThan(0.1);
    for (const s of pkg.seams.filter((x) => x.id.startsWith('waist-skirt'))) {
      const bodice = pkg.pieces.find((p) => p.id === s.a.pieceId)!.edges.find((e) => e.id === 'waist')!.lengthCm;
      expect((bodice + s.intendedEaseCm) / bodice).toBeLessThanOrEqual(1.55);
    }
  });

  it('adds gown structure: waist stay, boning, horsehair and petticoat', () => {
    const pkg = design({ measurements: tall, garment: 'ball-gown', styleId: 'european-couture-evening', materialId: 'silk-mikado' });
    expect(pkg.seams.some((s) => s.id === 'waist-stay')).toBe(true);
    expect(pkg.seams.filter((s) => s.id.startsWith('boning-')).length).toBeGreaterThanOrEqual(3);
    const bom = pkg.bom.map((b) => b.name.toLowerCase()).join(' | ');
    for (const need of ['petersham', 'boning', 'horsehair', 'petticoat', 'underlining']) expect(bom).toContain(need);
    // mikado is structured: the skirt is box-pleated, not gathered
    expect(pkg.seams.filter((s) => s.id.startsWith('waist-skirt')).every((s) => s.type !== 'gathered')).toBe(true);
    expect(pkg.instructions.some((st) => /box.pleat/i.test(st.title + st.body))).toBe(true);
  });

  it('stays the wrap edge and overlaps the wrap by at least a quarter waist', () => {
    const pkg = make({ garment: 'wrap-dress', styleId: 'parisian-chic', materialId: 'viscose-crepe' });
    expect(pkg.seams.some((s) => s.id === 'wrap-edge-stay')).toBe(true);
    expect(pkg.bom.some((b) => /stay tape|clear elastic/i.test(b.name))).toBe(true);
    const skirt = pkg.pieces.find((p) => p.id === 'front-skirt')!;
    const notch = skirt.notches.find((n) => n.label === 'CF')!;
    const edgeStart = edgePath(skirt, 'waist')[0]!;
    expect(Math.abs(notch.at.x - edgeStart.x)).toBeGreaterThanOrEqual(Math.min(17.9, 0.25 * pear.waistCm));
  });
});

describe('layout and instructions for a beginner', () => {
  const pkg = make({ garment: 'a-line-skirt', styleId: 'parisian-chic', materialId: 'belgian-linen-midweight' });

  it('turns the interfacing strip across the width', () => {
    const l = pkg.layouts.find((x) => x.layer === 'interfacing')!;
    expect(l.lengthCm).toBeLessThan(20);
  });

  it('tells the beginner to cut a single waistband through one layer', () => {
    const cut = pkg.instructions.find((s) => s.phase === 'cut' && s.pieceIds.includes('waistband'))!;
    expect(cut.body).toMatch(/Waistband: cut 1[^\n]*ONE layer/);
    const self = pkg.layouts.find((x) => x.layer === 'self')!;
    if (self.fold === 'folded') expect(self.placements.find((p) => p.pieceId === 'waistband')!.singleLayer).toBe(true);
  });

  it('lists the waistband interfacing as a reuse of the waistband paper piece', () => {
    const prep = pkg.instructions.find((s) => /paper pieces/.test(s.title))!;
    expect(prep.body).not.toMatch(/^\s*- Waistband interfacing/m);
    expect(prep.body).toMatch(/Waistband \(also used to cut the interfacing/);
  });

  it('does not sew the centre-back seam twice and finishes before pressing open', () => {
    const cb = pkg.seams.find((s) => s.id === 'cb');
    if (cb) {
      const st = pkg.instructions.find((s) => s.seamIds.includes('cb'))!;
      expect(st.title).not.toMatch(/^Sew/);
    }
    for (const st of pkg.instructions) {
      const finish = st.body.search(/Seam finish/);
      const press = st.body.search(/press the seam allowances open/i);
      if (finish >= 0 && press >= 0) expect(finish).toBeLessThan(press);
      if (/^Hem/.test(st.title)) expect(st.body).not.toMatch(/press(ing)? open/i);
    }
  });

  it('includes safety, the machine and the printed page count', () => {
    const warnings = pkg.instructions.flatMap((s) => s.warnings).join(' ');
    expect(warnings).toMatch(/needle/);
    expect(warnings).toMatch(/iron/);
    const tools = pkg.bom.filter((b) => b.kind === 'tool');
    expect(tools.some((t) => t.name === 'Sewing machine')).toBe(true);
    const printer = tools.find((t) => /Printer/.test(t.name))!;
    expect(pkg.instructions.some((s) => s.body.includes(`Print the ${printer.quantity} tiled pattern pages`))).toBe(true);
    expect(pkg.glossary['stitch in the ditch']).toBeTruthy();
  });
});
