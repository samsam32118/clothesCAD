/**
 * Runtime validation (zod v4) for everything that enters the design pipeline,
 * plus JSON Schema exports for agents (`z.toJSONSchema`).
 *
 * The schemas check STRUCTURE (required fields, numbers, allowed enum
 * values). Plausibility of measurement values (ranges, inch detection,
 * cross-checks such as waist <= bust + hip) is judged by
 * `validateMeasurements` in measurements.ts, which uses these schemas first
 * and then the metadata in `MEASUREMENT_FIELDS`.
 */
import { z } from 'zod';
import type {
  Closure,
  DesignRequest,
  FitPreference,
  GarmentOptions,
  GarmentType,
  LengthPreset,
  MeasurementKey,
  Measurements,
  Neckline,
  Occasion,
  SleeveType,
} from './types';

// ---------------------------------------------------------------------------
// Enumerations (kept in sync with types.ts by the `Exact` checks below)
// ---------------------------------------------------------------------------

export const GARMENT_TYPES = [
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
] as const satisfies readonly GarmentType[];
export const OCCASIONS = ['everyday', 'work', 'evening', 'runway'] as const satisfies readonly Occasion[];
export const LENGTH_PRESETS = ['mini', 'above-knee', 'knee', 'midi', 'ankle', 'floor'] as const satisfies readonly LengthPreset[];
export const SLEEVE_TYPES = ['none', 'cap', 'short', 'elbow', 'three-quarter', 'long'] as const satisfies readonly SleeveType[];
export const NECKLINES = ['jewel', 'scoop', 'v', 'boat', 'square', 'sweetheart'] as const satisfies readonly Neckline[];
export const CLOSURES = ['invisible-zip', 'lapped-zip', 'buttons', 'wrap-tie', 'elastic', 'none'] as const satisfies readonly Closure[];
export const FIT_PREFERENCES = ['fitted', 'regular', 'relaxed'] as const satisfies readonly FitPreference[];

/** Compile-time proof that each list covers its union exactly. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const exhaustive: [
  Exact<(typeof GARMENT_TYPES)[number], GarmentType>,
  Exact<(typeof OCCASIONS)[number], Occasion>,
  Exact<(typeof LENGTH_PRESETS)[number], LengthPreset>,
  Exact<(typeof SLEEVE_TYPES)[number], SleeveType>,
  Exact<(typeof NECKLINES)[number], Neckline>,
  Exact<(typeof CLOSURES)[number], Closure>,
  Exact<(typeof FIT_PREFERENCES)[number], FitPreference>,
] = [true, true, true, true, true, true, true];
void exhaustive;

// ---------------------------------------------------------------------------
// Measurement metadata: one source of truth for labels, help and ranges
// ---------------------------------------------------------------------------

export interface MeasurementField {
  /** Plain-language name used in messages ("back waist length"). */
  label: string;
  /** How to measure, for beginners and for agents reading the JSON Schema. */
  howTo: string;
  /** Plausible range for adult women (cm). Outside -> warning; far outside -> error. */
  min: number;
  max: number;
  required: boolean;
}

