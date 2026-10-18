/**
 * Cutting layouts: deterministic nesting of pattern pieces on fabric.
 *
 * Fabric coordinates: x across the width (0 .. usable width), y along the
 * length (grows down = along the selvedge). The lengthwise grain is the y
 * axis, and every piece's grainline is drafted parallel to its own y axis, so
 * pieces are only ever rotated 0° or 180° (and mirrored for pairs) — the grain
 * is always respected.
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
 * - 'single': single layer, full width. Every copy has its own placement
 *   (copy 1..cutCount, even copies of mirror pairs flipped). A cut-on-fold
 *   piece is cut opened out: its two mirrored halves are two placements of the
 *   same copy that meet exactly at the fold line.
 * Placements never overlap; a 0.5 cm gap is kept between pieces.
 */
import type { CuttingLayout, CuttingPlacement, FabricLayer, Path, PatternPiece, Point } from './types';
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
  for (const poly of rings) {
    const n = poly.length;
    for (let c = 0; c < cols; c++) {
      // sample three x positions in the column so thin features are not missed
      for (const fx of [0.02, 0.5, 0.98]) {
        const x = Math.min(w, (c + fx) * CELL);
        for (let i = 0; i < n; i++) {
          const a = poly[i];
          const b = poly[(i + 1) % n];
          if ((a.x - x) * (b.x - x) <= 0 && a.x !== b.x) {
            const y = a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y);
            top[c] = Math.min(top[c], y);
            bottom[c] = Math.max(bottom[c], y);
          }
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
  rotations: Array<0 | 180>;
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

interface Oriented {
  poly: Path; // transformed (flip/rotate) and shifted so bounds min = 0
  w: number;
  h: number;
  rotationDeg: 0 | 180;
  flipped: boolean;
  shift: Point; // translation already applied after flip/rotate
}

function orient(piece: PatternPiece, rotationDeg: 0 | 180, flipped: boolean): Oriented {
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
export function layoutPieces(pieces: PatternPiece[], fabricWidthCm: number, layer: FabricLayer): CuttingLayout {
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
        for (let k = 1; k <= p.cutCount; k++) items.push({ piece: p, copy: k, flipped: false, rotations: [0], onFold: true, twin: false });
      } else {
        const n = Math.ceil(p.cutCount / 2);
        for (let k = 0; k < n; k++) items.push({ piece: p, copy: 2 * k + 1, flipped: false, rotations: [0, 180], onFold: false, twin: false });
      }
    } else if (p.cutOnFold) {
      for (let k = 1; k <= p.cutCount; k++) items.push({ piece: p, copy: k, flipped: false, rotations: [0], onFold: false, twin: true });
    } else {
      for (let k = 1; k <= p.cutCount; k++) items.push({ piece: p, copy: k, flipped: p.mirrorPair && k % 2 === 0, rotations: [0, 180], onFold: false, twin: false });
    }
  }

  const sky = new Skyline(cols);
  const placements: CuttingPlacement[] = [];
  let usedArea = 0;
  for (const it of items) {
    if (it.twin) {
      // opened-out fold piece: the half whose fold is on its right, plus the mirror on its left
      const side = foldSide(it.piece);
      const leftFlip = side === 'max' ? false : true; // left half has its fold on the right
      const left = orient(it.piece, 0, leftFlip);
      const right = orient(it.piece, 0, !leftFlip);
      // combined polygon: left at x in [0, w], right starting at the fold (x = left.w minus its own fold offset 0)
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
    let best: { o: Oriented; prof: Profile; x: number; y: number } | null = null;
    const flips = it.onFold ? [foldSide(it.piece) === 'max'] : [it.flipped];
    for (const rot of it.rotations) {
      for (const fl of flips) {
        const o = orient(it.piece, rot, fl);
        const prof = profileOf([o.poly], o.w, o.h);
        const pos = bestPosition(sky, prof, cols, it.onFold);
        if (!best || pos.y + prof.height < best.y + best.prof.height - 1e-9 || (pos.y + prof.height === best.y + best.prof.height && pos.x < best.x)) {
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
  length = Math.ceil(length);
  return {
    layer,
    fabricWidthCm,
    fold: folded ? 'folded' : 'single',
    lengthCm: length,
    placements,
    efficiency: length > 0 ? Math.round((usedArea / (usable * length)) * 1000) / 1000 : 0,
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
