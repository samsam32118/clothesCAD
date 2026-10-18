/**
 * Seam specification helpers: assembly stages, seam-type selection and
 * material-aware finishing text.
 */
import type { MaterialPreset, PatternPiece, SeamSpec, SeamType } from '../types';
import { distToSegment, slicePath } from '../geometry';

/** Assembly order. Instructions follow ascending stage. */
export const STAGE = {
  staystitch: 5,
  darts: 10,
  princess: 15,
  ties: 16,
  shoulders: 20,
  facingPrep: 22,
  pocketAttach: 26,
  zip: 30,
  centreSeam: 32,
  sideSeams: 36,
  pocketBag: 37,
  crotch: 38,
  inseam: 39,
  neckline: 42,
  understitch: 44,
  sleeveSeam: 48,
  setSleeve: 50,
  armholeFinish: 52,
  waistSeam: 56,
  liningDarts: 58,
  liningSeams: 60,
  liningAttach: 62,
  waistband: 66,
  waistbandFinish: 68,
  hems: 80,
  liningHem: 82,
  openingFinish: 84,
} as const;

export class SeamBook {
  readonly seams: SeamSpec[] = [];
  private ids = new Set<string>();
  constructor(private material: MaterialPreset) {}

  add(spec: SeamSpec): SeamSpec {
    let id = spec.id;
    let k = 2;
    while (this.ids.has(id)) id = `${spec.id}-${k++}`;
    const s = { ...spec, id, intendedEaseCm: Math.round(spec.intendedEaseCm * 100) / 100 };
    this.ids.add(id);
    this.seams.push(s);
    return s;
  }

  /** Two-piece seam. */
  join(
    id: string,
    a: [string, string],
    b: [string, string],
    stage: number,
    opts: { type?: SeamType; ease?: number; finish?: string; note?: string } = {},
  ): SeamSpec {
    return this.add({
      id,
      type: opts.type ?? this.plainType(),
      a: { pieceId: a[0], edgeId: a[1] },
      b: { pieceId: b[0], edgeId: b[1] },
      intendedEaseCm: opts.ease ?? 0,
      stage,
      finish: opts.finish ?? this.seamFinish(),
      ...(opts.note ? { note: opts.note } : {}),
    });
  }

  /** Single-piece operation (hem, dart, understitch, topstitch). */
  single(
    id: string,
    a: [string, string],
    type: SeamType,
    stage: number,
    finish: string,
    note?: string,
  ): SeamSpec {
    return this.add({
      id,
      type,
      a: { pieceId: a[0], edgeId: a[1] },
      intendedEaseCm: 0,
      stage,
      finish,
      ...(note ? { note } : {}),
    });
  }

  /**
   * Default type for a two-piece seam: French on light wovens. This is only a
   * first guess; `resolveSeamTypes` demotes the joins a French seam cannot
   * make (facings, bindings, curves, zips, linings) once the pieces exist.
   */
  plainType(): SeamType {
    return frenchMaterial(this.material) ? 'french' : 'plain';
  }

  seamFinish(): string {
    return this.plainType() === 'french' ? FRENCH_FINISH : plainFinish(this.material);
  }

  hemType(curved: boolean): SeamType {
    const m = this.material;
    if (curved && m.weightGsm < 150) return 'hem-rolled';
    if (m.construction === 'knit') return 'hem-double-fold';
    return m.weightGsm >= 200 || m.stiffness >= 0.5 ? 'hem-blind' : 'hem-double-fold';
  }

  hemFinish(type: SeamType, allowance: number): string {
    switch (type) {
      case 'hem-rolled':
        return 'Narrow rolled hem: press up 0.6 cm, then roll again and stitch close to the fold. Let a bias-cut hem hang for 24 hours first.';
      case 'hem-blind':
        return `Finish the raw edge, press up ${allowance} cm and slip-stitch or blind-hem by machine so no stitches show.`;
      default:
        return `Press up 1 cm, then ${Math.max(1, allowance - 1)} cm more, and stitch close to the inner fold.`;
    }
  }
}

/** Length of an edge in a list of pieces (helper for intended ease). */
export function lengthOf(pieces: PatternPiece[], pieceId: string, edgeId: string): number {
  const p = pieces.find((x) => x.id === pieceId);
  const e = p?.edges.find((x) => x.id === edgeId);
  if (!e) throw new Error(`Unknown edge ${pieceId}.${edgeId}`);
  return e.lengthCm;
}

/** Standard zip lengths sold in shops (cm). */
export const ZIP_LENGTHS_CM: readonly number[] = [15, 18, 20, 22, 23, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70];

/**
 * Length of zip (cm) that does not open below the bottom stop: an invisible
 * zip can only be sewn to ~2 cm above its stop, a regular (lapped) zip opens
 * its full length.
 */
export const ZIP_END_ALLOWANCE_CM: Record<'zip-invisible' | 'zip-lapped', number> = { 'zip-invisible': 2, 'zip-lapped': 0 };

/** Shortest standard zip at least `lengthCm` long (rounded up to 5 cm beyond the shop range). */
export function standardZip(lengthCm: number): number {
  return ZIP_LENGTHS_CM.find((z) => z >= lengthCm - 0.5) ?? Math.ceil(lengthCm / 5) * 5;
}

/** The zip to buy for a drafted opening. Drafting and the bill of materials both use this. */
export function zipForOpening(openingCm: number, type: 'zip-invisible' | 'zip-lapped'): number {
  return standardZip(openingCm + ZIP_END_ALLOWANCE_CM[type]);
}

/**
 * Opening (cm) to draft for a zip: the shortest standard zip whose opening
 * reaches `neededCm`, limited to what fits in `availableCm` (the longest
 * standard zip that fits otherwise), so the drafted opening always matches a
 * zip that can be bought.
 */
