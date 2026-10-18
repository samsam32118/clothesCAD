/**
 * Pattern SVG rendering.
 *
 * - renderPieceSVG: one piece (cut line solid, seam line dashed, grainline
 *   arrow, notches, darts, fold marking, labels) in centimetre user units.
 * - renderPatternSheetSVG: every piece on one sheet with a 5 cm scale bar.
 * - renderCuttingLayoutSVG: the cutting layout of one fabric layer.
 * - renderTiledPrintPages: 1:1 printable pages (mm units), 1 cm overlap,
 *   page labels A1, A2 … (row letter + column number), alignment marks and a
 *   5 cm test square on page A1.
 *
 * Pattern pieces carry no size or date (they are generated for one body).
 */
import type { CuttingLayout, DesignPackage, FabricLayer, Path, PatternPiece, Point } from './types';
import { closestOnPath, dir, dist, pathBounds, slicePath, sub, normalize } from './geometry';
import { placePath } from './layout';
import { cutInstruction, isNarrow, layerLabel } from './drafting/piece';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f2 = (v: number) => (Math.round(v * 100) / 100).toString();

function pathD(p: Path, close = true): string {
  if (p.length === 0) return '';
  let d = `M${f2(p[0].x)} ${f2(p[0].y)}`;
  for (let i = 1; i < p.length; i++) d += `L${f2(p[i].x)} ${f2(p[i].y)}`;
  return close ? d + 'Z' : d;
}

export interface PieceRenderOptions {
  /** Draw the stitching line (dashed). Default true. */
  seamLine?: boolean;
  labels?: boolean;
  /** Label each edge with its id (useful for agents / debugging). */
  edgeLabels?: boolean;
  /** Stroke scale multiplier. */
  stroke?: number;
  /** Output physical size (width/height attributes in cm). Default false: responsive. */
  realSize?: boolean;
  /** Margin around the piece (cm). */
  margin?: number;
  /** Fill colour of the piece. */
  fill?: string;
  /** Text size multiplier over true point size (1 = print size). Default 1.5 for screen. */
  textScale?: number;
}

const PT_CM = 0.03528; // 1 typographic point in cm

const STYLE = `
  .cut{fill:none;stroke:#111;stroke-width:0.06}
  .seam{fill:none;stroke:#555;stroke-width:0.035;stroke-dasharray:0.5 0.3}
  .grain{stroke:#1d4ed8;stroke-width:0.06;fill:none}
  .grainhead{fill:#1d4ed8}
  .notch{stroke:#111;stroke-width:0.07}
  .dart{fill:none;stroke:#b91c1c;stroke-width:0.05}
  .pleatfold{fill:none;stroke:#7c3aed;stroke-width:0.06}
  .pleatplace{fill:none;stroke:#7c3aed;stroke-width:0.05;stroke-dasharray:0.4 0.25}
  .pleathead{fill:#7c3aed}
  .fold{stroke:#047857;stroke-width:0.07;fill:none}
  .foldtxt{fill:#047857;font-family:Helvetica,Arial,sans-serif}
  .lbl{fill:#111;font-family:Helvetica,Arial,sans-serif;text-anchor:middle}
  .edge{fill:#6b7280;font-family:Helvetica,Arial,sans-serif;text-anchor:middle}
`;

