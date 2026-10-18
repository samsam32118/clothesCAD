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
import { GARMENTS, MATERIALS, STYLES, getGarment, isLiningMaterial, recommend, type Region } from '../core/presets';
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
  /**
   * Keep this cloth. The style is then picked to suit it (styles whose own
   * cloths include it, and whose occasions it serves, rank first) and no
   * reason is given for the cloth, because nothing was chosen for it.
   */
  materialId?: string | null;
  body?: BodyAnalysis | null;
  /** Used to derive `body` when it is not given. */
  measurements?: Partial<Measurements>;
}

export interface Pick {
  styleId: string;
  materialId: string;
  /** Occasion the pick was made for (inferred from the garment when not given). */
  occasion: Occasion | null;
  /** Plain-language reasons, one per field that was actually picked (none for fields the caller supplied). */
  reasons: string[];
}

function findMaterial(id: string): MaterialPreset {
  const m = MATERIALS.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown material '${id}'. Valid: ${MATERIALS.map((x) => x.id).join(', ')}.`);
  return m;
}

function findStyle(id: string): StylePreset {
  const s = STYLES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown style '${id}'. Valid: ${STYLES.map((x) => x.id).join(', ')}.`);
  return s;
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
 * the garment and occasion. When the cloth is already chosen, the style that
 * lists that cloth among its own (and is worn on the occasions the cloth
 * serves) wins: a 70 gsm silk shell belongs to a dressy house, not a summer
 * linen one.
 */
