/**
 * PDF output built with jspdf (+ svg2pdf.js for vector pattern pages).
 * Loaded lazily from the Pattern and Make tabs so neither library is in the
 * main bundle.
 *
 * - buildPatternPdf: assembly map + 1:1 tiled pattern pages, each at exact
 *   paper size (mm) so printing at 100 % is 1:1.
 * - buildBookletPdf: the beginner sewing booklet (shopping list, fabric
 *   handling, fit rationale, every step with tips and checkpoints, glossary).
 */
import type { jsPDF as JsPDF } from 'jspdf';
import type { DesignPackage, InstructionStep } from '../core/types';
import { renderTiledPrintPages } from '../core/svg';
import { renderAssemblyMapSVG } from '../console/assembly';
import { PAPER_MM, slugify, type Paper } from '../console/exports';
import { formatMinutes } from '../console/summary';
import type { ExportFile } from '../console/types';
import { parseStepBody } from './stepBody';

function parseSvg(markup: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error(`Print page SVG is not well-formed: ${err.textContent ?? ''}`);
  return doc.documentElement as unknown as SVGSVGElement;
}

/** One PDF page per tiled sheet (after an assembly map), each at exact paper size (mm). */
export async function buildPatternPdf(pkg: DesignPackage, paper: Paper): Promise<ExportFile> {
  const [{ jsPDF }, { svg2pdf }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
  const { w, h } = PAPER_MM[paper];
  const format = paper === 'A4' ? 'a4' : 'letter';
  const pages = renderTiledPrintPages(pkg, { paper });
  const sheets = [renderAssemblyMapSVG(pkg, pages, paper), ...pages];
  const doc = new jsPDF({ unit: 'mm', format, orientation: 'portrait', compress: true });
  doc.setProperties({ title: `${pkg.name} - ${paper} print pattern`, creator: 'clothesCAD', subject: 'Print at 100 % (actual size)' });
  // svg2pdf needs the elements attached to the document to resolve styles.
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;';
  document.body.appendChild(host);
  try {
    for (let i = 0; i < sheets.length; i++) {
      if (i > 0) doc.addPage(format, 'portrait');
      const el = parseSvg(sheets[i]!);
      host.replaceChildren(el);
      await svg2pdf(el, doc, { x: 0, y: 0, width: w, height: h });
    }
  } finally {
    host.remove();
  }
  const bytes = new Uint8Array(doc.output('arraybuffer'));
  return { filename: `clothescad-${slugify(pkg.name)}-print-${paper}.pdf`, mime: 'application/pdf', data: bytes };
}

// ---------------------------------------------------------------------------
// Booklet
// ---------------------------------------------------------------------------

/** jsPDF's built-in fonts use WinAnsi; map the few symbols outside it to plain text. */
const SYMBOLS: Record<string, string> = {
  '≈': '~',
  '→': '->',
  '←': '<-',
  '↑': '^',
  '↓': 'v',
  '≤': '<=',
  '≥': '>=',
  '✓': '(ok)',
  '✔': '(ok)',
  '✗': 'x',
  '−': '-',
  '¾': '3/4',
  '½': '1/2',
  '¼': '1/4',
  '′': "'",
  '″': '"',
};
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

export function pdfSafe(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const code = ch.codePointAt(0) ?? 0;
    if (SYMBOLS[ch] !== undefined) out += SYMBOLS[ch];
    else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(ch) || ch === '\n') out += ch;
    else if (/\s/.test(ch)) out += ' ';
    else out += ch.normalize('NFKD').replace(/[^\x20-\x7e]/g, '') || '?';
  }
  return out;
}

const PHASE: Record<InstructionStep['phase'], string> = {
  prepare: 'Prepare',
  cut: 'Cut',
  mark: 'Mark',
  construct: 'Sew',
  fit: 'Fit',
  finish: 'Finish',
  press: 'Press',
};

/** A tiny flowing-text layout engine on top of jsPDF (mm units, A4/letter portrait). */
class Flow {
  private y: number;
  readonly left = 18;
  readonly right: number;
  readonly bottom: number;
  constructor(
    private readonly doc: JsPDF,
    private readonly format: 'a4' | 'letter',
    w: number,
    h: number,
  ) {
    this.right = w - 18;
    this.bottom = h - 18;
    this.y = 20;
  }
  get width(): number {
    return this.right - this.left;
  }
  newPage(): void {
    this.doc.addPage(this.format, 'portrait');
    this.y = 20;
  }
  ensure(space: number): void {
    if (this.y + space > this.bottom) this.newPage();
  }
  gap(mm: number): void {
    this.y += mm;
  }
  text(text: string, o: { size?: number; bold?: boolean; italic?: boolean; indent?: number; color?: [number, number, number]; bullet?: string; keepWithNext?: number } = {}): void {
    const size = o.size ?? 10.5;
    const indent = o.indent ?? 0;
    const style = o.bold && o.italic ? 'bolditalic' : o.bold ? 'bold' : o.italic ? 'italic' : 'normal';
    this.doc.setFont('helvetica', style);
    this.doc.setFontSize(size);
    this.doc.setTextColor(...(o.color ?? [27, 26, 23]));
    const lineH = size * 0.3528 * 1.35; // pt -> mm, with leading
    const lines = this.doc.splitTextToSize(pdfSafe(text), this.width - indent) as string[];
    this.ensure(lineH * Math.min(lines.length, 2) + (o.keepWithNext ?? 0));
    lines.forEach((line, i) => {
      this.ensure(lineH);
      if (i === 0 && o.bullet) this.doc.text(pdfSafe(o.bullet), this.left + indent - 4.5, this.y + lineH * 0.75);
      this.doc.text(line, this.left + indent, this.y + lineH * 0.75);
      this.y += lineH;
    });
  }
  rule(): void {
    this.ensure(4);
    this.doc.setDrawColor(221, 213, 198);
    this.doc.setLineWidth(0.3);
    this.doc.line(this.left, this.y + 1.5, this.right, this.y + 1.5);
    this.y += 4;
  }
}

