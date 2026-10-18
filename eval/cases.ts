/**
 * Builds the evaluation matrix: garment × body profile × style/material combo.
 *
 * Every garment gets one European and one Scandinavian combo (style and
 * material from that region, material valid for the garment's fabric types
 * and listing the garment in `suitableFor`), plus a third "stress" combo that
 * exercises knits (negative ease) when the garment allows them, otherwise an
 * evening/runway material, with non-default options (length, sleeve,
 * neckline) to widen coverage. Choices are deterministic.
 */
import type { DesignRequest, GarmentDefinition, GarmentOptions, GarmentType, MaterialPreset, StylePreset } from '../src/core/types';
import { GARMENTS, MATERIALS, STYLES } from '../src/core/presets';
import { CORE_PROFILE_IDS, PROFILES, QUICK_PROFILE_IDS, type EvalProfile } from './profiles';

export type Region = 'european' | 'scandinavian';

export interface EvalCombo {
  key: string; // 'eu' | 'scandi' | 'stress'
  region: Region;
  styleId: string;
  materialId: string;
  options?: GarmentOptions;
}

export interface EvalCase {
  id: string;
  garment: GarmentType;
  profileId: string;
  combo: EvalCombo;
  request: DesignRequest;
  /** Run the expensive checks (3D, determinism, SVG/print) on this case. */
  deep: boolean;
}

/** Garments run against every profile ("skirts and dress basics"). */
export const FULL_PROFILE_GARMENTS: readonly GarmentType[] = ['a-line-skirt', 'pencil-skirt', 'circle-skirt', 'shift-dress', 'sheath-dress'];

/** Lining fabrics are never the main ("self") fabric of an eval case. */
function isLining(m: MaterialPreset): boolean {
  return /lining/i.test(m.id) || /lining/i.test(m.name);
}

function validMaterials(g: GarmentDefinition, materials: MaterialPreset[]): MaterialPreset[] {
  const ok = materials.filter((m) => g.fabricTypes.includes(m.construction) && !isLining(m));
  const suitable = ok.filter((m) => m.suitableFor.includes(g.id));
  return suitable.length ? suitable : ok;
}

interface Pick {
  style: StylePreset;
  material: MaterialPreset;
  score: number;
}