export function rankStyles(input: PickInput): StylePreset[] {
  const garment = getGarment(input.garment);
  const chosen = input.materialId ? findMaterial(input.materialId) : null;
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
    if (chosen) {
      if (s.recommendedMaterials.includes(chosen.id)) k += 6;
      const shared = s.occasions.filter((o) => chosen.occasions.includes(o)).length;
      k += (2 * shared) / Math.max(1, s.occasions.length);
      if (chosen.regions.includes(s.region)) k += 0.5;
    }
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
 * Pick whatever the caller left out: the style (for the cloth, when one is
 * given) and the cloth (for the style). Deterministic. Reasons are given only
 * for the fields that were picked here.
 * Throws for an unknown garment, style or material id (with the valid ids listed).
 */
export function pickPresets(input: PickInput): Pick {
  const garment = getGarment(input.garment);
  const occasion = effectiveOccasion(garment, input.occasion);
  const body = input.body ?? (input.measurements ? currentBody(input.measurements) : null);
  const chosenMaterial = input.materialId ? findMaterial(input.materialId) : null;
  const reasons: string[] = [];
  let style: StylePreset | undefined;
  if (input.styleId) {
    style = findStyle(input.styleId);
  } else {
    style = rankStyles({ ...input, body })[0] ?? STYLES[0];
    if (!style) throw new Error('No style presets are available.');
    const forCloth = chosenMaterial
      ? style.recommendedMaterials.includes(chosenMaterial.id)
        ? `, and ${chosenMaterial.name.toLowerCase()} is one of its core cloths`
        : `, the closest match for ${chosenMaterial.name.toLowerCase()}`
      : '';
    reasons.push(
      `${style.name} was chosen for the ${garment.name.toLowerCase()}${occasion ? ` for ${occasion} wear` : ''}${input.region ? ` in the ${input.region} tradition` : ''}${forCloth}.`,
    );
  }
  if (chosenMaterial) {
    return { styleId: style.id, materialId: chosenMaterial.id, occasion: occasion ?? null, reasons };
  }
  const material = rankMaterials({ ...input, body, styleId: style.id })[0] ?? MATERIALS.find((m) => garment.fabricTypes.includes(m.construction));
  if (!material) throw new Error(`No cloth suits a ${garment.name.toLowerCase()}.`);
  reasons.push(
    `${material.name} was chosen because it suits the ${garment.name.toLowerCase()}${occasion && material.occasions.includes(occasion) ? ` and ${occasion} wear` : ''}${style.recommendedMaterials.includes(material.id) ? ` and is a core cloth of the ${style.name} look` : ''}.`,
  );
  return { styleId: style.id, materialId: material.id, occasion: occasion ?? null, reasons };
}

export interface SuitabilityInput {
  garment: GarmentType;
  styleId: string;
  materialId: string;
  occasion?: Occasion | null;
}

/**
 * Plain-language warnings for an explicit style/cloth choice that the
 * automatic picks would never make: a lining or day cloth for a gown, a
 * cloth of the wrong construction, a style not worn on the occasion. Each
 * warning names better-suited alternatives. Empty when the choice is sound.
 * The same tests drive the automatic picks, so a picked combination never
 * warns.
 */
export function suitabilityWarnings(input: SuitabilityInput): string[] {
  const garment = getGarment(input.garment);
  const style = findStyle(input.styleId);
  const material = findMaterial(input.materialId);
  const occasion = effectiveOccasion(garment, input.occasion);
  const g = garment.name.toLowerCase();
  const an = (word: string): string => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
  const aG = an(g);
  const out: string[] = [];

  const clothProblems: string[] = [];
  if (isLiningMaterial(material.id)) clothProblems.push('it is a lining cloth, too light and slippery to be the outer fabric');
  if (!garment.fabricTypes.includes(material.construction)) clothProblems.push(`it is ${an(material.construction)} and ${aG} needs ${garment.fabricTypes.join(' or ')} fabric`);
  else if (!material.suitableFor.includes(garment.id)) clothProblems.push('its weight and drape are not what this garment is usually cut from');
  if (occasion && !material.occasions.includes(occasion)) {
    clothProblems.push(`it is ${an(material.occasions.join('/'))} cloth and this is ${occasion} wear`);
  }
  if (clothProblems.length) {
    const alts = rankMaterials({ garment: garment.id, occasion: occasion ?? null, styleId: style.id })
      .filter((m) => m.id !== material.id && !isLiningMaterial(m.id) && materialFits(m, garment, occasion))
      .slice(0, 3)
      .map((m) => m.id);
    out.push(
      `${material.name} is an unusual choice for ${aG}: ${clothProblems.join('; ')}.${alts.length ? ` Consider ${alts.join(', ')}.` : ''}`,
    );
  }

  if (!styleFits(style, occasion)) {
    const alts = rankStyles({ garment: garment.id, occasion: occasion ?? null, materialId: material.id })
      .filter((s) => s.id !== style.id && styleFits(s, occasion))
      .slice(0, 3)
      .map((s) => s.id);
    out.push(
      `${style.name} is ${an(style.occasions.join('/'))} style and this is ${occasion} wear, so its proportions and finishes may look out of place.${alts.length ? ` Consider ${alts.join(', ')}.` : ''}`,
    );
  }
  return out;
}

const OCCASIONS: readonly Occasion[] = ['everyday', 'work', 'evening', 'runway'];

export interface AutoPicks {
  /** Request fields that were missing and filled in automatically. */
  filled: Array<'styleId' | 'materialId' | 'occasion'>;
  styleId: string;
  materialId: string;
  occasion: Occasion | null;
  reasons: string[];
}

/**
 * Fill styleId / materialId (and an occasion implied by the garment) when a
 * request leaves them out, exactly as the console and CLI do. Returns the
 * request unchanged when nothing is missing or it is too malformed to pick for
 * (schema validation then explains what is wrong).
 */
export function fillMissingPicks(request: unknown): { request: unknown; picks?: AutoPicks } {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return { request };
  const r = request as Record<string, unknown>;
  const missingStyle = r.styleId === undefined || r.styleId === null || r.styleId === '';
  const missingMaterial = r.materialId === undefined || r.materialId === null || r.materialId === '';
  if (!missingStyle && !missingMaterial) return { request };
  if (typeof r.garment !== 'string' || !GARMENTS.some((g) => g.id === r.garment)) return { request };
  const occasion = typeof r.occasion === 'string' && OCCASIONS.includes(r.occasion as Occasion) ? (r.occasion as Occasion) : null;
  const pick = pickPresets({
    garment: r.garment as GarmentType,
    occasion,
    styleId: missingStyle ? null : typeof r.styleId === 'string' ? r.styleId : null,
    materialId: missingMaterial ? null : typeof r.materialId === 'string' ? r.materialId : null,
    ...(typeof r.measurements === 'object' && r.measurements !== null ? { measurements: r.measurements as Partial<Measurements> } : {}),
  });
  const filled: AutoPicks['filled'] = [];
  const next: Record<string, unknown> = { ...r };
  if (missingStyle) {
    next.styleId = pick.styleId;
    filled.push('styleId');
  }
  if (missingMaterial) {
    next.materialId = pick.materialId;
    filled.push('materialId');
  }
  if (occasion === null && r.occasion === undefined && pick.occasion) {
    next.occasion = pick.occasion;
    filled.push('occasion');
  }
  return { request: next, picks: { filled, styleId: pick.styleId, materialId: pick.materialId, occasion: pick.occasion, reasons: pick.reasons } };
}