/** Inner SVG markup for a piece in its own coordinates (cm). */
export function pieceMarkup(piece: PatternPiece, o: PieceRenderOptions = {}): string {
  const parts: string[] = [];
  const fill = o.fill ?? '#fffdf7';
  parts.push(`<path class="cut" d="${pathD(piece.cutLine)}" fill="${fill}" style="fill:${fill}"/>`);
  if (o.seamLine !== false) parts.push(`<path class="seam" d="${pathD(piece.seamLine)}"/>`);
  // fold edges
  for (const e of piece.edges.filter((x) => x.kind === 'fold')) {
    const pts = slicePath(piece.seamLine, e.from, e.to);
    const a = pts[0];
    const b = pts[pts.length - 1];
    const d = dir(a, b);
    const n = { x: -d.y, y: d.x };
    // bracket arrow inside the piece
    const inward = insideNormal(piece, a, b, n);
    const off = 1.2;
    const a2 = { x: a.x + inward.x * off + d.x * 3, y: a.y + inward.y * off + d.y * 3 };
    const b2 = { x: b.x + inward.x * off - d.x * 3, y: b.y + inward.y * off - d.y * 3 };
    parts.push(
      `<path class="fold" d="M${f2(a2.x - inward.x * off)} ${f2(a2.y - inward.y * off)}L${f2(a2.x)} ${f2(a2.y)}L${f2(b2.x)} ${f2(b2.y)}L${f2(b2.x - inward.x * off)} ${f2(b2.y - inward.y * off)}"/>`,
    );
    const m = { x: (a2.x + b2.x) / 2 + inward.x * 0.8, y: (a2.y + b2.y) / 2 + inward.y * 0.8 };
    const ang = (Math.atan2(d.y, d.x) * 180) / Math.PI;
    const upright = ang > 90 || ang < -90 ? ang + 180 : ang;
    parts.push(`<text class="foldtxt" font-size="1" text-anchor="middle" transform="translate(${f2(m.x)} ${f2(m.y)}) rotate(${f2(upright)})">PLACE ON FOLD</text>`);
  }
  // grainline with arrowheads
  const [g0, g1] = piece.grainline;
  const gd = normalize(sub(g1, g0));
  const gn = { x: -gd.y, y: gd.x };
  const head = (tip: Point, back: Point) =>
    `<path class="grainhead" d="M${f2(tip.x)} ${f2(tip.y)}L${f2(back.x + gn.x * 0.35)} ${f2(back.y + gn.y * 0.35)}L${f2(back.x - gn.x * 0.35)} ${f2(back.y - gn.y * 0.35)}Z"/>`;
  parts.push(`<path class="grain" d="M${f2(g0.x)} ${f2(g0.y)}L${f2(g1.x)} ${f2(g1.y)}"/>`);
  parts.push(head(g1, { x: g1.x - gd.x * 1, y: g1.y - gd.y * 1 }));
  parts.push(head(g0, { x: g0.x + gd.x * 1, y: g0.y + gd.y * 1 }));
  // darts
  for (const d of piece.darts) {
    parts.push(`<path class="dart" d="M${f2(d.legs[0].x)} ${f2(d.legs[0].y)}L${f2(d.apex.x)} ${f2(d.apex.y)}L${f2(d.legs[1].x)} ${f2(d.legs[1].y)}"/>`);
    parts.push(`<circle cx="${f2(d.apex.x)}" cy="${f2(d.apex.y)}" r="0.15" fill="#b91c1c"/>`);
  }
  parts.push(pleatMarkup(piece));
  // notches: ticks from the cut line towards the seam line
  for (const n of piece.notches) {
    const c = closestOnPath([...piece.cutLine, piece.cutLine[0]], n.at);
    const v = dist(c.point, n.at) > 1e-6 ? normalize(sub(n.at, c.point)) : { x: 0, y: 0 };
    const len = Math.min(0.7, Math.max(0.4, dist(c.point, n.at)));
    const t = { x: -v.y, y: v.x };
    const offs = n.count === 2 ? [-0.25, 0.25] : [0];
    for (const k of offs) {
      const s = { x: c.point.x + t.x * k, y: c.point.y + t.y * k };
      parts.push(`<path class="notch" d="M${f2(s.x)} ${f2(s.y)}L${f2(s.x + v.x * len)} ${f2(s.y + v.y * len)}"/>`);
    }
  }
  if (o.labels !== false) {
    const b = pathBounds(piece.seamLine);
    const narrow = isNarrow(b.maxX - b.minX, b.maxY - b.minY);
    const k = o.textScale ?? 1.8;
    for (const l of piece.labels) {
      const size = (l.sizePt ?? 10) * PT_CM * k;
      const rot = narrow ? ` transform="rotate(-90 ${f2(l.at.x)} ${f2(l.at.y)})"` : '';
      parts.push(`<text class="lbl" x="${f2(l.at.x)}" y="${f2(l.at.y)}" font-size="${f2(size)}"${rot}>${esc(l.text)}</text>`);
    }
  }
  if (o.edgeLabels) {
    for (const e of piece.edges) {
      const pts = slicePath(piece.seamLine, e.from, e.to);
      const m = pts[Math.floor(pts.length / 2)];
      parts.push(`<text class="edge" x="${f2(m.x)}" y="${f2(m.y)}" font-size="0.7">${esc(e.id)}</text>`);
    }
  }
  return parts.join('');
}

/**
 * Pleat markings from the "pleat" notches on each edge, in edge order:
 * - box pleat (pleat, pleat centre, pleat): both fold lines solid, the
 *   placement line dashed at the centre, an arrow from each fold to it;
 * - knife pleat (pleat, pleat): fold line solid at the first notch,
 *   placement dashed at the second, an arrow from fold to placement.
 * Lines run into the piece, square to the edge.
 */