/** All (style, material) pairs from one region, scored by how well they belong together. */
function rankedPairs(g: GarmentDefinition, region: Region, styles: StylePreset[], materials: MaterialPreset[]): Pick[] {
  const mats = validMaterials(g, materials).filter((m) => m.regions.includes(region));
  const out: Pick[] = [];
  for (const style of styles.filter((s) => s.region === region)) {
    for (const material of mats) {
      let score = 0;
      if (style.recommendedMaterials.includes(material.id)) score += 4;
      if (style.recommendedGarments.includes(g.id)) score += 2;
      if (style.occasions.some((o) => g.occasions.includes(o))) score += 1;
      out.push({ style, material, score });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.style.id.localeCompare(b.style.id) || a.material.id.localeCompare(b.material.id));
}

/** Deterministic rotation among the best-scoring pairs so different garments exercise different presets. */
function rotatePick(pairs: Pick[], salt: number, avoid: Set<string>): Pick | undefined {
  const fresh = pairs.filter((p) => !avoid.has(p.material.id) && !avoid.has(p.style.id));
  const pool = fresh.length ? fresh : pairs;
  if (!pool.length) return undefined;
  const top = pool.filter((p) => p.score === pool[0].score);
  return top[salt % top.length];
}

function nonDefault<T>(allowed: readonly T[], def: T, salt: number): T | undefined {
  const others = allowed.filter((x) => x !== def);
  return others.length ? others[salt % others.length] : undefined;
}

/** Options for the stress combo: a non-default length, sleeve and neckline where the garment allows them. */
export function stressOptions(g: GarmentDefinition, salt: number): GarmentOptions {
  const o: GarmentOptions = {};
  const length = nonDefault(g.allowed.length, g.defaults.length, salt);
  if (length) o.length = length;
  const sleeve = nonDefault(g.allowed.sleeve, g.defaults.sleeve, salt + 1);
  if (sleeve) o.sleeve = sleeve;
  const neckline = nonDefault(g.allowed.neckline, g.defaults.neckline, salt + 2);
  if (neckline) o.neckline = neckline;
  return o;
}

export function combosFor(
  g: GarmentDefinition,
  salt = 0,
  styles: StylePreset[] = STYLES,
  materials: MaterialPreset[] = MATERIALS,
): EvalCombo[] {
  const used = new Set<string>();
  const combos: EvalCombo[] = [];
  for (const [key, region] of [
    ['eu', 'european'],
    ['scandi', 'scandinavian'],
  ] as const) {
    const pick = rotatePick(rankedPairs(g, region, styles, materials), salt, used);
    if (!pick) continue;
    used.add(pick.style.id);
    used.add(pick.material.id);
    combos.push({ key, region, styleId: pick.style.id, materialId: pick.material.id });
  }

  // Stress combo: knit if allowed and not yet used, else a lustrous evening fabric.
  const usedKnit = combos.some((c) => materials.find((m) => m.id === c.materialId)?.construction === 'knit');
  const candidates = validMaterials(g, materials).filter((m) => !used.has(m.id));
  const knit = !usedKnit && g.fabricTypes.includes('knit') ? candidates.filter((m) => m.construction === 'knit') : [];
  const evening = candidates.filter((m) => m.sheen === 'lustrous' || m.sheen === 'high' || m.occasions.includes('evening') || m.occasions.includes('runway'));
  const pool = knit.length ? knit : evening.length ? evening : candidates;
  if (pool.length) {
    const material = pool[salt % pool.length];
    const region: Region = material.regions.includes('scandinavian') ? 'scandinavian' : 'european';
    const style =
      styles.find((s) => s.region === region && s.recommendedMaterials.includes(material.id) && !used.has(s.id)) ??
      styles.find((s) => s.region === region && !used.has(s.id)) ??
      styles.find((s) => s.region === region);
    if (style) combos.push({ key: 'stress', region, styleId: style.id, materialId: material.id, options: stressOptions(g, salt) });
  }
  return combos;
}

export interface CaseOptions {
  garments?: GarmentType[];
  quick?: boolean;
  profiles?: string[];
}

function profilesFor(g: GarmentType, opts: CaseOptions): EvalProfile[] {
  if (opts.profiles?.length) return PROFILES.filter((p) => opts.profiles!.includes(p.id));
  if (opts.quick) return PROFILES.filter((p) => QUICK_PROFILE_IDS.includes(p.id));
  if (FULL_PROFILE_GARMENTS.includes(g)) return PROFILES;
  return PROFILES.filter((p) => CORE_PROFILE_IDS.includes(p.id));
}

/** Profiles that also get the deep checks on the first combo (size and height extremes). */
const DEEP_EXTRA_PROFILES = new Set(['round-54', 'petite-hourglass']);

export function buildCases(opts: CaseOptions = {}): EvalCase[] {
  const garments = GARMENTS.filter((g) => !opts.garments?.length || opts.garments.includes(g.id));
  const cases: EvalCase[] = [];
  garments.forEach((g, gi) => {
    const combos = combosFor(g, gi);
    const usable = opts.quick ? combos.slice(0, 2) : combos;
    const profiles = profilesFor(g.id, opts);
    usable.forEach((combo, ci) => {
      profiles.forEach((profile, pi) => {
        const request: DesignRequest = {
          measurements: profile.measurements,
          garment: g.id,
          styleId: combo.styleId,
          materialId: combo.materialId,
          ...(combo.options && Object.keys(combo.options).length ? { options: combo.options } : {}),
        };
        const deep = opts.quick ? ci === 0 && pi === 0 : pi === 0 || (ci === 0 && DEEP_EXTRA_PROFILES.has(profile.id));
        cases.push({
          id: `${g.id}/${profile.id}/${combo.key}:${combo.styleId}+${combo.materialId}`,
          garment: g.id,
          profileId: profile.id,
          combo,
          request,
          deep,
        });
      });
    });
  });
  return cases;
}
