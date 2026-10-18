/**
 * Physically based materials for the mannequin and the fabric.
 * Safe in Node (no textures, no DOM).
 */
import { Color, DoubleSide, FrontSide, MeshPhysicalMaterial } from 'three';
import type { MaterialPreset } from '../core/types';
import { clamp } from './math';

export type FabricLook = Pick<MaterialPreset, 'render' | 'sheen'> & Partial<Pick<MaterialPreset, 'name' | 'fiber' | 'id'>>;

const FALLBACK_COLOR = '#b8aa98';

function safeColor(hex: string | undefined): Color {
  const c = new Color(FALLBACK_COLOR);
  if (typeof hex === 'string' && /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex.trim())) {
    c.set(hex.trim().startsWith('#') ? hex.trim() : `#${hex.trim()}`);
  }
  return c;
}

/**
 * Fabric material from `material.render`: sheen drives the velvet-like sheen
 * lobe (silks, satins, cupro), roughness controls the matte look of wools and
 * linens. Double-sided so the inside of the garment is visible at openings.
 */
export function createGarmentMaterial(material: FabricLook): MeshPhysicalMaterial {
  const base = safeColor(material.render?.baseColor);
  const roughness = clamp(material.render?.roughness ?? 0.7, 0.05, 1);
  const sheen = clamp(material.render?.sheen ?? 0, 0, 1);
  const lustre = material.sheen === 'high' ? 1 : material.sheen === 'lustrous' ? 0.7 : material.sheen === 'soft' ? 0.35 : 0;
  const sheenColor = base.clone().lerp(new Color('#ffffff'), 0.45 + 0.25 * lustre);
  const mat = new MeshPhysicalMaterial({
    name: `fabric:${material.id ?? material.name ?? 'fabric'}`,
    color: base,
    roughness,
    metalness: 0,
    sheen,
    sheenColor,
    sheenRoughness: clamp(0.25 + 0.6 * roughness - 0.15 * lustre, 0.1, 1),
    specularIntensity: clamp(0.25 + 0.6 * lustre, 0, 1),
    clearcoat: material.sheen === 'high' ? 0.18 : 0,
    clearcoatRoughness: 0.35,
    side: DoubleSide,
  });
  return mat;
}

/** Neutral, elegant mannequin finish: warm ivory, satin-matte. */
export function createBodyMaterial(): MeshPhysicalMaterial {
  return new MeshPhysicalMaterial({
    name: 'mannequin',
    color: new Color('#e7e0d6'),
    roughness: 0.52,
    metalness: 0,
    clearcoat: 0.12,
    clearcoatRoughness: 0.5,
    side: FrontSide,
  });
}
