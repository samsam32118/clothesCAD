/**
 * Measurement validation, estimation of missing measurements and body
 * landmark heights.
 *
 * Estimation uses linear anthropometric proportions calibrated against
 * standard women's size charts (e.g. the classic UK/EU block size 12:
 * height 168, bust 88, waist 70, hip 94, nape-to-waist 41, waist-to-hip 20.6,
 * waist-to-knee 58.5, waist-to-floor 104, body rise 28, upper arm 28,
 * wrist 16, neck 37). Every constant is listed in `ESTIMATES` so it can be
 * audited; each formula reproduces the reference body within ~1 cm and scales
 * sensibly from petite (150 cm) to tall (190 cm) and XS to 4XL.
 */
import type {
  BodyLandmarks,
  MeasurementIssue,
  MeasurementKey,
  Measurements,
  OptionalMeasurements,
  ResolvedMeasurements,
} from './types';

const REQUIRED: Array<'heightCm' | 'bustCm' | 'waistCm' | 'hipCm'> = ['heightCm', 'bustCm', 'waistCm', 'hipCm'];

const LABELS: Record<MeasurementKey, string> = {
  heightCm: 'height',
  bustCm: 'bust',
  waistCm: 'waist',
  hipCm: 'hip',
  underbustCm: 'underbust',
  highHipCm: 'high hip',
  neckCm: 'neck',
  shoulderWidthCm: 'shoulder width',
  shoulderLengthCm: 'shoulder length',
  backWaistLengthCm: 'back waist length',
  frontWaistLengthCm: 'front waist length',
  shoulderToBustPointCm: 'shoulder to bust point',
  bustPointDistanceCm: 'bust point distance',
  armLengthCm: 'arm length',
  upperArmCm: 'upper arm',
  elbowCm: 'elbow',
  wristCm: 'wrist',
  waistToHipCm: 'waist to hip',
  waistToKneeCm: 'waist to knee',
  waistToFloorCm: 'waist to floor',
  crotchDepthCm: 'crotch depth',
  inseamCm: 'inseam',
  thighCm: 'thigh',
  kneeCm: 'knee',
  calfCm: 'calf',
  ankleCm: 'ankle',
};

/** Plausible ranges for adult women (cm). Outside -> warning; far outside -> error. */
const RANGES: Record<MeasurementKey, { min: number; max: number }> = {
  heightCm: { min: 140, max: 200 },
  bustCm: { min: 70, max: 170 },
  waistCm: { min: 50, max: 165 },
  hipCm: { min: 75, max: 180 },
  underbustCm: { min: 60, max: 150 },
  highHipCm: { min: 60, max: 175 },
  neckCm: { min: 28, max: 52 },
  shoulderWidthCm: { min: 30, max: 52 },
  shoulderLengthCm: { min: 9, max: 17 },
  backWaistLengthCm: { min: 33, max: 52 },
  frontWaistLengthCm: { min: 35, max: 62 },
  shoulderToBustPointCm: { min: 18, max: 40 },
  bustPointDistanceCm: { min: 13, max: 30 },
  armLengthCm: { min: 48, max: 70 },
  upperArmCm: { min: 21, max: 55 },
  elbowCm: { min: 19, max: 42 },
  wristCm: { min: 12.5, max: 24 },
  waistToHipCm: { min: 14, max: 30 },
  waistToKneeCm: { min: 48, max: 72 },
  waistToFloorCm: { min: 85, max: 128 },
  crotchDepthCm: { min: 21, max: 40 },
  inseamCm: { min: 62, max: 95 },
  thighCm: { min: 40, max: 95 },
  kneeCm: { min: 29, max: 55 },
  calfCm: { min: 27, max: 55 },
  ankleCm: { min: 18, max: 32 },
};

/** Margin beyond the plausible range (fraction) that turns a warning into an error. */
const HARD_MARGIN = 0.25;

/**
 * Estimation constants. `x = a*height + b*bust + c*waist + d*hip + k`
 * unless stated otherwise in `resolveMeasurements`.
 */
