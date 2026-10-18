import { describe, expect, it } from 'vitest';
import { analyzeBody } from '../src/core/fit/analyze';
import { planFit } from '../src/core/fit/plan';
import { resolveMeasurements, computeLandmarks } from '../src/core/measurements';
import { getGarment, getMaterial, getStyle } from '../src/core/presets';
import type { DesignRequest, FitPlan, GarmentType, Measurements } from '../src/core/types';
import { PROFILES, getProfile } from '../eval/profiles';
import { easeRange, lengthBand } from '../eval/metrics';
import { ALL_GARMENTS, comboFor, designFor } from './helpers';

function plan(req: DesignRequest): FitPlan {
  const measurements = resolveMeasurements(req.measurements);
  const body = analyzeBody(measurements);
  return planFit({
    request: req,
    garment: getGarment(req.garment),
    style: getStyle(req.styleId),
    material: getMaterial(req.materialId),
    measurements,
    body,
  });
}

function req(garment: GarmentType, m: Measurements, styleId = 'parisian-chic', materialId = 'wool-crepe', options?: DesignRequest['options']): DesignRequest {
  return { measurements: m, garment, styleId, materialId, ...(options ? { options } : {}) };
}

describe('analyzeBody', () => {
  it.each(PROFILES.map((p) => [p.id, p] as const))('classifies %s as its expected shape', (_id, p) => {
    const r = resolveMeasurements(p.measurements);
    const b = analyzeBody(r);
    expect(b.shape).toBe(p.expectedShape);
    expect(b.ratios.waistToHip).toBeCloseTo(r.waistCm / r.hipCm, 3);
    expect(b.ratios.waistToBust).toBeCloseTo(r.waistCm / r.bustCm, 3);
    expect(b.ratios.bustToHip).toBeCloseTo(r.bustCm / r.hipCm, 3);
    expect(b.ratios.legToHeight).toBeCloseTo(r.waistToFloorCm / r.heightCm, 3);
    expect(b.landmarks).toEqual(computeLandmarks(r));
    expect(b.notes.length).toBeGreaterThanOrEqual(2);
    for (const n of b.notes) expect(n.length).toBeGreaterThan(40);
  });

  it('covers all five body shapes across the eval profiles', () => {
    expect(new Set(PROFILES.map((p) => p.expectedShape))).toEqual(new Set(['hourglass', 'pear', 'inverted-triangle', 'rectangle', 'round']));
  });
});

