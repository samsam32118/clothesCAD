/**
 * Default style and cloth picks shared by the store, console commands, agent
 * API and CLI.
 *
 * `recommend()` (src/core/presets) ranks every preset with soft scores. That
 * is right for browsing, but an automatic pick has to respect the brief
 * strictly: a runway ball gown must never default to shirting cotton just
 * because cotton is easy to sew. This module therefore
 *   1. infers the occasion from the garment when none is given (a ball gown is
 *      evening wear even if nobody said so),
 *   2. hard-filters styles and cloths to that occasion and garment,
 *   3. picks the style first, then the cloth *for that style*, and
 *   4. for evening/runway ignores beginner friendliness (couture cloths are
 *      harder to sew; that is not a reason to swap them for cotton).
 */
import { analyzeBody } from '../core/fit/analyze';
import { resolveMeasurements, validateMeasurements } from '../core/measurements';
import { MATERIALS, STYLES, getGarment, isLiningMaterial, recommend, type Region } from '../core/presets';
import type { BodyAnalysis, GarmentDefinition, GarmentType, MaterialPreset, Measurements, Occasion, StylePreset } from '../core/types';

const DRESSY: ReadonlySet<Occasion> = new Set<Occasion>(['evening', 'runway']);

/** Body analysis from (possibly partial) measurements, or null when they are incomplete or invalid. */
export function currentBody(measurements: Partial<Measurements>): BodyAnalysis | null {
  const req = ['heightCm', 'bustCm', 'waistCm', 'hipCm'] as const;
  if (!req.every((k) => typeof measurements[k] === 'number' && Number.isFinite(measurements[k]))) return null;
  const m = measurements as Measurements;
  try {
    if (validateMeasurements(m).some((i) => i.severity === 'error')) return null;
    return analyzeBody(resolveMeasurements(m));
  } catch {
    return null;
  }
}

/**
 * The occasion a pick should satisfy: the requested one, or, when none was
 * given, the garment's own occasion if it is only made for dressy wear
 * (ball gown, column gown). Everyday garments return undefined (no filter).
 */
export function effectiveOccasion(garment: GarmentDefinition, occasion?: Occasion | null): Occasion | undefined {
  if (occasion) return occasion;
  if (garment.occasions.length && garment.occasions.every((o) => DRESSY.has(o))) return garment.occasions[0];
  return undefined;
}

/** True when a cloth suits this garment (and occasion, when one applies). */
export function materialFits(m: MaterialPreset, garment: GarmentDefinition, occasion?: Occasion): boolean {
  return (
    garment.fabricTypes.includes(m.construction) &&
    m.suitableFor.includes(garment.id) &&
    (!occasion || m.occasions.includes(occasion))
  );
}

/** True when a style is offered for the occasion (or no occasion applies). */
export function styleFits(s: StylePreset, occasion?: Occasion): boolean {
  return !occasion || s.occasions.includes(occasion);
}

export interface PickInput {
  garment: GarmentType;
  occasion?: Occasion | null;
  region?: Region | null;
  /** Keep this style (the cloth is then picked for it). */
  styleId?: string | null;
  body?: BodyAnalysis | null;
  /** Used to derive `body` when it is not given. */
  measurements?: Partial<Measurements>;
}

export interface Pick {
  styleId: string;
  materialId: string;
  /** Occasion the pick was made for (inferred from the garment when not given). */
  occasion: Occasion | null;
  /** Plain-language reasons for the pick. */
  reasons: string[];
}

/** Stable sort: higher key first, original (recommend) order breaks ties. */
function rerank<T>(items: readonly T[], key: (item: T, index: number) => number): T[] {
  return items
    .map((item, index) => ({ item, index, k: key(item, index) }))
    .sort((a, b) => b.k - a.k || a.index - b.index)
    .map((x) => x.item);
}

/**
 * Rank styles for a brief. Starts from recommend()'s order (which carries the
 * body-shape and region preferences), then adds what an atelier would weigh:
 * the garment is a signature shape of the style, the style is made for this
 * occasion (specialists beat generalists), and the style's own cloths suit
 * the garment and occasion.
 */