/** The complete beginner booklet as a PDF (text only, prints on any printer). */
export async function buildBookletPdf(pkg: DesignPackage, paper: Paper = 'A4'): Promise<ExportFile> {
  const { jsPDF } = await import('jspdf');
  const { w, h } = PAPER_MM[paper];
  const format = paper === 'A4' ? 'a4' : 'letter';
  const doc = new jsPDF({ unit: 'mm', format, orientation: 'portrait', compress: true });
  doc.setProperties({ title: `${pkg.name} - sewing booklet`, creator: 'clothesCAD', subject: `${pkg.garment.name} instructions` });
  const flow = new Flow(doc, format, w, h);
  const accent: [number, number, number] = [163, 74, 40];
  const muted: [number, number, number] = [122, 116, 104];

  flow.text('clothesCAD sewing booklet', { size: 9, bold: true, color: accent });
  flow.text(pkg.name, { size: 22, bold: true });
  flow.text(`${pkg.garment.name} · ${pkg.style.name} · ${pkg.material.name}`, { size: 11, color: muted });
  flow.text(
    `${pkg.instructions.length} steps · about ${formatMinutes(pkg.effort.minutes)} · difficulty ${pkg.effort.difficulty}/5 · ${pkg.fit.fit} fit`,
    { size: 11, color: muted },
  );
  flow.gap(4);

  flow.text('Why it flatters you', { size: 14, bold: true, keepWithNext: 10 });
  for (const r of pkg.fit.rationale) flow.text(r, { indent: 5, bullet: '•' });
  flow.gap(3);

  flow.text('Shopping list', { size: 14, bold: true, keepWithNext: 10 });
  for (const b of pkg.bom) {
    const qty = `${Number.isInteger(b.quantity) ? b.quantity : b.quantity.toFixed(2)} ${b.unit}`;
    flow.text(`${b.name} - ${qty}${b.essential ? '' : ' (optional)'}${b.spec ? `. ${b.spec}` : ''}`, { indent: 7.5, bullet: '[  ]' });
  }
  flow.gap(3);

  const hd = pkg.material.handling;
  flow.text(`Working with ${pkg.material.name.toLowerCase()}`, { size: 14, bold: true, keepWithNext: 10 });
  for (const [k, v] of [
    ['Before cutting', hd.preTreatment],
    ['Needle', hd.needle],
    ['Thread', hd.thread],
    ['Stitch length', `${hd.stitchLengthMm} mm`],
    ['Pressing', hd.pressing],
    ['Interfacing', hd.interfacing],
    ['Seam finish', hd.seamFinish],
    ['Cutting', hd.cuttingTips],
  ] as const) {
    flow.text(`${k}: ${v}`, { indent: 5, bullet: '•' });
  }

  let phase: InstructionStep['phase'] | null = null;
  flow.newPage();
  flow.text('Step by step', { size: 18, bold: true });
  flow.text('Tick each box as you finish a step. Words in the glossary at the end are explained in plain language.', { size: 10, color: muted });
  for (const step of pkg.instructions) {
    if (step.phase !== phase) {
      phase = step.phase;
      flow.gap(3);
      flow.text(PHASE[step.phase].toUpperCase(), { size: 9, bold: true, color: accent, keepWithNext: 16 });
    }
    flow.rule();
    flow.text(`${step.n}. ${step.title}`, { size: 12.5, bold: true, keepWithNext: 10 });
    flow.text(`[  ] done   ·   about ${formatMinutes(step.minutes)}`, { size: 9, color: muted });
    flow.gap(1);
    for (const block of parseStepBody(step.body)) {
      if (block.kind === 'p') flow.text(block.text);
      else if (block.kind === 'ul') for (const item of block.items) flow.text(item, { indent: 6, bullet: '•' });
      else block.items.forEach((item, i) => flow.text(item, { indent: 7, bullet: `${block.start + i}.` }));
      flow.gap(1);
    }
    for (const t of step.tips) flow.text(`Tip: ${t}`, { italic: true, indent: 3, color: [74, 70, 63] });
    for (const wv of step.warnings) flow.text(`Careful: ${wv}`, { bold: true, indent: 3, color: [154, 106, 18] });
    if (step.checkpoint) flow.text(`Try-on checkpoint: ${step.checkpoint}`, { bold: true, indent: 3, color: [63, 107, 74] });
    flow.gap(2);
  }

  const terms = Object.entries(pkg.glossary).sort(([a], [b]) => a.localeCompare(b));
  if (terms.length) {
    flow.newPage();
    flow.text('Glossary', { size: 18, bold: true });
    flow.gap(2);
    for (const [term, def] of terms) {
      flow.text(term.charAt(0).toUpperCase() + term.slice(1), { bold: true, keepWithNext: 5 });
      flow.text(def, { indent: 4 });
      flow.gap(1.5);
    }
  }

  const pagesCount = doc.getNumberOfPages();
  for (let i = 1; i <= pagesCount; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...muted);
    doc.text(pdfSafe(`${pkg.name} · page ${i} of ${pagesCount}`), w / 2, h - 9, { align: 'center' });
  }
  const bytes = new Uint8Array(doc.output('arraybuffer'));
  return { filename: `clothescad-${slugify(pkg.name)}-booklet.pdf`, mime: 'application/pdf', data: bytes };
}
