/**
 * Artifact builders shared by the console, agent API, UI and CLI.
 * Pure string/bytes producers: no DOM. Heavy pieces (three.js, fflate) are
 * loaded with dynamic imports so the web app's main bundle stays small.
 */
import { renderCuttingLayoutSVG, renderPatternSheetSVG, renderTiledPrintPages } from '../core/svg';
import { renderInstructionsMarkdown } from '../core/instructions';
import type { DesignPackage, FabricLayer } from '../core/types';
import type { ExportFile } from './types';
import { ASSEMBLY_STEPS, printSheetsNote, renderAssemblyMapSVG } from './assembly';

export type Paper = 'A4' | 'letter';

export const EXPORT_KINDS = ['svg', 'print', 'html', 'layout', 'md', 'json', 'glb', 'obj', 'zip', 'all'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export const EXPORT_DESCRIPTIONS: Record<ExportKind, string> = {
  svg: 'pattern.svg - every pattern piece on one sheet (cm units)',
  print: 'print-<paper>-page-N.svg - 1:1 tiled pages to print at 100 % and tape together, plus print-<paper>-assembly-map.svg',
  html: 'print-<paper>.html - assembly map + all tiled pages in one printable document',
  layout: 'layout-<layer>.svg - cutting layout per fabric layer',
  md: 'instructions.md - full illustrated-in-words sewing booklet',
  json: 'package.json - the complete DesignPackage',
  glb: 'model.glb - binary glTF 3D model of body + garment',
  obj: 'model.obj - Wavefront OBJ 3D model',
  zip: 'clothescad-<id>.zip - everything above in one archive',
  all: 'every individual file (what the CLI writes)',
};

export const PAPER_MM: Record<Paper, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  letter: { w: 215.9, h: 279.4 },
};

const SVG = 'image/svg+xml';

export function slugify(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'design'
  );
}

export function patternFile(pkg: DesignPackage): ExportFile {
  return { filename: 'pattern.svg', mime: SVG, data: renderPatternSheetSVG(pkg) };
}

export function layoutFiles(pkg: DesignPackage, layer?: FabricLayer): ExportFile[] {
  const layers = layer ? [layer] : pkg.layouts.map((l) => l.layer);
  return layers.map((l) => ({ filename: `layout-${l}.svg`, mime: SVG, data: renderCuttingLayoutSVG(pkg, l) }));
}

