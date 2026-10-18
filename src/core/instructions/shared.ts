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
import { zipForOpening } from '../drafting/seams';

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
  'cb-zip': 'centre back zip opening',
  'cf-zip': 'centre front zip opening',
  'end-start': 'first short end',
  'end-end': 'second short end',
  'side-upper': 'upper side',
  'side-pocket': 'pocket opening',
  'cap-front': 'front sleeve cap',
  'cap-back': 'back sleeve cap',
  'cap-front-upper': 'upper front sleeve cap',
  'cap-front-lower': 'lower front sleeve cap',
  'cap-back-upper': 'upper back sleeve cap',
  'cap-back-lower': 'lower back sleeve cap',
  'underarm-front': 'front underarm',
  'underarm-back': 'back underarm',
  'wrap-edge': 'wrap front',
  'front-edge': 'front opening',
  princess: 'princess seam',
  inner: 'inner long',
  attach: 'open end',
  long: 'long',
  'seam-sf': 'side-front panel',
  'seam-cf': 'centre-front panel',
  'seam-sb': 'side-back panel',
  'seam-cb': 'centre-back panel',
  'ext-end': 'underlap extension',
  'ext-start': 'extension',
  'fly-top': 'top of the fly extension',
  'fly-facing': 'fly extension',
  'fly-curve': 'curved fly edge',
  'side-zip': 'zip section of the side seam',
  seat: 'centre-back seat seam',
};

