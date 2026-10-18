/**
 * Fit planner: decides options, ease, finished measurements and hem height for
 * one design, and explains every choice in plain language tied to this body.
 *
 * Option precedence: garment defaults <- style silhouette preferences <- user
 * options (user values are only honoured when the garment allows them).
 */
import type {
  BodyAnalysis,
  BodyLandmarks,
  BodyShape,
  Closure,
  DesignRequest,
  FitPlan,
  FitPreference,
  GarmentCategory,
  GarmentDefinition,
  GarmentOptions,
  GarmentType,
  LengthPreset,
  MaterialPreset,
  Neckline,
  ResolvedMeasurements,
  StylePreset,
} from '../types';
import { headCircumference, heelInstepCircumference, hpsHeight } from '../measurements';
import { bodyProfile } from './profile';

export interface FitContext {
  request: DesignRequest;
  garment: GarmentDefinition;
  style: StylePreset;
  material: MaterialPreset;
  measurements: ResolvedMeasurements;
  body: BodyAnalysis;
}

interface EaseRow {
  bust: number;
  waist: number;
  hip: number;
  upperArm: number;
  thigh: number;
}

/**
 * Base wearing ease (finished garment minus body, cm of circumference) for
 * WOVEN fabrics by garment category and fit preference. Values follow common
 * flat-pattern references: a fitted woven bodice has ~5–7 cm bust ease,
 * 2–3 cm waist ease and 4–5 cm hip ease; relaxed garments roughly double that.
 */
export const WOVEN_EASE: Record<GarmentCategory, Record<FitPreference, EaseRow>> = {
  top: {
    fitted: { bust: 6, waist: 5, hip: 5, upperArm: 5, thigh: 0 },
    regular: { bust: 9, waist: 9, hip: 7, upperArm: 7, thigh: 0 },
    relaxed: { bust: 14, waist: 14, hip: 10, upperArm: 10, thigh: 0 },
  },
  dress: {
    fitted: { bust: 6, waist: 3, hip: 4.5, upperArm: 5, thigh: 0 },
    regular: { bust: 8.5, waist: 5, hip: 6, upperArm: 6.5, thigh: 0 },
    relaxed: { bust: 12, waist: 10, hip: 9, upperArm: 9, thigh: 0 },
  },
  gown: {
    fitted: { bust: 4.5, waist: 2, hip: 4, upperArm: 4.5, thigh: 0 },
    regular: { bust: 6.5, waist: 3.5, hip: 5.5, upperArm: 6, thigh: 0 },
    relaxed: { bust: 10, waist: 7, hip: 8, upperArm: 8, thigh: 0 },
  },
  skirt: {
    fitted: { bust: 0, waist: 2, hip: 4, upperArm: 0, thigh: 0 },
    regular: { bust: 0, waist: 2.5, hip: 5, upperArm: 0, thigh: 0 },
    relaxed: { bust: 0, waist: 3, hip: 8, upperArm: 0, thigh: 0 },
  },
  trousers: {
    fitted: { bust: 0, waist: 2, hip: 5, upperArm: 0, thigh: 6 },
    regular: { bust: 0, waist: 2.5, hip: 7, upperArm: 0, thigh: 9 },
    relaxed: { bust: 0, waist: 3, hip: 10, upperArm: 0, thigh: 14 },
  },
};

/** Fraction of the fabric's crosswise stretch used as negative ease for knits. */
export const KNIT_STRETCH_USE: Record<FitPreference, number> = { fitted: 0.35, regular: 0.2, relaxed: 0.05 };

/** Garments whose character depends on fit: a style may move their fit by at most one step. */
const FIT_DEFINED: GarmentType[] = ['pencil-skirt', 'sheath-dress', 'column-gown', 'ball-gown'];

const FIT_ORDER: FitPreference[] = ['fitted', 'regular', 'relaxed'];

/** Body shapes each neckline flatters most (first = best). */
const NECKLINE_BY_SHAPE: Record<BodyShape, Neckline[]> = {
  hourglass: ['sweetheart', 'v', 'scoop', 'square', 'jewel', 'boat'],
  pear: ['boat', 'square', 'scoop', 'sweetheart', 'v', 'jewel'],
  'inverted-triangle': ['v', 'scoop', 'sweetheart', 'jewel', 'square', 'boat'],
  rectangle: ['square', 'sweetheart', 'scoop', 'boat', 'v', 'jewel'],
  round: ['v', 'scoop', 'square', 'sweetheart', 'boat', 'jewel'],
};

const NECKLINE_REASON: Record<Neckline, string> = {
  jewel: 'a jewel neckline frames the face simply and suits clean, minimal styling',
  scoop: 'a scoop neckline opens the collarbone area and softens the shoulder line',
  v: 'a V neckline draws the eye vertically and lengthens the neck and torso',
  boat: 'a boat neckline runs wide towards the shoulders, broadening the upper body to balance the hip',
  square: 'a square neckline adds structure at the top and frames the collarbones',
  sweetheart: 'a sweetheart neckline follows the curve of the bust for a romantic, sculpted line',
};