export function zipOpening(neededCm: number, availableCm: number, type: 'zip-invisible' | 'zip-lapped'): number {
  const allow = ZIP_END_ALLOWANCE_CM[type];
  const fits = ZIP_LENGTHS_CM.map((z) => z - allow).filter((o) => o >= 10 && o <= availableCm + 1e-9);
  if (!fits.length) return Math.round(Math.max(8, availableCm) * 10) / 10;
  return fits.find((o) => o >= neededCm - 0.5) ?? fits[fits.length - 1];
}

// ---------------------------------------------------------------------------
// Seam type rules (single source of truth for the package AND the instructions)
// ---------------------------------------------------------------------------

export const FRENCH_FINISH =
  'French seam: stitch wrong sides together at 0.6 cm, trim to 0.3 cm, turn and stitch right sides together at 0.9 cm; press to the back.';

/** Plain-seam finishing text for a material. */
export function plainFinish(m: MaterialPreset): string {
  if (m.construction === 'knit') return `${m.handling.seamFinish}. Use a stretch or narrow zigzag stitch so the seam can stretch.`;
  return `${m.handling.seamFinish}; press the seam open.`;
}

/** Light wovens whose raw edges fray and show through: French seams where the seam allows it. */
export function frenchMaterial(m: MaterialPreset): boolean {
  return m.construction === 'woven' && m.weightGsm < 90 && (m.fiber === 'silk' || m.fiber === 'viscose' || m.fiber === 'cupro');
}

/** Roles whose seams are turned, enclosed or folded: never French-seamed. */
const NON_STRUCTURAL_ROLE = /waistband|facing|binding|tie|lining|pocket/;
/** Edge names that are curved by construction (turned, clipped or eased seams). */
const CURVED_EDGE = /neck|armhole|crotch|rise|cap|waist|curve|princess/i;
/** Max sideways deviation (cm) from the chord for an edge to count as straight enough for a French seam. */
const FRENCH_MAX_BOW_CM = 1.5;

function edgeBow(piece: PatternPiece, edgeId: string): number {
  const e = piece.edges.find((x) => x.id === edgeId);
  if (!e) return Infinity;
  const pts = slicePath(piece.seamLine, e.from, e.to);
  const a = pts[0];
  const b = pts[pts.length - 1];
  let bow = 0;
  for (const q of pts) bow = Math.max(bow, distToSegment(q, a, b));
  return bow;
}

/**
 * Why a seam cannot be a French seam, or null when it can. A French seam
 * needs two self-fabric pieces joined along a straight structural edge that
 * carries no zip, with at least 1 cm allowance.
 */
export function frenchSeamBlocker(seam: SeamSpec, pieces: readonly PatternPiece[], seams: readonly SeamSpec[]): string | null {
  if (!seam.b) return 'single-piece operation';
  const ends = [seam.a, seam.b];
  const ps = ends.map((r) => pieces.find((p) => p.id === r.pieceId));
  if (ps.some((p) => !p)) return 'unknown piece';
  const [pa, pb] = ps as [PatternPiece, PatternPiece];
  if (seam.a.pieceId === seam.b.pieceId && seam.a.edgeId === seam.b.edgeId && pa.role === 'wrap-tie') return 'folded strip';
  if (pa.layer !== 'self' || pb.layer !== 'self') return 'lining or interfacing join';
  if (NON_STRUCTURAL_ROLE.test(pa.role) || NON_STRUCTURAL_ROLE.test(pb.role)) return 'facing, binding, waistband, tie or pocket join (turned or enclosed)';
  if (ends.some((r) => CURVED_EDGE.test(r.edgeId))) return 'curved seam';
  if (edgeBow(pa, seam.a.edgeId) > FRENCH_MAX_BOW_CM || edgeBow(pb, seam.b.edgeId) > FRENCH_MAX_BOW_CM) return 'curved seam';
  if (Math.min(pa.seamAllowanceCm, pb.seamAllowanceCm) < 1) return 'allowance too narrow';
  const zipPieces = new Set(
    seams.filter((z) => z.type === 'zip-invisible' || z.type === 'zip-lapped').flatMap((z) => [z.a.pieceId, ...(z.b ? [z.b.pieceId] : [])]),
  );
  // A seam that continues a zip opening (the centre seam below it) must be plain.
  const zipEdges = new Set(
    seams.filter((z) => z.type === 'zip-invisible' || z.type === 'zip-lapped').flatMap((z) => [z.a, ...(z.b ? [z.b] : [])].map((r) => `${r.pieceId}.${r.edgeId}`)),
  );
  if (ends.some((r) => zipEdges.has(`${r.pieceId}.${r.edgeId}`))) return 'holds a zip';
  if (ends.every((r) => zipPieces.has(r.pieceId)) && ends.some((r) => /^c[bf]$|centre/.test(r.edgeId))) return 'continues a zip opening';
  return null;
}

/**
 * Final seam types: French seams survive only where a French seam can be
 * sewn; every other two-piece join becomes a plain seam with a finish to
 * match. Runs once on the drafted package, so pattern data and instructions agree.
 */
export function resolveSeamTypes(pieces: readonly PatternPiece[], seams: readonly SeamSpec[], material: MaterialPreset): SeamSpec[] {
  return seams.map((s) => {
    if (s.type !== 'french') return s;
    const blocker = frenchSeamBlocker(s, pieces, seams);
    if (!blocker) return s;
    return { ...s, type: 'plain' as const, finish: s.finish === FRENCH_FINISH ? plainFinish(material) : s.finish };
  });
}
