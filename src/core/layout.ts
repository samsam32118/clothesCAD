/**
 * Cutting layouts: deterministic nesting of pattern pieces on fabric.
 *
 * Fabric coordinates: x across the width (0 .. usable width), y along the
 * length (grows down = along the selvedge). The lengthwise grain is the y
 * axis, and every piece's grainline is drafted parallel to its own y axis, so
 * fabric pieces are only ever rotated 0° or 180° (and mirrored for pairs) —
 * the grain is always respected; one-way fabrics (sheen, nap) only 0°.
 * Interfacing (non-woven fusible / sew-in) has no grain, so its pieces may
 * also turn 90° / 270°: a waistband strip then lies across the width.
 * For every layout two packing orders are tried (largest first, and
 * identical pieces alternating head-to-tail so trapezoid gores nest) and the
 * shorter one wins.
 *
 * Placement transform (applied to piece.cutLine, in this order):
 *   1. flip    : if `flipped`, mirror x -> -x
 *   2. rotate  : by `rotationDeg` about the origin (y-down, so 180° maps (x,y) -> (-x,-y))
 *   3. translate by (x, y)
 * `placePath(path, placement)` implements exactly this.
 *
 * Layout modes
 * - 'folded': used when the layer has cut-on-fold pieces and every piece fits
 *   in half the width. The fabric is folded selvedge to selvedge; x = 0 is the
 *   FOLD, x = width/2 the selvedges. Each placement cuts through both layers:
 *   a cut-on-fold piece placed against x = 0 yields one whole piece; any other
 *   placement yields a mirrored pair. Pairs therefore need cutCount/2
 *   placements (copy numbers 1, 3, 5 …: placement k covers copies 2k-1 and 2k).
 *   A piece needed an odd number of times (e.g. one waistband) has its last
 *   copy marked `singleLayer`: it is nested like any other piece, but cut
 *   last, after lifting the top layer away in that area, so only ONE layer is
 *   cut (cutting both would give an unwanted second piece). Nesting it costs
 *   no extra fabric; the other layer there becomes a spare scrap.
 * - 'single': single layer, full width. Every copy has its own placement
 *   (copy 1..cutCount, even copies of mirror pairs flipped). A cut-on-fold
 *   piece is cut opened out: its two mirrored halves are two placements of the
 *   same copy that meet exactly at the fold line.
 * Placements never overlap; a 0.5 cm gap is kept between pieces.
 */
import type { CuttingLayout, CuttingPlacement, FabricLayer, MaterialPreset, Path, PatternPiece, Point } from './types';
import { pathBounds, polygonArea, slicePath } from './geometry';

const CELL = 0.5; // cm
const GAP = 0.5; // cm between pieces

/** Apply a placement transform to a path (see module doc). */
export function placePath(path: Path, pl: Pick<CuttingPlacement, 'x' | 'y' | 'rotationDeg' | 'flipped'>): Path {
  const rad = (pl.rotationDeg * Math.PI) / 180;
  const c = Math.round(Math.cos(rad));
  const s = Math.round(Math.sin(rad));
  return path.map((p) => {
    const fx = pl.flipped ? -p.x : p.x;
    return { x: fx * c - p.y * s + pl.x, y: fx * s + p.y * c + pl.y };
  });
}

interface Profile {
  cols: number;
  /** Margin columns on each side (the gap); column k covers piece column k - pad. */
  pad: number;
  top: number[]; // per column, offset (cells) of the first occupied cell from the shape top
  bottom: number[]; // per column, offset of the last occupied cell + 1
  height: number;
}