const SLEEVE_FRACTION: Record<string, number> = {
  cap: 0.13,
  short: 0.3,
  elbow: 0.56,
  'three-quarter': 0.78,
  long: 1.0,
};

export function categoryOf(g: GarmentDefinition): GarmentCategory {
  return g.category;
}

/** Hem height (cm from floor) for a length preset, before calf/knee avoidance. */
export function presetHemHeight(length: LengthPreset, category: GarmentCategory, L: BodyLandmarks, heightCm: number, shoeHeelCm = 0): number {
  const petite = heightCm < 158;
  switch (length) {
    case 'mini':
      return L.crotch - 0.32 * (L.crotch - L.knee);
    case 'above-knee':
      return L.knee + 0.04 * heightCm + 1; // two fingers above the kneecap
    case 'knee':
      return L.knee - 0.012 * heightCm; // just below the kneecap, the slimmest point of the knee
    case 'midi':
      return petite ? L.knee - 0.3 * (L.knee - L.calf) : L.calf - 0.28 * (L.calf - L.ankle);
    case 'ankle':
      return category === 'trousers' ? L.ankle + 1.5 : L.ankle + 4;
    case 'floor':
      // Clear the floor IN the intended shoes: the body (and the hem) rise by
      // the heel height, so barefoot the hem sits that much lower.
      return floorClearance(category) - shoeHeelCm;
  }
}

/** Extra room (cm) over the bust a garment needs to slip over it without an opening. */
export const SHELL_PASS_EASE = 3;

/** Shell tops in light wovens: skimming, pulled over the bust, short neck zip only. */
export function isLightShell(garment: Pick<GarmentDefinition, 'id'>, material: Pick<MaterialPreset, 'construction' | 'weightGsm'>): boolean {
  return garment.id === 'shell-top' && material.construction === 'woven' && material.weightGsm < 100;
}

/** Gap (cm) between a floor-length hem and the floor, wearing the intended shoes. */
export function floorClearance(category: GarmentCategory): number {
  return category === 'trousers' ? 1.5 : 1;
}

/** Upper bounds for a woven gown bodice's ease (cm). */
export const GOWN_BODICE_EASE = { bust: 5, waist: 2 } as const;

/** Heel height the hem is planned for: the request's, else 7 cm for gowns and evening/runway, 2 cm otherwise. */
export function shoeHeelFor(request: Pick<DesignRequest, 'shoeHeelCm' | 'occasion'>, garment: Pick<GarmentDefinition, 'category'>): number {
  const h = request.shoeHeelCm;
  if (h !== undefined && Number.isFinite(h)) return Math.min(15, Math.max(0, h));
  if (garment.category === 'gown' || request.occasion === 'evening' || request.occasion === 'runway') return 7;
  return 2;
}

/**
 * Knit stretch (%) from which a garment is drafted on the knit block: no
 * darts (the fabric's stretch shapes it), a low sleeve cap and near-zero ease.
 */
export const KNIT_BLOCK_STRETCH_PCT = 20;

/** Base ease of the knit block before the stretch allowance is taken off (cm). */
const KNIT_BASE_EASE: Record<FitPreference, EaseRow> = {
  fitted: { bust: 2, waist: 2, hip: 2, upperArm: 2, thigh: 3 },
  regular: { bust: 4, waist: 4, hip: 4, upperArm: 3, thigh: 5 },
  relaxed: { bust: 8, waist: 8, hip: 7, upperArm: 5, thigh: 9 },
};

function isLowerCat(cat: GarmentCategory): boolean {
  return cat === 'skirt' || cat === 'trousers';
}

/**
 * Minimum hem circumference needed to walk freely without a vent or slit:
 * the hips plus the leg spread of a normal stride, which grows the further the
 * hem sits below the knee.
 */
export function strideHemNeeded(r: ResolvedMeasurements, L: BodyLandmarks, hemHeight: number): number {
  if (hemHeight >= L.knee) return 0;
  return 0.55 * r.hipCm + 0.62 * r.heightCm * (1 - hemHeight / L.knee);
}

/** Zone around the widest part of the calf where a hem visually widens the leg. */
export function calfAvoidZone(L: BodyLandmarks): [number, number] {
  return [L.calf - 3, L.calf + 3];
}

