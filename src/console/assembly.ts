/**
 * Page-assembly map for the 1:1 tiled print pattern.
 *
 * Built from the page SVGs that `renderTiledPrintPages` (src/core/svg) returns,
 * so it always matches what is printed: each printed page is shown as a
 * thumbnail in its grid position (cropped to the part that stays visible once
 * the pages overlap), and grid positions with nothing on them are marked as
 * skipped. The same trimming rule is used everywhere the user reads it.
 */
import type { DesignPackage } from '../core/types';

export type AssemblyPaper = 'A4' | 'letter';

const PAPER: Record<AssemblyPaper, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  letter: { w: 215.9, h: 279.4 },
};

/** One consistent rule for joining the pages (also used by the print note). */
export const ASSEMBLY_STEPS: readonly string[] = [
  'Print every page at 100 % ("actual size", no "fit to page"). Measure the 5 cm test square on page A1.',
  'Lay the pages out like this map: letters are rows (A at the top), numbers are columns (1 on the left). Grey squares are blank and were not printed.',
  'Trim the white margin off the LEFT and TOP edge of each page, cutting along the thin grey frame. Leave the right and bottom margins on. Pages in column 1 keep their left edge; pages in row A keep their top edge.',
  'Lay each trimmed edge exactly on the dashed line of the page to its left or above it, so the pattern lines continue, then tape.',
];

export interface PageGridInfo {
  /** Label such as "B3". */
  label: string;
  row: number;
  col: number;
  /** Index in the printed page list (0-based). */
  index: number;
}

export interface PageGrid {
  rows: number;
  cols: number;
  pages: PageGridInfo[];
  /** Printable area of each sheet (mm). */
  area: { x: number; y: number; w: number; h: number };
  /** Overlap strip between neighbouring pages (mm). */
  overlap: number;
}

function letterIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function rowLetters(r: number): string {
  let s = '';
  let n = r;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Recover the page grid from the rendered page SVGs (labels, grid size, frame and overlap). */
export function readPageGrid(pages: readonly string[], paper: AssemblyPaper): PageGrid {
  const { w, h } = PAPER[paper];
  let rows = 1;
  let cols = 1;
  let area = { x: 10, y: 10, w: w - 20, h: h - 20 };
  let overlap = 10;
  const infos: PageGridInfo[] = [];
  pages.forEach((svg, index) => {
    const lbl = /page ([A-Z]+)(\d+)\s*<\/title>/.exec(svg);
    const of = /of ([A-Z]+)(\d+)/.exec(svg);
    if (of) {
      rows = Math.max(rows, letterIndex(of[1]!) + 1);
      cols = Math.max(cols, Number(of[2]));
    }
    if (index === 0) {
      const clip = /<clipPath[^>]*>\s*<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(svg);
      if (clip) area = { x: Number(clip[1]), y: Number(clip[2]), w: Number(clip[3]), h: Number(clip[4]) };
    }
    const dash = /<path d="M([\d.]+) [\d.]+L[\d.]+ [\d.]+"[^>]*stroke-dasharray/.exec(svg);
    if (dash) {
      const ov = area.x + area.w - Number(dash[1]);
      if (ov > 0 && ov < area.w / 2) overlap = ov;
    }
    if (lbl) {
      const row = letterIndex(lbl[1]!);
      const col = Number(lbl[2]) - 1;
      infos.push({ label: `${lbl[1]}${lbl[2]}`, row, col, index });
    } else {
      infos.push({ label: `P${index + 1}`, row: 0, col: index, index });
      cols = Math.max(cols, index + 1);
    }
  });
  return { rows, cols, pages: infos, area, overlap };
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Inner markup of an SVG document with ids (and references to them) prefixed so copies can share a document. */
function innerWithPrefixedIds(svg: string, prefix: string): string {
  const open = svg.indexOf('>', svg.indexOf('<svg'));
  const close = svg.lastIndexOf('</svg>');
  const inner = open >= 0 && close > open ? svg.slice(open + 1, close) : '';
  return inner
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/\bid="([^"]+)"/g, (_m, id: string) => `id="${prefix}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_m, id: string) => `url(#${prefix}${id})`)
    .replace(/href="#([^"]+)"/g, (_m, id: string) => `href="#${prefix}${id}"`);
}

/** Break text into lines of at most `max` characters (word wrap). */
function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > max) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

/**
 * A full paper-size SVG page showing how the printed pages fit together.
 * Thumbnails carry the real pattern lines, so the user sees the garment
 * pieces emerge from the grid.
 */
