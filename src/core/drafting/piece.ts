/**
 * Pattern piece builder: turns a list of drafted edges (open polylines that
 * chain end-to-start around the piece) into a complete PatternPiece with a
 * dense clockwise seam line, edge index ranges and lengths, a cut line with
 * per-edge allowances, notches, darts, grainline and labels.
 *
 * Edge index convention: `from`/`to` index into seamLine and are inclusive.
 * The seam line does not repeat its first point, so the LAST edge ends at
 * index 0 (`to < from`, wrapping through the implicit closing segment).
 * `pathLength(seamLine, from, to)` from geometry.ts measures both cases.
 */
import type { Dart, FabricLayer, Notch, Path, PatternEdge, PatternPiece, PieceRole, Point } from '../types';
import {
  densify,
  dedupe,
  dist,
  interiorPoint,
  offsetClosedPathVariable,
  pathBounds,
  pathLength,
  pointAtLength,
  pointInPolygon,
  reversePath,
  signedArea,
  slicePath,
} from '../geometry';

export interface EdgeDraft {
  id: string;
  kind: PatternEdge['kind'];
  points: Path;
  /** Override the default allowance for this edge (cm). */
  allowance?: number;
}

export interface NotchDraft {
  edgeId: string;
  /** Distance along the edge (cm) from its start (or from its end when fromEnd). */
  at: number;
  fromEnd?: boolean;
  count?: 1 | 2;
  label?: string;
}

export interface PieceDraft {
  id: string;
  role: PieceRole;
  name: string;
  layer: FabricLayer;
  cutCount: number;
  cutOnFold: boolean;
  mirrorPair: boolean;
  edges: EdgeDraft[];
  darts?: Dart[];
  notches?: NotchDraft[];
  /** Grain direction; default vertical (parallel to the y axis). 'bias' = 45°. */
  grain?: 'vertical' | 'horizontal' | 'bias';
  /** Extra label lines (placement marks such as "button", "fold line"). */
  extraLabels?: Array<{ at: Point; text: string; sizePt?: number }>;
  /** Extra text lines added under the cut instruction. */
  notes?: string[];
  seamAllowanceCm: number;
  hemAllowanceCm: number;
}

export function cutInstruction(p: Pick<PatternPiece, 'cutCount' | 'cutOnFold' | 'mirrorPair'>): string {
  if (p.cutOnFold) return p.cutCount === 1 ? 'Cut 1 on fold' : `Cut ${p.cutCount} on fold`;
  if (p.mirrorPair) {
    const pairs = p.cutCount / 2;
    return pairs === 1 ? 'Cut 2 (1 pair)' : `Cut ${p.cutCount} (${pairs} pairs)`;
  }
  return `Cut ${p.cutCount}`;
}

export function layerLabel(layer: FabricLayer): string {
  return layer === 'self' ? 'Main fabric' : layer === 'lining' ? 'Lining' : 'Interfacing';
}

function allowanceFor(e: EdgeDraft, d: PieceDraft): number {
  if (e.allowance !== undefined) return e.allowance;
  switch (e.kind) {
    case 'fold':
      return 0;
    case 'hem':
      return d.hemAllowanceCm;
    default:
      return d.seamAllowanceCm;
  }
}