export function rankStyles(input: PickInput): StylePreset[] {
  const garment = getGarment(input.garment);
  const occasion = effectiveOccasion(garment, input.occasion);
  const body = input.body ?? (input.measurements ? currentBody(input.measurements) : null);
  const base = recommend({
    garment: garment.id,
    ...(occasion ? { occasion } : {}),
    ...(input.region ? { region: input.region } : {}),
    ...(body ? { body } : {}),
  }).styles;
  const eligible = base.filter((s) => styleFits(s, occasion));
  const pool = eligible.length ? eligible : base;
  return rerank(pool, (s, i) => {
    let k = 0;
    if (s.recommendedGarments.includes(garment.id)) k += 3;
    if (occasion && s.occasions.includes(occasion)) k += 3 + 2 / s.occasions.length;
    if (input.region && s.region === input.region) k += 3;
    const ownCloths = s.recommendedMaterials
      .map((id) => MATERIALS.find((m) => m.id === id))
      .filter((m): m is MaterialPreset => !!m && !isLiningMaterial(m.id) && materialFits(m, garment, occasion));
    k += 0.5 * ownCloths.length;
    return k - 0.25 * i; // recommend() order (body shape, region) as a soft prior
  });
}

/**
 * Rank cloths for a garment in a given style. Unsuitable cloths (wrong
 * construction, not suited to the garment, wrong occasion) are filtered out
 * whenever anything suitable remains.
 */
export function rankMaterials(input: PickInput & { styleId: string }): MaterialPreset[] {
  const garment = getGarment(input.garment);
  const occasion = effectiveOccasion(garment, input.occasion);
  const body = input.body ?? (input.measurements ? currentBody(input.measurements) : null);
  const style = STYLES.find((s) => s.id === input.styleId);
  const base = recommend({
    garment: garment.id,
    styleId: input.styleId,
    ...(occasion ? { occasion } : {}),
    ...(input.region ? { region: input.region } : {}),
    ...(body ? { body } : {}),
  }).materials.filter((m) => garment.fabricTypes.includes(m.construction));
  const strict = base.filter((m) => materialFits(m, garment, occasion));
  const relaxed = base.filter((m) => m.suitableFor.includes(garment.id));
  const pool = strict.length ? strict : relaxed.length ? relaxed : base;
  if (!occasion || !DRESSY.has(occasion)) return pool;
  // Evening / runway: the brief and the house style decide, not ease of sewing.
  return rerank(pool, (m) => {
    let k = 0;
    if (style?.recommendedMaterials.includes(m.id)) k += 4;
    if (m.occasions.includes('runway') && occasion === 'runway') k += 1;
    if (m.occasions.every((o) => DRESSY.has(o))) k += 1; // a true occasion cloth
    if (m.occasions.includes('everyday')) k -= 1; // day cloth: only if nothing better
    return k;
  });
}

/**
 * Pick a style (unless given) and then a cloth for it. Deterministic.
 * Throws for an unknown garment or style id (with the valid ids listed).
 */
export function pickPresets(input: PickInput): Pick {
  const garment = getGarment(input.garment);
  const occasion = effectiveOccasion(garment, input.occasion);
  const body = input.body ?? (input.measurements ? currentBody(input.measurements) : null);
  const reasons: string[] = [];
  let style: StylePreset | undefined;
  if (input.styleId) {
    style = STYLES.find((s) => s.id === input.styleId);
    if (!style) throw new Error(`Unknown style '${input.styleId}'. Valid: ${STYLES.map((s) => s.id).join(', ')}.`);
  } else {
    style = rankStyles({ ...input, body })[0] ?? STYLES[0];
    if (!style) throw new Error('No style presets are available.');
    reasons.push(
      `${style.name} was chosen for the ${garment.name.toLowerCase()}${occasion ? ` for ${occasion} wear` : ''}${input.region ? ` in the ${input.region} tradition` : ''}.`,
    );
  }
  const material = rankMaterials({ ...input, body, styleId: style.id })[0] ?? MATERIALS.find((m) => garment.fabricTypes.includes(m.construction));
  if (!material) throw new Error(`No cloth suits a ${garment.name.toLowerCase()}.`);
  reasons.push(
    `${material.name} was chosen because it suits the ${garment.name.toLowerCase()}${occasion && material.occasions.includes(occasion) ? ` and ${occasion} wear` : ''}${style.recommendedMaterials.includes(material.id) ? ` and is a core cloth of the ${style.name} look` : ''}.`,
  );
  return { styleId: style.id, materialId: material.id, occasion: occasion ?? null, reasons };
}
