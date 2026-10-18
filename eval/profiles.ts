/**
 * Body profiles for the evaluation harness.
 *
 * Fifteen valid adult women's profiles spanning 150–185 cm, EU sizes 32–54 and
 * all five body shapes, with three levels of completeness:
 *   - 'required': only height, bust, waist, hip (everything else estimated)
 *   - 'partial' : the four required plus a handful of optional measurements
 *   - 'full'    : every measurement in `Measurements`
 *
 * Numbers are internally consistent (e.g. inseam + crotch depth ≈ waist to
 * floor, knee < thigh < hip, underbust < bust, front waist > back waist) and
 * the `expectedShape` follows the FFIT circumference-difference rules (in cm)
 * used by `analyzeBody`. EU sizes are the nearest size of the larger of the
 * bust/hip on a standard EU women's chart (34: 80/64/88 … 54: 130/114/138).
 *
 * `INVALID_PROFILES` hold deliberately broken data for validation tests and
 * are never run through the design pipeline as valid cases.
 */
import type { BodyShape, Measurements } from '../src/core/types';

export type ProfileCompleteness = 'required' | 'partial' | 'full';

export interface EvalProfile {
  id: string;
  label: string;
  euSize: number;
  expectedShape: BodyShape;
  completeness: ProfileCompleteness;
  measurements: Measurements;
}

export interface InvalidProfile {
  id: string;
  label: string;
  /** Measurement keys (or 'general') that validation must flag with severity 'error'. */
  expectErrorOn: Array<keyof Measurements | 'general'>;
  measurements: Measurements;
}