/** 1:1 tiled pages plus the assembly map that shows how they fit together. */
export function printPageFiles(pkg: DesignPackage, paper: Paper): ExportFile[] {
  const pages = renderTiledPrintPages(pkg, { paper });
  return [
    ...pages.map((svg, i) => ({ filename: `print-${paper}-page-${i + 1}.svg`, mime: SVG, data: svg })),
    { filename: `print-${paper}-assembly-map.svg`, mime: SVG, data: renderAssemblyMapSVG(pkg, pages, paper) },
  ];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * One self-contained HTML document holding every tiled page, sized so the
 * browser prints each SVG on its own sheet at exactly 100 %.
 */
export function printableHtml(pkg: DesignPackage, paper: Paper, pages = renderTiledPrintPages(pkg, { paper })): string {
  const { w, h } = PAPER_MM[paper];
  const title = `${pkg.name} - ${paper} print pattern`;
  const map = renderAssemblyMapSVG(pkg, pages, paper);
  const sheets = [
    `<section class="sheet" aria-label="Assembly map: how the ${pages.length} pages fit together">${map}</section>`,
    ...pages.map((svg, i) => `<section class="sheet" aria-label="Page ${i + 1} of ${pages.length}">${svg.replace(/^<\?xml[^>]*>/, '')}</section>`),
  ].join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
@page { size: ${w}mm ${h}mm; margin: 0; }
html, body { margin: 0; padding: 0; background: #e9e6df; font-family: system-ui, sans-serif; }
.note { max-width: 46rem; margin: 16px auto; padding: 16px; background: #fff; border-radius: 8px; line-height: 1.5; }
.note button { font: inherit; padding: 10px 18px; min-height: 44px; border-radius: 999px; border: 0; background: #1b1a17; color: #fff; cursor: pointer; }
.sheet { width: ${w}mm; height: ${h}mm; margin: 16px auto; background: #fff; box-shadow: 0 1px 6px rgba(0,0,0,.15); overflow: hidden; break-after: page; page-break-after: always; }
.sheet:last-child { break-after: auto; page-break-after: auto; }
.sheet > svg { display: block; width: ${w}mm; height: ${h}mm; }
@media print { body { background: #fff; } .note { display: none; } .sheet { margin: 0; box-shadow: none; } }
</style></head>
<body>
<div class="note">
<strong>${escapeHtml(pkg.name)}</strong> - ${escapeHtml(printSheetsNote(pages.length, paper))}
<ol>${ASSEMBLY_STEPS.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
<p><button type="button" onclick="window.print()">Print pages</button></p>
</div>
${sheets}
</body></html>`;
}

export function htmlFile(pkg: DesignPackage, paper: Paper): ExportFile {
  return { filename: `print-${paper}.html`, mime: 'text/html', data: printableHtml(pkg, paper) };
}

export function markdownFile(pkg: DesignPackage): ExportFile {
  return { filename: 'instructions.md', mime: 'text/markdown', data: renderInstructionsMarkdown(pkg) };
}

export function jsonFile(pkg: DesignPackage): ExportFile {
  return { filename: 'package.json', mime: 'application/json', data: JSON.stringify(pkg, null, 2) };
}

export async function objFile(pkg: DesignPackage): Promise<ExportFile> {
  const three = await import('../three');
  return { filename: 'model.obj', mime: 'model/obj', data: three.exportOBJ(pkg) };
}

export async function glbFile(pkg: DesignPackage): Promise<ExportFile> {
  const three = await import('../three');
  const buf = await three.exportGLB(pkg);
  return { filename: 'model.glb', mime: 'model/gltf-binary', data: new Uint8Array(buf) };
}

/** Every artifact as individual files (the CLI's output set). */
export async function allFiles(pkg: DesignPackage, paper: Paper = 'A4'): Promise<ExportFile[]> {
  const [obj, glb] = await Promise.all([objFile(pkg), glbFile(pkg)]);
  return [
    jsonFile(pkg),
    patternFile(pkg),
    ...layoutFiles(pkg),
    ...printPageFiles(pkg, paper),
    htmlFile(pkg, paper),
    markdownFile(pkg),
    obj,
    glb,
  ];
}

const encoder = new TextEncoder();

export function fileBytes(f: ExportFile): Uint8Array {
  return typeof f.data === 'string' ? encoder.encode(f.data) : f.data;
}

/** Zip a set of files with fflate (compressed, deterministic timestamps). */
export async function zipFiles(files: ExportFile[], name: string): Promise<ExportFile> {
  const { zipSync } = await import('fflate');
  const entries: Record<string, [Uint8Array, { level: 0 | 6; mtime: Date }]> = {};
  const mtime = new Date('2024-01-01T00:00:00Z');
  for (const f of files) {
    // GLB is already dense binary; store it, deflate the text formats.
    entries[f.filename] = [fileBytes(f), { level: f.filename.endsWith('.glb') ? 0 : 6, mtime }];
  }
  return { filename: name, mime: 'application/zip', data: zipSync(entries) };
}

export interface ExportOptions {
  paper?: Paper;
  layer?: FabricLayer;
}

/** Produce the files for one export kind. */
export async function buildExport(pkg: DesignPackage, kind: ExportKind, opts: ExportOptions = {}): Promise<ExportFile[]> {
  const paper = opts.paper ?? 'A4';
  switch (kind) {
    case 'svg':
      return [patternFile(pkg)];
    case 'print':
      return printPageFiles(pkg, paper);
    case 'html':
      return [htmlFile(pkg, paper)];
    case 'layout':
      return layoutFiles(pkg, opts.layer);
    case 'md':
      return [markdownFile(pkg)];
    case 'json':
      return [jsonFile(pkg)];
    case 'obj':
      return [await objFile(pkg)];
    case 'glb':
      return [await glbFile(pkg)];
    case 'all':
      return allFiles(pkg, paper);
    case 'zip':
      return [await zipFiles(await allFiles(pkg, paper), `clothescad-${slugify(pkg.name)}-${pkg.id}.zip`)];
  }
}

/** Base64 for binary payloads crossing a JSON boundary (agent API). */
export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}