function shiftFit(base: FitPreference, toward: FitPreference): FitPreference {
  const a = FIT_ORDER.indexOf(base);
  const b = FIT_ORDER.indexOf(toward);
  if (Math.abs(a - b) <= 1) return toward;
  return FIT_ORDER[a + Math.sign(b - a)];
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const fmt = (v: number) => `${r1(v)}`;

/** Whether a garment has a bodice. */
export function hasBodice(type: GarmentType): boolean {
  return !['a-line-skirt', 'pencil-skirt', 'circle-skirt', 'wide-leg-trousers', 'tapered-trousers'].includes(type);
}

/** Circle-skirt fraction (1 = full, 0.75, 0.5) for a flare value. */
export function circleFraction(flare: number): number {
  if (flare >= 0.67) return 1;
  if (flare >= 0.34) return 0.75;
  return 0.5;
}

/**
 * Ball-gown waist fullness ratio (skirt waist / bodice waist). The skirt is
 * made of flared gores, so the fullness at the hem comes from the gores and
 * only a modest 1.25–1.5× is gathered or pleated into the waist (more bulk
 * there would thicken the waist of the very figure the gown should define).
 */
export function ballGownGatherRatio(flare: number): number {
  return 1.25 + 0.25 * Math.min(1, Math.max(0, flare));
}

/** Structured (crisp) silks are box-pleated into the waist; softer fabrics are gathered. */
export function ballGownWaistTreatment(material: Pick<MaterialPreset, 'stiffness'>): 'pleats' | 'gathers' {
  return material.stiffness >= 0.6 ? 'pleats' : 'gathers';
}

export function planFit(ctx: FitContext): FitPlan {
  const { request, garment, style, material, measurements: r, body } = ctx;
  const L = body.landmarks;
  const profile = bodyProfile(r, L);
  const rationale: string[] = [];
  const knit = material.construction === 'knit';
  const user: GarmentOptions = request.options ?? {};
  const cat = garment.category;
  const allowed = garment.allowed;

  // ---------------------------------------------------------------- options
  const opts: Required<GarmentOptions> = { ...garment.defaults };

  // style preferences
  let fit: FitPreference = garment.defaults.fit;
  const styleFit = FIT_DEFINED.includes(garment.id) ? shiftFit(garment.defaults.fit, style.silhouette.defaultFit) : style.silhouette.defaultFit;
  fit = styleFit;
  // A style's preferred lengths describe its skirts and dresses; trousers keep
  // their own cut (a floor-length wide leg must not become a cropped culotte).
  const styleLengths =
    cat === 'skirt' || cat === 'dress' || cat === 'gown' ? style.silhouette.preferredLengths.filter((l) => allowed.length.includes(l)) : [];
  if (styleLengths.length) {
    // among the style's preferred lengths prefer one that suits this height
    const petite = r.heightCm < 158;
    const ranked = [...styleLengths].sort((a, b) => lengthScore(b, petite) - lengthScore(a, petite));
    opts.length = styleLengths.includes(garment.defaults.length) && !petite ? garment.defaults.length : ranked[0];
  }
  const styleNecks = style.silhouette.preferredNecklines.filter((n) => allowed.neckline.includes(n));
  if (styleNecks.length) {
    const order = NECKLINE_BY_SHAPE[body.shape];
    const best = [...styleNecks].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
    opts.neckline = best;
  }
  let flare = garment.defaults.flare + style.silhouette.hemFlareBias * 0.3;
  if (user.flare === undefined && cat !== 'top' && garment.id !== 'pencil-skirt') {
    if (body.shape === 'inverted-triangle') flare += 0.1;
    if (body.shape === 'pear') flare += 0.05;
  }

  // user options (only allowed values)
  const reject = (what: string, value: string, used: string) =>
    rationale.push(`You asked for ${what} "${value}", which this ${garment.name.toLowerCase()} does not offer, so ${used} is used instead.`);
  if (user.length !== undefined) {
    if (allowed.length.includes(user.length)) opts.length = user.length;
    else if (allowed.length.length) reject('length', user.length, `"${opts.length}"`);
  }
  if (user.sleeve !== undefined) {
    if (allowed.sleeve.includes(user.sleeve)) opts.sleeve = user.sleeve;
    else reject('sleeve', user.sleeve, `"${opts.sleeve}"`);
  }
  if (user.neckline !== undefined) {
    if (allowed.neckline.includes(user.neckline)) opts.neckline = user.neckline;
    else if (allowed.neckline.length) reject('neckline', user.neckline, `"${opts.neckline}"`);
  }
  if (user.closure !== undefined) {
    if (allowed.closure.includes(user.closure)) opts.closure = user.closure;
    else reject('closure', user.closure, `"${opts.closure}"`);
  }
  if (user.lining !== undefined) {
    if (!user.lining || allowed.lining) opts.lining = user.lining;
    else reject('lining', 'yes', 'no lining');
  }
  if (user.pockets !== undefined) {
    if (!user.pockets || allowed.pockets) opts.pockets = user.pockets;
    else reject('pockets', 'yes', 'no pockets');
  }
  if (user.fit !== undefined) fit = user.fit;
  if (user.flare !== undefined && Number.isFinite(user.flare)) flare = user.flare;
  flare = Math.min(1, Math.max(0, flare));
  if (garment.id === 'pencil-skirt' || garment.id === 'sheath-dress') flare = Math.min(flare, 0.3);
  opts.flare = Math.round(flare * 100) / 100;
  opts.fit = fit;
  if (!allowed.lining) opts.lining = false;
  if (!allowed.pockets) opts.pockets = false;
  if (allowed.sleeve.length && !allowed.sleeve.includes(opts.sleeve)) opts.sleeve = allowed.sleeve[0];
  if (allowed.closure.length && !allowed.closure.includes(opts.closure)) opts.closure = allowed.closure[0];
  if (knit && opts.lining) {
    opts.lining = false;
    rationale.push('Knit fabrics stretch and a woven lining would stop them moving, so the lining is left out.');
  }
  if (!garment.fabricTypes.includes(material.construction)) {
    rationale.push(
      `Note: this ${garment.name.toLowerCase()} is designed for ${garment.fabricTypes.join(' or ')} fabrics; ${material.name} is a ${material.construction}, so the ease has been adapted but a test garment is strongly recommended.`,
    );
  }

  // ------------------------------------------------------------------ ease
  const base = KNIT_BLOCK_STRETCH_PCT <= material.stretchPct && knit ? KNIT_BASE_EASE[fit] : WOVEN_EASE[cat][fit];
  const mod = style.silhouette.easeModifierCm;
  const lowerOnly = cat === 'skirt' || cat === 'trousers';
  // A gown bodice carries the weight of the skirt: it must stay close, so a
  // style's relaxed room only goes into the skirt (closer styles still apply).
  const gown = cat === 'gown';
  const bodiceMod = gown ? Math.min(0, mod) : mod;
  const ease: EaseRow = {
    bust: base.bust + bodiceMod,
    waist: base.waist + bodiceMod * (lowerOnly ? 0.25 : 0.5),
    hip: base.hip + mod,
    upperArm: base.upperArm + bodiceMod * 0.5,
    thigh: base.thigh + mod,
  };
  if (knit) {
    const k = KNIT_STRETCH_USE[fit] * material.stretchPct / 100;
    const capNeg = (circ: number) => -circ * Math.min(0.1, material.stretchPct / 200);
    ease.bust = Math.max(capNeg(r.bustCm), ease.bust - r.bustCm * k);
    ease.waist = Math.max(capNeg(r.waistCm), ease.waist - r.waistCm * k);
    ease.hip = Math.max(capNeg(r.hipCm), ease.hip - r.hipCm * k);
    ease.upperArm = Math.max(capNeg(r.upperArmCm), ease.upperArm - r.upperArmCm * k);
    ease.thigh = Math.max(capNeg(r.thighCm), ease.thigh - r.thighCm * k);
    rationale.push(
      `${material.name} stretches about ${material.stretchPct} % across, so the ${fit} fit uses ${ease.bust < 0 || ease.hip < 0 ? 'negative ease (the garment is slightly smaller than you and stretches to hug the body)' : 'less ease than a woven would need'}.`,
    );
  } else {
    const s = material.stiffness;
    const min = { bust: 3 + 3 * s, waist: 1 + 2 * s, hip: 2.5 + 3 * s, upperArm: 3 + 3 * s, thigh: 4 + 3 * s };
    let raised = false;
    for (const k of Object.keys(min) as Array<keyof EaseRow>) {
      if (base[k] === 0 && k !== 'waist') continue;
      if (ease[k] < min[k]) {
        ease[k] = min[k];
        raised = true;
      }
    }
    if (raised) {
      rationale.push(`${material.name} is ${s > 0.6 ? 'crisp and structured' : 'firm'} and does not give, so the minimum ease was raised to keep the garment comfortable to sit and move in.`);
    }
  }
  if (garment.id === 'pencil-skirt' || garment.id === 'sheath-dress' || garment.id === 'column-gown') {
    // Must be able to sit: woven hip ease never below 4 cm on hip-hugging shapes.
    if (!knit && ease.hip < 4) ease.hip = 4;
  }
  if (gown && !knit) {
    // Couture gown bodice: 2.5–5 cm at the bust and 0–2 cm at the waist, so the
    // waist seam sits on the body and holds the skirt up (with a waist stay).
    ease.bust = Math.min(GOWN_BODICE_EASE.bust, Math.max(2.5, ease.bust));
    ease.waist = Math.min(GOWN_BODICE_EASE.waist, ease.waist);
    rationale.push(
      `A gown bodice carries the weight of the skirt, so it is fitted close: bust +${fmt(ease.bust)} cm, waist +${fmt(ease.waist)} cm. A petersham waist stay and boning keep it from sliding down.`,
    );
  }

  // ------------------------------------------------------------- finished
  const bustF = r.bustCm + ease.bust;
  const hipF = r.hipCm + ease.hip;
  let waistF = r.waistCm + ease.waist;
  if (garment.id === 'shift-dress') {
    const drop = { fitted: 8, regular: 5, relaxed: 2 }[fit];
    const straight = 0.5 * (bustF + hipF) - drop;
    if (straight > waistF) {
      waistF = straight;
      rationale.push(`A shift falls straight from the bust, so the waist is not taken in: it has ${fmt(waistF - r.waistCm)} cm of room and skims rather than grips.`);
    }
  }
  if (garment.id === 'shell-top') {
    // No waist darts in a shell: side seams alone can take ~12 cm out.
    const minWaist = bustF - 12;
    if (waistF < minWaist) {
      waistF = minWaist;
      rationale.push(`The shell is shaped only at the side seams, so its waist (${fmt(waistF)} cm) skims your waist rather than fitting it closely; tuck it in or wear it loose.`);
    }
    if (isLightShell(garment, material) && waistF < r.bustCm + SHELL_PASS_EASE) {
      // A long zip puckers a fine silk; a skimming shell slips over the bust and
      // needs only a short zip at the back neck to pass the head.
      waistF = r.bustCm + SHELL_PASS_EASE;
      rationale.push(
        `${material.name} is fine and fluid, so the shell skims straight down (waist ${fmt(waistF)} cm) and slips over your bust: it needs only a short zip at the back neck, because a long zip would pucker such a light fabric.`,
      );
    }
  }
  if (cat === 'skirt' || cat === 'trousers') {
    // Waist may not be larger than hip for skirts drafted from the hip
    if (waistF > hipF) waistF = hipF;
  }
  if (cat !== 'skirt' && cat !== 'trousers') {
    // bodice: waist cannot exceed the bust-hip straight line by much on a round figure
    waistF = Math.max(waistF, r.waistCm + (knit ? Math.min(0, ease.waist) : 1));
  }

  // ------------------------------------------------------------ closures
  let closure: Closure = opts.closure;
  if (hasBodice(garment.id) && (closure === 'elastic')) closure = 'none';
  if (closure === 'wrap-tie' && garment.id !== 'wrap-dress') {
    const alt = allowed.closure.find((c) => c === 'invisible-zip' || c === 'lapped-zip' || c === 'buttons') ?? 'invisible-zip';
    rationale.push(`Wrap ties are drafted for the wrap dress; this ${garment.name.toLowerCase()} uses ${closureLabel(alt)} instead.`);
    closure = alt;
  }
  if (closure === 'none') {
    const stretch = knit ? material.stretchPct / 100 : 0;
    const passNeeded = Math.max(r.bustCm, r.hipCm) + (knit ? 0 : 2);
    const ok = waistF * (1 + 0.8 * stretch) >= passNeeded;
    if (!ok) {
      const alt = allowed.closure.find((c) => c === 'invisible-zip' || c === 'lapped-zip' || c === 'buttons');
      if (alt) {
        closure = alt;
        rationale.push(
          `Without an opening the ${fmt(waistF)} cm waist could not pass over your ${r.bustCm >= r.hipCm ? 'bust' : 'hips'} (${fmt(passNeeded)} cm needed), so ${closureLabel(alt)} is added at the centre back.`,
        );
      } else {
        waistF = passNeeded / (1 + 0.8 * stretch);
        rationale.push(`To pull the garment on without a zip, the waist is widened to ${fmt(waistF)} cm.`);
      }
    } else if (hasBodice(garment.id)) {
      rationale.push(
        `No zip needed: the garment slips over your head (neck opening drafted to at least ${fmt(headCircumference(r.heightCm) + (knit ? 0 : 4))} cm) and over your bust and hips.`,
      );
    }
  }
  opts.closure = closure;

  ease.waist = waistF - r.waistCm;

  // ---------------------------------------------------------------- length
  const hps = hpsHeight(r);
  const heel = shoeHeelFor(request, garment);
  let hemH: number;
  if (cat === 'top') {
    hemH = topHemHeight(body.shape, L);
    rationale.push(topHemReason(body.shape, hemH));
  } else {
    hemH = presetHemHeight(opts.length, cat, L, r.heightCm, heel);
    const [z0, z1] = calfAvoidZone(L);
    if (cat !== 'trousers' && hemH > z0 && hemH < z1) {
      const below = z0 - 0.5;
      const above = L.knee - 0.012 * r.heightCm;
      hemH = opts.length === 'midi' || opts.length === 'ankle' ? below : Math.max(above, z1 + 0.5);
    }
    rationale.push(hemReason(opts.length, cat, hemH, L, r.heightCm, heel));
  }
  hemH = r1(hemH);

  // ------------------------------------------------------------- hem width
  const lengthFromWaist = L.waist - hemH;
  const belowHip = Math.max(0, L.hip - hemH);
  let hem: number | undefined;
  let inseam: number | undefined;
  const thighF = r.thighCm + ease.thigh;
  switch (garment.id) {
    case 'a-line-skirt':
      hem = hipF + belowHip * (0.5 + 1.6 * opts.flare);
      break;
    case 'pencil-skirt':
      hem = Math.max(hipF - 5, profile.torsoAt(hemH) + 4);
      break;
    case 'circle-skirt': {
      const f = circleFraction(opts.flare);
      hem = waistF + 2 * Math.PI * f * lengthFromWaist;
      break;
    }
    case 'wide-leg-trousers':
      hem = Math.max(thighF * (0.85 + 0.35 * opts.flare), r.kneeCm + 14, heelInstepCircumference(r) + 10);
      inseam = L.crotch - hemH;
      break;
    case 'tapered-trousers': {
      const fitAdd = { fitted: 0, regular: 3, relaxed: 6 }[fit];
      hem = Math.max(heelInstepCircumference(r) + 3, r.ankleCm + 12 + fitAdd, (r.kneeCm + 8) * 0.75);
      if (knit) hem = Math.max(heelInstepCircumference(r) + 1, r.ankleCm + 6 + fitAdd);
      inseam = L.crotch - hemH;
      break;
    }
    case 'shell-top':
      hem = Math.max(profile.torsoAt(hemH) + Math.max(ease.hip, 3), bustF - 6) + 10 * opts.flare;
      if (isLightShell(garment, material)) hem = Math.max(hem, r.bustCm + SHELL_PASS_EASE);
      break;
    case 'shift-dress':
      hem = Math.max(bustF, hipF) + belowHip * 0.35 * opts.flare + 2;
      break;
    case 'sheath-dress':
      hem = Math.max(hipF - 3, profile.torsoAt(hemH) + 6);
      break;
    case 'wrap-dress':
      hem = hipF + belowHip * (0.4 + 1.2 * opts.flare);
      break;
    case 'column-gown':
      hem = hipF + 6 + belowHip * 0.6 * opts.flare;
      break;
    case 'ball-gown': {
      const g = ballGownGatherRatio(opts.flare);
      hem = waistF * g + 2 * Math.PI * lengthFromWaist * (0.15 + 0.3 * opts.flare);
      break;
    }
  }

  // ---------------------------------------------------------------- sleeve
  let sleeveLength: number | undefined;
  if (hasBodice(garment.id) && opts.sleeve !== 'none') {
    sleeveLength = r1(r.armLengthCm * SLEEVE_FRACTION[opts.sleeve] + (opts.sleeve === 'long' ? 1 : 0));
    rationale.push(sleeveReason(opts.sleeve, r, body));
  }

  // ----------------------------------------------------------- rationale
  if (hasBodice(garment.id) && allowed.neckline.length) {
    const order = NECKLINE_BY_SHAPE[body.shape];
    const rank = order.indexOf(opts.neckline);
    rationale.push(
      `Neckline: ${NECKLINE_REASON[opts.neckline]}${rank <= 2 ? ` — one of the most flattering choices for your ${body.shape.replace('-', ' ')} shape` : ''}.`,
    );
  }
  rationale.push(easeReason(garment, fit, ease, r, knit));
  if (cat === 'skirt' || cat === 'dress' || cat === 'gown') {
    if (garment.id === 'pencil-skirt' || garment.id === 'sheath-dress') {
      rationale.push(straightReason(garment.id, body.shape, hem ?? 0, hipF));
    } else if (opts.flare > 0.05) {
      rationale.push(flareReason(garment.id, opts.flare, body.shape, hem ?? 0, hipF, ballGownWaistTreatment(material)));
    }
  }
  if (garment.id === 'wrap-dress') {
    rationale.push(`The crossover front and tie mark your natural waist ${fmt(L.waist)} cm from the floor, ${body.shape === 'round' ? 'while the V neckline and fluid skirt draw the eye up and down rather than across' : 'creating a defined hourglass line'}.`);
  }
  if (cat === 'trousers') {
    rationale.push(
      garment.id === 'wide-leg-trousers'
        ? `The leg falls straight and wide (${fmt(hem ?? 0)} cm opening) from the hip, so the line from waist to ${opts.length === 'floor' ? 'floor' : 'hem'} is unbroken and the legs look longer.`
        : `The leg narrows to a ${fmt(hem ?? 0)} cm ankle opening — just enough to slip your foot through — which shows the ankle, the slimmest point of the leg.`,
    );
  }
  if (style.silhouette.easeModifierCm !== 0) {
    const m = style.silhouette.easeModifierCm;
    rationale.push(
      gown && m > 0
        ? `${style.name} styling adds ${fmt(m)} cm of relaxed room to the skirt only; the bodice stays close-fitting so it can carry the skirt.`
        : `${style.name} styling ${m > 0 ? `adds ${fmt(m)} cm of relaxed room` : `takes ${fmt(-m)} cm for a closer, sharper line`} at ${isLowerCat(cat) ? 'waist and hip' : 'bust and hip'}.`,
    );
  }

  const isLower = cat === 'skirt' || cat === 'trousers';
  const finished: FitPlan['finished'] = {
    bust: isLower ? undefined : r1(bustF),
    waist: r1(waistF),
    hip: r1(hipF),
    hem: hem === undefined ? undefined : r1(hem),
    lengthFromWaist: cat === 'top' ? undefined : r1(lengthFromWaist),
    lengthFromShoulder: isLower ? undefined : r1(hps - hemH),
    sleeveLength,
    inseam: inseam === undefined ? undefined : r1(inseam),
  };

  return {
    fit,
    options: opts,
    ease: {
      bust: isLower ? 0 : r1(ease.bust),
      waist: r1(ease.waist),
      hip: r1(ease.hip),
      upperArm: hasBodice(garment.id) && opts.sleeve !== 'none' ? r1(ease.upperArm) : 0,
      thigh: cat === 'trousers' ? r1(ease.thigh) : 0,
    },
    finished,
    hemHeightFromFloorCm: hemH,
    shoeHeelCm: heel,
    rationale,
  };
}

function lengthScore(l: LengthPreset, petite: boolean): number {
  const base: Record<LengthPreset, number> = { mini: 1, 'above-knee': 2, knee: 3, midi: 3, ankle: 2, floor: 2 };
  if (petite) return { mini: 2, 'above-knee': 3, knee: 4, midi: 2, ankle: 1, floor: 2 }[l];
  return base[l];
}

function closureLabel(c: Closure): string {
  switch (c) {
    case 'invisible-zip':
      return 'an invisible zip';
    case 'lapped-zip':
      return 'a lapped zip';
    case 'buttons':
      return 'a button opening';
    case 'wrap-tie':
      return 'wrap ties';
    case 'elastic':
      return 'an elastic waist';
    case 'none':
      return 'no fastening';
  }
}

export function topHemHeight(shape: BodyShape, L: BodyLandmarks): number {
  switch (shape) {
    case 'pear':
      return L.highHip + 1;
    case 'inverted-triangle':
      return L.hip - 2;
    case 'round':
      return L.hip - 3;
    default:
      return (L.highHip + L.hip) / 2;
  }
}

function topHemReason(shape: BodyShape, h: number): string {
  const at = `${fmt(h)} cm from the floor`;
  switch (shape) {
    case 'pear':
      return `The hem ends at your high hip (${at}), above the fullest part of the hip, so no horizontal line crosses the widest point.`;
    case 'inverted-triangle':
      return `The hem falls to just below the hip line (${at}), adding length below the waist to balance broader shoulders.`;
    case 'round':
      return `The hem falls just below the hip line (${at}) so the top skims over the middle instead of stopping at it.`;
    default:
      return `The hem sits between high hip and hip (${at}): long enough to tuck in, short enough to wear loose without cutting the leg line.`;
  }
}

function hemReason(length: LengthPreset, cat: GarmentCategory, h: number, L: BodyLandmarks, height: number, heel: number): string {
  const at = `${fmt(h)} cm from the floor`;
  const inShoes = fmt(h + heel);
  const shoes = heel > 0.5 ? `${fmt(heel)} cm heels` : 'flat shoes';
  if (cat === 'trousers') {
    if (length === 'floor')
      return `Full length, drafted for ${shoes}: in them the hem ends ${inShoes} cm from the floor and the leg line runs unbroken to the ground, which makes the legs look longest. Barefoot the hem ${h < 0 ? 'rests on the floor' : `is ${fmt(h)} cm from the floor`}. Wear these shoes when you pin the hem.`;
    if (length === 'ankle') return `Ankle length: the hem ends ${at}, right at the ankle bone, showing the slimmest part of the leg.`;
    return `Cropped length: the hem ends ${at}, below the fullest part of the calf.`;
  }
  switch (length) {
    case 'mini':
      return `Mini length: the hem ends mid-thigh at ${at}, about a third of the way from crotch to knee, showing off the leg.`;
    case 'above-knee':
      return `Above-knee hem at ${at}: a hand's width above the knee, youthful yet easy to sit in.`;
    case 'knee':
      return `Knee-length hem at ${at}: just below the kneecap, where the leg is slimmest, a flattering length for almost everyone.`;
    case 'midi':
      return height < 158
        ? `Midi hem at ${at}: for a petite frame it sits just below the knee rather than mid-calf, so the skirt does not swallow your height.`
        : `Midi hem at ${at} sits just below the calf's widest point (${fmt(L.calf)} cm), lengthening the leg line instead of cutting across the fullest part.`;
    case 'ankle':
      return `Ankle-length hem at ${at}, just above the ankle bone, so the narrowest part of the leg shows and you can walk freely.`;
    case 'floor':
      return `Floor-length hem drafted for ${shoes}: in them it clears the floor by ${inShoes} cm, so you can walk without treading on it. Heels lift the hem by their height, so barefoot it ${h < 0 ? `lies ${fmt(-h)} cm on the floor` : `sits ${fmt(h)} cm from the floor`}. Pin the hem wearing these exact shoes.`;
  }
}

function sleeveReason(sleeve: string, r: ResolvedMeasurements, body: BodyAnalysis): string {
  const len = r1(r.armLengthCm * (SLEEVE_FRACTION[sleeve] ?? 0.3));
  switch (sleeve) {
    case 'cap':
      return `Cap sleeves (${len} cm) just cover the shoulder point${body.shape === 'pear' ? ', widening the shoulder line to balance your hip' : ''}.`;
    case 'short':
      return `Short sleeves end at ${len} cm from the shoulder, above the fullest part of the upper arm.`;
    case 'elbow':
      return `Elbow sleeves (${len} cm) end at the elbow crease line so you can bend your arm freely.`;
    case 'three-quarter':
      return `Three-quarter sleeves (${len} cm) show the forearm and wrist, the slimmest part of the arm.`;
    default:
      return `Long sleeves (${len} cm) end at the wrist bone; the extra centimetre lets you reach forward without the cuff riding up.`;
  }
}

function easeReason(g: GarmentDefinition, fit: FitPreference, e: EaseRow, r: ResolvedMeasurements, knit: boolean): string {
  const parts: string[] = [];
  if (g.category === 'skirt' || g.category === 'trousers') {
    parts.push(`waist +${fmt(e.waist)} cm (room to breathe and sit)`, `hip +${fmt(e.hip)} cm (room to sit and walk)`);
    if (g.category === 'trousers') parts.push(`thigh +${fmt(e.thigh)} cm`);
  } else {
    parts.push(`bust ${e.bust >= 0 ? '+' : ''}${fmt(e.bust)} cm`, `waist ${e.waist >= 0 ? '+' : ''}${fmt(e.waist)} cm`, `hip ${e.hip >= 0 ? '+' : ''}${fmt(e.hip)} cm`);
  }
  const why =
    fit === 'fitted'
      ? 'a fitted silhouette that follows your shape while you can still raise your arms, sit and breathe'
      : fit === 'regular'
        ? 'a classic fit that skims the body without clinging'
        : 'a relaxed, easy fit with visible drape';
  return `Ease (${fit}${knit ? ', knit' : ''}): ${parts.join(', ')} for ${why}. Based on your bust ${fmt(r.bustCm)} / waist ${fmt(r.waistCm)} / hip ${fmt(r.hipCm)} cm.`;
}

/** Why a straight, close-fitting cut (pencil skirt, sheath) suits this body shape. */
function straightReason(id: GarmentType, shape: BodyShape, hem: number, hipF: number): string {
  const shapeWhy: Record<BodyShape, string> = {
    pear: 'the shaped waist and straight drop from the hip keep the line clean instead of adding width, especially in a darker or matte fabric',
    'inverted-triangle': 'the close line through hip and thigh keeps the lower half streamlined; pair it with a soft, simple top so the shoulders are not emphasised further',
    hourglass: 'it follows the curve from waist to hip, the shape this cut was made for',
    rectangle: 'the waist is taken in more than the hip, so the cut itself creates a gentle waist-to-hip curve',
    round: 'the straight, unbroken column from waist to hem draws the eye down the length rather than across, and the walking ease keeps it from pulling',
  };
  const garmentName = id === 'pencil-skirt' ? 'pencil skirt' : 'sheath';
  const taper = hipF - hem;
  const line =
    taper > 0.5
      ? `narrows by ${fmt(taper)} cm from hip to hem`
      : 'falls straight from the hip to the hem';
  return `Silhouette: the ${garmentName} ${line} (hem ${fmt(hem)} cm around), so ${shapeWhy[shape]}.`;
}

function flareReason(id: GarmentType, flare: number, shape: BodyShape, hem: number, hipF: number, treatment: 'pleats' | 'gathers'): string {
  const amount = flare < 0.3 ? 'a gentle' : flare < 0.7 ? 'a moderate' : 'a generous';
  const shapeWhy: Record<BodyShape, string> = {
    pear: 'it glides over the hip instead of clinging to it',
    'inverted-triangle': 'volume below the waist balances your shoulders',
    hourglass: 'the flare echoes your curves while the fitted waist shows them off',
    rectangle: 'the flare creates the impression of a defined waist',
    round: 'the skirt falls away from the body and keeps the line long',
  };
  if (id === 'circle-skirt') {
    const f = circleFraction(flare);
    return `${f === 1 ? 'Full' : f === 0.75 ? 'Three-quarter' : 'Half'} circle cut: the ${fmt(hem)} cm hem swirls as you move; ${shapeWhy[shape]}.`;
  }
  if (id === 'ball-gown') {
    return `The skirt is cut in flared gores, ${treatment === 'pleats' ? 'box-pleated' : 'gathered'} only ${fmt(ballGownGatherRatio(flare))}× into the waist so the waist stays slim, and spreads to a ${fmt(hem / 100)} m hem over a petticoat, so the fitted bodice makes your waist look smaller by contrast.`;
  }
  return `${amount[0].toUpperCase()}${amount.slice(1)} flare: the hem measures ${fmt(hem)} cm against ${fmt(hipF)} cm at the hip, so ${shapeWhy[shape]}.`;
}
