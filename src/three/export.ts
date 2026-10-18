/**
 * GLB / OBJ export of the posed mannequin + garment (metres, y up, +z front).
 * Works in the browser and in Node: GLTFExporter's binary path relies on
 * FileReader, which Node lacks, so a minimal Blob-backed FileReader is
 * installed on demand (only when the global is missing).
 */
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import type { FigureSource } from './garment';
import { buildFigureGroup, disposeObject } from './scene';

type ReaderTarget = { result: ArrayBuffer | string | null };

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Minimal FileReader for runtimes that have Blob but no FileReader (Node). */
class BlobFileReader implements ReaderTarget {
  result: ArrayBuffer | string | null = null;
  error: unknown = null;
  readyState = 0;
  onload: ((ev: { target: BlobFileReader }) => void) | null = null;
  onloadend: ((ev: { target: BlobFileReader }) => void) | null = null;
  onerror: ((ev: { target: BlobFileReader }) => void) | null = null;

  private finish(ok: boolean) {
    this.readyState = 2;
    const ev = { target: this };
    if (ok) this.onload?.(ev);
    else this.onerror?.(ev);
    this.onloadend?.(ev);
  }

  readAsArrayBuffer(blob: Blob): void {
    this.readyState = 1;
    blob.arrayBuffer().then(
      (buf) => {
        this.result = buf;
        this.finish(true);
      },
      (err: unknown) => {
        this.error = err;
        this.finish(false);
      },
    );
  }

  readAsDataURL(blob: Blob): void {
    this.readyState = 1;
    blob.arrayBuffer().then(
      (buf) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${bytesToBase64(new Uint8Array(buf))}`;
        this.finish(true);
      },
      (err: unknown) => {
        this.error = err;
        this.finish(false);
      },
    );
  }
}

function ensureFileReader(): void {
  const g = globalThis as unknown as { FileReader?: unknown; Blob?: unknown };
  if (typeof g.FileReader === 'undefined') {
    if (typeof g.Blob === 'undefined') {
      throw new Error('clothesCAD 3D: GLB export needs Blob support (Node >= 18 or a browser).');
    }
    g.FileReader = BlobFileReader;
  }
}

/** Binary glTF (GLB) of the dressed mannequin, in metres. */
export async function exportGLB(pkg: FigureSource): Promise<ArrayBuffer> {
  ensureFileReader();
  const { figure } = buildFigureGroup(pkg);
  try {
    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(figure, { binary: true, onlyVisible: true });
    if (!(result instanceof ArrayBuffer)) throw new Error('clothesCAD 3D: GLTFExporter did not return binary output');
    return result;
  } finally {
    disposeObject(figure);
  }
}

/** Wavefront OBJ (objects: body, garment-*) in metres. */
export function exportOBJ(pkg: FigureSource): string {
  const { figure } = buildFigureGroup(pkg);
  try {
    const body = new OBJExporter().parse(figure);
    const header = [
      '# clothesCAD export',
      `# design: ${pkg.name ?? pkg.id ?? 'untitled'}`,
      '# units: metres, +Y up, figure faces +Z, feet at Y = 0',
      '',
    ].join('\n');
    return header + body;
  } finally {
    disposeObject(figure);
  }
}