export const ESTIMATES = {
  underbustOfBust: 0.86, // underbust ≈ 86 % of bust (B-cup reference: 88 -> 75.7)
  highHipBlend: 0.6, // high hip sits 60 % of the way from waist to hip girth
  neck: { bust: 0.3, k: 10.5 }, // 88 -> 36.9
  shoulderWidth: { height: 0.17, bust: 0.12 }, // 168/88 -> 39.1
  shoulderLength: { height: 0.055, bust: 0.035 }, // -> 12.3
  backWaistLength: { height: 0.245 }, // -> 41.2
  frontWaistExtraPerCup: 0.25, // front waist = back waist + 2 (HPS above nape) + 0.25*(bust - underbust)
  shoulderToBust: { height: 0.1, bust: 0.1 }, // -> 25.6
  bustPointDistance: { bust: 0.2, k: 0.5 }, // -> 18.1
  armLength: { height: 0.35 }, // -> 58.8
  upperArm: { bust: 0.22, waist: 0.12 }, // -> 27.8
  elbow: { upperArm: 0.75, k: 3 }, // -> 23.9
  wrist: { height: 0.06, bust: 0.06 }, // -> 15.4
  waistToHip: { height: 0.123 }, // -> 20.7
  waistToKnee: { height: 0.35 }, // -> 58.8
  waistToFloor: { height: 0.62 }, // -> 104.2
  crotchDepth: { height: 0.14, hip: 0.05 }, // -> 28.2
  thigh: { hip: 0.6 }, // -> 56.4
  knee: { hip: 0.25, height: 0.08 }, // -> 36.9
  calf: { hip: 0.3, height: 0.04 }, // -> 34.9
  ankle: { height: 0.09, hip: 0.08 }, // -> 22.6
} as const;

/** Approximate head circumference (for pull-over openings), cm. */
export function headCircumference(heightCm: number): number {
  return 0.13 * heightCm + 34.5; // 168 -> 56.3
}

/** Heel-to-instep circumference (smallest loop the foot passes through), cm. */
export function heelInstepCircumference(r: ResolvedMeasurements): number {
  return Math.max(r.ankleCm + 8, 0.19 * r.heightCm); // 168 -> ~32
}

const fmt = (v: number) => (Math.round(v * 10) / 10).toString();

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Check a measurement set and return plain-language issues.
 * Errors block design; warnings and info are shown to the user.
 */