/** "side-left" -> "side left", "cb" -> "centre back", "join-front-skirt-1" -> "lower". */
export function humanEdge(edgeId: string): string {
  const direct = EDGE_NAMES[edgeId];
  if (direct) return direct;
  if (/^join-/.test(edgeId)) return 'lower';
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

const STRIP_ROLES = /^(wrap-tie|neck-binding|waistband)$/;

/** How many times a seam is physically sewn (left + right side, etc.). */
export function seamRepeats(seam: SeamSpec, idx: PieceIndex): number {
  const a = idx.get(seam.a.pieceId);
  if (!seam.b) {
    if (seam.type === 'dart') return edgeInstances(a);
    // Strips (ties, bindings, waistbands) are cut on a lengthwise fold: one operation per strip.
    if (a && STRIP_ROLES.test(a.role)) return Math.max(1, a.cutCount);
    if (seam.type.startsWith('hem')) return 1; // a hem runs continuously around
    return edgeInstances(a);
  }
  const b = idx.get(seam.b.pieceId);
  // A strip folded onto itself is sewn once per strip cut (a fold-cut strip is still one strip).
  if (isFoldedJoin(seam, idx)) return Math.max(1, a?.cutCount ?? 1);
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

/**
 * A seam joining an edge of a piece to the same edge of the same piece is
 * either two copies sewn together (centre-back seam of a mirrored pair) or one
 * strip folded onto itself (ties, bindings, loops). Decide from role and note.
 */
export function isFoldedJoin(seam: SeamSpec, idx: PieceIndex): boolean {
  if (!seam.b || seam.a.pieceId !== seam.b.pieceId || seam.a.edgeId !== seam.b.edgeId) return false;
  const role = idx.get(seam.a.pieceId)?.role ?? '';
  return /wrap-tie|neck-binding/.test(role) || /\bfold (each|the) [a-z ]*lengthwise/i.test(`${seam.note ?? ''} ${seam.finish}`);
}

/** Plain-language description of what is joined to what. */
/** "waist" -> "waist edge", but "first short end" / "pocket opening" stay as they are. */
export function edgePhrase(edgeId: string, plural = false): string {
  const h = humanEdge(edgeId);
  if (/\b(edge|end|opening|seam)$/.test(h)) return plural ? `${h}s` : h;
  return `${h} edge${plural ? 's' : ''}`;
}

export function describeJoin(seam: SeamSpec, idx: PieceIndex): string {
  const a = pieceName(idx.get(seam.a.pieceId), seam.a.pieceId);
  const ea = humanEdge(seam.a.edgeId);
  if (!seam.b) return `the ${edgePhrase(seam.a.edgeId)} of the ${a}`;
  const b = pieceName(idx.get(seam.b.pieceId), seam.b.pieceId);
  const eb = humanEdge(seam.b.edgeId);
  if (seam.a.pieceId === seam.b.pieceId) {
    if (ea === eb && isFoldedJoin(seam, idx)) return `the ${edgePhrase(seam.a.edgeId)} of each ${a}, folded in half lengthwise`;
    return ea === eb
      ? `the two ${a} pieces along their ${edgePhrase(seam.a.edgeId, true)}`
      : `the ${edgePhrase(seam.a.edgeId)} and the ${edgePhrase(seam.b.edgeId)} of the ${a}`;
  }
  if (ea === eb) return `the ${a} and ${b} along their ${edgePhrase(seam.a.edgeId, true)}`;
  return `the ${edgePhrase(seam.a.edgeId)} of the ${a} to the ${edgePhrase(seam.b.edgeId)} of the ${b}`;
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
  // Pressing is described by each step at the right moment; drop "before
  // pressing open" style clauses so a hem or zip edge never reads "press open".
  const rec = m.handling.seamFinish
    .replace(/\.$/, '')
    .replace(/[,;]?\s*(?:(?:then|and|or|before|after)\s+)?press(?:ing|ed)?\b[^,.;]*/gi, '')
    .trim();
  if (/french/i.test(rec)) return 'a narrow zigzag or overlock along each raw edge';
  return rec.charAt(0).toLowerCase() + rec.slice(1);
}

/** Whether the material calls for a sew-in (organza) interfacing rather than a fusible one. */
export function sewInInterfacing(m: MaterialPreset): boolean {
  const s = m.handling.interfacing.trim();
  return /^(silk organza|sew-in)/i.test(s) || /sew-in only/i.test(s);
}

/** Slippery, stretchy or thick cloth is cut with a rotary cutter (listed in the tools, with its safety rule). */
export function needsRotaryCutter(m: MaterialPreset): boolean {
  const t = materialTraits(m);
  return t.slippery || t.knit || t.thick;
}

/** Usable width (cm) of the interfacing bought for a main fabric: silk organza 114 cm, fusible 90 cm. */
export function interfacingWidthCm(m: MaterialPreset): number {
  return sewInInterfacing(m) ? 114 : 90;
}

/** Multiplier on sewing time for harder fabrics (beginnerFriendliness 5 -> 1.0, 1 -> ~1.5). */
export function materialTimeFactor(m: MaterialPreset): number {
  return 1 + (5 - m.beginnerFriendliness) * 0.12;
}

// ---------------------------------------------------------------------------
// Closures
// ---------------------------------------------------------------------------

export { ZIP_LENGTHS_CM as STANDARD_ZIP_LENGTHS_CM } from '../drafting/seams';

function defaultOpeningCm(category: GarmentDefinition['category']): number {
  switch (category) {
    case 'skirt':
    case 'trousers':
      return 18;
    case 'top':
      return 20;
    case 'dress':
      return 48;
    case 'gown':
      return 58;
  }
}

export interface ZipInfo {
  seam?: SeamSpec;
  kind: 'invisible' | 'lapped';
  /** Total drafted opening (cm): every zip edge of the main fabric, e.g. bodice + skirt on a gown. */
  openingCm: number;
  /** Standard zip to buy; the same rule the drafter used (`zipForOpening`). */
  zipLengthCm: number;
}

/** Zip requirements derived from the drafted zip edges (or a sensible default when none is drafted). */
export function zipInfo(ctx: InstructionContext, idx: PieceIndex): ZipInfo | null {
  const closure = ctx.fit.options.closure;
  const zipSeams = ctx.seams.filter((s) => s.type === 'zip-invisible' || s.type === 'zip-lapped');
  const seam = zipSeams[0];
  if (!seam && closure !== 'invisible-zip' && closure !== 'lapped-zip') return null;
  const type: 'zip-invisible' | 'zip-lapped' = seam ? (seam.type as 'zip-invisible' | 'zip-lapped') : closure === 'lapped-zip' ? 'zip-lapped' : 'zip-invisible';
  const kind: ZipInfo['kind'] = type === 'zip-invisible' ? 'invisible' : 'lapped';
  // Each zip seam joins the two halves of one opening edge (a and b are the
  // same drafted edge on a mirrored pair), so count every distinct edge once.
  const seen = new Set<string>();
  let openingCm = 0;
  for (const s of zipSeams) {
    const key = `${s.a.pieceId}.${s.a.edgeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const edge = idx.edge(s.a.pieceId, s.a.edgeId);
    if (edge) openingCm += edge.lengthCm;
  }
  if (openingCm < 5) openingCm = defaultOpeningCm(ctx.garment.category);
  openingCm = Math.round(openingCm * 10) / 10;
  return { seam, kind, openingCm, zipLengthCm: zipForOpening(openingCm, type) };
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
