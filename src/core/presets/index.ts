import type {
  BodyAnalysis,
  BodyShape,
  GarmentDefinition,
  GarmentType,
  MaterialPreset,
  Occasion,
  StylePreset,
} from '../types';
import { GARMENTS } from './garments';
import { MATERIALS } from './materials';
import { STYLES } from './styles';

export { GARMENTS, MATERIALS, STYLES };

export type Region = 'european' | 'scandinavian';

/** Materials intended as linings rather than the main (self) fabric. */
export const LINING_MATERIAL_IDS: readonly string[] = ['cupro-lining', 'silk-habotai-lining'];

export function isLiningMaterial(id: string): boolean {
  return LINING_MATERIAL_IDS.includes(id);
}

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

function unknownIdError(kind: string, id: unknown, valid: string[]): Error {
  const asText = typeof id === 'string' ? id : JSON.stringify(id);
  let hint = '';
  if (typeof id === 'string' && id.length > 0) {
    const needle = id.toLowerCase();
    const best = valid
      .map((v) => ({
        v,
        d: v.includes(needle) || needle.includes(v) ? 0 : editDistance(needle, v),
      }))
      .sort((x, y) => x.d - y.d)[0];
    if (best && best.d <= Math.max(3, Math.floor(best.v.length / 3))) hint = ` Did you mean '${best.v}'?`;
  }
  return new Error(`Unknown ${kind} '${asText}'.${hint} Valid ${kind} ids: ${valid.join(', ')}.`);
}

export function getGarment(id: GarmentType | string): GarmentDefinition {
  const g = GARMENTS.find((x) => x.id === id);
  if (!g) throw unknownIdError('garment', id, GARMENTS.map((x) => x.id));
  return g;
}

export function getMaterial(id: string): MaterialPreset {
  const m = MATERIALS.find((x) => x.id === id);
  if (!m) throw unknownIdError('material', id, MATERIALS.map((x) => x.id));
  return m;
}

export function getStyle(id: string): StylePreset {
  const s = STYLES.find((x) => x.id === id);
  if (!s) throw unknownIdError('style', id, STYLES.map((x) => x.id));
  return s;
}

/**
 * Pick a lining fabric to go with a main fabric: silk habotai for silks and
 * evening/runway cloths, cupro for everything else (breathable, anti-static,
 * washable, and much easier to sew).
 */
export function suggestLining(material: MaterialPreset): MaterialPreset {
  const luxurious =
    material.fiber === 'silk' ||
    (material.occasions.includes('runway') && !material.occasions.includes('everyday'));
  return getMaterial(luxurious ? 'silk-habotai-lining' : 'cupro-lining');
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

export interface RecommendOptions {
  body?: BodyAnalysis;
  garment?: GarmentType;
  styleId?: string;
  occasion?: Occasion;
  region?: Region;
  /** Only materials at least this beginner friendly (1..5). */
  minBeginnerFriendliness?: number;
  /** Only garments at most this difficult (1..5). */
  maxDifficulty?: number;
  /** Include lining fabrics among material recommendations (default false). */
  includeLinings?: boolean;
}

export interface Recommendation {
  materials: MaterialPreset[];
  styles: StylePreset[];
  garments: GarmentDefinition[];
  reasons: string[];
}

/** Which garments flatter each body shape, and why (plain language). */
const SHAPE_GARMENTS: Record<BodyShape, Partial<Record<GarmentType, string>>> = {
  hourglass: {
    'wrap-dress': 'the crossover and tie follow your defined waist and balanced bust and hip',
    'sheath-dress': 'vertical darts trace your curves without adding bulk',
    'pencil-skirt': 'it follows the curve from your waist over your hip',
    'ball-gown': 'a fitted bodice and full skirt celebrate your clear waistline',
    'circle-skirt': 'a fitted waistband marks your narrow waist and the fullness balances bust and hip',
  },
  pear: {
    'a-line-skirt': 'it skims past the hip instead of clinging, balancing your proportions',
    'circle-skirt': 'the fullness flows over the hip and draws the eye to your waist',
    'wide-leg-trousers': 'a straight, wide leg falls from the fullest hip and lengthens the leg line',
    'shell-top': 'a boat or square neckline widens the shoulder line to balance your hip',
    'wrap-dress': 'the V neckline draws attention upward and the skirt skims the hip',
    'ball-gown': 'the full skirt hides the hip line entirely and showcases your waist',
  },
  'inverted-triangle': {
    'a-line-skirt': 'flare at the hem adds volume below to balance broader shoulders',
    'circle-skirt': 'the full hem balances the shoulder line',
    'wide-leg-trousers': 'wide legs add visual weight below the waist to balance your shoulders',
    'wrap-dress': 'a V neckline breaks up the width across the shoulders',
    'ball-gown': 'a voluminous skirt balances strong shoulders for a classic hourglass effect',
  },
  rectangle: {
    'wrap-dress': 'the tie cinches in and creates waist definition',
    'circle-skirt': 'the contrast between fitted waist and full hem suggests curves',
    'shift-dress': 'its clean straight line suits a balanced, streamlined figure',
    'sheath-dress': 'darts add shaping through the waist on a straight figure',
    'ball-gown': 'a fitted bodice with a full skirt creates a defined waist',
    'tapered-trousers': 'room at the hip tapering to the ankle adds shape to a straight figure',
  },
  round: {
    'shift-dress': 'it skims rather than clings and makes one long, elegant vertical line',
    'wrap-dress': 'the V neckline elongates the torso and the wrap adjusts to your waist',
    'a-line-skirt': 'it falls cleanly from the waist without clinging at the tummy',
    'wide-leg-trousers': 'a high waist and fluid wide leg create a long, continuous line',
    'column-gown': 'a single unbroken vertical line from shoulder to floor is very elongating',
  },
};

const SHAPE_LABEL: Record<BodyShape, string> = {
  hourglass: 'hourglass',
  pear: 'pear (hip fuller than bust)',
  'inverted-triangle': 'inverted-triangle (shoulders/bust broader than hip)',
  rectangle: 'rectangle (straight, little waist definition)',
  round: 'round (fullness through the middle)',
};

interface Scored<T> {
  item: T;
  score: number;
  why: string[];
}

function rank<T>(items: Array<Scored<T>>): Array<Scored<T>> {
  // Stable, deterministic: score desc, then original order.
  return items
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.score - a.s.score || a.i - b.i)
    .map((x) => x.s);
}