export const MEASUREMENT_FIELDS: Record<MeasurementKey, MeasurementField> = {
  heightCm: { label: 'height', howTo: 'Standing barefoot against a wall, floor to the top of the head.', min: 140, max: 200, required: true },
  bustCm: { label: 'bust', howTo: 'Around the fullest part of the bust, tape level all round, wearing a well-fitting bra.', min: 70, max: 170, required: true },
  waistCm: { label: 'waist', howTo: 'Around the natural waist (the narrowest point, where you bend sideways), tape snug but not tight.', min: 50, max: 165, required: true },
  hipCm: { label: 'hip', howTo: 'Around the fullest part of the seat, feet together, tape level.', min: 75, max: 180, required: true },
  underbustCm: { label: 'underbust', howTo: 'Snugly around the ribcage directly under the bust.', min: 60, max: 150, required: false },
  highHipCm: { label: 'high hip', howTo: 'Around the body about 10 cm below the natural waist, over the hip bones.', min: 60, max: 175, required: false },
  neckCm: { label: 'neck', howTo: 'Around the base of the neck, over the bone at the back of the neck.', min: 28, max: 52, required: false },
  shoulderWidthCm: { label: 'shoulder width', howTo: 'Across the back from one shoulder point (bony tip) to the other.', min: 30, max: 52, required: false },
  shoulderLengthCm: { label: 'shoulder length', howTo: 'From the side of the neck to the shoulder point.', min: 9, max: 17, required: false },
  backWaistLengthCm: { label: 'back waist length', howTo: 'From the bone at the base of the neck straight down the spine to the natural waist.', min: 33, max: 52, required: false },
  frontWaistLengthCm: { label: 'front waist length', howTo: 'From the side of the neck, over the bust point, down to the natural waist.', min: 35, max: 62, required: false },
  shoulderToBustPointCm: { label: 'shoulder to bust point', howTo: 'From the side of the neck to the bust point (apex).', min: 18, max: 40, required: false },
  bustPointDistanceCm: { label: 'bust point distance', howTo: 'Straight across from one bust point to the other.', min: 13, max: 30, required: false },
  armLengthCm: { label: 'arm length', howTo: 'From the shoulder point over the slightly bent elbow to the wrist bone.', min: 48, max: 70, required: false },
  upperArmCm: { label: 'upper arm', howTo: 'Around the fullest part of the upper arm, arm relaxed.', min: 21, max: 55, required: false },
  elbowCm: { label: 'elbow', howTo: 'Around the bent elbow.', min: 19, max: 42, required: false },
  wristCm: { label: 'wrist', howTo: 'Around the wrist over the wrist bone.', min: 12.5, max: 24, required: false },
  waistToHipCm: { label: 'waist to hip', howTo: 'At the side, from the natural waist straight down to the fullest part of the seat.', min: 14, max: 30, required: false },
  waistToKneeCm: { label: 'waist to knee', howTo: 'At the side, from the natural waist to the middle of the knee.', min: 48, max: 72, required: false },
  waistToFloorCm: { label: 'waist to floor', howTo: 'At the side, barefoot, from the natural waist to the floor.', min: 85, max: 128, required: false },
  crotchDepthCm: { label: 'crotch depth', howTo: 'Sitting on a hard chair: at the side, from the natural waist down to the chair seat.', min: 21, max: 40, required: false },
  inseamCm: { label: 'inseam', howTo: 'On the inside of the leg, from the crotch to the floor, barefoot.', min: 62, max: 95, required: false },
  thighCm: { label: 'thigh', howTo: 'Around one leg at its fullest, just below the crotch.', min: 40, max: 95, required: false },
  kneeCm: { label: 'knee', howTo: 'Around one knee, leg straight.', min: 29, max: 55, required: false },
  calfCm: { label: 'calf', howTo: 'Around the fullest part of the calf.', min: 27, max: 55, required: false },
  ankleCm: { label: 'ankle', howTo: 'Around the ankle just above the ankle bone.', min: 18, max: 32, required: false },
};

export const MEASUREMENT_KEYS = Object.keys(MEASUREMENT_FIELDS) as MeasurementKey[];
export const REQUIRED_MEASUREMENT_KEYS = MEASUREMENT_KEYS.filter((k) => MEASUREMENT_FIELDS[k].required);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

function measurementNumber(key: MeasurementKey): z.ZodNumber {
  const f = MEASUREMENT_FIELDS[key];
  return z
    .number({ error: (iss) => (iss.input === undefined ? `${f.label} is required` : `${f.label} must be a number in centimetres`) })
    .positive({ error: `${f.label} must be greater than zero` })
    .describe(`${f.label[0].toUpperCase()}${f.label.slice(1)} in cm. ${f.howTo} Typical adult range ${f.min}–${f.max} cm.${f.required ? '' : ' Optional: estimated from height, bust, waist and hip when omitted.'}`);
}

const measurementShape = Object.fromEntries(
  MEASUREMENT_KEYS.map((k) => [k, MEASUREMENT_FIELDS[k].required ? measurementNumber(k) : measurementNumber(k).optional()]),
) as { [K in MeasurementKey]: K extends keyof Required<Pick<Measurements, 'heightCm' | 'bustCm' | 'waistCm' | 'hipCm'>> ? z.ZodNumber : z.ZodOptional<z.ZodNumber> };

/** Body measurements in centimetres. Unknown keys are rejected (they are usually typos such as "bust" for "bustCm"). */
export const measurementsSchema = z
  .strictObject(measurementShape)
  .describe('Body measurements in centimetres. heightCm, bustCm, waistCm and hipCm are required; every other measurement is optional and estimated when omitted.');