export function validateMeasurements(m: Measurements): MeasurementIssue[] {
  const issues: MeasurementIssue[] = [];
  const record = m as unknown as Record<string, unknown>;

  // Required presence
  for (const key of REQUIRED) {
    const v = record[key];
    if (v === undefined || v === null || (typeof v === 'string' && v === '')) {
      issues.push({ key, severity: 'error', message: `Your ${LABELS[key]} is needed. Measure it in centimetres and enter it.` });
    } else if (!isNum(v)) {
      issues.push({ key, severity: 'error', message: `The ${LABELS[key]} must be a number in centimetres (you entered "${String(v)}").` });
    } else if (v <= 0) {
      issues.push({ key, severity: 'error', message: `The ${LABELS[key]} must be greater than zero.` });
    }
  }
  if (issues.some((i) => i.severity === 'error')) return issues;

  // Whole set entered in inches?
  const allSmall = m.heightCm < 90 && m.bustCm < 65 && m.hipCm < 70;
  if (allSmall && m.heightCm * 2.54 >= 120) {
    issues.push({
      key: 'general',
      severity: 'error',
      message: `These numbers look like inches (height ${fmt(m.heightCm)} would be ${fmt(m.heightCm * 2.54)} cm). Please enter every measurement in centimetres: multiply inches by 2.54.`,
    });
    return issues;
  }

  // Ranges + inch detection per key
  for (const key of Object.keys(RANGES) as MeasurementKey[]) {
    const v = record[key];
    if (v === undefined || v === null) continue;
    if (!isNum(v)) {
      issues.push({ key, severity: 'error', message: `The ${LABELS[key]} must be a number in centimetres (you entered "${String(v)}").` });
      continue;
    }
    if (v <= 0) {
      issues.push({ key, severity: 'error', message: `The ${LABELS[key]} must be greater than zero. Leave it empty if you don't know it and we'll estimate it.` });
      continue;
    }
    const { min, max } = RANGES[key];
    const hardMin = min * (1 - HARD_MARGIN);
    const hardMax = max * (1 + HARD_MARGIN);
    if (v < min) {
      const inCm = v * 2.54;
      const looksLikeInches = inCm >= min && inCm <= max;
      if (looksLikeInches) {
        issues.push({
          key,
          severity: 'error',
          message: `${cap(LABELS[key])} ${fmt(v)} looks like inches (${fmt(inCm)} cm). Please enter centimetres.`,
        });
      } else if (v < hardMin) {
        issues.push({
          key,
          severity: 'error',
          message: `${cap(LABELS[key])} of ${fmt(v)} cm is smaller than any adult we can draft for (usual range ${min}–${max} cm). Please re-measure.`,
        });
      } else {
        issues.push({
          key,
          severity: 'warning',
          message: `${cap(LABELS[key])} of ${fmt(v)} cm is unusually small (usual range ${min}–${max} cm). Double-check the tape is flat and in centimetres.`,
        });
      }
    } else if (v > max) {
      if (v > hardMax) {
        issues.push({
          key,
          severity: 'error',
          message: `${cap(LABELS[key])} of ${fmt(v)} cm is larger than we can draft for (usual range ${min}–${max} cm). Please re-measure; did you add an extra digit?`,
        });
      } else {
        issues.push({
          key,
          severity: 'warning',
          message: `${cap(LABELS[key])} of ${fmt(v)} cm is outside the usual range (${min}–${max} cm). The pattern will still be drafted, but check it with a test garment.`,
        });
      }
    }
  }
  if (issues.some((i) => i.severity === 'error')) return issues;

  // Cross-checks between measurements
  const { heightCm: h, bustCm: bust, waistCm: waist, hipCm: hip } = m;
  if (waist > bust + hip) {
    issues.push({
      key: 'waistCm',
      severity: 'error',
      message: `A waist of ${fmt(waist)} cm cannot be larger than bust and hip together (${fmt(bust + hip)} cm). Check that you measured the waist around, not a length.`,
    });
  } else if (waist > Math.max(bust, hip) * 1.25) {
    issues.push({
      key: 'waistCm',
      severity: 'warning',
      message: `Your waist is much larger than both bust and hip. That is possible, but please double-check: measure around the natural waist, level, without pulling.`,
    });
  }
  if (bust / hip > 1.6 || hip / bust > 1.6) {
    issues.push({
      key: 'general',
      severity: 'warning',
      message: `Bust (${fmt(bust)} cm) and hip (${fmt(hip)} cm) are very different. Re-measure both at the fullest point to be sure.`,
    });
  }
  if (isNum(m.underbustCm)) {
    if (m.underbustCm >= bust) {
      issues.push({ key: 'underbustCm', severity: 'error', message: `The underbust (${fmt(m.underbustCm)} cm) must be smaller than the bust (${fmt(bust)} cm). Measure it snugly just below the breasts.` });
    } else if (bust - m.underbustCm > 45) {
      issues.push({ key: 'underbustCm', severity: 'warning', message: `Bust minus underbust is over 45 cm. Please double-check the underbust; it is measured snugly around the ribcage.` });
    }
  }
  if (isNum(m.highHipCm)) {
    if (m.highHipCm > hip + 6 && m.highHipCm > waist + 6) {
      issues.push({ key: 'highHipCm', severity: 'warning', message: `The high hip is larger than both waist and hip. It is measured about 10 cm below the waist; please check it.` });
    }
    if (m.highHipCm < Math.min(waist, hip) - 6) {
      issues.push({ key: 'highHipCm', severity: 'warning', message: `The high hip is smaller than both waist and hip, which is unusual. Please re-measure about 10 cm below your waist.` });
    }
  }
  if (isNum(m.waistToFloorCm)) {
    const r = m.waistToFloorCm / h;
    if (r < 0.52 || r > 0.7) {
      issues.push({ key: 'waistToFloorCm', severity: r < 0.45 || r > 0.78 ? 'error' : 'warning', message: `Waist-to-floor (${fmt(m.waistToFloorCm)} cm) is ${Math.round(r * 100)} % of your height; most people are 57–67 %. Measure at the side, barefoot, from natural waist to the floor.` });
    }
  }
  if (isNum(m.inseamCm)) {
    const wtf = isNum(m.waistToFloorCm) ? m.waistToFloorCm : h * ESTIMATES.waistToFloor.height;
    if (m.inseamCm >= wtf - 12) {
      issues.push({ key: 'inseamCm', severity: 'error', message: `The inseam (${fmt(m.inseamCm)} cm) must be well below your waist-to-floor length (${fmt(wtf)} cm). The inseam runs from the crotch to the floor on the inside of the leg.` });
    }
  }
  if (isNum(m.crotchDepthCm) && isNum(m.inseamCm) && isNum(m.waistToFloorCm)) {
    const gap = m.waistToFloorCm - m.inseamCm - m.crotchDepthCm;
    if (Math.abs(gap) > 6) {
      issues.push({ key: 'crotchDepthCm', severity: 'warning', message: `Crotch depth + inseam (${fmt(m.crotchDepthCm + m.inseamCm)} cm) differs from waist-to-floor (${fmt(m.waistToFloorCm)} cm) by ${fmt(Math.abs(gap))} cm. The trousers will use your crotch depth; please re-check one of these.` });
    }
  }
  if (isNum(m.waistToKneeCm)) {
    const wtf = isNum(m.waistToFloorCm) ? m.waistToFloorCm : h * ESTIMATES.waistToFloor.height;
    if (m.waistToKneeCm >= wtf - 25) {
      issues.push({ key: 'waistToKneeCm', severity: 'error', message: `Waist-to-knee (${fmt(m.waistToKneeCm)} cm) must be clearly shorter than waist-to-floor (${fmt(wtf)} cm).` });
    }
  }
  if (isNum(m.waistToHipCm) && isNum(m.waistToKneeCm) && m.waistToHipCm >= m.waistToKneeCm * 0.6) {
    issues.push({ key: 'waistToHipCm', severity: 'warning', message: `Waist-to-hip looks long compared with waist-to-knee. The hip line is usually 18–23 cm below the waist.` });
  }
  if (isNum(m.backWaistLengthCm)) {
    const r = m.backWaistLengthCm / h;
    if (r < 0.2 || r > 0.3) {
      issues.push({ key: 'backWaistLengthCm', severity: 'warning', message: `Back waist length is ${Math.round(r * 100)} % of height (typical 22–27 %). Measure from the bone at the base of the neck to the natural waist.` });
    }
  }
  if (isNum(m.frontWaistLengthCm)) {
    const back = isNum(m.backWaistLengthCm) ? m.backWaistLengthCm : h * ESTIMATES.backWaistLength.height;
    if (m.frontWaistLengthCm < back + 1) {
      issues.push({ key: 'frontWaistLengthCm', severity: 'warning', message: `Front waist length is usually 2–7 cm longer than back waist length because it travels over the bust. Measure from the side of the neck, over the bust point, down to the waist.` });
    }
  }
  if (isNum(m.shoulderToBustPointCm) && isNum(m.frontWaistLengthCm) && m.shoulderToBustPointCm >= m.frontWaistLengthCm - 8) {
    issues.push({ key: 'shoulderToBustPointCm', severity: 'error', message: `Shoulder-to-bust-point must be much shorter than the front waist length (it stops at the bust point).` });
  }
  if (isNum(m.bustPointDistanceCm) && m.bustPointDistanceCm > bust * 0.32) {
    issues.push({ key: 'bustPointDistanceCm', severity: 'warning', message: `Bust point distance looks wide for your bust. Measure straight across from one bust point to the other.` });
  }
  if (isNum(m.wristCm) && isNum(m.upperArmCm) && m.wristCm >= m.upperArmCm) {
    issues.push({ key: 'wristCm', severity: 'error', message: `The wrist must be smaller than the upper arm.` });
  }
  if (isNum(m.elbowCm) && isNum(m.upperArmCm) && m.elbowCm > m.upperArmCm + 1) {
    issues.push({ key: 'elbowCm', severity: 'warning', message: `The elbow is usually smaller than the upper arm. Measure around the bent elbow.` });
  }
  if (isNum(m.thighCm) && m.thighCm >= hip) {
    issues.push({ key: 'thighCm', severity: 'error', message: `One thigh (${fmt(m.thighCm)} cm) cannot be larger than the hip around both legs (${fmt(hip)} cm). Measure one leg at its fullest, just below the crotch.` });
  }
  const legChain: Array<[MeasurementKey, MeasurementKey]> = [
    ['kneeCm', 'thighCm'],
    ['calfCm', 'thighCm'],
    ['ankleCm', 'calfCm'],
    ['ankleCm', 'kneeCm'],
  ];
  for (const [small, big] of legChain) {
    const a = record[small];
    const b = record[big];
    if (isNum(a) && isNum(b) && a >= b) {
      issues.push({ key: small, severity: 'warning', message: `${cap(LABELS[small])} (${fmt(a)} cm) is usually smaller than ${LABELS[big]} (${fmt(b)} cm). Please re-measure.` });
    }
  }
  if (h < 150) {
    issues.push({ key: 'heightCm', severity: 'info', message: `Petite proportions detected: lengths and hem positions are scaled to your height rather than a standard size.` });
  } else if (h > 180) {
    issues.push({ key: 'heightCm', severity: 'info', message: `Tall proportions detected: lengths are scaled to your height; check fabric quantities as they will be above standard.` });
  }

  const missing = (Object.keys(RANGES) as MeasurementKey[]).filter((k) => !REQUIRED.includes(k as (typeof REQUIRED)[number]) && !isNum(record[k]));
  if (missing.length > 0) {
    issues.push({
      key: 'general',
      severity: 'info',
      message: `${missing.length} optional measurement${missing.length > 1 ? 's were' : ' was'} not given and will be estimated from your height, bust, waist and hip: ${missing.map((k) => LABELS[k]).join(', ')}. Measuring them yourself gives a closer fit.`,
    });
  }
  return issues;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Fill every optional measurement. Given values are kept; missing ones are
 * estimated (listed in `estimated`). Estimates are then made mutually
 * consistent (e.g. knee < thigh, inseam + crotch depth ≈ waist-to-floor).
 */
export function resolveMeasurements(m: Measurements): ResolvedMeasurements {
  const E = ESTIMATES;
  const h = m.heightCm;
  const bust = m.bustCm;
  const waist = m.waistCm;
  const hip = m.hipCm;
  const estimated: MeasurementKey[] = [];
  const out: Partial<Record<keyof OptionalMeasurements, number>> = {};

  const pick = (key: keyof OptionalMeasurements, est: () => number): number => {
    const v = m[key];
    if (isNum(v) && v > 0) {
      out[key] = v;
      return v;
    }
    const e = r1(est());
    out[key] = e;
    estimated.push(key);
    return e;
  };

  pick('underbustCm', () => Math.min(bust - 6, Math.max(bust * E.underbustOfBust, Math.min(waist + 2, bust - 6))));
  pick('highHipCm', () => (hip >= waist ? waist + E.highHipBlend * (hip - waist) : (waist + hip) / 2));
  pick('neckCm', () => Math.min(48, Math.max(31, E.neck.bust * bust + E.neck.k)));
  pick('shoulderWidthCm', () => E.shoulderWidth.height * h + E.shoulderWidth.bust * bust);
  pick('shoulderLengthCm', () => E.shoulderLength.height * h + E.shoulderLength.bust * bust);
  const bwl = pick('backWaistLengthCm', () => E.backWaistLength.height * h);
  pick('frontWaistLengthCm', () => bwl + 2 + E.frontWaistExtraPerCup * Math.max(4, bust - (out.underbustCm as number)));
  pick('shoulderToBustPointCm', () => E.shoulderToBust.height * h + E.shoulderToBust.bust * bust);
  pick('bustPointDistanceCm', () => E.bustPointDistance.bust * bust + E.bustPointDistance.k);
  pick('armLengthCm', () => E.armLength.height * h);
  const upperArm = pick('upperArmCm', () => E.upperArm.bust * bust + E.upperArm.waist * waist);
  const elbow = pick('elbowCm', () => Math.min(upperArm - 2, E.elbow.upperArm * upperArm + E.elbow.k));
  pick('wristCm', () => Math.min(elbow - 4, E.wrist.height * h + E.wrist.bust * bust));
  pick('waistToHipCm', () => E.waistToHip.height * h);
  const wtf = pick('waistToFloorCm', () => E.waistToFloor.height * h);
  pick('waistToKneeCm', () => E.waistToKnee.height * h * (wtf / (E.waistToFloor.height * h)));
  // Rise and inseam must add up to waist-to-floor when either is estimated.
  const givenInseam = isNum(m.inseamCm) && m.inseamCm > 0;
  pick('crotchDepthCm', () => (givenInseam ? Math.max(20, wtf - (m.inseamCm as number)) : E.crotchDepth.height * h + E.crotchDepth.hip * hip));
  pick('inseamCm', () => wtf - (out.crotchDepthCm as number));
  const thigh = pick('thighCm', () => Math.min(hip * 0.66, E.thigh.hip * hip));
  const knee = pick('kneeCm', () => Math.min(thigh - 8, E.knee.hip * hip + E.knee.height * h));
  const calf = pick('calfCm', () => Math.min(thigh - 6, Math.max(knee - 4, E.calf.hip * hip + E.calf.height * h)));
  pick('ankleCm', () => Math.min(calf - 8, E.ankle.height * h + E.ankle.hip * hip));

  const resolved = {
    heightCm: h,
    bustCm: bust,
    waistCm: waist,
    hipCm: hip,
    ...(out as Required<OptionalMeasurements>),
    estimated,
  } satisfies ResolvedMeasurements;
  return resolved;
}

/** Height above floor of the high point shoulder (side neck point), cm. */
export function hpsHeight(r: ResolvedMeasurements): number {
  return r.waistToFloorCm + r.backWaistLengthCm + 2;
}

/** Vertical drop from the high point shoulder to the bust apex, cm. */
export function apexDrop(r: ResolvedMeasurements): number {
  const neckHalfWidth = r.neckCm / 6;
  const dx = Math.max(0, r.bustPointDistanceCm / 2 - neckHalfWidth);
  return Math.sqrt(Math.max(r.shoulderToBustPointCm ** 2 - dx * dx, r.shoulderToBustPointCm ** 2 * 0.8));
}

/** Body landmark heights from the floor (cm). */
export function computeLandmarks(r: ResolvedMeasurements): BodyLandmarks {
  const waist = r.waistToFloorCm;
  const nape = waist + r.backWaistLengthCm;
  const hps = nape + 2;
  const shoulder = nape - 0.012 * r.heightCm; // shoulder point ~2 cm below the nape
  const bust = hps - apexDrop(r);
  const cup = r.bustCm - r.underbustCm;
  const underbust = Math.max(waist + 4, bust - (6 + 0.25 * cup));
  const highHip = waist - Math.min(10, 0.5 * r.waistToHipCm);
  const hip = waist - r.waistToHipCm;
  const crotch = Math.min(hip - 4, waist - r.crotchDepthCm);
  const knee = waist - r.waistToKneeCm;
  const ankle = 0.045 * r.heightCm;
  const calf = Math.max(ankle + 10, knee - 0.065 * r.heightCm);
  const elbow = shoulder - 0.56 * r.armLengthCm;
  const wrist = shoulder - r.armLengthCm;
  return {
    head: r.heightCm,
    nape,
    shoulder,
    bust,
    underbust,
    waist,
    highHip,
    hip,
    crotch,
    knee,
    calf,
    ankle,
    elbow,
    wrist,
  };
}
