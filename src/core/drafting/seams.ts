/**
 * Seam specification helpers: assembly stages, seam-type selection and
 * material-aware finishing text.
 */
import type { MaterialPreset, PatternPiece, SeamSpec, SeamType } from '../types';

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

  /** Default seam type for long straight seams: French seams on sheer/light wovens. */
  plainType(): SeamType {
    const m = this.material;
    return m.construction === 'woven' && m.weightGsm < 90 && (m.fiber === 'silk' || m.fiber === 'viscose' || m.fiber === 'cupro')
      ? 'french'
      : 'plain';
  }

  seamFinish(): string {
    const m = this.material;
    if (this.plainType() === 'french') return 'French seam: stitch wrong sides together at 0.6 cm, trim to 0.3 cm, turn and stitch right sides together at 0.9 cm; press to the back.';
    if (m.construction === 'knit') return `${m.handling.seamFinish}. Use a stretch or narrow zigzag stitch so the seam can stretch.`;
    return `${m.handling.seamFinish}; press the seam open.`;
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
const ZIP_LENGTHS = [15, 18, 20, 23, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70];

/** Shortest standard zip at least as long as the opening. */
export function standardZip(openingCm: number): number {
  return ZIP_LENGTHS.find((z) => z >= openingCm - 0.5) ?? Math.ceil(openingCm / 5) * 5;
}