function pleatMarkup(piece: PatternPiece): string {
  const out: string[] = [];
  const byEdge = new Map<string, Array<{ at: Point; centre: boolean; s: number; inward: Point }>>();
  for (const n of piece.notches) {
    if (!/^pleat/i.test(n.label ?? '')) continue;
    const e = piece.edges.find((x) => x.id === n.edgeId);
    if (!e) continue;
    const pts = slicePath(piece.seamLine, e.from, e.to);
    if (pts.length < 2) continue;
    const c = closestOnPath(pts, n.at);
    // tangent of the segment the notch sits on, then the normal into the piece
    let i = 1;
    for (let acc = 0; i < pts.length - 1; i++) {
      acc += dist(pts[i - 1], pts[i]);
      if (acc >= c.s) break;
    }
    const t = dir(pts[i - 1], pts[i]);
    const inward = insideNormal(piece, sub(n.at, t), { x: n.at.x + t.x, y: n.at.y + t.y }, { x: -t.y, y: t.x });
    const list = byEdge.get(e.id) ?? [];
    list.push({ at: n.at, centre: /centre|center/i.test(n.label ?? ''), s: c.s, inward });
    byEdge.set(e.id, list);
  }
  const line = (q: { at: Point; inward: Point }, len: number, cls: string) =>
    `<path class="${cls}" d="M${f2(q.at.x)} ${f2(q.at.y)}L${f2(q.at.x + q.inward.x * len)} ${f2(q.at.y + q.inward.y * len)}"/>`;
  const arrow = (from: { at: Point; inward: Point }, to: { at: Point; inward: Point }, depth: number) => {
    const a = { x: from.at.x + from.inward.x * depth, y: from.at.y + from.inward.y * depth };
    const b = { x: to.at.x + to.inward.x * depth, y: to.at.y + to.inward.y * depth };
    const d = dist(a, b);
    if (d < 0.4) return '';
    const u = normalize(sub(b, a));
    const tip = { x: b.x - u.x * 0.1, y: b.y - u.y * 0.1 };
    const back = { x: tip.x - u.x * Math.min(0.6, d / 3), y: tip.y - u.y * Math.min(0.6, d / 3) };
    const nn = { x: -u.y * 0.25, y: u.x * 0.25 };
    return (
      `<path class="pleatfold" d="M${f2(a.x)} ${f2(a.y)}L${f2(back.x)} ${f2(back.y)}"/>` +
      `<path class="pleathead" d="M${f2(tip.x)} ${f2(tip.y)}L${f2(back.x + nn.x)} ${f2(back.y + nn.y)}L${f2(back.x - nn.x)} ${f2(back.y - nn.y)}Z"/>`
    );
  };
  for (const list of byEdge.values()) {
    list.sort((a, b) => a.s - b.s);
    let i = 0;
    while (i < list.length) {
      const [a, b, c] = [list[i], list[i + 1], list[i + 2]];
      if (a && b && c && !a.centre && b.centre && !c.centre) {
        out.push(line(a, 8, 'pleatfold'), line(c, 8, 'pleatfold'), line(b, 8, 'pleatplace'), arrow(a, b, 3), arrow(c, b, 3));
        i += 3;
      } else if (a && b && !a.centre && !b.centre) {
        out.push(line(a, 6, 'pleatfold'), line(b, 6, 'pleatplace'), arrow(a, b, 2.5));
        i += 2;
      } else i += 1;
    }
  }
  return out.join('');
}

function insideNormal(piece: PatternPiece, a: Point, b: Point, n: Point): Point {
  const m = { x: (a.x + b.x) / 2 + n.x * 0.5, y: (a.y + b.y) / 2 + n.y * 0.5 };
  // test which side is inside the seam polygon
  let inside = false;
  const poly = piece.seamLine;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p = poly[i];
    const q = poly[j];
    if (p.y > m.y !== q.y > m.y && m.x < ((q.x - p.x) * (m.y - p.y)) / (q.y - p.y) + p.x) inside = !inside;
  }
  return inside ? n : { x: -n.x, y: -n.y };
}

/** A complete SVG document for a single piece (centimetre user units). */
export function renderPieceSVG(piece: PatternPiece, opts: PieceRenderOptions = {}): string {
  const m = opts.margin ?? 2;
  const b = piece.bounds;
  const w = b.maxX - b.minX + 2 * m;
  const h = b.maxY - b.minY + 2 * m;
  const size = opts.realSize ? ` width="${f2(w)}cm" height="${f2(h)}cm"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f2(b.minX - m)} ${f2(b.minY - m)} ${f2(w)} ${f2(h)}"${size} role="img" aria-label="${esc(piece.name)} pattern piece">` +
    `<title>${esc(piece.name)}</title><style>${STYLE}</style>` +
    pieceMarkup(piece, opts) +
    `</svg>`
  );
}

