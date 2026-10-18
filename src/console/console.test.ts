import { describe, expect, it } from 'vitest';
import { createAgentAPI } from './api';
import { executeScript, splitCommands, tokenize } from './commands';
import { createAppStore } from './store';
import { parseLength, resolveMeasurementKey } from './units';

const REQ = {
  measurements: { heightCm: 166, bustCm: 90, waistCm: 72, hipCm: 99 },
  garment: 'a-line-skirt',
  styleId: 'parisian-chic',
  materialId: 'wool-crepe',
};

describe('parsing', () => {
  it('splits scripts on ; but not inside JSON or quotes', () => {
    expect(splitCommands('measure bust=90; json {"name":"a;b"}; set name="x;y"')).toEqual([
      'measure bust=90',
      'json {"name":"a;b"}',
      'set name="x;y"',
    ]);
  });
  it('tokenizes quotes', () => {
    expect(tokenize('set name="Summer skirt" garment=a-line-skirt')).toEqual(['set', 'name=Summer skirt', 'garment=a-line-skirt']);
  });
  it('parses lengths and measurement names', () => {
    expect(parseLength('36in')).toBeCloseTo(91.44);
    expect(parseLength('92')).toBe(92);
    expect(parseLength('abc')).toBeNull();
    expect(resolveMeasurementKey('bust')).toBe('bustCm');
    expect(resolveMeasurementKey('waist-to-floor')).toBe('waistToFloorCm');
  });
});

describe('commands', () => {
  it('drives the shared store end to end', async () => {
    const store = createAppStore();
    const results = await executeScript('measure height=166 bust=90 waist=72 hip=99; set garment=a-line-skirt style=parisian option.length=midi; design; show fit; export svg', { store });
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true, true]);
    const s = store.getState();
    expect(s.pkg?.garment.id).toBe('a-line-skirt');
    expect(s.selection.options.length).toBe('midi');
    expect(results[4]!.files?.[0]?.filename).toBe('pattern.svg');
    expect(s.lastResult?.command).toBe('export svg');
  });
  it('rejects options the garment does not offer', async () => {
    const store = createAppStore();
    const [r] = await executeScript('set garment=wrap-dress option.length=floor', { store });
    expect(r!.ok).toBe(false);
    expect(r!.message).toMatch(/offers length/);
  });
  it('never throws on bad input', async () => {
    const store = createAppStore();
    const rs = await executeScript('frobnicate; ', { store, }, { stopOnError: false });
    expect(rs[0]!.ok).toBe(false);
    const [j] = await executeScript('json {not json}', { store });
    expect(j!.ok).toBe(false);
  });
});

describe('agent API', () => {
  it('designs from JSON and exports', () => {
    const api = createAgentAPI();
    const r = api.design(JSON.stringify(REQ));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const again = createAgentAPI().design(REQ);
    expect(again.ok && again.data.id).toBe(r.data.id);
    const svg = api.exportSVG('pattern');
    expect(svg.ok && typeof svg.data === 'string' && svg.data.startsWith('<svg')).toBe(true);
    const pages = api.exportSVG('print', { paper: 'letter' });
    expect(pages.ok && Array.isArray(pages.data) && pages.data.length > 0).toBe(true);
    expect(api.getState().ok).toBe(true);
  });
  it('returns structured errors', () => {
    const api = createAgentAPI();
    const r = api.design({ garment: 'a-line-skirt' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues?.length).toBeGreaterThan(0);
    expect(api.exportMarkdown().ok).toBe(false);
    const s = api.schema();
    expect(s.ok && (s.data as { type?: string }).type).toBe('object');
  });
});