export const PROFILES: EvalProfile[] = [
  {
    id: 'petite-hourglass',
    label: 'Petite hourglass, 150 cm, EU 34',
    euSize: 34,
    expectedShape: 'hourglass',
    completeness: 'required',
    measurements: { heightCm: 150, bustCm: 82, waistCm: 61, hipCm: 88 },
  },
  {
    id: 'petite-pear',
    label: 'Petite pear, 153 cm, EU 40 hip / 36 top',
    euSize: 40,
    expectedShape: 'pear',
    completeness: 'full',
    measurements: {
      heightCm: 153,
      bustCm: 84,
      waistCm: 68,
      hipCm: 99,
      underbustCm: 72,
      highHipCm: 89,
      neckCm: 34,
      shoulderWidthCm: 36,
      shoulderLengthCm: 11.5,
      backWaistLengthCm: 37.5,
      frontWaistLengthCm: 41,
      shoulderToBustPointCm: 24,
      bustPointDistanceCm: 17,
      armLengthCm: 53.5,
      upperArmCm: 27,
      elbowCm: 22.5,
      wristCm: 14.5,
      waistToHipCm: 19,
      waistToKneeCm: 54,
      waistToFloorCm: 95,
      crotchDepthCm: 26.5,
      inseamCm: 68.5,
      thighCm: 59,
      kneeCm: 36,
      calfCm: 35,
      ankleCm: 21.5,
    },
  },
  {
    id: 'inverted-petite',
    label: 'Inverted triangle, 158 cm, EU 42',
    euSize: 42,
    expectedShape: 'inverted-triangle',
    completeness: 'required',
    measurements: { heightCm: 158, bustCm: 98, waistCm: 78, hipCm: 88 },
  },
  {
    id: 'rectangle-50',
    label: 'Rectangle, 160 cm, EU 50',
    euSize: 50,
    expectedShape: 'rectangle',
    completeness: 'partial',
    measurements: { heightCm: 160, bustCm: 116, waistCm: 102, hipCm: 120, neckCm: 39, upperArmCm: 36, waistToFloorCm: 99 },
  },
  {
    id: 'round-46',
    label: 'Round, 162 cm, EU 46',
    euSize: 46,
    expectedShape: 'round',
    completeness: 'required',
    measurements: { heightCm: 162, bustCm: 108, waistCm: 106, hipCm: 110 },
  },
  {
    id: 'pear-44',
    label: 'Pear, 164 cm, EU 44 hip / 40 top',
    euSize: 44,
    expectedShape: 'pear',
    completeness: 'partial',
    measurements: { heightCm: 164, bustCm: 90, waistCm: 74, hipCm: 106, waistToHipCm: 21, thighCm: 64, calfCm: 37.5, waistToFloorCm: 101 },
  },
  {
    id: 'xs-rectangle',
    label: 'Slim rectangle, 165 cm, EU 32',
    euSize: 32,
    expectedShape: 'rectangle',
    completeness: 'required',
    measurements: { heightCm: 165, bustCm: 78, waistCm: 64, hipCm: 84 },
  },
  {
    id: 'round-54',
    label: 'Round, 166 cm, EU 54',
    euSize: 54,
    expectedShape: 'round',
    completeness: 'full',
    measurements: {
      heightCm: 166,
      bustCm: 128,
      waistCm: 125,
      hipCm: 130,
      underbustCm: 112,
      highHipCm: 128,
      neckCm: 42,
      shoulderWidthCm: 41,
      shoulderLengthCm: 12.5,
      backWaistLengthCm: 41,
      frontWaistLengthCm: 47,
      shoulderToBustPointCm: 29,
      bustPointDistanceCm: 23,
      armLengthCm: 58,
      upperArmCm: 40,
      elbowCm: 32,
      wristCm: 18.5,
      waistToHipCm: 21,
      waistToKneeCm: 57,
      waistToFloorCm: 102,
      crotchDepthCm: 31,
      inseamCm: 71,
      thighCm: 72,
      kneeCm: 45,
      calfCm: 43,
      ankleCm: 26,
    },
  },
  {
    id: 'hourglass-38',
    label: 'Hourglass, 168 cm, EU 38',
    euSize: 38,
    expectedShape: 'hourglass',
    completeness: 'full',
    measurements: {
      heightCm: 168,
      bustCm: 88,
      waistCm: 66,
      hipCm: 94,
      underbustCm: 74,
      highHipCm: 86,
      neckCm: 35,
      shoulderWidthCm: 38.5,
      shoulderLengthCm: 12,
      backWaistLengthCm: 41,
      frontWaistLengthCm: 44,
      shoulderToBustPointCm: 25.5,
      bustPointDistanceCm: 18,
      armLengthCm: 59,
      upperArmCm: 26.5,
      elbowCm: 22.5,
      wristCm: 15,
      waistToHipCm: 20.5,
      waistToKneeCm: 58.5,
      waistToFloorCm: 104,
      crotchDepthCm: 28,
      inseamCm: 76,
      thighCm: 55,
      kneeCm: 36,
      calfCm: 34.5,
      ankleCm: 22,
    },
  },
  {
    id: 'rectangle-40',
    label: 'Rectangle, 170 cm, EU 40 (reference)',
    euSize: 40,
    expectedShape: 'rectangle',
    completeness: 'required',
    measurements: { heightCm: 170, bustCm: 90, waistCm: 75, hipCm: 96 },
  },
  {
    id: 'pear-plus-48',
    label: 'Pear, 170 cm, EU 48 hip / 44 top',
    euSize: 48,
    expectedShape: 'pear',
    completeness: 'partial',
    measurements: { heightCm: 170, bustCm: 100, waistCm: 86, hipCm: 118, waistToHipCm: 22, highHipCm: 104, thighCm: 70 },
  },
  {
    id: 'hourglass-plus-48',
    label: 'Hourglass, 172 cm, EU 48',
    euSize: 48,
    expectedShape: 'hourglass',
    completeness: 'full',
    measurements: {
      heightCm: 172,
      bustCm: 112,
      waistCm: 88,
      hipCm: 116,
      underbustCm: 94,
      highHipCm: 106,
      neckCm: 38.5,
      shoulderWidthCm: 40.5,
      shoulderLengthCm: 12.5,
      backWaistLengthCm: 42.5,
      frontWaistLengthCm: 48,
      shoulderToBustPointCm: 28,
      bustPointDistanceCm: 21,
      armLengthCm: 60,
      upperArmCm: 35,
      elbowCm: 28,
      wristCm: 16.5,
      waistToHipCm: 21.5,
      waistToKneeCm: 60,
      waistToFloorCm: 106.5,
      crotchDepthCm: 30,
      inseamCm: 76.5,
      thighCm: 66,
      kneeCm: 41,
      calfCm: 40,
      ankleCm: 24,
    },
  },
  {
    id: 'inverted-tall',
    label: 'Inverted triangle, 178 cm, EU 46 top / 40 hip',
    euSize: 46,
    expectedShape: 'inverted-triangle',
    completeness: 'full',
    measurements: {
      heightCm: 178,
      bustCm: 104,
      waistCm: 84,
      hipCm: 94,
      underbustCm: 86,
      highHipCm: 89,
      neckCm: 37.5,
      shoulderWidthCm: 42.5,
      shoulderLengthCm: 13.5,
      backWaistLengthCm: 43.5,
      frontWaistLengthCm: 48.5,
      shoulderToBustPointCm: 28,
      bustPointDistanceCm: 20,
      armLengthCm: 62.5,
      upperArmCm: 31,
      elbowCm: 25.5,
      wristCm: 16.5,
      waistToHipCm: 21.5,
      waistToKneeCm: 62,
      waistToFloorCm: 110.5,
      crotchDepthCm: 29.5,
      inseamCm: 81,
      thighCm: 55,
      kneeCm: 37,
      calfCm: 35.5,
      ankleCm: 23,
    },
  },
  {
    id: 'athletic-tall',
    label: 'Athletic rectangle, 180 cm, EU 42',
    euSize: 42,
    expectedShape: 'rectangle',
    completeness: 'partial',
    measurements: { heightCm: 180, bustCm: 96, waistCm: 82, hipCm: 100, shoulderWidthCm: 42, armLengthCm: 63, waistToFloorCm: 112 },
  },
  {
    id: 'tall-hourglass',
    label: 'Tall hourglass, 185 cm, EU 40',
    euSize: 40,
    expectedShape: 'hourglass',
    completeness: 'partial',
    measurements: { heightCm: 185, bustCm: 92, waistCm: 68, hipCm: 96, waistToFloorCm: 116, armLengthCm: 65, inseamCm: 86 },
  },
];