// ---------------------------------------------------------------------------
// Sheet arrangement (shared by the pattern sheet and print tiles)
// ---------------------------------------------------------------------------

interface Arranged {
  piece: PatternPiece;
  dx: number; // translation applied to piece coordinates
  dy: number;
}

/**
 * Pieces to draw on sheets and print pages: identical outlines (a facing and
 * its interfacing, a waistband and its interfacing) are drawn once with one
 * cutting line per fabric.
 */
/**
 * Pieces grouped by identical cutting outline (first = the one printed; the
 * rest reuse its paper piece). With `crossLayerOnly`, a group only collects
 * pieces of different layers (a facing and its interfacing), never two
 * fabric pieces that merely happen to share a shape.
 */
export function outlineGroups(pieces: PatternPiece[], crossLayerOnly = false): PatternPiece[][] {
  const groups = new Map<string, PatternPiece[][]>();
  const out: PatternPiece[][] = [];
  for (const p of pieces) {
    const key = p.cutLine.map((q) => `${Math.round(q.x * 10)},${Math.round(q.y * 10)}`).join(';');
    const list = groups.get(key) ?? [];
    const g = crossLayerOnly ? list.find((x) => !x.some((q) => q.layer === p.layer)) : list[0];
    if (g) g.push(p);
    else {
      const fresh = [p];
      list.push(fresh);
      out.push(fresh);
    }
    groups.set(key, list);
  }
  return out;
}

export function uniquePieces(pieces: PatternPiece[]): PatternPiece[] {
  const out: PatternPiece[] = [];
  for (const g of outlineGroups(pieces)) {
    const first = g[0];
    if (g.length === 1 || first.labels.length === 0) {
      out.push(...g.slice(0, first.labels.length === 0 ? g.length : 1));
      continue;
    }
    const [name, , , ...rest] = first.labels;
    const step = first.labels.length > 1 ? { x: first.labels[1].at.x - first.labels[0].at.x, y: first.labels[1].at.y - first.labels[0].at.y } : { x: 0, y: 1 };
    const lines = g.map((p, i) => ({
      at: { x: name.at.x + step.x * (i + 1), y: name.at.y + step.y * (i + 1) },
      text: `${layerLabel(p.layer)}: ${cutInstruction(p)}`,
      sizePt: 10,
    }));
    const shifted = rest.map((l) => (l.text === 'fold line' || l.text.startsWith('⊕') ? l : { ...l, at: { x: l.at.x + step.x * (g.length - 2), y: l.at.y + step.y * (g.length - 2) } }));
    out.push({ ...first, labels: [name, ...lines, ...shifted] });
  }
  return out;
}

/** Skyline (bottom-left) packing of piece bounding boxes into a band of the given width (cm). No rotation. */
export function arrangePieces(pieces: PatternPiece[], width: number, gap = 2): { items: Arranged[]; width: number; height: number } {
  const order = [...pieces].sort((a, b) => b.bounds.maxY - b.bounds.minY - (a.bounds.maxY - a.bounds.minY) || (a.id < b.id ? -1 : 1));
  const res = 1; // cm
  const band = Math.max(width, ...pieces.map((p) => p.bounds.maxX - p.bounds.minX));
  const cols = Math.ceil(band / res) + 1;
  const sky = new Array<number>(cols).fill(0);
  const items: Arranged[] = [];
  let maxX = 0;
  let maxY = 0;
  for (const p of order) {
    const w = Math.ceil((p.bounds.maxX - p.bounds.minX + gap) / res);
    const h = p.bounds.maxY - p.bounds.minY;
    let bx = 0;
    let by = Infinity;
    for (let x = 0; x + w <= cols; x++) {
      let y = 0;
      for (let c = x; c < x + w; c++) y = Math.max(y, sky[c]);
      if (y < by - 1e-9) {
        by = y;
        bx = x;
      }
    }
    if (!Number.isFinite(by)) {
      bx = 0;
      by = Math.max(...sky);
    }
    for (let c = bx; c < Math.min(cols, bx + w); c++) sky[c] = by + h + gap;
    items.push({ piece: p, dx: bx * res - p.bounds.minX, dy: by - p.bounds.minY });
    maxX = Math.max(maxX, bx * res + (p.bounds.maxX - p.bounds.minX));
    maxY = Math.max(maxY, by + h);
  }
  return { items, width: maxX, height: maxY };
}

function scaleBar(x: number, y: number): string {
  return (
    `<g><rect x="${x}" y="${y}" width="5" height="0.4" fill="#111"/>` +
    `<text class="lbl" x="${x + 2.5}" y="${y + 1.5}" font-size="0.9">5 cm</text></g>`
  );
}

