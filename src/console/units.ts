/**
 * Unit handling. clothesCAD stores and computes everything in centimetres;
 * inches exist only at the edges (UI display and typed command values).
 */
import type { MeasurementKey } from '../core/types';
import { MEASUREMENT_FIELDS, MEASUREMENT_KEYS } from '../core/schema';

export type UnitSystem = 'cm' | 'in';

export const CM_PER_INCH = 2.54;

export function toDisplay(cm: number, unit: UnitSystem): number {
  return unit === 'cm' ? cm : cm / CM_PER_INCH;
}

export function fromDisplay(value: number, unit: UnitSystem): number {
  return unit === 'cm' ? value : value * CM_PER_INCH;
}

/** Round for display: 0.5 cm or 1/8 in resolution, trailing zeros removed. */
export function formatLength(cm: number, unit: UnitSystem, withUnit = true): string {
  const v = toDisplay(cm, unit);
  const rounded = unit === 'cm' ? Math.round(v * 10) / 10 : Math.round(v * 8) / 8;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(unit === 'cm' ? 1 : 2).replace(/0+$/, '');
  return withUnit ? `${text} ${unit}` : text;
}

/**
 * Parse a length typed by a person or agent: "92", "92cm", "36in", "36.5\"", "36 1/2in".
 * Bare numbers use `defaultUnit`. Returns centimetres, or null when unparseable.
 */
export function parseLength(raw: string, defaultUnit: UnitSystem = 'cm'): number | null {
  const s = raw.trim().toLowerCase().replace(/,/g, '.');
  const m = /^(-?\d+(?:\.\d+)?)(?:\s+(\d+)\/(\d+))?\s*(cm|in|inch|inches|"|mm)?$/.exec(s);
  if (!m) return null;
  let v = Number(m[1]);
  if (m[2] && m[3]) {
    const den = Number(m[3]);
    if (den === 0) return null;
    v += Number(m[2]) / den;
  }
  if (!Number.isFinite(v)) return null;
  const unit = m[4];
  if (unit === 'mm') return v / 10;
  if (unit === 'cm') return v;
  if (unit === 'in' || unit === 'inch' || unit === 'inches' || unit === '"') return v * CM_PER_INCH;
  return fromDisplay(v, defaultUnit);
}

/**
 * Resolve a measurement name typed loosely ("bust", "bustCm", "back-waist-length",
 * "waist_to_floor") to its MeasurementKey.
 */
export function resolveMeasurementKey(name: string): MeasurementKey | null {
  const norm = name.toLowerCase().replace(/[^a-z]/g, '');
  for (const key of MEASUREMENT_KEYS) {
    const k = key.toLowerCase();
    if (k === norm || k === `${norm}cm` || k.replace(/cm$/, '') === norm) return key;
    if (MEASUREMENT_FIELDS[key].label.replace(/[^a-z]/g, '') === norm) return key;
  }
  return null;
}
