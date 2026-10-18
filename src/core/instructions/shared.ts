import type {
  BodyAnalysis,
  CuttingLayout,
  FitPlan,
  GarmentDefinition,
  MaterialPreset,
  PatternEdge,
  PatternPiece,
  Point,
  ResolvedMeasurements,
  SeamSpec,
  StylePreset,
} from '../types';

/** Everything the instruction and BOM builders need. */
export interface InstructionContext {
  garment: GarmentDefinition;
  style: StylePreset;
  material: MaterialPreset;
  measurements: ResolvedMeasurements;
  body: BodyAnalysis;
  fit: FitPlan;
  pieces: PatternPiece[];
  seams: SeamSpec[];
  layouts: CuttingLayout[];
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/** Format a number with at most `digits` decimals, trimming trailing zeros. */
export function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '0';
  const f = 10 ** digits;
  const r = Math.round(n * f) / f;
  const str = (Object.is(r, -0) ? 0 : r).toFixed(digits);
  return str.includes('.') ? str.replace(/\.?0+$/, '') : str;
}

export function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

/** Realistic minutes: rounded to 5, never below 5. */
export function minutes(n: number): number {
  return Math.max(5, roundTo(n, 5));
}

export function ceilTo(n: number, step: number): number {
  return Math.ceil(n / step - 1e-9) * step;
}

export function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Pieces, edges, seams
// ---------------------------------------------------------------------------

const EDGE_NAMES: Record<string, string> = {
  cf: 'centre front',
  cb: 'centre back',
  hps: 'high shoulder point',
  sa: 'seam allowance',
  'sleeve-cap': 'sleeve cap',
  cap: 'sleeve cap',
  'centre-front': 'centre front',
  'center-front': 'centre front',
  'centre-back': 'centre back',
  'center-back': 'centre back',
};

/** "side-left" -> "side left", "cb" -> "centre back". */
export function humanEdge(edgeId: string): string {
  const direct = EDGE_NAMES[edgeId];
  if (direct) return direct;
  return edgeId
    .split(/[-_]/)
    .map((w) => EDGE_NAMES[w] ?? w)
    .join(' ');
}

export function pieceName(p: PatternPiece | undefined, fallbackId: string): string {
  return (p?.name ?? fallbackId.replace(/[-_]/g, ' ')).toLowerCase();
}

export interface PieceIndex {
  byId: Map<string, PatternPiece>;
  get(id: string): PatternPiece | undefined;
  edge(pieceId: string, edgeId: string): PatternEdge | undefined;
}

export function indexPieces(pieces: PatternPiece[]): PieceIndex {
  const byId = new Map(pieces.map((p) => [p.id, p] as const));
  return {
    byId,
    get: (id) => byId.get(id),
    edge: (pieceId, edgeId) => byId.get(pieceId)?.edges.find((e) => e.id === edgeId),
  };
}

/**
 * How many times each edge of a piece occurs in the finished garment.
 * A piece cut on the fold is drafted as a half, so its (non-fold) edges exist
 * on both the left and right; a piece cut N times has N copies of each edge.
 */
export function edgeInstances(p: PatternPiece | undefined): number {
  if (!p) return 1;
  return Math.max(1, p.cutOnFold ? p.cutCount * 2 : p.cutCount);
}

/** How many times a seam is physically sewn (left + right side, etc.). */
export function seamRepeats(seam: SeamSpec, idx: PieceIndex): number {
  const a = idx.get(seam.a.pieceId);
  if (!seam.b) {
    if (seam.type === 'dart') return edgeInstances(a);
    if (seam.type.startsWith('hem')) return 1; // a hem runs continuously around
    return edgeInstances(a);
  }
  const b = idx.get(seam.b.pieceId);
  if (seam.b.pieceId === seam.a.pieceId) {
    // Joining copies of the same piece to each other (e.g. centre-back seam).
    return Math.max(1, Math.floor(edgeInstances(a) / 2));
  }
  return Math.max(1, Math.min(edgeInstances(a), edgeInstances(b)));
}

