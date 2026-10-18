/**
 * clothesCAD core contract.
 *
 * Every module (drafting, presets, instructions, 3D, UI, console, eval) codes
 * against these types. Units are centimetres everywhere unless a field name
 * says otherwise. Pattern coordinates: x grows right, y grows DOWN (SVG space).
 */

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

/** A polyline; curves are pre-flattened into dense points (<= 0.5 cm apart). */
export type Path = Point[];

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

/** Measurements a user must give. Everything else can be estimated. */
export interface RequiredMeasurements {
  heightCm: number;
  bustCm: number; // fullest part of bust, horizontal
  waistCm: number; // natural waist, narrowest point
  hipCm: number; // fullest part of seat, horizontal
}

export interface OptionalMeasurements {
  underbustCm?: number;
  highHipCm?: number; // ~10 cm below waist
  neckCm?: number; // base of neck circumference
  shoulderWidthCm?: number; // shoulder point to shoulder point across back
  shoulderLengthCm?: number; // side neck point to shoulder point
  backWaistLengthCm?: number; // nape (C7) to natural waist
  frontWaistLengthCm?: number; // side neck point over bust apex to waist
  shoulderToBustPointCm?: number; // side neck point to apex
  bustPointDistanceCm?: number; // apex to apex
  armLengthCm?: number; // shoulder point to wrist, arm slightly bent
  upperArmCm?: number; // bicep circumference
  elbowCm?: number;
  wristCm?: number;
  waistToHipCm?: number; // vertical depth natural waist -> hip line
  waistToKneeCm?: number;
  waistToFloorCm?: number; // at side, barefoot
  crotchDepthCm?: number; // seated, side waist to chair
  inseamCm?: number;
  thighCm?: number;
  kneeCm?: number;
  calfCm?: number;
  ankleCm?: number;
}

export type Measurements = RequiredMeasurements & OptionalMeasurements;

export type MeasurementKey = keyof Measurements;

/** All measurements filled in; `estimated` lists the keys that were derived. */
export type ResolvedMeasurements = Required<Measurements> & {
  estimated: MeasurementKey[];
};

export interface MeasurementIssue {
  key: MeasurementKey | 'general';
  severity: 'error' | 'warning' | 'info';
  message: string; // plain language, beginner friendly
}

/** Heights from the floor (cm) of body landmarks, used by 3D + proportions. */
export interface BodyLandmarks {
  head: number; // top of head
  nape: number;
  shoulder: number; // shoulder point
  bust: number;
  underbust: number;
  waist: number;
  highHip: number;
  hip: number;
  crotch: number;
  knee: number;
  calf: number;
  ankle: number;
  elbow: number; // with arm hanging
  wrist: number;
}

export type BodyShape =
  | 'hourglass' // bust ~ hip, waist clearly defined
  | 'pear' // hip > bust
  | 'inverted-triangle' // bust/shoulders > hip
  | 'rectangle' // little waist definition
  | 'round'; // waist >= bust/hip

