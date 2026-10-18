import { describe, expect, it } from 'vitest';
import { computeLandmarks, resolveMeasurements, validateMeasurements } from '../src/core/measurements';
import type { MeasurementKey, Measurements } from '../src/core/types';
import { INVALID_PROFILES, PROFILES, getProfile } from '../eval/profiles';

const ALL_KEYS: MeasurementKey[] = [
  'heightCm', 'bustCm', 'waistCm', 'hipCm', 'underbustCm', 'highHipCm', 'neckCm', 'shoulderWidthCm', 'shoulderLengthCm',
  'backWaistLengthCm', 'frontWaistLengthCm', 'shoulderToBustPointCm', 'bustPointDistanceCm', 'armLengthCm', 'upperArmCm',
  'elbowCm', 'wristCm', 'waistToHipCm', 'waistToKneeCm', 'waistToFloorCm', 'crotchDepthCm', 'inseamCm', 'thighCm',
  'kneeCm', 'calfCm', 'ankleCm',
];

describe('validateMeasurements', () => {
  it.each(PROFILES.map((p) => [p.id, p] as const))('accepts the valid eval profile %s without errors or warnings', (_id, p) => {
    const issues = validateMeasurements(p.measurements);
    expect(issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it.each(INVALID_PROFILES.map((p) => [p.id, p] as const))('rejects %s with errors on the right fields', (_id, p) => {
    const errors = validateMeasurements(p.measurements).filter((i) => i.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    for (const key of p.expectErrorOn) expect(errors.map((e) => e.key), `expected an error on ${key}`).toContain(key);
    for (const e of errors) expect(e.message.length, 'messages are explanatory sentences').toBeGreaterThan(20);
  });

  it('requires the four core measurements', () => {
    const issues = validateMeasurements({ heightCm: 168, bustCm: 90, waistCm: 72 } as unknown as Measurements);
    expect(issues.some((i) => i.key === 'hipCm' && i.severity === 'error')).toBe(true);
  });

  it('rejects non-numeric values', () => {
    const issues = validateMeasurements({ heightCm: 168, bustCm: 'ninety', waistCm: 72, hipCm: 98 } as unknown as Measurements);
    expect(issues.some((i) => i.key === 'bustCm' && i.severity === 'error')).toBe(true);
  });

  it('flags a single value that looks like inches', () => {
    const issues = validateMeasurements({ heightCm: 168, bustCm: 36, waistCm: 72, hipCm: 98 });
    const bust = issues.find((i) => i.key === 'bustCm');
    expect(bust?.severity).toBe('error');
    expect(bust?.message.toLowerCase()).toContain('inch');
  });

  it('warns about unknown keys with a suggestion instead of failing', () => {
    const issues = validateMeasurements({ heightCm: 168, bustCm: 90, waistCm: 72, hipCm: 98, bust: 90 } as unknown as Measurements);
    const unknown = issues.find((i) => i.message.includes('"bust"'));
    expect(unknown?.severity).toBe('warning');
    expect(unknown?.message).toContain('bustCm');
  });

  it('reports which optional measurements will be estimated', () => {
    const issues = validateMeasurements(getProfile('rectangle-40').measurements);
    expect(issues.some((i) => i.severity === 'info' && /estimated/i.test(i.message))).toBe(true);
  });
});

describe('resolveMeasurements', () => {
  it.each(PROFILES.map((p) => [p.id, p] as const))('fills every measurement consistently for %s', (_id, p) => {
    const r = resolveMeasurements(p.measurements);
    for (const k of ALL_KEYS) {
      expect(Number.isFinite(r[k]), k).toBe(true);
      expect(r[k], k).toBeGreaterThan(0);
    }
    // given values are kept exactly; only missing ones are estimated
    const given = Object.keys(p.measurements) as MeasurementKey[];
    for (const k of given) expect(r[k], k).toBe(p.measurements[k]);
    expect([...r.estimated].sort()).toEqual(ALL_KEYS.filter((k) => !given.includes(k)).sort());
    // anatomical consistency
    expect(r.underbustCm).toBeLessThan(r.bustCm);
    expect(r.thighCm).toBeLessThan(r.hipCm);
    expect(r.kneeCm).toBeLessThan(r.thighCm);
    expect(r.ankleCm).toBeLessThan(r.calfCm);
    expect(r.wristCm).toBeLessThan(r.upperArmCm);
    expect(r.waistToHipCm).toBeLessThan(r.waistToKneeCm);
    expect(r.waistToKneeCm).toBeLessThan(r.waistToFloorCm);
    expect(r.frontWaistLengthCm).toBeGreaterThan(r.backWaistLengthCm);
    expect(Math.abs(r.inseamCm + r.crotchDepthCm - r.waistToFloorCm)).toBeLessThanOrEqual(6);
    const legRatio = r.waistToFloorCm / r.heightCm;
    expect(legRatio).toBeGreaterThan(0.55);
    expect(legRatio).toBeLessThan(0.7);
  });

  it('scales length estimates with height', () => {
    const short = resolveMeasurements({ heightCm: 152, bustCm: 90, waistCm: 72, hipCm: 98 });
    const tall = resolveMeasurements({ heightCm: 184, bustCm: 90, waistCm: 72, hipCm: 98 });
    for (const k of ['armLengthCm', 'waistToFloorCm', 'waistToKneeCm', 'backWaistLengthCm', 'inseamCm'] as const) {
      expect(tall[k], k).toBeGreaterThan(short[k]);
    }
  });

  it('estimates close to the classic size-38 reference body', () => {
    const r = resolveMeasurements({ heightCm: 168, bustCm: 88, waistCm: 70, hipCm: 94 });
    expect(r.waistToFloorCm).toBeGreaterThan(100);
    expect(r.waistToFloorCm).toBeLessThan(108);
    expect(r.backWaistLengthCm).toBeGreaterThan(38);
    expect(r.backWaistLengthCm).toBeLessThan(44);
    expect(r.armLengthCm).toBeGreaterThan(55);
    expect(r.armLengthCm).toBeLessThan(63);
  });
});

describe('computeLandmarks', () => {
  it.each(PROFILES.map((p) => [p.id, p] as const))('orders landmark heights head to ankle for %s', (_id, p) => {
    const r = resolveMeasurements(p.measurements);
    const L = computeLandmarks(r);
    const chain = [L.head, L.nape, L.shoulder, L.bust, L.underbust, L.waist, L.highHip, L.hip, L.crotch, L.knee, L.calf, L.ankle];
    for (let i = 1; i < chain.length; i++) expect(chain[i], `landmark ${i}`).toBeLessThan(chain[i - 1]);
    expect(L.ankle).toBeGreaterThan(0);
    expect(L.head).toBeCloseTo(r.heightCm, 5);
    expect(Math.abs(L.waist - r.waistToFloorCm)).toBeLessThanOrEqual(1);
    expect(L.elbow).toBeLessThan(L.shoulder);
    expect(L.wrist).toBeLessThan(L.elbow);
  });
});
