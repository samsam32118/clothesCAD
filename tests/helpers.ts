/**
 * Shared helpers for the vitest suites: cached designs for (garment, profile,
 * combo) triples and assertions over eval metric results.
 */
import { expect } from 'vitest';
import { design } from '../src/core/design';
import { getGarment } from '../src/core/presets';
import type { DesignPackage, DesignRequest, GarmentType } from '../src/core/types';
import { combosFor, type EvalCombo } from '../eval/cases';
import type { MetricResult } from '../eval/metrics';
import { getProfile } from '../eval/profiles';

const cache = new Map<string, DesignPackage>();

export function comboFor(garment: GarmentType, key: 'eu' | 'scandi' | 'stress' = 'eu'): EvalCombo {
  const all = combosFor(getGarment(garment));
  const c = all.find((x) => x.key === key) ?? all[0];
  if (!c) throw new Error(`no ${key} combo for ${garment}`);
  return c;
}

export function requestFor(garment: GarmentType, profileId = 'hourglass-38', key: 'eu' | 'scandi' | 'stress' = 'eu'): DesignRequest {
  const c = comboFor(garment, key);
  return {
    measurements: getProfile(profileId).measurements,
    garment,
    styleId: c.styleId,
    materialId: c.materialId,
    ...(c.options && Object.keys(c.options).length ? { options: c.options } : {}),
  };
}

/** Design once per (garment, profile, combo) for the whole test file. */
export function designFor(garment: GarmentType, profileId = 'hourglass-38', key: 'eu' | 'scandi' | 'stress' = 'eu'): DesignPackage {
  const k = `${garment}|${profileId}|${key}`;
  let pkg = cache.get(k);
  if (!pkg) {
    pkg = design(requestFor(garment, profileId, key));
    cache.set(k, pkg);
  }
  return pkg;
}

/** Failure details of a metric restricted to the given aspects. */
export function failuresIn(r: MetricResult, aspects: string[]): string[] {
  return r.details.filter((d) => aspects.some((a) => d.startsWith(`[${a}]`)));
}

/** Assert that none of the given aspects of a metric failed, showing the concrete failures otherwise. */
export function expectAspectsPass(r: MetricResult, aspects: string[], context = ''): void {
  expect(failuresIn(r, aspects), `${r.id} ${context}`).toEqual([]);
}

export const ALL_GARMENTS: GarmentType[] = [
  'a-line-skirt',
  'pencil-skirt',
  'circle-skirt',
  'wide-leg-trousers',
  'tapered-trousers',
  'shell-top',
  'shift-dress',
  'sheath-dress',
  'wrap-dress',
  'column-gown',
  'ball-gown',
];