export function renderAssemblyMapSVG(pkg: Pick<DesignPackage, 'name'>, pages: readonly string[], paper: AssemblyPaper): string {
  const { w, h } = PAPER[paper];
  const grid = readPageGrid(pages, paper);
  const { rows, cols, area, overlap } = grid;
  const stepX = area.w - overlap;
  const stepY = area.h - overlap;
  const totalW = (cols - 1) * stepX + area.w;
  const totalH = (rows - 1) * stepY + area.h;
  const margin = 14;
  const top = 40;
  const fontLine = 4.6;
  const stepLines = ASSEMBLY_STEPS.map((s, i) => wrap(`${i + 1}. ${s}`, 104));
  const textH = stepLines.reduce((n, l) => n + l.length, 0) * fontLine + ASSEMBLY_STEPS.length * 1.6 + 8;
  const boxW = w - 2 * margin;
  const boxH = h - top - textH - margin;
  const scale = Math.min(boxW / totalW, boxH / totalH);
  const ox = margin + (boxW - totalW * scale) / 2;
  const oy = top;
  const byPos = new Map(grid.pages.map((p) => [`${p.row}:${p.col}`, p]));
  const cells: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cw = (c === cols - 1 ? area.w : stepX) * scale;
      const ch = (r === rows - 1 ? area.h : stepY) * scale;
      const x = ox + c * stepX * scale;
      const y = oy + r * stepY * scale;
      const page = byPos.get(`${r}:${c}`);
      const label = `${rowLetters(r)}${c + 1}`;
      const fs = Math.max(3, Math.min(9, Math.min(cw, ch) * 0.22));
      if (page) {
        const vw = c === cols - 1 ? area.w : stepX;
        const vh = r === rows - 1 ? area.h : stepY;
        cells.push(
          `<svg class="amap-thumb" x="${f(x)}" y="${f(y)}" width="${f(cw)}" height="${f(ch)}" viewBox="${f(area.x)} ${f(area.y)} ${f(vw)} ${f(vh)}" preserveAspectRatio="none">` +
            innerWithPrefixedIds(pages[page.index]!, `map-${label}-`) +
            `</svg>`,
          `<rect x="${f(x)}" y="${f(y)}" width="${f(cw)}" height="${f(ch)}" fill="none" stroke="#1b1a17" stroke-width="0.35"/>`,
          `<text x="${f(x + cw / 2)}" y="${f(y + ch / 2 + fs * 0.35)}" font-size="${f(fs)}" text-anchor="middle" font-weight="700" fill="#a34a28" fill-opacity="0.85" font-family="Helvetica,Arial,sans-serif">${label}</text>`,
          `<text x="${f(x + 1.2)}" y="${f(y + Math.max(2.6, fs * 0.45))}" font-size="${f(Math.max(2.2, fs * 0.38))}" fill="#4a463f" font-family="Helvetica,Arial,sans-serif">p.${page.index + 1}</text>`,
        );
      } else {
        cells.push(
          `<rect x="${f(x)}" y="${f(y)}" width="${f(cw)}" height="${f(ch)}" fill="#e5e1d8" stroke="#b9b2a5" stroke-width="0.3" stroke-dasharray="1.2 1"/>`,
          `<text x="${f(x + cw / 2)}" y="${f(y + ch / 2)}" font-size="${f(Math.max(2.4, fs * 0.5))}" text-anchor="middle" fill="#7a7468" font-family="Helvetica,Arial,sans-serif">${label}</text>`,
          // "skipped" only where it fits (about 0.55 em per character).
          cw >= Math.max(2, fs * 0.36) * 0.55 * 9
            ? `<text x="${f(x + cw / 2)}" y="${f(y + ch / 2 + Math.max(2.6, fs * 0.5))}" font-size="${f(Math.max(2, fs * 0.36))}" text-anchor="middle" fill="#7a7468" font-family="Helvetica,Arial,sans-serif">skipped</text>`
            : '',
        );
      }
    }
  }
  let ty = oy + totalH * scale + 9;
  const steps: string[] = [];
  for (const lines of stepLines) {
    for (const line of lines) {
      steps.push(`<text x="${margin}" y="${f(ty)}" font-size="3.4" fill="#1b1a17" font-family="Helvetica,Arial,sans-serif">${esc(line)}</text>`);
      ty += fontLine;
    }
    ty += 1.6;
  }
  const printed = grid.pages.length;
  const skipped = rows * cols - printed;
  // The pages' own pattern styles (once), then thumbnail overrides.
  const pageStyle = /<style>([\s\S]*?)<\/style>/.exec(pages[0] ?? '')?.[1] ?? '';
  const style =
    `<style>${pageStyle}.amap-thumb text,.amap-thumb .seam,.amap-thumb .grain,.amap-thumb .grainhead,.amap-thumb .notch,.amap-thumb .foldtxt,.amap-thumb .edge,.amap-thumb .lbl{display:none}` +
    `.amap-thumb .cut,.amap-thumb .fold,.amap-thumb .dart{vector-effect:non-scaling-stroke;stroke-width:0.6px}</style>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">` +
    `<title>${esc(pkg.name)} – assembly map</title>${style}` +
    `<rect width="${w}" height="${h}" fill="#ffffff"/>` +
    `<g font-family="Helvetica,Arial,sans-serif">` +
    `<text x="${margin}" y="18" font-size="7" fill="#111">How the pages fit together</text>` +
    `<text x="${margin}" y="26" font-size="3.6" fill="#333">${esc(pkg.name)} · ${printed} ${paper} page${printed === 1 ? '' : 's'} to print on a ${rows} × ${cols} grid${skipped ? ` (${skipped} blank position${skipped === 1 ? '' : 's'} skipped)` : ''}.</text>` +
    `<text x="${margin}" y="32" font-size="3.2" fill="#555">Each square is one printed page; p.N is its number in the print file.</text>` +
    `</g>` +
    cells.join('') +
    steps.join('') +
    `</svg>`
  );
}