/** Column profile of one or more rings (already shifted so bounds start at 0,0), dilated by the gap. */
function profileOf(rings: Path[], w: number, h: number): Profile {
  const cols = Math.max(1, Math.ceil(w / CELL));
  const top = new Array<number>(cols).fill(Infinity);
  const bottom = new Array<number>(cols).fill(-Infinity);
  const SAMPLES = [0.02, 0.5, 0.98]; // three x positions per column so thin features are not missed
  for (const poly of rings) {
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      if (a.x === b.x) continue;
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      const c0 = Math.max(0, Math.floor(x0 / CELL) - 1);
      const c1 = Math.min(cols - 1, Math.floor(x1 / CELL) + 1);
      for (let c = c0; c <= c1; c++) {
        for (const fx of SAMPLES) {
          const x = Math.min(w, (c + fx) * CELL);
          if (x < x0 || x > x1) continue;
          const y = a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y);
          if (y < top[c]) top[c] = y;
          if (y > bottom[c]) bottom[c] = y;
        }
      }
    }
    for (const p of poly) {
      const c = Math.min(cols - 1, Math.max(0, Math.floor(p.x / CELL)));
      top[c] = Math.min(top[c], p.y);
      bottom[c] = Math.max(bottom[c], p.y);
    }
  }
  for (let c = 0; c < cols; c++) {
    if (!Number.isFinite(top[c])) {
      top[c] = 0;
      bottom[c] = 0;
    }
  }
  // dilate by the gap: pad columns on both sides, spread sideways, extend downwards by GAP
  const g = Math.ceil(GAP / CELL);
  const T: number[] = [];
  const B: number[] = [];
  for (let k = 0; k < cols + 2 * g; k++) {
    const c = k - g;
    let t = Infinity;
    let b = -Infinity;
    for (let d = -g; d <= g; d++) {
      const cc = c + d;
      if (cc < 0 || cc >= cols) continue;
      t = Math.min(t, top[cc]);
      b = Math.max(b, bottom[cc]);
    }
    T.push(Number.isFinite(t) ? Math.floor((t - GAP) / CELL) : 0);
    B.push(Number.isFinite(b) ? Math.ceil((b + GAP) / CELL) : 0);
  }
  return { cols: cols + 2 * g, pad: g, top: T, bottom: B, height: Math.ceil(h / CELL) };
}

interface Item {
  piece: PatternPiece;
  copy: number;
  flipped: boolean;
  /** Which orientations may be tried. */
  rotations: Rotation[];
  /** Folded layout: cut through one layer only (odd copy of a non-fold piece). */
  single: boolean;
  /** Folded layout: this item must touch the fold at x = 0. */
  onFold: boolean;
  /** Single layout opened-out fold piece: place this item and its mirror twin together. */
  twin: boolean;
}

/** x-extent of the piece's fold edge on the cut line, if it has one: 'min' or 'max' side. */
function foldSide(piece: PatternPiece): 'min' | 'max' | null {
  const fold = piece.edges.find((e) => e.kind === 'fold');
  if (!fold) return null;
  const pts = slicePath(piece.seamLine, fold.from, fold.to);
  const x = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const b = pathBounds(piece.seamLine);
  return x - b.minX < b.maxX - x ? 'min' : 'max';
}

type Rotation = 0 | 90 | 180 | 270;

interface Oriented {
  poly: Path; // transformed (flip/rotate) and shifted so bounds min = 0
  w: number;
  h: number;
  rotationDeg: Rotation;
  flipped: boolean;
  shift: Point; // translation already applied after flip/rotate
}

function orient(piece: PatternPiece, rotationDeg: Rotation, flipped: boolean): Oriented {
  const t = placePath(piece.cutLine, { x: 0, y: 0, rotationDeg, flipped });
  const b = pathBounds(t);
  return {
    poly: t.map((p) => ({ x: p.x - b.minX, y: p.y - b.minY })),
    w: b.maxX - b.minX,
    h: b.maxY - b.minY,
    rotationDeg,
    flipped,
    shift: { x: -b.minX, y: -b.minY },
  };
}

class Skyline {
  readonly h: number[];
  constructor(readonly cols: number) {
    this.h = new Array<number>(cols).fill(0);
  }

  /** Lowest y (cells) at which the profile fits with its left column at x. */
  fitAt(p: Profile, x: number): number {
    let y = 0;
    for (let c = 0; c < p.cols; c++) {
      const X = x + c;
      if (X < 0 || X >= this.cols) continue;
      y = Math.max(y, this.h[X] - p.top[c]);
    }
    return y;
  }
  place(p: Profile, x: number, y: number): void {
    for (let c = 0; c < p.cols; c++) {
      const X = x + c;
      if (X < 0 || X >= this.cols) continue;
      this.h[X] = Math.max(this.h[X], y + p.bottom[c]);
    }
  }
}

