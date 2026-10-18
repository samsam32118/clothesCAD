/**
 * Shared helpers for garment drafters.
 */
import type {
  BodyLandmarks,
  Closure,
  FitPlan,
  MaterialPreset,
  Path,
  PatternPiece,
  ResolvedMeasurements,
  SeamSpec,
  Silhouette,
} from '../../types';
import type { DraftContext } from '../context';
import type { EdgeDraft, PieceDraft } from '../piece';
import { dist, pathLength, pathBounds, splitAtLength, dedupe } from '../../geometry';
import { bodyProfile, type BodyProfile } from '../../fit/profile';
import { hpsHeight } from '../../measurements';
import { BEGINNER_CURVED_HEM_CM, isStableWoven, SeamBook, zipForOpening, zipOpening } from '../seams';

export interface DraftResult {
  pieces: PatternPiece[];
  seams: SeamSpec[];
  silhouette: Silhouette;
}

export interface G {
  ctx: DraftContext;
  r: ResolvedMeasurements;
  L: BodyLandmarks;
  fit: FitPlan;
  material: MaterialPreset;
  knit: boolean;
  sa: number;
  ha: number;
  closure: Closure;
  zip: boolean;
  zipType: 'zip-invisible' | 'zip-lapped';
  prof: BodyProfile;
  hps: number;
  book: SeamBook;
}

export function makeG(ctx: DraftContext): G {
  const closure = ctx.fit.options.closure;
  return {
    ctx,
    r: ctx.measurements,
    L: ctx.body.landmarks,
    fit: ctx.fit,
    material: ctx.material,
    knit: ctx.material.construction === 'knit',
    sa: ctx.seamAllowanceCm,
    ha: ctx.hemAllowanceCm,
    closure,
    zip: closure === 'invisible-zip' || closure === 'lapped-zip',
    zipType: closure === 'lapped-zip' ? 'zip-lapped' : 'zip-invisible',
    prof: bodyProfile(ctx.measurements, ctx.body.landmarks),
    hps: hpsHeight(ctx.measurements),
    book: new SeamBook(ctx.material, { beginnerHems: ctx.garment.difficulty <= 2 }),
  };
}

/** Split a path at ascending arc lengths into consecutive sub-paths. */
export function splitByLengths(p: Path, cuts: number[]): Path[] {
  const out: Path[] = [];
  let rest = p;
  let consumed = 0;
  for (const c of cuts) {
    const [a, b] = splitAtLength(rest, c - consumed);
    out.push(a);
    rest = b;
    consumed = c;
  }
  out.push(rest);
  return out.map((x) => dedupe(x));
}

/**
 * Split a side seam into 'side-upper' / 'side-pocket' / 'side' for an in-seam
 * pocket. `fromTop` = distance from the top (waist) end to the pocket opening,
 * `opening` = opening length. `topAtStart` tells whether the path starts at the top.
 */
export function pocketSplit(points: Path, topAtStart: boolean, fromTop: number, opening: number, kind: EdgeDraft['kind'] = 'seam', allowance?: number): EdgeDraft[] {
  const total = pathLength(points);
  const a = Math.min(fromTop, total * 0.4);
  const b = Math.min(a + opening, total * 0.8);
  const extra = allowance !== undefined ? { allowance } : {};
  if (topAtStart) {
    const [up, pocket, rest] = splitByLengths(points, [a, b]);
    return [
      { id: 'side-upper', kind, points: up, ...extra },
      { id: 'side-pocket', kind, points: pocket, ...extra },
      { id: 'side', kind, points: rest, ...extra },
    ];
  }
  const [rest, pocket, up] = splitByLengths(points, [total - b, total - a]);
  return [
    { id: 'side', kind, points: rest, ...extra },
    { id: 'side-pocket', kind, points: pocket, ...extra },
    { id: 'side-upper', kind, points: up, ...extra },
  ];
}

/**
 * Drafted zip opening (cm) for a seam of `available` cm that must open at
 * least `needed` cm. The opening always matches a standard zip (see
 * `zipOpening`); `zipFor` gives the zip to buy.
 */