describe('planFit', () => {
  it.each(ALL_GARMENTS)('%s: options stay within what the garment allows and ease is consistent', (g) => {
    const garment = getGarment(g);
    const c = comboFor(g, 'eu');
    for (const pid of ['petite-hourglass', 'round-54', 'tall-hourglass']) {
      const p = plan(req(g, getProfile(pid).measurements, c.styleId, c.materialId));
      const o = p.options;
      if (garment.allowed.length.length) expect(garment.allowed.length).toContain(o.length);
      if (garment.allowed.sleeve.length) expect(garment.allowed.sleeve).toContain(o.sleeve);
      if (garment.allowed.neckline.length) expect(garment.allowed.neckline).toContain(o.neckline);
      expect(garment.allowed.closure).toContain(o.closure);
      if (!garment.allowed.lining) expect(o.lining).toBe(false);
      expect(o.flare).toBeGreaterThanOrEqual(0);
      expect(o.flare).toBeLessThanOrEqual(1);
      const r = resolveMeasurements(getProfile(pid).measurements);
      if (p.finished.waist !== undefined) expect(Math.abs(p.finished.waist - r.waistCm - p.ease.waist)).toBeLessThanOrEqual(0.5);
      if (p.finished.hip !== undefined) expect(Math.abs(p.finished.hip - r.hipCm - p.ease.hip)).toBeLessThanOrEqual(0.5);
      if (p.finished.bust !== undefined) expect(Math.abs(p.finished.bust - r.bustCm - p.ease.bust)).toBeLessThanOrEqual(0.5);
      expect(p.rationale.length).toBeGreaterThanOrEqual(3);
      expect(Number.isFinite(p.hemHeightFromFloorCm)).toBe(true);
    }
  });

  it('honours allowed user options and explains rejected ones', () => {
    const m = getProfile('hourglass-38').measurements;
    const ok = plan(req('a-line-skirt', m, 'parisian-chic', 'wool-crepe', { length: 'midi', fit: 'relaxed', flare: 0.8 }));
    expect(ok.options.length).toBe('midi');
    expect(ok.fit).toBe('relaxed');
    expect(ok.options.flare).toBeCloseTo(0.8, 5);
    const bad = plan(req('ball-gown', m, 'european-couture-evening', 'silk-mikado', { length: 'mini' }));
    expect(bad.options.length).toBe('floor');
    expect(bad.rationale.some((x) => x.includes('mini'))).toBe(true);
  });

  it('gives more ease to a relaxed fit than to a fitted one', () => {
    const m = getProfile('rectangle-40').measurements;
    const fitted = plan(req('shift-dress', m, 'parisian-chic', 'wool-crepe', { fit: 'fitted' }));
    const relaxed = plan(req('shift-dress', m, 'parisian-chic', 'wool-crepe', { fit: 'relaxed' }));
    expect(relaxed.ease.bust).toBeGreaterThan(fitted.ease.bust);
    expect(relaxed.ease.hip).toBeGreaterThan(fitted.ease.hip);
  });

  it('uses less (possibly negative) ease for a stretch knit than for a woven', () => {
    const m = getProfile('hourglass-38').measurements;
    const woven = plan(req('pencil-skirt', m, 'stockholm-minimal', 'wool-crepe', { fit: 'fitted' }));
    const knit = plan(req('pencil-skirt', m, 'stockholm-minimal', 'ponte-knit', { fit: 'fitted' }));
    expect(knit.ease.hip).toBeLessThan(woven.ease.hip);
    expect(knit.ease.hip).toBeGreaterThanOrEqual(-0.15 * m.hipCm);
    expect(woven.ease.hip).toBeGreaterThanOrEqual(2.5);
  });

  it('keeps hems off the widest part of the calf for skirts, dresses and gowns', () => {
    for (const p of PROFILES) {
      for (const g of ['a-line-skirt', 'pencil-skirt', 'sheath-dress', 'wrap-dress'] as GarmentType[]) {
        for (const length of ['knee', 'midi'] as const) {
          const fp = plan(req(g, p.measurements, 'parisian-chic', 'wool-crepe', { length }));
          const L = analyzeBody(resolveMeasurements(p.measurements)).landmarks;
          expect(Math.abs(fp.hemHeightFromFloorCm - L.calf), `${g} ${length} ${p.id}`).toBeGreaterThan(3);
        }
      }
    }
  });

  it('adds a fastening when a pull-on garment could not pass over the hips', () => {
    const p = plan(req('sheath-dress', getProfile('pear-plus-48').measurements, 'stockholm-minimal', 'wool-crepe', { closure: 'none' }));
    expect(p.options.closure).not.toBe('none');
  });

  it('is deterministic', () => {
    const r = req('wrap-dress', getProfile('pear-44').measurements, 'copenhagen-relaxed', 'viscose-crepe');
    expect(plan(r)).toEqual(plan(r));
  });
});

describe('plan sanity against the eval rules', () => {
  it.each(ALL_GARMENTS)('%s: ease within the eval ranges and hem within the length band', (g) => {
    const pkg = designFor(g, 'hourglass-38', 'eu');
    const cat = pkg.garment.category;
    const keys: Array<'bust' | 'hip'> = cat === 'skirt' || cat === 'trousers' ? ['hip'] : ['bust', 'hip'];
    for (const k of keys) {
      if (k === 'hip' && pkg.fit.finished.hip === undefined) continue;
      const [lo, hi] = easeRange(k, pkg);
      expect(pkg.fit.ease[k], `${k} ease`).toBeGreaterThanOrEqual(lo);
      expect(pkg.fit.ease[k], `${k} ease`).toBeLessThanOrEqual(hi);
    }
    const band = lengthBand(pkg);
    if (band && cat !== 'top') {
      expect(pkg.fit.hemHeightFromFloorCm).toBeGreaterThanOrEqual(band[0] - 0.01);
      expect(pkg.fit.hemHeightFromFloorCm).toBeLessThanOrEqual(band[1] + 0.01);
    }
  });
});
