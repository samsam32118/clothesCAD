import { describe, expect, it } from 'vitest';
import { designRequestJSONSchema, parseDesignRequest, GARMENT_TYPES } from './schema';
import { computeLandmarks, resolveMeasurements, validateMeasurements } from './measurements';
import { analyzeBody, classifyShape } from './fit/analyze';
import type { Measurements } from './types';

const ref: Measurements = { heightCm: 168, bustCm: 88, waistCm: 70, hipCm: 94 };
const errors = (m: unknown) => validateMeasurements(m as Measurements).filter((i) => i.severity === 'error');

describe('schema', () => {
  it('exports a JSON Schema for agents', () => {
    const js = designRequestJSONSchema() as { properties: Record<string, { enum?: string[]; required?: string[] }>; required: string[] };
    expect(js.required).toEqual(['measurements', 'garment', 'styleId', 'materialId']);
    expect(js.properties.garment.enum).toEqual([...GARMENT_TYPES]);
    expect(js.properties.measurements.required).toEqual(['heightCm', 'bustCm', 'waistCm', 'hipCm']);
  });

  it('parses valid requests and reports paths of invalid ones', () => {
    expect(parseDesignRequest({ measurements: ref, garment: 'a-line-skirt', styleId: 's', materialId: 'm' }).ok).toBe(true);
    const bad = parseDesignRequest({ measurements: { ...ref, bustCm: 'big' }, garment: 'cape', styleId: 's', materialId: 'm', options: { flare: 3 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((i) => i.path).sort()).toEqual(['garment', 'measurements.bustCm', 'options.flare']);
  });
});

describe('measurements', () => {
  it('accepts a standard body', () => expect(errors(ref)).toEqual([]));
  it('requires the four core measurements', () => expect(errors({ heightCm: 168 }).map((i) => i.key).sort()).toEqual(['bustCm', 'hipCm', 'waistCm']));
  it('detects a whole set entered in inches', () => expect(errors({ heightCm: 66, bustCm: 34.5, waistCm: 27.5, hipCm: 37 })[0].message).toMatch(/inches/));
  it('detects a single value in inches', () => expect(errors({ ...ref, neckCm: 14.5 })[0].key).toBe('neckCm'));
  it('rejects a waist larger than bust + hip', () => expect(errors({ ...ref, waistCm: 190 }).some((i) => i.key === 'waistCm')).toBe(true));
  it('rejects out-of-range heights', () => expect(errors({ ...ref, heightCm: 260 }).length).toBeGreaterThan(0));
  it('warns about unknown keys with a suggestion', () => {
    const w = validateMeasurements({ ...ref, thigh: 50 } as unknown as Measurements).find((i) => i.severity === 'warning');
    expect(w?.message).toMatch(/thighCm/);
  });

  it('estimates every optional measurement consistently', () => {
    const r = resolveMeasurements(ref);
    expect(r.estimated.length).toBe(22);
    expect(r.inseamCm + r.crotchDepthCm).toBeCloseTo(r.waistToFloorCm, 0);
    expect(r.kneeCm).toBeLessThan(r.thighCm);
    expect(r.ankleCm).toBeLessThan(r.calfCm);
    expect(r.wristCm).toBeLessThan(r.elbowCm);
    const given = resolveMeasurements({ ...ref, inseamCm: 80 });
    expect(given.inseamCm).toBe(80);
    expect(given.estimated).not.toContain('inseamCm');
  });

  it('orders landmarks from head to ankle', () => {
    const L = computeLandmarks(resolveMeasurements(ref));
    const order = [L.head, L.nape, L.bust, L.underbust, L.waist, L.highHip, L.hip, L.crotch, L.knee, L.calf, L.ankle];
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeLessThan(order[i - 1]);
  });
});

describe('body analysis', () => {
  it('classifies shapes by circumference differences', () => {
    expect(classifyShape(92, 66, 94)).toBe('hourglass');
    expect(classifyShape(84, 68, 104)).toBe('pear');
    expect(classifyShape(104, 84, 92)).toBe('inverted-triangle');
    expect(classifyShape(88, 78, 92)).toBe('rectangle');
    expect(classifyShape(110, 112, 112)).toBe('round');
  });
  it('explains what flatters, with reasons', () => {
    const b = analyzeBody(resolveMeasurements({ heightCm: 152, bustCm: 84, waistCm: 68, hipCm: 104 }));
    expect(b.shape).toBe('pear');
    expect(b.notes.some((n) => /petite/i.test(n))).toBe(true);
  });
});