function materialBodyScore(m: MaterialPreset, shape: BodyShape, category?: GarmentDefinition['category']): [number, string | null] {
  switch (shape) {
    case 'round':
      if (m.stiffness <= 0.45 && (m.sheen === 'matte' || m.sheen === 'soft'))
        return [2, 'a fluid, low-sheen cloth skims the midsection rather than adding volume'];
      if (m.sheen === 'high') return [-1, null];
      return [0, null];
    case 'pear':
      if ((category === 'skirt' || category === 'trousers') && m.sheen === 'high') return [-1, null];
      if (m.stiffness >= 0.35 && m.stiffness <= 0.75)
        return [1.5, 'medium body lets the skirt or leg fall cleanly past the hip without clinging'];
      return [0, null];
    case 'hourglass':
      if (m.stiffness <= 0.5 || m.stretchPct >= 5)
        return [2, 'a softer or stretchier cloth follows your curves instead of boxing them in'];
      return [0, null];
    case 'inverted-triangle':
      if ((category === 'skirt' || category === 'gown' || category === 'trousers') && m.stiffness >= 0.5)
        return [1.5, 'a cloth with body builds volume below the waist to balance the shoulders'];
      return [0, null];
    case 'rectangle':
      if (m.stiffness >= 0.5) return [1.5, 'structure creates shape and suggests a defined waist'];
      return [0, null];
  }
}

function styleBodyScore(s: StylePreset, shape: BodyShape): [number, string | null] {
  const sil = s.silhouette;
  switch (shape) {
    case 'round':
      return sil.defaultFit === 'fitted'
        ? [-1, null]
        : [1, 'its easier fit and long lines skim the body comfortably'];
    case 'hourglass':
      return sil.defaultFit !== 'relaxed'
        ? [1.5, 'its closer fit shows off your defined waist']
        : [0, null];
    case 'pear':
    case 'inverted-triangle':
      return sil.hemFlareBias > 0
        ? [1.5, 'it favours fuller hems that balance your proportions']
        : [0, null];
    case 'rectangle':
      return sil.hemFlareBias > 0 || sil.defaultFit === 'fitted'
        ? [1, 'its shaping and hem fullness create the impression of a waist']
        : [0, null];
  }
}

/**
 * Rank garments, styles and materials for a person and occasion.
 * Uses body analysis (if given) to favour what flatters, the occasion and
 * region to favour what fits the brief, and the garment's fabric types and
 * beginner friendliness to filter fabrics. Every recommendation is explained
 * in `reasons` (plain language).
 */