export interface BodyAnalysis {
  shape: BodyShape;
  /** bust - hip, waist-to-hip ratio, etc. */
  ratios: {
    waistToHip: number;
    waistToBust: number;
    bustToHip: number;
    legToHeight: number; // (waistToFloor) / height
    torsoToLeg: number; // (height - waistToFloor) / waistToFloor
  };
  landmarks: BodyLandmarks;
  /** Plain-language notes on what flatters, with the reason. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Catalog: garments, materials, styles
// ---------------------------------------------------------------------------

export type GarmentType =
  | 'a-line-skirt'
  | 'pencil-skirt'
  | 'circle-skirt'
  | 'wide-leg-trousers'
  | 'tapered-trousers'
  | 'shell-top'
  | 'shift-dress'
  | 'sheath-dress'
  | 'wrap-dress'
  | 'column-gown'
  | 'ball-gown';

export type GarmentCategory = 'skirt' | 'trousers' | 'top' | 'dress' | 'gown';

export type Occasion = 'everyday' | 'work' | 'evening' | 'runway';

export type LengthPreset = 'mini' | 'above-knee' | 'knee' | 'midi' | 'ankle' | 'floor';
export type SleeveType = 'none' | 'cap' | 'short' | 'elbow' | 'three-quarter' | 'long';
export type Neckline = 'jewel' | 'scoop' | 'v' | 'boat' | 'square' | 'sweetheart';
export type Closure = 'invisible-zip' | 'lapped-zip' | 'buttons' | 'wrap-tie' | 'elastic' | 'none';
export type FitPreference = 'fitted' | 'regular' | 'relaxed';

export interface GarmentOptions {
  length?: LengthPreset;
  sleeve?: SleeveType;
  neckline?: Neckline;
  closure?: Closure;
  lining?: boolean;
  pockets?: boolean;
  fit?: FitPreference;
  /** Extra hem fullness 0..1 (skirts/gowns). 0 = straight, 1 = maximum for type. */
  flare?: number;
}

export interface GarmentDefinition {
  id: GarmentType;
  name: string;
  category: GarmentCategory;
  description: string;
  difficulty: 1 | 2 | 3 | 4 | 5; // 1 = first project
  occasions: Occasion[];
  defaults: Required<GarmentOptions>;
  allowed: {
    length: LengthPreset[];
    sleeve: SleeveType[];
    neckline: Neckline[];
    closure: Closure[];
    lining: boolean; // whether lining is offered
    pockets: boolean;
  };
  /** woven-only, knit-only or both */
  fabricTypes: Array<'woven' | 'knit'>;
}

export type Fiber =
  | 'wool'
  | 'linen'
  | 'cotton'
  | 'silk'
  | 'viscose'
  | 'lyocell'
  | 'cupro'
  | 'polyester'
  | 'blend';

export interface MaterialPreset {
  id: string;
  name: string;
  fiber: Fiber;
  construction: 'woven' | 'knit';
  weightGsm: number;
  widthCm: number; // usable width selvedge-to-selvedge
  /** 0 = fluid/drapey, 1 = crisp/structured */
  stiffness: number;
  stretchPct: number; // crosswise mechanical stretch
  shrinkagePct: number; // expected on pre-wash
  sheen: 'matte' | 'soft' | 'lustrous' | 'high';
  regions: Array<'european' | 'scandinavian'>;
  origin: string; // e.g. "Biella, Italy" — traditional source, informational
  description: string;
  beginnerFriendliness: 1 | 2 | 3 | 4 | 5; // 5 = easiest
  handling: {
    preTreatment: string;
    needle: string; // e.g. "Universal 80/12"
    thread: string;
    stitchLengthMm: number;
    pressing: string; // temp + cloth advice
    interfacing: string;
    seamFinish: string; // recommended finish for beginners
    cuttingTips: string;
  };
  care: string;
  suitableFor: GarmentType[];
  occasions: Occasion[];
  /** For the 3D renderer and swatches. */
  render: { baseColor: string; roughness: number; sheen: number };
  pricePerMeterEur: [number, number];
}

export interface PaletteColor {
  name: string;
  hex: string;
}

export interface StylePreset {
  id: string;
  name: string;
  region: 'european' | 'scandinavian';
  subregion: string; // 'parisian', 'italian', 'british', 'scandi-minimal', ...
  description: string;
  keywords: string[];
  palette: PaletteColor[];
  recommendedMaterials: string[]; // MaterialPreset ids
  recommendedGarments: GarmentType[];
  occasions: Occasion[];
  /** Silhouette rules applied by the fit engine. */
  silhouette: {
    easeModifierCm: number; // added to base ease at bust/waist/hip (+ relaxed / - closer)
    preferredLengths: LengthPreset[];
    preferredNecklines: Neckline[];
    hemFlareBias: number; // -1..1 nudges flare
    defaultFit: FitPreference;
  };
  details: string[]; // finishing details, e.g. "clean-finished seams, no visible topstitching"
  stylingNotes: string[];
}