export function zipLength(g: G, needed: number, available: number): number {
  return zipOpening(needed, available - 1.5, g.zipType);
}

/** The standard zip (cm) for a drafted opening. */
export function zipFor(g: G, openingCm: number): number {
  return zipForOpening(openingCm, g.zipType);
}

/** "a 22 cm invisible zip (opening 20 cm)" */
export function zipPhrase(g: G, openingCm: number): string {
  const kind = g.zipType === 'zip-lapped' ? 'regular (lapped)' : 'invisible';
  return `a ${zipFor(g, openingCm)} cm ${kind} zip (the opening is ${Math.round(openingCm * 10) / 10} cm)`;
}

/**
 * Centre edge (bottom -> top) of a back piece, split for a zip:
 * returns ['cb' (plain, lower), 'cb-zip' (top zipLen)] or just the zip / fold.
 */
export function centreBackEdges(
  path: Path,
  g: G,
  opts: { fold: boolean; zipLen: number; ventHeight?: number; ventExtension?: number; slitHeight?: number; lining?: boolean },
): EdgeDraft[] {
  if (opts.fold) return [{ id: 'cb', kind: 'fold', points: path }];
  const zipAllowance = g.closure === 'lapped-zip' ? Math.max(2, g.sa) : g.sa;
  const total = pathLength(path);
  const edges: EdgeDraft[] = [];
  let p = path;
  let consumed = 0;
  if (opts.slitHeight && opts.slitHeight > 0) {
    const [slit, rest] = splitAtLength(p, opts.slitHeight);
    edges.push({ id: 'slit', kind: 'opening', points: slit, allowance: opts.lining ? g.sa : 2.5 });
    p = rest;
    consumed = opts.slitHeight;
  } else if (opts.ventHeight && opts.ventHeight > 0) {
    const [, rest] = splitAtLength(p, opts.ventHeight);
    const top = rest[0];
    const bottom = p[0];
    const w = opts.ventExtension ?? 4;
    // vent extension sticks out to the left of the centre line (x - w)
    edges.push({
      id: 'vent',
      kind: 'opening',
      points: [
        { x: bottom.x - w, y: bottom.y },
        { x: top.x - w, y: top.y + w },
        top,
      ],
      allowance: 1,
    });
    p = rest;
    consumed = opts.ventHeight;
  }
  const remaining = total - consumed;
  if (!g.zip || opts.zipLen <= 0) {
    edges.push({ id: 'cb', kind: 'seam', points: p });
    return edges;
  }
  if (opts.zipLen >= remaining - 1) {
    edges.push({ id: 'cb-zip', kind: opts.lining ? 'opening' : 'seam', points: p, allowance: zipAllowance });
    return edges;
  }
  const [lower, upper] = splitAtLength(p, remaining - opts.zipLen);
  edges.push({ id: 'cb', kind: 'seam', points: lower });
  edges.push({ id: 'cb-zip', kind: opts.lining ? 'opening' : 'seam', points: upper, allowance: zipAllowance });
  return edges;
}