/** Build a PatternPiece. Throws on structurally invalid drafts (programming errors). */
export function buildPiece(draft: PieceDraft): PatternPiece {
  let edges = draft.edges.map((e) => ({ ...e, points: dedupe(e.points, 1e-6) }));
  for (const e of edges) {
    if (e.points.length < 2) throw new Error(`Piece ${draft.id}: edge "${e.id}" has fewer than 2 points`);
  }
  // Chain edges: snap each start to the previous end.
  for (let i = 0; i < edges.length; i++) {
    const prev = edges[(i - 1 + edges.length) % edges.length];
    const cur = edges[i];
    const gap = dist(prev.points[prev.points.length - 1], cur.points[0]);
    if (gap > 0.2) {
      throw new Error(`Piece ${draft.id}: edge "${prev.id}" does not meet edge "${cur.id}" (gap ${gap.toFixed(2)} cm)`);
    }
    cur.points = dedupe([{ ...prev.points[prev.points.length - 1] }, ...cur.points.slice(1)], 1e-3);
    if (cur.points.length < 2) throw new Error(`Piece ${draft.id}: edge "${cur.id}" is degenerate`);
  }
  edges = edges.map((e) => ({ ...e, points: densify(e.points, 0.5) }));

  let notches = (draft.notches ?? []).map((n) => ({ ...n }));
  // Orientation: clockwise in y-down space = positive signed area.
  const probe: Path = [];
  for (const e of edges) probe.push(...e.points.slice(0, -1));
  if (signedArea(probe) < 0) {
    edges = edges.reverse().map((e) => ({ ...e, points: reversePath(e.points) }));
    notches = notches.map((n) => ({ ...n, fromEnd: !n.fromEnd }));
  }

  // Concatenate.
  const seamLine: Path = [];
  const ranges: Array<{ from: number; to: number }> = [];
  for (let i = 0; i < edges.length; i++) {
    const pts = edges[i].points;
    const from = seamLine.length === 0 ? 0 : seamLine.length - 1;
    if (seamLine.length === 0) seamLine.push(...pts);
    else seamLine.push(...pts.slice(1));
    ranges.push({ from, to: seamLine.length - 1 });
  }
  // last edge ends at the first point: drop the duplicate
  seamLine.pop();
  ranges[ranges.length - 1].to = 0;

  const n = seamLine.length;
  const segDist: number[] = new Array(n).fill(0);
  const patternEdges: PatternEdge[] = edges.map((e, i) => {
    const { from, to } = ranges[i];
    const a = allowanceFor(e, draft);
    // segments from..to-1 (wrapping)
    let k = from;
    while (k !== to) {
      segDist[k] = a;
      k = (k + 1) % n;
    }
    return { id: e.id, from, to, lengthCm: round2(pathLength(seamLine, from, to)), kind: e.kind };
  });
  const ids = new Set<string>();
  for (const e of patternEdges) {
    if (ids.has(e.id)) throw new Error(`Piece ${draft.id}: duplicate edge id "${e.id}"`);
    ids.add(e.id);
  }

  const cutLine = offsetClosedPathVariable(seamLine, segDist);

  const builtNotches: Notch[] = notches.map((nd) => {
    const idx = patternEdges.findIndex((e) => e.id === nd.edgeId);
    if (idx < 0) throw new Error(`Piece ${draft.id}: notch on unknown edge "${nd.edgeId}"`);
    const e = patternEdges[idx];
    const pts = slicePath(seamLine, e.from, e.to);
    const s = nd.fromEnd ? e.lengthCm - nd.at : nd.at;
    const at = pointAtLength(pts, Math.max(0, Math.min(e.lengthCm, s))).point;
    return { at: r2p(at), edgeId: nd.edgeId, count: nd.count ?? 1, ...(nd.label ? { label: nd.label } : {}) };
  });

  const darts: Dart[] = (draft.darts ?? []).map((d) => ({
    ...d,
    apex: r2p(d.apex),
    legs: [r2p(d.legs[0]), r2p(d.legs[1])],
    intakeCm: round2(d.intakeCm),
    lengthCm: round2(dist(d.apex, { x: (d.legs[0].x + d.legs[1].x) / 2, y: (d.legs[0].y + d.legs[1].y) / 2 })),
  }));

  const labelAt = interiorPoint(seamLine, darts.map((d) => d.apex));
  let grainline = makeGrainline(seamLine, labelAt, draft.grain ?? 'vertical');
  if (dist(grainline[0], grainline[1]) < MIN_GRAINLINE_CM) {
    // Narrow strips (bindings cut across the grain or on the bias): the seam
    // line is too thin for a usable grainline, so let it span the cut piece.
    // Try from the label and from the middle of the piece (a label near the
    // end of a bias strip leaves only a short chord there); keep the longest.
    const cb = pathBounds(cutLine);
    for (const near of [labelAt, { x: (cb.minX + cb.maxX) / 2, y: (cb.minY + cb.maxY) / 2 }]) {
      const wide = makeGrainline(cutLine, near, draft.grain ?? 'vertical', 0.42);
      if (dist(wide[0], wide[1]) > dist(grainline[0], grainline[1])) grainline = wide;
    }
  }
  const b = pathBounds(seamLine);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  // Narrow strips get their text along the long side (the renderer rotates it).
  const narrow = isNarrow(w, h);
  const lines = 3 + (draft.notes?.length ?? 0);
  const across = narrow ? w : h;
  const lh = Math.max(0.45, Math.min(1, (across - 0.6) / lines));
  const at = (i: number): Point => (narrow ? { x: labelAt.x - ((lines - 1) / 2) * lh + i * lh, y: labelAt.y } : { x: labelAt.x, y: labelAt.y + i * lh });
  const labels: PatternPiece['labels'] = [
    { at: r2p(at(0)), text: draft.name, sizePt: 14 },
    { at: r2p(at(1)), text: cutInstruction(draft), sizePt: 11 },
    { at: r2p(at(2)), text: layerLabel(draft.layer), sizePt: 10 },
  ];
  (draft.notes ?? []).forEach((t, i) => labels.push({ at: r2p(at(3 + i)), text: t, sizePt: 9 }));
  for (const l of draft.extraLabels ?? []) labels.push({ ...l, at: r2p(l.at) });

  const cb = pathBounds(cutLine);
  return {
    id: draft.id,
    role: draft.role,
    name: draft.name,
    layer: draft.layer,
    cutCount: draft.cutCount,
    cutOnFold: draft.cutOnFold,
    mirrorPair: draft.mirrorPair,
    seamLine: seamLine.map(r4p),
    cutLine: cutLine.map(r4p),
    edges: patternEdges,
    grainline: [r2p(grainline[0]), r2p(grainline[1])],
    notches: builtNotches,
    darts,
    labels,
    seamAllowanceCm: draft.seamAllowanceCm,
    bounds: { minX: round2(cb.minX), minY: round2(cb.minY), maxX: round2(cb.maxX), maxY: round2(cb.maxY) },
  };
}