export const garmentOptionsSchema = z
  .strictObject({
    length: z.enum(LENGTH_PRESETS).optional().describe('Hem length preset (skirts, dresses, gowns, trousers).'),
    sleeve: z.enum(SLEEVE_TYPES).optional().describe('Sleeve type for garments with a bodice.'),
    neckline: z.enum(NECKLINES).optional().describe('Neckline shape for garments with a bodice.'),
    closure: z.enum(CLOSURES).optional().describe('How the garment opens. Values the garment does not offer are replaced and explained in the fit rationale.'),
    lining: z.boolean().optional().describe('Add a full lining (woven fabrics only).'),
    pockets: z.boolean().optional().describe('Add in-seam side pockets where the garment allows.'),
    fit: z.enum(FIT_PREFERENCES).optional().describe('Overall ease: fitted, regular or relaxed.'),
    flare: z.number().min(0).max(1).optional().describe('Extra hem fullness 0..1 (0 = straight, 1 = maximum for the garment type).'),
  })
  .describe('Optional style choices. Anything omitted comes from the garment defaults and the chosen style preset.');

export const designRequestSchema = z
  .strictObject({
    measurements: measurementsSchema,
    garment: z.enum(GARMENT_TYPES).describe('Garment type to draft.'),
    styleId: z.string().min(1).describe('Style preset id, e.g. "parisian-chic" or "stockholm-minimal" (see listStyles()).'),
    materialId: z.string().min(1).describe('Material preset id, e.g. "wool-crepe" or "belgian-linen-midweight" (see listMaterials()).'),
    occasion: z.enum(OCCASIONS).optional().describe('Where the garment will be worn.'),
    options: garmentOptionsSchema.optional(),
    seamAllowanceCm: z.number().min(0.5).max(3).optional().describe('Seam allowance in cm (default 1.5 for wovens, 1 for knits).'),
    hemAllowanceCm: z.number().min(0.5).max(8).optional().describe('Hem allowance in cm (default 3, 2 for gowns; curved hems use less automatically).'),
    shoeHeelCm: z
      .number()
      .min(0)
      .max(15)
      .optional()
      .describe('Heel height (cm) of the shoes you will wear; floor-length hems are drafted to clear the floor in them (default 7 for gowns/evening, 2 otherwise).'),
    name: z.string().max(120).optional().describe('Name for the design package.'),
  })
  .describe('A clothesCAD design request: body measurements plus garment, style and material choices.');

// Compile-time proof that parsed values are the contract types (and vice versa).
type Parsed<S extends z.ZodType> = z.output<S>;
const schemaMatchesTypes: [
  Exact<Parsed<typeof measurementsSchema>, Measurements>,
  Exact<Parsed<typeof garmentOptionsSchema>, GarmentOptions>,
] = [true, true];
void schemaMatchesTypes;
const requestAssignable: (r: Parsed<typeof designRequestSchema>) => DesignRequest = (r) => r;
void requestAssignable;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface SchemaIssue {
  /** Dotted path of the offending field, e.g. "measurements.bustCm" ('' for the root). */
  path: string;
  message: string;
}

function toIssues(error: z.ZodError): SchemaIssue[] {
  return error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: SchemaIssue[] };

/** Structural validation of an untrusted design request (e.g. JSON from an agent). */
export function parseDesignRequest(input: unknown): ParseResult<DesignRequest> {
  const r = designRequestSchema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, issues: toIssues(r.error) };
}

/** Structural validation of an untrusted measurement object. */
export function parseMeasurements(input: unknown): ParseResult<Measurements> {
  const r = measurementsSchema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, issues: toIssues(r.error) };
}

/** Raw zod issues of a measurement object (used by validateMeasurements). */
export function measurementSchemaIssues(input: unknown): z.core.$ZodIssue[] {
  const r = measurementsSchema.safeParse(input);
  return r.success ? [] : r.error.issues;
}

/** A JSON Schema document (plain JSON object). */
export type JSONSchemaDocument = Record<string, unknown>;
let requestJson: JSONSchemaDocument | undefined;
let measurementsJson: JSONSchemaDocument | undefined;

/** JSON Schema (draft 2020-12) of DesignRequest, for agents and the console `schema()` call. */
export function designRequestJSONSchema(): JSONSchemaDocument {
  requestJson ??= z.toJSONSchema(designRequestSchema, { target: 'draft-2020-12' }) as JSONSchemaDocument;
  return structuredClone(requestJson);
}

/** JSON Schema (draft 2020-12) of Measurements. */
export function measurementsJSONSchema(): JSONSchemaDocument {
  measurementsJson ??= z.toJSONSchema(measurementsSchema, { target: 'draft-2020-12' }) as JSONSchemaDocument;
  return structuredClone(measurementsJson);
}