/** All pieces of a package on one sheet (cm units). */
export function renderPatternSheetSVG(pkg: DesignPackage): string {
  const layers: FabricLayer[] = ['self', 'lining', 'interfacing'];
  const pieces = uniquePieces(layers.flatMap((l) => pkg.pieces.filter((p) => p.layer === l)));
  const totalArea = pieces.reduce((a, p) => a + (p.bounds.maxX - p.bounds.minX + 2) * (p.bounds.maxY - p.bounds.minY + 2), 0);
  const bandW = Math.max(100, Math.min(260, Math.sqrt(totalArea) * 1.5), ...pieces.map((p) => p.bounds.maxX - p.bounds.minX));
  const arr = arrangePieces(pieces, bandW);
  const headH = 9;
  const W = arr.width + 4;
  const H = arr.height + headH + 4;
  const body = arr.items
    .map((it) => {
      const fill = it.piece.layer === 'self' ? '#fffdf7' : it.piece.layer === 'lining' ? '#f5f3ff' : '#f0fdf4';
      return `<g transform="translate(${f2(it.dx + 2)} ${f2(it.dy + headH)})">${pieceMarkup(it.piece, { fill, textScale: 2.2 })}</g>`;
    })
    .join('');
  const title = `${pkg.name}`;
  const sub = `${pkg.garment.name} · ${pkg.style.name} · ${pkg.material.name} · ${pkg.pieces.length} pattern pieces · seam allowance ${pkg.pieces[0]?.seamAllowanceCm ?? 1.5} cm included`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f2(W)} ${f2(H)}" role="img" aria-label="Pattern sheet">` +
    `<title>${esc(title)} – pattern sheet</title><style>${STYLE}</style>` +
    `<rect x="0" y="0" width="${f2(W)}" height="${f2(H)}" fill="#ffffff"/>` +
    `<text x="2" y="3" font-size="2" font-family="Helvetica,Arial,sans-serif" fill="#111">${esc(title)}</text>` +
    `<text x="2" y="5.4" font-size="1.1" font-family="Helvetica,Arial,sans-serif" fill="#444">${esc(sub)}</text>` +
    legend(W - 40, 1.5) +
    scaleBar(2, 6.4) +
    body +
    `</svg>`
  );
}

function legend(x: number, y: number): string {
  return (
    `<g transform="translate(${f2(x)} ${f2(y)})" font-family="Helvetica,Arial,sans-serif" font-size="0.9">` +
    `<path class="cut" d="M0 0.5L3 0.5"/><text x="3.5" y="0.8" fill="#111">cutting line</text>` +
    `<path class="seam" d="M0 2L3 2"/><text x="3.5" y="2.3" fill="#111">stitching line</text>` +
    `<path class="grain" d="M18 0.5L21 0.5"/><text x="21.5" y="0.8" fill="#111">grainline</text>` +
    `<path class="dart" d="M18 2L21 2"/><text x="21.5" y="2.3" fill="#111">dart</text>` +
    `<path class="pleatfold" d="M33 0.5L36 0.5"/><text x="36.5" y="0.8" fill="#111">pleat fold line</text>` +
    `<path class="pleatplace" d="M33 2L36 2"/><text x="36.5" y="2.3" fill="#111">pleat placement (fold to here)</text>` +
    `</g>`
  );
}

// ---------------------------------------------------------------------------
// Cutting layout diagram
// ---------------------------------------------------------------------------

