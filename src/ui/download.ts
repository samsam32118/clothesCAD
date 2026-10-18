/** Browser-side delivery of exported files. */
import type { ExportFile } from '../console/types';
import { slugify } from '../console/exports';
import type { DesignPackage } from '../core/types';

/** Prefix canonical names ("pattern.svg") with the design so downloads stay organised. */
export function downloadName(pkg: Pick<DesignPackage, 'name'> | null, filename: string): string {
  if (!pkg || filename.startsWith('clothescad-')) return filename;
  return `clothescad-${slugify(pkg.name)}-${filename}`;
}

export function downloadFile(file: ExportFile, pkg: Pick<DesignPackage, 'name'> | null = null): void {
  const part: BlobPart = typeof file.data === 'string' ? file.data : (file.data.slice().buffer as ArrayBuffer);
  const blob = new Blob([part], { type: file.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = downloadName(pkg, file.filename);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before revoking.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Sequential downloads with a short gap (browsers throttle bursts). */
export async function downloadFiles(files: ExportFile[], pkg: Pick<DesignPackage, 'name'> | null = null): Promise<void> {
  for (const f of files) {
    downloadFile(f, pkg);
    await new Promise((r) => window.setTimeout(r, 250));
  }
}

/**
 * Open self-contained HTML in a new window (printable pattern). Falls back to
 * a download when pop-ups are blocked. Returns true when a window opened.
 */
export function openHtmlWindow(html: string, fallbackName: string): boolean {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank', 'noopener');
  window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
  if (win) return true;
  downloadFile({ filename: fallbackName, mime: 'text/html', data: html });
  return false;
}