/** Pieces whose labels run along the long side: long, thin strips (waistbands, ties, bindings). */
export function isNarrow(w: number, h: number): boolean {
  return w < 12 && h > 2.2 * w;
}

/** Shortest grainline worth drawing: it must be long enough to measure from. */
const MIN_GRAINLINE_CM = 3;

/**
 * Grainline through `near` (or close to it), spanning `keep` × 2 of the chord
 * of `poly` along the grain direction (capped at 80 cm).
 */
function makeGrainline(poly: Path, near: Point, kind: 'vertical' | 'horizontal' | 'bias', keep = 0.35): [Point, Point] {
  const b = pathBounds(poly);
  const d =
    kind === 'vertical' ? { x: 0, y: 1 } : kind === 'horizontal' ? { x: 1, y: 0 } : { x: Math.SQRT1_2, y: Math.SQRT1_2 };
  const extent = kind === 'vertical' ? b.maxY - b.minY : kind === 'horizontal' ? b.maxX - b.minX : Math.min(b.maxX - b.minX, b.maxY - b.minY);
  // Offset the grainline sideways from the label so text does not sit on it.
  const side = { x: -d.y, y: d.x };
  const off = Math.min(4, (kind === 'vertical' ? b.maxX - b.minX : b.maxY - b.minY) * 0.18);
  const candidates = [off, -off, off * 0.5, 0];
  for (const o of candidates) {
    const c = { x: near.x + side.x * o, y: near.y + side.y * o };
    if (!pointInPolygon(c, poly)) continue;
    // walk out both ways while inside, then keep 70 %
    const walk = (sgn: number) => {
      let t = 0;
      const step = Math.max(0.25, extent / 200);
      while (t < extent) {
        const q = { x: c.x + d.x * (t + step) * sgn, y: c.y + d.y * (t + step) * sgn };
        if (!pointInPolygon(q, poly)) break;
        t += step;
      }
      return t;
    };
    const t1 = walk(1);
    const t0 = walk(-1);
    const total = t0 + t1;
    if (total < 2) continue;
    const half = Math.min(total * keep, 40);
    const centre = (t1 - t0) / 2;
    return [
      { x: c.x + d.x * (centre - half), y: c.y + d.y * (centre - half) },
      { x: c.x + d.x * (centre + half), y: c.y + d.y * (centre + half) },
    ];
  }
  return [
    { x: near.x - d.x, y: near.y - d.y },
    { x: near.x + d.x, y: near.y + d.y },
  ];
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const r2p = (p: Point): Point => ({ x: round2(p.x), y: round2(p.y) });
const r4p = (p: Point): Point => ({ x: Math.round(p.x * 1e4) / 1e4, y: Math.round(p.y * 1e4) / 1e4 });

/** Points of an edge of a built piece (in path order). */
export function edgePoints(piece: PatternPiece, edgeId: string): Path {
  const e = piece.edges.find((x) => x.id === edgeId);
  if (!e) throw new Error(`Piece ${piece.id} has no edge "${edgeId}"`);
  return slicePath(piece.seamLine, e.from, e.to);
}

export function edgeLength(piece: PatternPiece, edgeId: string): number {
  const e = piece.edges.find((x) => x.id === edgeId);
  if (!e) throw new Error(`Piece ${piece.id} has no edge "${edgeId}"`);
  return e.lengthCm;
}