export function renderCuttingLayoutSVG(pkg: DesignPackage, layer: FabricLayer = 'self'): string {
  const layout: CuttingLayout | undefined = pkg.layouts.find((l) => l.layer === layer);
  if (!layout) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20"><text x="2" y="10" font-size="4" font-family="Helvetica,Arial,sans-serif">No ${esc(layer)} pieces</text></svg>`;
  }
  const usable = layout.fold === 'folded' ? layout.fabricWidthCm / 2 : layout.fabricWidthCm;
  const L = Math.max(layout.lengthCm, 10);
  const padL = 8;
  const padT = 9;
  const W = usable + padL + 6;
  const H = L + padT + 6;
  const parts: string[] = [];
  parts.push(`<rect x="${padL}" y="${padT}" width="${f2(usable)}" height="${f2(L)}" fill="#f8fafc" stroke="#94a3b8" stroke-width="0.2"/>`);
  if (layout.fold === 'folded') {
    parts.push(`<path d="M${padL} ${padT}L${padL} ${f2(padT + L)}" stroke="#047857" stroke-width="0.5" stroke-dasharray="2 1"/>`);
    parts.push(`<text x="${padL - 1.5}" y="${f2(padT + L / 2)}" font-size="2.2" fill="#047857" font-family="Helvetica,Arial,sans-serif" text-anchor="middle" transform="rotate(-90 ${padL - 1.5} ${f2(padT + L / 2)})">FOLD</text>`);
    parts.push(`<text x="${f2(padL + usable + 2)}" y="${f2(padT + L / 2)}" font-size="2.2" fill="#475569" font-family="Helvetica,Arial,sans-serif" text-anchor="middle" transform="rotate(90 ${f2(padL + usable + 2)} ${f2(padT + L / 2)})">SELVEDGES</text>`);
  } else {
    parts.push(`<text x="${padL - 1.5}" y="${f2(padT + L / 2)}" font-size="2.2" fill="#475569" font-family="Helvetica,Arial,sans-serif" text-anchor="middle" transform="rotate(-90 ${padL - 1.5} ${f2(padT + L / 2)})">SELVEDGE</text>`);
    parts.push(`<text x="${f2(padL + usable + 2)}" y="${f2(padT + L / 2)}" font-size="2.2" fill="#475569" font-family="Helvetica,Arial,sans-serif" text-anchor="middle" transform="rotate(90 ${f2(padL + usable + 2)} ${f2(padT + L / 2)})">SELVEDGE</text>`);
  }
  for (const pl of layout.placements) {
    const piece = pkg.pieces.find((p) => p.id === pl.pieceId);
    if (!piece) continue;
    const poly = placePath(piece.cutLine, pl);
    const fill = layer === 'self' ? '#fde68a' : layer === 'lining' ? '#ddd6fe' : '#bbf7d0';
    const single = layout.fold === 'folded' && pl.singleLayer === true;
    parts.push(
      `<path d="${pathD(poly.map((p) => ({ x: p.x + padL, y: p.y + padT })))}" fill="${fill}" fill-opacity="${single ? 0.45 : 0.8}" stroke="${single ? '#b91c1c' : '#334155'}" stroke-width="${single ? 0.4 : 0.25}"${single ? ' stroke-dasharray="1.2 0.6"' : ''}/>`,
    );
    const g = placePath(piece.grainline, pl).map((p) => ({ x: p.x + padL, y: p.y + padT }));
    parts.push(`<path d="M${f2(g[0].x)} ${f2(g[0].y)}L${f2(g[1].x)} ${f2(g[1].y)}" stroke="#1d4ed8" stroke-width="0.3"/>`);
    const b = pathBounds(poly);
    const cx = (b.minX + b.maxX) / 2 + padL;
    const cy = (b.minY + b.maxY) / 2 + padT;
    const fs = Math.max(1.4, Math.min(3, (b.maxX - b.minX) / 10));
    parts.push(`<text x="${f2(cx)}" y="${f2(cy)}" font-size="${f2(fs)}" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" fill="#0f172a">${esc(piece.name)}${pl.flipped ? ' (flipped)' : ''}</text>`);
    if (single) {
      parts.push(
        `<text x="${f2(cx)}" y="${f2(cy + fs * 1.2)}" font-size="${f2(fs * 0.8)}" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" fill="#b91c1c">ONE LAYER ONLY – cut last</text>`,
      );
    }
  }
  if (layout.fold === 'folded' && layout.placements.some((pl) => pl.singleLayer)) {
    parts.push(
      `<text x="${f2(padL + usable / 2)}" y="${f2(padT + L + 4)}" font-size="2" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" fill="#b91c1c">Dashed red pieces: lift the top layer away and cut through ONE layer only.</text>`,
    );
  }
  const line1 = `${layerTitle(layer)}: ${f2(layout.fabricWidthCm)} cm wide, ${layout.fold === 'folded' ? 'folded selvedge to selvedge' : 'single layer'}`;
  const line2 = `${f2(layout.lengthCm / 100)} m length used by this layout (buy the amount in the shopping list) · ${Math.round(layout.efficiency * 100)} % of the fabric used`;
  // Helvetica averages ~0.55 em per character: keep both lines inside the drawing width.
  const titleSize = Math.min(2.6, (W - padL - 1) / (0.55 * Math.max(line1.length, line2.length)));
  parts.push(
    `<text x="${padL}" y="${f2(padT - 1.2 - titleSize * 1.15)}" font-size="${f2(titleSize)}" font-family="Helvetica,Arial,sans-serif" fill="#0f172a">${esc(line1)}</text>`,
    `<text x="${padL}" y="${f2(padT - 1.2)}" font-size="${f2(titleSize)}" font-family="Helvetica,Arial,sans-serif" fill="#334155">${esc(line2)}</text>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f2(W)} ${f2(H)}" role="img" aria-label="Cutting layout"><title>Cutting layout – ${esc(layer)}</title>${parts.join('')}</svg>`;
}