export function recommend(opts: RecommendOptions = {}): Recommendation {
  const { body, occasion, region } = opts;
  const garment = opts.garment ? getGarment(opts.garment) : undefined;
  const chosenStyle = opts.styleId ? getStyle(opts.styleId) : undefined;
  const shape = body?.shape;
  const reasons: string[] = [];

  if (shape) reasons.push(`Your measurements suggest a ${SHAPE_LABEL[shape]} figure.`);
  if (body) {
    for (const note of body.notes.slice(0, 3)) reasons.push(note);
  }

  // ---- garments ---------------------------------------------------------
  const garmentScores = GARMENTS.filter(
    (g) => opts.maxDifficulty === undefined || g.difficulty <= opts.maxDifficulty,
  ).map<Scored<GarmentDefinition>>((g) => {
    const why: string[] = [];
    let score = 0;
    if (occasion) {
      if (g.occasions.includes(occasion)) {
        score += 3;
        why.push(`made for ${occasion} wear`);
      } else score -= 2;
    }
    if (chosenStyle?.recommendedGarments.includes(g.id)) {
      score += 3;
      why.push(`a signature shape of the ${chosenStyle.name} style`);
    }
    if (region && STYLES.some((s) => s.region === region && s.recommendedGarments.includes(g.id))) score += 1;
    if (shape) {
      const flatter = SHAPE_GARMENTS[shape][g.id];
      if (flatter) {
        score += 3;
        why.push(flatter);
      }
    }
    if (body && body.ratios.legToHeight < 0.6 && g.id === 'wide-leg-trousers') {
      score += 1.5;
      why.push('a high waist with a floor-skimming wide leg adds visual leg length');
    }
    if (body && body.ratios.legToHeight < 0.6 && g.category === 'gown' && g.id === 'column-gown') {
      score += 1;
      why.push('one unbroken vertical line lengthens the whole figure');
    }
    score += (5 - g.difficulty) * 0.25; // mild preference for easier makes
    if (garment && g.id === garment.id) score += 100; // explicit choice first
    return { item: g, score, why };
  });
  const garmentsRanked = rank(garmentScores);

  // ---- materials ----------------------------------------------------------
  const minBf = opts.minBeginnerFriendliness ?? 1;
  const materialScores = MATERIALS.filter((m) => {
    if (!opts.includeLinings && isLiningMaterial(m.id)) return false;
    if (m.beginnerFriendliness < minBf) return false;
    if (garment && !garment.fabricTypes.includes(m.construction)) return false;
    return true;
  }).map<Scored<MaterialPreset>>((m) => {
    const why: string[] = [];
    let score = 0;
    if (garment) {
      if (m.suitableFor.includes(garment.id)) {
        score += 4;
        why.push(`well suited to a ${garment.name.toLowerCase()}`);
      } else score -= 4;
    }
    if (occasion) {
      if (m.occasions.includes(occasion)) {
        score += 3;
        why.push(`appropriate for ${occasion}`);
      } else score -= 2;
    }
    if (chosenStyle?.recommendedMaterials.includes(m.id)) {
      score += 4;
      why.push(`a core cloth of the ${chosenStyle.name} look`);
    }
    if (region) {
      if (m.regions.includes(region)) {
        score += 2;
        why.push(`a staple of the ${region === 'european' ? 'European' : 'Scandinavian'} wardrobe (traditionally from ${m.origin})`);
      } else score -= 1;
    }
    if (shape) {
      const [s, reason] = materialBodyScore(m, shape, garment?.category);
      score += s;
      if (reason) why.push(reason);
    }
    score += m.beginnerFriendliness * 0.3;
    return { item: m, score, why };
  });
  const materialsRanked = rank(materialScores);

  // ---- styles -------------------------------------------------------------
  const styleScores = STYLES.map<Scored<StylePreset>>((s) => {
    const why: string[] = [];
    let score = 0;
    if (chosenStyle && s.id === chosenStyle.id) score += 100;
    if (region) {
      if (s.region === region) {
        score += 3;
        why.push(`${region === 'european' ? 'European' : 'Scandinavian'} aesthetic`);
      } else score -= 2;
    }
    if (occasion) {
      if (s.occasions.includes(occasion)) {
        score += 3;
        why.push(`suited to ${occasion}`);
      } else score -= 2;
    }
    if (garment) {
      if (s.recommendedGarments.includes(garment.id)) {
        score += 3;
        why.push(`the ${garment.name.toLowerCase()} is one of its signature shapes`);
      }
    }
    if (shape) {
      const [sc, reason] = styleBodyScore(s, shape);
      score += sc;
      if (reason) why.push(reason);
    }
    return { item: s, score, why };
  });
  const stylesRanked = rank(styleScores);

  // ---- reasons for the top picks -----------------------------------------
  const describe = (name: string, why: string[]): string | null =>
    why.length ? `${name}: ${why.join('; ')}.` : null;
  for (const g of garmentsRanked.slice(0, 3)) {
    const r = describe(`Garment - ${g.item.name}`, g.why);
    if (r) reasons.push(r);
  }
  for (const s of stylesRanked.slice(0, 2)) {
    const r = describe(`Style - ${s.item.name}`, s.why);
    if (r) reasons.push(r);
  }
  for (const m of materialsRanked.slice(0, 3)) {
    const r = describe(`Fabric - ${m.item.name}`, m.why);
    if (r) reasons.push(r);
  }
  if (garment && materialsRanked.length === 0) {
    reasons.push(
      `No fabric matches a ${garment.name.toLowerCase()} with beginner friendliness >= ${minBf}; lower the limit to see more options.`,
    );
  }

  return {
    garments: garmentsRanked.map((x) => x.item),
    styles: stylesRanked.map((x) => x.item),
    materials: materialsRanked.map((x) => x.item),
    reasons,
  };
}