// ---------------------------------------------------------------------------
// Request / package
// ---------------------------------------------------------------------------

export interface DesignRequest {
  measurements: Measurements;
  garment: GarmentType;
  styleId: string;
  materialId: string;
  occasion?: Occasion;
  options?: GarmentOptions;
  /** Seam allowance in cm; default 1.5 (1 for knits, 2.5 for gown side seams handled internally). */
  seamAllowanceCm?: number;
  hemAllowanceCm?: number;
  name?: string;
}

/** Final per-area ease (finished garment minus body), cm of circumference. */
export interface FitPlan {
  fit: FitPreference;
  options: Required<GarmentOptions>;
  ease: { bust: number; waist: number; hip: number; upperArm: number; thigh: number };
  /** Finished garment measurements (circumference / length, cm). */
  finished: {
    bust?: number;
    waist?: number;
    hip?: number;
    hem?: number; // hem circumference
    lengthFromWaist?: number; // waist to hem
    lengthFromShoulder?: number; // HPS to hem
    sleeveLength?: number;
    inseam?: number;
  };
  hemHeightFromFloorCm: number;
  /** Why these choices look great on this body: plain-language rationale. */
  rationale: string[];
}

export type PieceRole =
  | 'front-bodice'
  | 'back-bodice'
  | 'front-skirt'
  | 'back-skirt'
  | 'front-dress'
  | 'back-dress'
  | 'sleeve'
  | 'front-leg'
  | 'back-leg'
  | 'waistband'
  | 'front-facing'
  | 'back-facing'
  | 'neck-binding'
  | 'pocket-bag'
  | 'wrap-tie'
  | 'skirt-panel'
  | 'lining';

export type FabricLayer = 'self' | 'lining' | 'interfacing';

export interface PatternEdge {
  id: string; // unique within the piece, e.g. 'side', 'cf', 'waist', 'hem', 'armhole'
  /** Indices into PatternPiece.seamLine (inclusive). Edge runs from -> to along the path order. */
  from: number;
  to: number;
  /** Stitch-line length in cm (computed from the path). */
  lengthCm: number;
  kind: 'seam' | 'fold' | 'hem' | 'opening' | 'facing';
}

export interface Notch {
  at: Point;
  /** Edge the notch sits on. */
  edgeId: string;
  label?: string; // 'single' front / 'double' back, etc.
  count: 1 | 2;
}

export interface Dart {
  id: string;
  apex: Point;
  legs: [Point, Point]; // on the seam line
  intakeCm: number;
  lengthCm: number;
}

export interface PatternPiece {
  id: string; // unique within the package, e.g. 'front-skirt'
  role: PieceRole;
  name: string; // "Front skirt"
  layer: FabricLayer;
  cutCount: number; // total pieces to cut (2 = one pair)
  cutOnFold: boolean;
  mirrorPair: boolean; // cut as mirror pair (fabric folded / flipped)
  /** Stitch line (finished edge), closed, clockwise in SVG space. */
  seamLine: Path;
  /** Cutting line including seam/hem allowances, closed. */
  cutLine: Path;
  edges: PatternEdge[];
  grainline: [Point, Point];
  notches: Notch[];
  darts: Dart[];
  /** Text placed on the piece (name, cut instructions, size). */
  labels: Array<{ at: Point; text: string; sizePt?: number }>;
  seamAllowanceCm: number;
  /** Bounding box of cutLine. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export type SeamType =
  | 'plain'
  | 'french'
  | 'dart'
  | 'zip-invisible'
  | 'zip-lapped'
  | 'set-in-sleeve'
  | 'hem-blind'
  | 'hem-double-fold'
  | 'hem-rolled'
  | 'understitch'
  | 'gathered'
  | 'topstitch';

export interface SeamSpec {
  id: string;
  type: SeamType;
  a: { pieceId: string; edgeId: string };
  /** Undefined for single-piece operations (hems, darts, staystitching). */
  b?: { pieceId: string; edgeId: string };
  /** Expected |lenA - lenB| (cm). 0 for equal seams, > 0 for eased/gathered seams. */
  intendedEaseCm: number;
  /** Assembly order; instructions follow ascending stage. */
  stage: number;
  finish: string; // e.g. "overlock or zigzag, press open"
  note?: string;
}