/**
 * Lay out the pieces of one fabric layer. Pieces wider than the usable width
 * are still placed (flush left) and will extend past the selvedge; the
 * quality checks report this.
 */
export interface LayoutOptions {
  /**
   * One-way fabric (lustrous sheen, nap or pile): every piece must point the
   * same way, so the 180° turn is not allowed.
   */
  oneWay?: boolean;
}

/** True when a fabric's sheen or nap changes with direction (needs a with-nap layout). */
export function isOneWayFabric(material: Pick<MaterialPreset, 'sheen' | 'description'>): boolean {
  return material.sheen === 'lustrous' || material.sheen === 'high' || /\bnap\b|\bpile\b|one[- ]way/i.test(material.description);
}

export function layoutPieces(pieces: PatternPiece[], fabricWidthCm: number, layer: FabricLayer, options: LayoutOptions = {}): CuttingLayout {
  // Interfacing has no grain: strips may lie across the width.
  const turns: Rotation[] = layer === 'interfacing' ? [0, 90, 180, 270] : options.oneWay ? [0] : [0, 180];
  const hasFold = pieces.some((p) => p.cutOnFold);
  const maxW = Math.max(0, ...pieces.map((p) => p.bounds.maxX - p.bounds.minX));
  const folded = hasFold && maxW + GAP <= fabricWidthCm / 2;
  const usable = folded ? fabricWidthCm / 2 : fabricWidthCm;
  const cols = Math.max(1, Math.floor(usable / CELL));

  // expand into items
  const items: Item[] = [];
  const sorted = [...pieces].sort((a, b) => {
    const ah = a.bounds.maxY - a.bounds.minY;
    const bh = b.bounds.maxY - b.bounds.minY;
    const aa = polygonArea(a.cutLine);
    const ba = polygonArea(b.cutLine);
    if (a.cutOnFold !== b.cutOnFold) return a.cutOnFold ? -1 : 1;
    if (Math.abs(aa - ba) > 1e-6) return ba - aa;
    if (Math.abs(ah - bh) > 1e-6) return bh - ah;
    return a.id < b.id ? -1 : 1;
  });
  for (const p of sorted) {
    if (folded) {
      if (p.cutOnFold) {
        for (let k = 1; k <= p.cutCount; k++) items.push({ piece: p, copy: k, flipped: false, rotations: [0], onFold: true, twin: false, single: false });
      } else {
        const pairs = Math.floor(p.cutCount / 2);
        for (let k = 0; k < pairs; k++) items.push({ piece: p, copy: 2 * k + 1, flipped: false, rotations: turns, onFold: false, twin: false, single: false });
        if (p.cutCount % 2 === 1) items.push({ piece: p, copy: p.cutCount, flipped: false, rotations: turns, onFold: false, twin: false, single: true });
      }
    } else if (p.cutOnFold) {
      for (let k = 1; k <= p.cutCount; k++) items.push({ piece: p, copy: k, flipped: false, rotations: [0], onFold: false, twin: true, single: false });
    } else {
      for (let k = 1; k <= p.cutCount; k++) items.push({ piece: p, copy: k, flipped: p.mirrorPair && k % 2 === 0, rotations: turns, onFold: false, twin: false, single: false });
    }
  }
  const ordered = items;

  const pack = (alternate: boolean) => {
    const sky = new Skyline(cols);
    const placements: CuttingPlacement[] = [];
    let usedArea = 0;
    const seen = new Map<string, number>();
    for (const it of ordered) {
      if (it.twin) {
        // opened-out fold piece: the half whose fold is on its right, plus the mirror on its left
        const side = foldSide(it.piece);
        const leftFlip = side === 'max' ? false : true; // left half has its fold on the right
        const left = orient(it.piece, 0, leftFlip);
        const right = orient(it.piece, 0, !leftFlip);
        const w = left.w + right.w;
        const h = Math.max(left.h, right.h);
        const prof = profileOf([left.poly, right.poly.map((p) => ({ x: p.x + left.w, y: p.y }))], w, h);
        const pos = bestPosition(sky, prof, cols, false);
        sky.place(prof, pos.x, pos.y);
        const x0 = (pos.x + prof.pad) * CELL;
        const y0 = pos.y * CELL;
        placements.push({ pieceId: it.piece.id, copy: it.copy, x: round(x0 + left.shift.x), y: round(y0 + left.shift.y), rotationDeg: 0, flipped: leftFlip });
        placements.push({ pieceId: it.piece.id, copy: it.copy, x: round(x0 + left.w + right.shift.x), y: round(y0 + right.shift.y), rotationDeg: 0, flipped: !leftFlip });
        usedArea += 2 * polygonArea(it.piece.cutLine);
        continue;
      }
      // Alternate strategy: repeated copies of one piece prefer to turn
      // head-to-tail every other time, so gores and trapezoids nest.
      const nth = seen.get(it.piece.id) ?? 0;
      seen.set(it.piece.id, nth + 1);
      let rotations = it.rotations;
      if (alternate && rotations.includes(180) && nth % 2 === 1) rotations = [180, ...rotations.filter((r) => r !== 180)];
      let best: { o: Oriented; prof: Profile; x: number; y: number } | null = null;
      const flips = it.onFold ? [foldSide(it.piece) === 'max'] : [it.flipped];
      for (const rot of rotations) {
        for (const fl of flips) {
          const o = orient(it.piece, rot, fl);
          const prof = profileOf([o.poly], o.w, o.h);
          if (prof.cols - 2 * prof.pad > cols && rot % 180 !== 0) continue; // a turned strip must fit the width
          const pos = bestPosition(sky, prof, cols, it.onFold);
          const end = pos.y + prof.height;
          const bestEnd = best ? best.y + best.prof.height : Infinity;
          // alternate: keep the preferred (first) orientation unless another is clearly shorter
          const margin = alternate && best ? Math.ceil(1 / CELL) : 0;
          if (!best || end < bestEnd - margin - 1e-9 || (end === bestEnd && !alternate && pos.x < best.x)) {
            best = { o, prof, x: pos.x, y: pos.y };
          }
        }
      }
      if (!best) continue;
      sky.place(best.prof, best.x, best.y);
      const x0 = (best.x + best.prof.pad) * CELL;
      const y0 = best.y * CELL;
      placements.push({
        pieceId: it.piece.id,
        copy: it.copy,
        x: round(x0 + best.o.shift.x),
        y: round(y0 + best.o.shift.y),
        rotationDeg: best.o.rotationDeg,
        flipped: best.o.flipped,
        ...(it.single ? { singleLayer: true } : {}),
      });
      usedArea += polygonArea(it.piece.cutLine);
    }
    // actual length from placed outlines
    let length = 0;
    for (const pl of placements) {
      const piece = pieces.find((p) => p.id === pl.pieceId);
      if (!piece) continue;
      const b = pathBounds(placePath(piece.cutLine, pl));
      length = Math.max(length, b.maxY);
    }
    return { placements, usedArea, length: Math.ceil(length) };
  };

  const a = pack(false);
  const hasRepeats = items.some((i, k) => !i.twin && items.findIndex((j) => j.piece.id === i.piece.id) !== k);
  const b = hasRepeats && turns.includes(180) ? pack(true) : a;
  const best = b.length < a.length ? b : a;
  return {
    layer,
    fabricWidthCm,
    fold: folded ? 'folded' : 'single',
    lengthCm: best.length,
    placements: best.placements,
    efficiency: best.length > 0 ? Math.round((best.usedArea / (usable * best.length)) * 1000) / 1000 : 0,
  };
}

/** Bottom-left position (cells) of the profile's left column; the piece itself starts at x + pad. */
function bestPosition(sky: Skyline, prof: Profile, cols: number, onFold: boolean): { x: number; y: number } {
  const inner = prof.cols - 2 * prof.pad;
  if (onFold || inner >= cols) return { x: -prof.pad, y: Math.max(0, sky.fitAt(prof, -prof.pad)) };
  let bx = -prof.pad;
  let by = Infinity;
  for (let x = -prof.pad; x <= cols - inner - prof.pad; x++) {
    const y = sky.fitAt(prof, x);
    if (y < by) {
      by = y;
      bx = x;
    }
  }
  return { x: bx, y: Math.max(0, by) };
}

const round = (v: number) => Math.round(v * 100) / 100;