/** Stitch-line length of side A of the seam (cm). */
export function seamLengthCm(seam: SeamSpec, idx: PieceIndex): number {
  return idx.edge(seam.a.pieceId, seam.a.edgeId)?.lengthCm ?? 0;
}

/** Plain-language description of what is joined to what. */
export function describeJoin(seam: SeamSpec, idx: PieceIndex): string {
  const a = pieceName(idx.get(seam.a.pieceId), seam.a.pieceId);
  const ea = humanEdge(seam.a.edgeId);
  if (!seam.b) return `the ${ea} edge of the ${a}`;
  const b = pieceName(idx.get(seam.b.pieceId), seam.b.pieceId);
  const eb = humanEdge(seam.b.edgeId);
  if (seam.a.pieceId === seam.b.pieceId) {
    return ea === eb ? `the two ${a} pieces along their ${ea} edges` : `the ${ea} and ${eb} edges of the ${a}`;
  }
  if (ea === eb) return `the ${a} and ${b} along their ${ea} edges`;
  return `the ${ea} edge of the ${a} to the ${eb} edge of the ${b}`;
}

/** Ordered list of point indices of an edge (handles wrap-around on closed paths). */
export function edgeIndices(edge: PatternEdge, pathLength: number): number[] {
  const out: number[] = [];
  if (pathLength === 0) return out;
  let i = edge.from;
  for (let guard = 0; guard <= pathLength; guard++) {
    out.push(i);
    if (i === edge.to) break;
    i = (i + 1) % pathLength;
  }
  return out;
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distToClosedPath(p: Point, path: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = distToSegment(p, path[i]!, path[(i + 1) % path.length]!);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Allowance actually drafted beyond an edge (cm): distance from the middle of
 * the stitch line to the cutting line. Falls back to the piece seam allowance.
 */
export function allowanceAtEdge(p: PatternPiece | undefined, edgeId: string, fallback: number): number {
  if (!p) return fallback;
  const edge = p.edges.find((e) => e.id === edgeId);
  if (!edge || p.seamLine.length < 2 || p.cutLine.length < 3) return p.seamAllowanceCm || fallback;
  const ids = edgeIndices(edge, p.seamLine.length);
  const mid = p.seamLine[ids[Math.floor(ids.length / 2)] ?? edge.from];
  if (!mid) return p.seamAllowanceCm || fallback;
  const d = distToClosedPath(mid, p.cutLine);
  if (!Number.isFinite(d) || d < 0.3 || d > 12) return p.seamAllowanceCm || fallback;
  return Math.round(d * 10) / 10;
}

// ---------------------------------------------------------------------------
// Material traits (derived from the preset data, not hardcoded per id)
// ---------------------------------------------------------------------------

export interface MaterialTraits {
  knit: boolean;
  sheer: boolean;
  slippery: boolean;
  directional: boolean;
  pinInAllowanceOnly: boolean;
  tailorTacks: boolean;
  noFray: boolean;
  needsMatching: boolean;
  dryPressOnly: boolean;
  thick: boolean;
  noWash: boolean;
}

export function materialTraits(m: MaterialPreset): MaterialTraits {
  const tips = m.handling.cuttingTips;
  return {
    knit: m.construction === 'knit',
    sheer: m.construction === 'woven' && m.weightGsm <= 90,
    slippery: (m.construction === 'woven' && m.stiffness <= 0.15) || /slipp|slid|shift/i.test(tips),
    directional:
      m.sheen === 'lustrous' || m.sheen === 'high' || /nap|same direction|same way|pointing/i.test(tips),
    pinInAllowanceOnly: /holes|only within seam allowance|pin only within/i.test(tips + ' ' + m.handling.pressing),
    tailorTacks: /tailor tack/i.test(tips),
    noFray: /do not fray|no finish needed|does not fray/i.test(m.handling.seamFinish),
    needsMatching: /match|repeat/i.test(tips),
    dryPressOnly: /\bdry\b/i.test(m.handling.pressing),
    thick: m.weightGsm >= 300,
    noWash: /do not wash/i.test(m.handling.preTreatment),
  };
}

/**
 * Beginner-safe way to finish a single raw edge. French seams cannot finish a
 * lone edge (e.g. beside a zip or at a hem), so fall back to zigzag/overlock.
 */
export function edgeFinish(m: MaterialPreset): string {
  const rec = m.handling.seamFinish.replace(/\.$/, '');
  if (/french/i.test(rec)) return 'a narrow zigzag or overlock along each raw edge';
  return rec.charAt(0).toLowerCase() + rec.slice(1);
}

/** Whether the material calls for a sew-in (organza) interfacing rather than a fusible one. */
export function sewInInterfacing(m: MaterialPreset): boolean {
  const s = m.handling.interfacing.trim();
  return /^(silk organza|sew-in)/i.test(s) || /sew-in only/i.test(s);
}

/** Multiplier on sewing time for harder fabrics (beginnerFriendliness 5 -> 1.0, 1 -> ~1.5). */
export function materialTimeFactor(m: MaterialPreset): number {
  return 1 + (5 - m.beginnerFriendliness) * 0.12;
}

// ---------------------------------------------------------------------------
// Closures
// ---------------------------------------------------------------------------

export const STANDARD_ZIP_LENGTHS_CM = [15, 18, 20, 22, 23, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70];

function defaultOpeningCm(category: GarmentDefinition['category']): number {
  switch (category) {
    case 'skirt':
    case 'trousers':
      return 18;
    case 'top':
      return 35;
    case 'dress':
      return 50;
    case 'gown':
      return 55;
  }
}

export interface ZipInfo {
  seam?: SeamSpec;
  kind: 'invisible' | 'lapped';
  openingCm: number;
  zipLengthCm: number;
}

/** Zip requirements derived from the zip seam's opening edge (or a sensible default). */
export function zipInfo(ctx: InstructionContext, idx: PieceIndex): ZipInfo | null {
  const closure = ctx.fit.options.closure;
  const seam = ctx.seams.find((s) => s.type === 'zip-invisible' || s.type === 'zip-lapped');
  if (!seam && closure !== 'invisible-zip' && closure !== 'lapped-zip') return null;
  const kind: ZipInfo['kind'] =
    seam ? (seam.type === 'zip-invisible' ? 'invisible' : 'lapped') : closure === 'lapped-zip' ? 'lapped' : 'invisible';
  const fallback = defaultOpeningCm(ctx.garment.category);
  let openingCm = fallback;
  if (seam) {
    const edge = idx.edge(seam.a.pieceId, seam.a.edgeId);
    if (edge && edge.lengthCm > 5) {
      openingCm = edge.kind === 'opening' ? edge.lengthCm : Math.min(edge.lengthCm, fallback);
    }
  }
  const wanted = openingCm + (kind === 'invisible' ? 2 : 0);
  const zipLengthCm =
    STANDARD_ZIP_LENGTHS_CM.find((l) => l >= wanted) ?? Math.ceil(wanted / 5) * 5;
  return { seam, kind, openingCm, zipLengthCm };
}

/** Edge that is an opening (button placket etc.), if drafted. */
export function openingEdge(ctx: InstructionContext): { piece: PatternPiece; edge: PatternEdge } | null {
  for (const piece of ctx.pieces) {
    const edge = piece.edges.find((e) => e.kind === 'opening');
    if (edge) return { piece, edge };
  }
  return null;
}

export function buttonCount(ctx: InstructionContext): number {
  const op = openingEdge(ctx);
  const len = op ? op.edge.lengthCm : ctx.garment.category === 'gown' ? 45 : 40;
  const spacing = ctx.garment.category === 'gown' ? 2.5 : 7; // gowns: rows of small covered buttons
  return Math.max(3, Math.round(len / spacing) + 1);
}

/** Comfortable elastic length for a waist: about 92 % of the body waist + 2.5 cm overlap. */
export function elasticLengthCm(waistCm: number): number {
  return Math.round(waistCm * 0.92 + 2.5);
}
