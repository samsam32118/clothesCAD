import { describe, expect, it } from 'vitest';
import { GARMENTS, MATERIALS, STYLES, getGarment, getMaterial, getStyle, recommend } from '../src/core/presets';
import { resolveMeasurements } from '../src/core/measurements';
import { analyzeBody } from '../src/core/fit/analyze';
import { BRAND_NAMES, scorePresets } from '../eval/metrics';
import { combosFor } from '../eval/cases';
import { PROFILES } from '../eval/profiles';

describe('preset integrity', () => {
  it('passes every eval integrity check (ids, references, palettes, regions, no brand names)', () => {
    const r = scorePresets();
    expect(r.details).toEqual([]);
    expect(r.score).toBe(1);
  });

  it('has European and Scandinavian styles and materials', () => {
    expect(STYLES.filter((s) => s.region === 'european').length).toBeGreaterThanOrEqual(1);
    expect(STYLES.filter((s) => s.region === 'scandinavian').length).toBeGreaterThanOrEqual(1);
    expect(MATERIALS.filter((m) => m.regions.includes('european')).length).toBeGreaterThanOrEqual(1);
    expect(MATERIALS.filter((m) => m.regions.includes('scandinavian')).length).toBeGreaterThanOrEqual(1);
    expect(STYLES.length).toBeGreaterThanOrEqual(8);
    expect(MATERIALS.length).toBeGreaterThanOrEqual(16);
    expect(GARMENTS.length).toBe(11);
  });

  it('uses valid #rrggbb palettes', () => {
    for (const s of STYLES) for (const c of s.palette) expect(c.hex, `${s.id}/${c.name}`).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('never names a brand or trademark', () => {
    const corpus = JSON.stringify({ GARMENTS, MATERIALS, STYLES }).toLowerCase();
    for (const b of BRAND_NAMES) {
      const re = new RegExp(`(^|[^a-z])${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`);
      expect(re.test(corpus), b).toBe(false);
    }
  });

  it('offers a European and a Scandinavian combo valid for every garment\'s fabric types', () => {
    for (const g of GARMENTS) {
      const combos = combosFor(g);
      for (const region of ['european', 'scandinavian'] as const) {
        const c = combos.find((x) => x.region === region && x.key !== 'stress');
        expect(c, `${g.id} ${region}`).toBeDefined();
        expect(getStyle(c!.styleId).region).toBe(region);
        const m = getMaterial(c!.materialId);
        expect(m.regions).toContain(region);
        expect(g.fabricTypes).toContain(m.construction);
      }
    }
  });
});

describe('lookups', () => {
  it('throws helpful errors listing the valid ids', () => {
    expect(() => getGarment('ballgown')).toThrow(/ball-gown/);
    expect(() => getMaterial('silk')).toThrow(/silk-/);
    expect(() => getStyle('paris')).toThrow(/parisian/);
  });

  it('finds every catalogue entry by id', () => {
    for (const g of GARMENTS) expect(getGarment(g.id)).toBe(g);
    for (const m of MATERIALS) expect(getMaterial(m.id)).toBe(m);
    for (const s of STYLES) expect(getStyle(s.id)).toBe(s);
  });
});

describe('recommend', () => {
  it.each(PROFILES.map((p) => [p.id, p] as const))('returns garments, styles and materials with reasons for %s', (_id, p) => {
    const body = analyzeBody(resolveMeasurements(p.measurements));
    const rec = recommend({ body });
    expect(rec.garments.length).toBeGreaterThan(0);
    expect(rec.styles.length).toBeGreaterThan(0);
    expect(rec.materials.length).toBeGreaterThan(0);
    expect(rec.reasons.length).toBeGreaterThan(0);
  });

  it('only recommends materials that suit the requested garment', () => {
    const g = getGarment('wrap-dress');
    const rec = recommend({ garment: 'wrap-dress' });
    for (const m of rec.materials) expect(g.fabricTypes).toContain(m.construction);
  });
});
