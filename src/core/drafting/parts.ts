/**
 * Reusable secondary pieces: waistbands and binding strips (with one edge per
 * garment edge they join, so every seam pairs exactly two edges), neck
 * facings, in-seam pocket bags and ties.
 */
import type { FabricLayer, Path, PieceRole, Point } from '../types';
import type { EdgeDraft, NotchDraft, PieceDraft } from './piece';
import {
  dedupe,
  mirrorPathX,
  offsetOpenPath,
  reversePath,
  rotatePath,
  splineThrough,
  translatePath,
  add,
  scale,
} from '../geometry';

export interface StripSegment {
  edgeId: string;
  length: number;
  notchLabel?: string;
}

export interface StripOptions {
  id: string;
  role: PieceRole;
  name: string;
  layer: FabricLayer;
  segments: StripSegment[];
  /** Finished width (one layer). */
  width: number;
  /** Folded lengthwise (waistband, binding): cut width = 2 × width. */
  folded: boolean;
  extensionStart?: number;
  extensionEnd?: number;
  /** 'lengthwise' = long axis on the straight grain; 'crosswise' = across (knit bindings); 'bias'. */
  grain: 'lengthwise' | 'crosswise' | 'bias';
  seamAllowanceCm: number;
  cutCount?: number;
  notes?: string[];
  /** Kind of the two short ends. */
  endKind?: 'seam' | 'opening';
}

/**
 * Strip with the long attach edge split into one edge per segment
 * (in the order given). Other edges: 'end-start', 'inner', 'end-end' and
 * optional 'ext-start' / 'ext-end' extensions.
 */
export function stripPiece(o: StripOptions): PieceDraft {
  const H = o.folded ? 2 * o.width : o.width;
  const e0 = o.extensionStart ?? 0;
  const e1 = o.extensionEnd ?? 0;
  const total = e0 + e1 + o.segments.reduce((a, s) => a + s.length, 0);
  // Drawn with the long axis along +y, attach edge on the left (x = 0) going up.
  // Segment order along the waist runs from y = 0 downwards.
  const edges: EdgeDraft[] = [];
  edges.push({ id: 'end-start', kind: o.endKind ?? 'seam', points: [{ x: 0, y: 0 }, { x: H, y: 0 }] });
  edges.push({ id: 'inner', kind: 'facing', points: [{ x: H, y: 0 }, { x: H, y: total }] });
  edges.push({ id: 'end-end', kind: o.endKind ?? 'seam', points: [{ x: H, y: total }, { x: 0, y: total }] });
  const notches: NotchDraft[] = [];
  let y = total;
  if (e1 > 0) {
    edges.push({ id: 'ext-end', kind: 'opening', points: [{ x: 0, y }, { x: 0, y: y - e1 }] });
    y -= e1;
  }
  for (let i = o.segments.length - 1; i >= 0; i--) {
    const s = o.segments[i];
    edges.push({ id: s.edgeId, kind: 'seam', points: [{ x: 0, y }, { x: 0, y: y - s.length }] });
    if (s.notchLabel) notches.push({ edgeId: s.edgeId, at: 0, fromEnd: true, count: 1, label: s.notchLabel });
    y -= s.length;
  }
  if (e0 > 0) edges.push({ id: 'ext-start', kind: 'opening', points: [{ x: 0, y: e0 }, { x: 0, y: 0 }] });

  let out = edges;
  let extra: PieceDraft['extraLabels'] = o.folded ? [{ at: { x: o.width, y: Math.max(total * 0.85, total - 8) }, text: 'fold line', sizePt: 8 }] : [];
  if (o.grain === 'crosswise') {
    // rotate 90° so the long axis runs across the fabric (grain stays vertical)
    out = edges.map((e) => ({ ...e, points: rotatePath(e.points, -Math.PI / 2) }));
    extra = extra.map((l) => ({ ...l, at: rotatePath([l.at], -Math.PI / 2)[0] }));
  } else if (o.grain === 'bias') {
    out = edges.map((e) => ({ ...e, points: rotatePath(e.points, -Math.PI / 4) }));
    extra = extra.map((l) => ({ ...l, at: rotatePath([l.at], -Math.PI / 4)[0] }));
  }
  return {
    id: o.id,
    role: o.role,
    name: o.name,
    layer: o.layer,
    cutCount: o.cutCount ?? 1,
    cutOnFold: false,
    mirrorPair: (o.cutCount ?? 1) % 2 === 0,
    edges: out,
    notches,
    grain: 'vertical',
    extraLabels: extra,
    notes: o.notes,
    seamAllowanceCm: o.seamAllowanceCm,
    hemAllowanceCm: o.seamAllowanceCm,
  };
}

export interface FacingOptions {
  id: string;
  role: PieceRole;
  name: string;
  layer: FabricLayer;
  /**
   * The garment edge the facing follows, from its start point (centre front /
   * centre back / waist corner) to the high point shoulder, as on the garment
   * piece. The facing lies on the right-hand side of this direction (inside).
   */
  path: Path;
  pathEdgeId: string;
  /** Unit direction of the shoulder line from the HPS towards the shoulder point. */
  shoulderDir: Point;
  width: number;
  /** How the facing closes at the start point: along a vertical centre line, or a horizontal waist line. */
  close: 'vertical' | 'horizontal';
  closeEdgeId: string;
  closeKind: EdgeDraft['kind'];
  cutCount: number;
  cutOnFold: boolean;
  seamAllowanceCm: number;
}