function layerTitle(l: FabricLayer): string {
  return l === 'self' ? 'Main fabric' : l === 'lining' ? 'Lining' : 'Interfacing';
}

// ---------------------------------------------------------------------------
// Tiled 1:1 print pages
// ---------------------------------------------------------------------------

const PAPER = {
  A4: { w: 210, h: 297 },
  letter: { w: 215.9, h: 279.4 },
} as const;

/**
 * Printable pages at 1:1 (all units mm). The pattern canvas (pieces arranged
 * in a band) is cut into tiles of the printable area; neighbouring tiles share
 * a 10 mm overlap strip marked with dashed lines so pages can be trimmed and
 * taped. Page A1 also carries the title, a legend and a 5 cm test square.
 */
/** Tiling plan of the 1:1 print pages: arrangement, page grid and the number of pages actually printed. */
function planPrintTiling(allPieces: PatternPiece[], paperName: 'A4' | 'letter') {
  const paper = PAPER[paperName] ?? PAPER.A4;
  const margin = 10; // printer margin, mm
  const overlap = 10; // mm
  const pw = paper.w - 2 * margin; // printable width
  const ph = paper.h - 2 * margin;
  const stepX = pw - overlap;
  const stepY = ph - overlap;
  const headerH = 80; // mm reserved at the top of the canvas for title + test square
  const pieces = uniquePieces((['self', 'lining', 'interfacing'] as FabricLayer[]).flatMap((l) => allPieces.filter((p) => p.layer === l)));
  const maxPieceW = Math.max(...pieces.map((p) => (p.bounds.maxX - p.bounds.minX) * 10), 0);
  // Try several page-column counts and keep the arrangement that prints the fewest pages.
  let best: { arr: ReturnType<typeof arrangePieces>; pages: number; cols: number; rows: number } | null = null;
  for (let tryCols = 1; tryCols <= 8; tryCols++) {
    const bandWmm = Math.max(tryCols * stepX - overlap - 5, maxPieceW);
    const arr = arrangePieces(pieces, bandWmm / 10, 1.5);
    const cw = Math.max(arr.width * 10, 160);
    const ch = arr.height * 10 + headerH;
    const cols = Math.max(1, Math.ceil((cw - overlap) / stepX));
    const rows = Math.max(1, Math.ceil((ch - overlap) / stepY));
    let pages = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = c * stepX;
        const y0 = r * stepY;
        const hit = (r === 0 && c === 0) || arr.items.some((it) => {
          const minX = (it.piece.bounds.minX + it.dx) * 10;
          const maxX = (it.piece.bounds.maxX + it.dx) * 10;
          const minY = (it.piece.bounds.minY + it.dy) * 10 + headerH;
          const maxY = (it.piece.bounds.maxY + it.dy) * 10 + headerH;
          return maxX > x0 && minX < x0 + pw && maxY > y0 && minY < y0 + ph;
        });
        if (hit) pages++;
      }
    }
    if (!best || pages < best.pages) best = { arr, pages, cols, rows };
  }
  return { paper, margin, overlap, pw, ph, stepX, stepY, headerH, pieces, ...best! };
}

/** Number of pages `renderTiledPrintPages` prints for these pieces (empty pages are skipped). */
export function printPageCount(pieces: PatternPiece[], paper: 'A4' | 'letter' = 'A4'): number {
  return planPrintTiling(pieces, paper).pages;
}

