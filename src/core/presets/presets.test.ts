import { describe, expect, it } from 'vitest';
import { GARMENTS, MATERIALS, STYLES, getGarment, getMaterial, getStyle, recommend, isLiningMaterial } from './index';
import type { GarmentType } from '../types';

const ALL_GARMENTS: GarmentType[] = [
  'a-line-skirt', 'pencil-skirt', 'circle-skirt', 'wide-leg-trousers', 'tapered-trousers', 'shell-top',
  'shift-dress', 'sheath-dress', 'wrap-dress', 'column-gown', 'ball-gown',
];

describe('presets', () => {
  it('covers every garment type with consistent defaults', () => {
    expect(GARMENTS.map((g) => g.id).sort()).toEqual([...ALL_GARMENTS].sort());
    for (const g of GARMENTS) {
      for (const k of ['length', 'sleeve', 'neckline', 'closure'] as const) {
        const allowed = g.allowed[k] as string[];
        if (allowed.length) expect(allowed, `${g.id}.${k}`).toContain(g.defaults[k]);
      }
      if (g.defaults.lining) expect(g.allowed.lining).toBe(true);
      if (g.defaults.pockets) expect(g.allowed.pockets).toBe(true);
    }
    expect(getGarment('wrap-dress').allowed.closure).toEqual(['wrap-tie']);
    expect(getGarment('ball-gown').allowed.length).toEqual(['floor']);
  });

  it('has realistic, unique materials that fit their garments', () => {
    expect(MATERIALS.length).toBeGreaterThanOrEqual(18);
    expect(new Set(MATERIALS.map((m) => m.id)).size).toBe(MATERIALS.length);
    for (const m of MATERIALS) {
      expect(m.weightGsm).toBeGreaterThan(20);
      expect(m.widthCm).toBeGreaterThanOrEqual(110);
      expect(m.stiffness).toBeGreaterThanOrEqual(0);
      expect(m.stiffness).toBeLessThanOrEqual(1);
      expect(m.pricePerMeterEur[0]).toBeLessThanOrEqual(m.pricePerMeterEur[1]);
      expect(m.render.baseColor).toMatch(/^#[0-9a-f]{6}$/i);
      for (const g of m.suitableFor) expect(getGarment(g).fabricTypes, `${m.id} -> ${g}`).toContain(m.construction);
    }
    expect(MATERIALS.some((m) => m.regions.includes('scandinavian'))).toBe(true);
    for (const g of ALL_GARMENTS) expect(MATERIALS.some((m) => m.suitableFor.includes(g) && !isLiningMaterial(m.id))).toBe(true);
  });

  it('has European and Scandinavian styles referencing valid materials', () => {
    expect(STYLES.length).toBeGreaterThanOrEqual(10);
    expect(STYLES.filter((s) => s.region === 'scandinavian').length).toBeGreaterThanOrEqual(4);
    for (const s of STYLES) {
      for (const id of s.recommendedMaterials) expect(() => getMaterial(id)).not.toThrow();
      for (const c of s.palette) expect(c.hex).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('throws helpful errors for unknown ids', () => {
    expect(() => getStyle('parisian')).toThrow(/Did you mean 'parisian-chic'/);
    expect(() => getMaterial('nope')).toThrow(/Valid material ids/);
  });

  it('recommends by garment, occasion, region and body', () => {
    const r = recommend({ garment: 'ball-gown', occasion: 'runway', region: 'european' });
    expect(r.materials.length).toBeGreaterThan(0);
    for (const m of r.materials) expect(getGarment('ball-gown').fabricTypes).toContain(m.construction);
    expect(r.materials[0]!.suitableFor).toContain('ball-gown');
    expect(r.styles[0]!.region).toBe('european');
    const easy = recommend({ garment: 'shift-dress', minBeginnerFriendliness: 4 });
    for (const m of easy.materials) expect(m.beginnerFriendliness).toBeGreaterThanOrEqual(4);
    expect(recommend({ region: 'scandinavian' }).styles[0]!.region).toBe('scandinavian');
    expect(recommend({}).reasons).toBeInstanceOf(Array);
  });
});