/** Sum of dart intakes whose legs lie on the given edge of a built piece. */
export function dartIntakeOn(piece: PatternPiece, edgeId: string): number {
  const e = piece.edges.find((x) => x.id === edgeId);
  if (!e) return 0;
  const n = piece.seamLine.length;
  const pts: Path = [];
  let k = e.from;
  for (let guard = 0; guard <= n; guard++) {
    pts.push(piece.seamLine[k]);
    if (k === e.to) break;
    k = (k + 1) % n;
  }
  const at = (q: { x: number; y: number }) => {
    let best = -1;
    let bd = 0.05;
    pts.forEach((p, i) => {
      const d = dist(p, q);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  // The seam-line length between the legs (dart cap included) is what the
  // sewn dart removes from the edge.
  let total = 0;
  for (const d of piece.darts) {
    const i0 = at(d.legs[0]);
    const i1 = at(d.legs[1]);
    if (i0 < 0 || i1 < 0) continue;
    total += pathLength(pts.slice(Math.min(i0, i1), Math.max(i0, i1) + 1));
  }
  return total;
}

export function pieceById(pieces: PatternPiece[], id: string): PatternPiece {
  const p = pieces.find((x) => x.id === id);
  if (!p) throw new Error(`Missing piece ${id}`);
  return p;
}

export function edgeLen(pieces: PatternPiece[], pieceId: string, edgeId: string): number {
  const e = pieceById(pieces, pieceId).edges.find((x) => x.id === edgeId);
  if (!e) throw new Error(`Missing edge ${pieceId}.${edgeId}`);
  return e.lengthCm;
}

export function hasEdge(pieces: PatternPiece[], pieceId: string, edgeId: string): boolean {
  const p = pieces.find((x) => x.id === pieceId);
  return !!p && p.edges.some((e) => e.id === edgeId);
}

/** Add a dart seam for every dart on every piece. */
export function addDartSeams(g: G, pieces: PatternPiece[], stage: number): void {
  for (const p of pieces) {
    for (const d of p.darts) {
      const edge = p.edges.find((e) => {
        const n = p.seamLine.length;
        let k = e.from;
        for (let guard = 0; guard <= n; guard++) {
          if (dist(p.seamLine[k], d.legs[0]) < 0.05) return true;
          if (k === e.to) break;
          k = (k + 1) % n;
        }
        return false;
      });
      if (!edge) continue;
      const lining = p.layer === 'lining';
      g.book.single(
        `${p.id}-${d.id}`,
        [p.id, edge.id],
        'dart',
        lining ? stage + 48 : stage,
        lining
          ? 'Stitch as the main fabric dart (or fold as a soft pleat); press towards the side.'
          : `Stitch from the edge to the point, tapering off the fold; tie the threads at the point. Press ${d.id.includes('bust') ? 'downwards' : 'towards the centre'}.`,
        `Dart ${d.id}: ${d.intakeCm.toFixed(1)} cm intake, ${d.lengthCm.toFixed(1)} cm long.`,
      );
    }
  }
}

/** Hem operation on a piece edge. */
export function addHem(g: G, pieceId: string, edgeId: string, curved: boolean, allowance: number, stage: number, note?: string): void {
  const t = g.book.hemType(curved);
  g.book.single(`${pieceId}-${edgeId}`, [pieceId, edgeId], t, stage, g.book.hemFinish(t, allowance), note);
}

/** Hem allowance for a curved/flared hem. */
export function curvedHemAllowance(g: G, flare: number): number {
  // First projects in stable wovens: a narrow double-turn hem (1 + 1 cm) that
  // lies flat round the curve and is easy to keep even.
  if (g.ctx.garment.difficulty <= 2 && isStableWoven(g.material) && g.material.weightGsm < 150 && flare > 0.3) return Math.min(g.ha, BEGINNER_CURVED_HEM_CM);
  if (flare > 0.66) return Math.min(g.ha, 1.2);
  if (flare > 0.3) return Math.min(g.ha, 2.5);
  return g.ha;
}

/** Fabric width used for a layer's cutting layout (matches design.ts). */
export function layerWidth(g: G, layer: PieceDraft['layer']): number {
  return layer === 'self' ? g.material.widthCm : layer === 'lining' ? 140 : 90;
}

/**
 * Cut-on-fold pieces must fit the fabric opened out (2 × half width). Pieces
 * that are too wide get a centre seam instead: the fold edge becomes a seam
 * edge, the piece is cut as a mirrored pair, and drafting/index adds the seam.
 */
export function fitFolds(g: G, drafts: PieceDraft[]): PieceDraft[] {
  return drafts.map((d) => {
    if (!d.cutOnFold) return d;
    const pts = d.edges.flatMap((e) => e.points);
    const b = pathBounds(pts);
    const fullWidth = 2 * (b.maxX - b.minX + d.seamAllowanceCm);
    if (fullWidth <= layerWidth(g, d.layer) - 1) return d;
    return {
      ...d,
      cutOnFold: false,
      mirrorPair: true,
      cutCount: d.cutCount * 2,
      edges: d.edges.map((e) => (e.kind === 'fold' ? { ...e, kind: 'seam' as const, allowance: undefined } : e)),
      notes: [...(d.notes ?? []), 'Centre seam: too wide to cut on the fold'],
    };
  });
}