export function renderTiledPrintPages(pkg: DesignPackage, opts: { paper: 'A4' | 'letter' }): string[] {
  const best = planPrintTiling(pkg.pieces, opts.paper);
  const { paper, margin, overlap, pw, ph, stepX, stepY, headerH } = best;
  const arr = best.arr;
  const cols = best!.cols;
  const rows = best!.rows;

  // canvas content (mm); piece coordinates are cm -> scale(10)
  const pieceGroups = arr.items.map((it) => ({
    bounds: {
      minX: (it.piece.bounds.minX + it.dx) * 10,
      maxX: (it.piece.bounds.maxX + it.dx) * 10,
      minY: (it.piece.bounds.minY + it.dy) * 10 + headerH,
      maxY: (it.piece.bounds.maxY + it.dy) * 10 + headerH,
    },
    svg: `<g transform="translate(0 ${headerH}) scale(10) translate(${f2(it.dx)} ${f2(it.dy)})">${pieceMarkup(it.piece, { fill: '#ffffff', textScale: 1 })}</g>`,
  }));
  const label = (r: number, c: number) => `${rowLetter(r)}${c + 1}`;
  const header =
    `<g font-family="Helvetica,Arial,sans-serif">` +
    `<text x="0" y="8" font-size="7" fill="#111">${esc(pkg.name)}</text>` +
    `<text x="0" y="15" font-size="3.6" fill="#333">${esc(pkg.garment.name)} · ${esc(pkg.material.name)} · print at 100 % (no scaling)</text>` +
    `<text x="0" y="21" font-size="3.2" fill="#333">${best!.pages} pages on a grid of ${rows} row${rows > 1 ? 's' : ''} (A…${rowLetter(rows - 1)}) × ${cols} column${cols > 1 ? 's' : ''}; blank grid pages are skipped. Overlap the 1 cm strips and match the page labels.</text>` +
    `<rect x="0" y="28" width="50" height="50" fill="none" stroke="#111" stroke-width="0.5"/>` +
    `<text x="25" y="52" font-size="4" text-anchor="middle" fill="#111">5 cm</text>` +
    `<text x="25" y="58" font-size="3" text-anchor="middle" fill="#555">test square</text>` +
    `<text x="56" y="34" font-size="3" fill="#333">Measure this square before cutting:</text>` +
    `<text x="56" y="39" font-size="3" fill="#333">it must be exactly 5 cm × 5 cm.</text>` +
    `<text x="56" y="47" font-size="3" fill="#333">Solid line = cut · dashed line = stitch (${f2(pkg.pieces[0]?.seamAllowanceCm ?? 1.5)} cm inside; hem allowances are wider)</text>` +
    `</g>`;
  const css = `<style>${STYLE}</style>`;
  const pages: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = c * stepX;
      const y0 = r * stepY;
      const visible = pieceGroups.filter((g) => g.bounds.maxX > x0 && g.bounds.minX < x0 + pw && g.bounds.maxY > y0 && g.bounds.minY < y0 + ph);
      const isFirst = r === 0 && c === 0;
      if (!isFirst && visible.length === 0) continue;
      const clipId = `clip-${label(r, c)}`;
      const marks: string[] = [];
      // overlap strips (dashed) on the right and bottom edges, alignment crosses
      if (c < cols - 1) marks.push(`<path d="M${f2(margin + pw - overlap)} ${margin}L${f2(margin + pw - overlap)} ${f2(margin + ph)}" stroke="#9ca3af" stroke-width="0.3" stroke-dasharray="2 2"/>`);
      if (r < rows - 1) marks.push(`<path d="M${margin} ${f2(margin + ph - overlap)}L${f2(margin + pw)} ${f2(margin + ph - overlap)}" stroke="#9ca3af" stroke-width="0.3" stroke-dasharray="2 2"/>`);
      marks.push(`<rect x="${margin}" y="${margin}" width="${f2(pw)}" height="${f2(ph)}" fill="none" stroke="#d1d5db" stroke-width="0.2"/>`);
      const lbl = label(r, c);
      const neighbours = [
        r > 0 ? `↑ ${label(r - 1, c)}` : '',
        c > 0 ? `← ${label(r, c - 1)}` : '',
        c < cols - 1 ? `${label(r, c + 1)} →` : '',
        r < rows - 1 ? `↓ ${label(r + 1, c)}` : '',
      ]
        .filter(Boolean)
        .join('   ');
      pages.push(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${paper.w}mm" height="${paper.h}mm" viewBox="0 0 ${paper.w} ${paper.h}">` +
          `<title>${esc(pkg.name)} – page ${lbl}</title>${css}` +
          `<defs><clipPath id="${clipId}"><rect x="${margin}" y="${margin}" width="${f2(pw)}" height="${f2(ph)}"/></clipPath></defs>` +
          `<rect width="${paper.w}" height="${paper.h}" fill="#ffffff"/>` +
          `<g clip-path="url(#${clipId})"><g transform="translate(${f2(margin - x0)} ${f2(margin - y0)})">${isFirst ? header : ''}${visible.map((g) => g.svg).join('')}</g></g>` +
          marks.join('') +
          `<text x="${f2(paper.w - margin)}" y="${f2(margin - 3)}" font-size="5" text-anchor="end" font-family="Helvetica,Arial,sans-serif" fill="#111">${lbl}</text>` +
          `<text x="${margin}" y="${f2(paper.h - margin + 6)}" font-size="3" font-family="Helvetica,Arial,sans-serif" fill="#6b7280">Page ${lbl} of ${rowLetter(rows - 1)}${cols} · ${neighbours}</text>` +
          `</svg>`,
      );
    }
  }
  return pages;
}

function rowLetter(r: number): string {
  let s = '';
  let n = r;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}