export const INVALID_PROFILES: InvalidProfile[] = [
  {
    id: 'invalid-extra-digit',
    label: 'Bust typed with an extra digit',
    expectErrorOn: ['bustCm'],
    measurements: { heightCm: 168, bustCm: 880, waistCm: 70, hipCm: 94 },
  },
  {
    id: 'invalid-inches',
    label: 'Whole set entered in inches',
    expectErrorOn: ['general'],
    measurements: { heightCm: 66, bustCm: 35, waistCm: 28, hipCm: 37 },
  },
  {
    id: 'invalid-negative',
    label: 'Negative waist',
    expectErrorOn: ['waistCm'],
    measurements: { heightCm: 168, bustCm: 88, waistCm: -70, hipCm: 94 },
  },
  {
    id: 'invalid-inconsistent-legs',
    label: 'Inseam longer than waist-to-floor, thigh larger than hip',
    expectErrorOn: ['inseamCm', 'thighCm'],
    measurements: { heightCm: 168, bustCm: 88, waistCm: 70, hipCm: 94, waistToFloorCm: 104, inseamCm: 95, thighCm: 99 },
  },
];

/** The one invalid profile the task calls for, kept as a named export for tests. */
export const INVALID_PROFILE: InvalidProfile = INVALID_PROFILES[0];

export function getProfile(id: string): EvalProfile {
  const p = PROFILES.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown eval profile "${id}". Valid: ${PROFILES.map((x) => x.id).join(', ')}`);
  return p;
}

/**
 * A spread of six profiles covering both height extremes (150 / 185 cm), both
 * size extremes (EU 32 / 54) and every body shape; used for garments that are
 * not run against the full set.
 */
export const CORE_PROFILE_IDS: readonly string[] = [
  'petite-hourglass',
  'xs-rectangle',
  'pear-44',
  'round-54',
  'inverted-tall',
  'tall-hourglass',
];

/** Three profiles for --quick runs: petite, reference-ish, plus size. */
export const QUICK_PROFILE_IDS: readonly string[] = ['petite-pear', 'hourglass-38', 'round-54'];