export interface CuttingPlacement {
  pieceId: string;
  copy: number; // 1..cutCount
  x: number; // translation applied to piece cutLine (after rotation/flip)
  y: number;
  rotationDeg: 0 | 90 | 180 | 270;
  flipped: boolean;
}

export interface CuttingLayout {
  layer: FabricLayer;
  fabricWidthCm: number;
  /** 'folded' = fabric folded selvedge to selvedge (usable width = width/2). */
  fold: 'single' | 'folded';
  lengthCm: number; // fabric length consumed
  placements: CuttingPlacement[];
  efficiency: number; // 0..1 piece area / used area
}

export interface BomItem {
  kind: 'fabric' | 'lining' | 'interfacing' | 'notion' | 'thread' | 'tool';
  name: string;
  quantity: number;
  unit: 'm' | 'cm' | 'pcs' | 'spool' | 'pack';
  spec?: string; // "18 cm invisible zip, colour-matched"
  estCostEur?: number;
  essential: boolean;
}

export interface InstructionStep {
  n: number;
  phase: 'prepare' | 'cut' | 'mark' | 'construct' | 'fit' | 'finish' | 'press';
  title: string;
  /** Plain-language, imperative, beginner level. No unexplained jargon. */
  body: string;
  tips: string[];
  warnings: string[];
  seamIds: string[];
  pieceIds: string[];
  /** Glossary terms used in this step (keys into DesignPackage.glossary). */
  terms: string[];
  minutes: number;
  checkpoint?: string; // "Try it on: the waist should ..."
}

/** Stack of rings describing the finished garment on the body; consumed by 3D. */
export interface SilhouetteRing {
  heightCm: number; // from floor
  /** Finished garment circumference at this height. */
  circumferenceCm: number;
  /** Body circumference at this height (for clipping checks). */
  bodyCircumferenceCm: number;
  /** Front-back depth vs width ratio of the ellipse (approx 0.6..1). */
  depthRatio: number;
}

export interface Silhouette {
  /** Ordered top -> bottom. For trousers: rings to crotch, then legs. */
  torso: SilhouetteRing[];
  /** Per-leg rings below the crotch (trousers only). */
  leg?: SilhouetteRing[];
  sleeve?: { lengthCm: number; topCircumferenceCm: number; bottomCircumferenceCm: number };
  neckline: Neckline | null;
  /** Height (from floor) of the garment top edge at centre front, e.g. neckline depth or waistband. */
  topHeightCm: number;
  hemHeightCm: number;
}

export interface QualityCheck {
  id: string;
  ok: boolean;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface DesignPackage {
  version: 1;
  id: string; // deterministic hash of the normalized request
  name: string;
  request: DesignRequest;
  garment: GarmentDefinition;
  style: StylePreset;
  material: MaterialPreset;
  measurements: ResolvedMeasurements;
  measurementIssues: MeasurementIssue[];
  body: BodyAnalysis;
  fit: FitPlan;
  pieces: PatternPiece[];
  seams: SeamSpec[];
  layouts: CuttingLayout[];
  bom: BomItem[];
  instructions: InstructionStep[];
  glossary: Record<string, string>;
  silhouette: Silhouette;
  /** Total estimated sewing time in minutes and a difficulty 1..5. */
  effort: { minutes: number; difficulty: 1 | 2 | 3 | 4 | 5 };
  quality: QualityCheck[];
}
