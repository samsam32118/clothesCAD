/**
 * SVG/XML well-formedness and structure checks for the eval, built on
 * `@xmldom/xmldom` (pure JS, works in Node without a DOM).
 */
import { DOMParser } from '@xmldom/xmldom';

/** Minimal element surface we rely on (xmldom's DOM types vary by version). */
export interface XmlElement {
  tagName: string;
  getAttribute(name: string): string | null;
  childNodes: ArrayLike<{ nodeType: number }>;
  textContent: string | null;
}

export interface XmlParseResult {
  ok: boolean;
  errors: string[];
  root: XmlElement | null;
}

/** Parse an SVG/XML string; any warning, error or fatal error makes it invalid. */
export function parseXml(text: string): XmlParseResult {
  const errors: string[] = [];
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, errors: ['empty document'], root: null };
  let root: XmlElement | null = null;
  try {
    const doc = new DOMParser({
      onError: (level: string, msg: string) => {
        errors.push(`${level}: ${String(msg).split('\n')[0]}`);
      },
    }).parseFromString(text, 'image/svg+xml');
    root = (doc.documentElement as unknown as XmlElement | null) ?? null;
  } catch (err) {
    errors.push(err instanceof Error ? err.message.split('\n')[0] : String(err));
  }
  if (!root) errors.push('no root element');
  else if (root.tagName !== 'svg') errors.push(`root element is <${root.tagName}>, expected <svg>`);
  return { ok: errors.length === 0, errors, root };
}

/** Child elements (nodeType 1) of an element. */
export function childElements(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  const kids = el.childNodes;
  for (let i = 0; i < kids.length; i++) if (kids[i].nodeType === 1) out.push(kids[i] as unknown as XmlElement);
  return out;
}

/** Depth-first walk carrying the cumulative uniform scale of `transform` attributes. */
export function walk(el: XmlElement, visit: (el: XmlElement, scale: number) => void, scale = 1): void {
  const s = scale * transformScale(el.getAttribute('transform'));
  visit(el, s);
  for (const c of childElements(el)) walk(c, visit, s);
}

/**
 * Uniform scale factor of an SVG transform list. Supports translate, scale
 * (uniform or not: returns sqrt(|sx·sy|)), rotate and matrix.
 */
export function transformScale(transform: string | null): number {
  if (!transform) return 1;
  let s = 1;
  const re = /(matrix|scale|translate|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(transform))) {
    const args = m[2]
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (m[1] === 'scale') {
      const sx = args[0] ?? 1;
      const sy = args[1] ?? sx;
      s *= Math.sqrt(Math.abs(sx * sy));
    } else if (m[1] === 'matrix' && args.length === 6) {
      s *= Math.sqrt(Math.abs(args[0] * args[3] - args[1] * args[2]));
    }
  }
  return s;
}

/** Parse an SVG length in mm ("210mm", "8.5in", "297"), or NaN. */
export function lengthMm(v: string | null): number {
  if (!v) return NaN;
  const m = /^\s*([\d.]+)\s*(mm|cm|in|px)?\s*$/.exec(v);
  if (!m) return NaN;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'cm':
      return n * 10;
    case 'in':
      return n * 25.4;
    case 'px':
      return (n * 25.4) / 96;
    default:
      return n;
  }
}