/** Facing following a garment edge (neck or wrap edge): edges <pathEdgeId>, 'shoulder', 'outer', <closeEdgeId>. */
export function edgeFacing(o: FacingOptions): PieceDraft {
  const path = dedupe(o.path);
  const p0 = path[0];
  const hps = path[path.length - 1];
  const sp = add(hps, scale(o.shoulderDir, o.width));
  let inner = offsetOpenPath(path, -o.width);
  inner = o.close === 'vertical' ? inner.filter((p) => p.x >= p0.x + 0.3) : inner.filter((p) => p.y <= p0.y - 0.3);
  if (inner.length === 0) inner = [add(p0, { x: o.width, y: o.close === 'vertical' ? o.width : -o.width })];
  const first = inner[0];
  const cEnd = o.close === 'vertical' ? { x: p0.x, y: first.y } : { x: first.x, y: p0.y };
  // drop offset points too close to the shoulder end so the outer edge leaves the shoulder cleanly
  const body = inner.filter((p) => Math.hypot(p.x - sp.x, p.y - sp.y) > 1);
  const outerPts = dedupe([sp, ...reversePath(body), cEnd], 0.05);
  const outer = splineThrough(thin(outerPts, 1.5));
  return {
    id: o.id,
    role: o.role,
    name: o.name,
    layer: o.layer,
    cutCount: o.cutCount,
    cutOnFold: o.cutOnFold,
    mirrorPair: !o.cutOnFold && o.cutCount % 2 === 0,
    edges: [
      { id: o.pathEdgeId, kind: 'seam', points: path },
      { id: 'shoulder', kind: 'seam', points: [hps, sp] },
      { id: 'outer', kind: 'facing', points: outer, allowance: 0 },
      { id: o.closeEdgeId, kind: o.closeKind, points: [cEnd, p0] },
    ],
    notes: ['Finish the outer edge (zigzag or overlock)'],
    seamAllowanceCm: o.seamAllowanceCm,
    hemAllowanceCm: o.seamAllowanceCm,
  };
}

/** Keep points at least `step` apart (always keeping first and last). */
function thin(p: Path, step: number): Path {
  if (p.length <= 2) return p;
  const out: Path = [p[0]];
  for (let i = 1; i < p.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(p[i].x - last.x, p[i].y - last.y) >= step) out.push(p[i]);
  }
  const lastPt = p[p.length - 1];
  if (out.length > 1 && Math.hypot(out[out.length - 1].x - lastPt.x, out[out.length - 1].y - lastPt.y) < step * 0.5) out.pop();
  out.push(lastPt);
  return out;
}

/**
 * In-seam pocket bag. `attach` is the garment's pocket-opening edge as it
 * appears on the garment piece; `interiorRight` tells which side of it the
 * garment lies on (the bag hangs inside the garment).
 */
export function pocketBag(o: {
  id: string;
  name: string;
  layer: FabricLayer;
  attach: Path;
  interiorRight: boolean;
  seamAllowanceCm: number;
}): PieceDraft {
  let p = dedupe(o.attach);
  if (p[0].y > p[p.length - 1].y) p = reversePath(p);
  if (o.interiorRight) p = mirrorPathX(p, 0);
  // normalise so the top of the opening is at the origin
  p = translatePath(p, -p[0].x, -p[0].y);
  const top = p[0];
  const bot = p[p.length - 1];
  const depth = bot.y - top.y;
  const bag = splineThrough(
    [
      bot,
      { x: bot.x - 3, y: bot.y + 7 },
      { x: Math.min(bot.x, top.x) - 13, y: bot.y + 6 },
      { x: Math.min(bot.x, top.x) - 17, y: top.y + depth * 0.4 },
      { x: top.x - 12, y: top.y - 1.5 },
      { x: top.x - 3, y: top.y - 2 },
      top,
    ],
    { tension: 0.5 },
  );
  return {
    id: o.id,
    role: 'pocket-bag',
    name: o.name,
    layer: o.layer,
    cutCount: 4,
    cutOnFold: false,
    mirrorPair: true,
    edges: [
      { id: 'attach', kind: 'seam', points: p },
      { id: 'bag', kind: 'seam', points: bag },
    ],
    seamAllowanceCm: o.seamAllowanceCm,
    hemAllowanceCm: o.seamAllowanceCm,
  };
}

/** Tie cut on the fold along its length: edges 'attach', 'long', 'end', 'fold'. */
export function tiePiece(o: { id: string; name: string; length: number; width: number; cutCount: number; seamAllowanceCm: number }): PieceDraft {
  const w = o.width;
  const L = o.length;
  // fold on the left (x = 0), long seam on the right, attach at the top, angled end at the bottom
  return {
    id: o.id,
    role: 'wrap-tie',
    name: o.name,
    layer: 'self',
    cutCount: o.cutCount,
    cutOnFold: true,
    mirrorPair: false,
    edges: [
      { id: 'attach', kind: 'seam', points: [{ x: 0, y: 0 }, { x: w, y: 0 }] },
      { id: 'long', kind: 'seam', points: [{ x: w, y: 0 }, { x: w, y: L - w }] },
      { id: 'end', kind: 'seam', points: [{ x: w, y: L - w }, { x: 0, y: L }] },
      { id: 'fold', kind: 'fold', points: [{ x: 0, y: L }, { x: 0, y: 0 }] },
    ],
    seamAllowanceCm: o.seamAllowanceCm,
    hemAllowanceCm: o.seamAllowanceCm,
  };
}
