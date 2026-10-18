/**
 * Agent-facing behaviour: automatic style/cloth picks, option substitutions,
 * run() failure reporting and the print assembly map.
 */
import { describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { createAgentAPI } from '../src/console/api';
import { readPageGrid, renderAssemblyMapSVG } from '../src/console/assembly';
import { runCommand } from '../src/console/commands';
import { printPageFiles, printableHtml } from '../src/console/exports';
import { pickPresets, rankMaterials } from '../src/console/picks';
import { createAppStore } from '../src/console/store';
import { design } from '../src/core/design';
import { MATERIALS, STYLES } from '../src/core/presets';
import { renderTiledPrintPages } from '../src/core/svg';

const BODY = { heightCm: 180, bustCm: 88, waistCm: 72, hipCm: 90 };

describe('automatic picks', () => {
  it('never dresses a runway ball gown in a day cloth', () => {
    const pick = pickPresets({ garment: 'ball-gown', occasion: 'runway', measurements: BODY });
    const m = MATERIALS.find((x) => x.id === pick.materialId)!;
    const s = STYLES.find((x) => x.id === pick.styleId)!;
    expect(m.occasions).toContain('runway');
    expect(m.suitableFor).toContain('ball-gown');
    expect(s.occasions).toContain('runway');
    expect(s.recommendedMaterials).toContain(m.id);
  });

  it('infers evening for a ball gown when no occasion is given', () => {
    const pick = pickPresets({ garment: 'ball-gown', measurements: BODY });
    expect(pick.occasion).toBe('evening');
    expect(MATERIALS.find((x) => x.id === pick.materialId)!.occasions).toContain('evening');
  });

  it('respects region and keeps an explicit style', () => {
    expect(STYLES.find((s) => s.id === pickPresets({ garment: 'ball-gown', occasion: 'evening', region: 'scandinavian' }).styleId)!.region).toBe('scandinavian');
    expect(pickPresets({ garment: 'shift-dress', styleId: 'stockholm-minimal' }).styleId).toBe('stockholm-minimal');
  });

  it('filters cloths to the garment and occasion', () => {
    for (const m of rankMaterials({ garment: 'column-gown', occasion: 'runway', styleId: 'scandi-evening' })) {
      expect(m.suitableFor).toContain('column-gown');
      expect(m.occasions).toContain('runway');
    }
  });

  it('`set garment=ball-gown occasion=runway` swaps an unsuitable style and cloth, and says so', async () => {
    const store = createAppStore();
    const r = await runCommand('set garment=ball-gown occasion=runway', { store });
    expect(r.ok).toBe(true);
    const sel = store.getState().selection;
    expect(MATERIALS.find((m) => m.id === sel.materialId)!.occasions).toContain('runway');
    expect(STYLES.find((s) => s.id === sel.styleId)!.occasions).toContain('runway');
    expect((r.data as { notes: string[] }).notes.length).toBeGreaterThan(0);
  });

  it('keeps a cloth the user chose in the same command', async () => {
    const store = createAppStore();
    await runCommand('set garment=ball-gown material=silk-organza', { store });
    expect(store.getState().selection.materialId).toBe('silk-organza');
  });
});

describe('option substitutions', () => {
  const req = { measurements: { heightCm: 168, bustCm: 90, waistCm: 72, hipCm: 98 }, garment: 'a-line-skirt', styleId: 'parisian-chic', materialId: 'wool-crepe', options: { sleeve: 'long' } };

  it('design() reports replaced options in data.substitutions and warnings', () => {
    const r = createAgentAPI(createAppStore()).design(req);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.substitutions).toEqual([{ option: 'sleeve', requested: 'long', used: 'none', allowed: ['none'] }]);
    expect(r.data.warnings.some((w) => w.includes('sleeve'))).toBe(true);
  });

  it('design(req, {strict:true}) rejects them', () => {
    const r = createAgentAPI(createAppStore()).design(req, { strict: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues?.[0]?.path).toBe('options.sleeve');
  });

  it('console errors list the garment values, not the global enum', async () => {
    const store = createAppStore();
    await runCommand('set garment=pencil-skirt', { store });
    const r = await runCommand('set option.length=floor', { store });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Pencil skirt offers length: /);
    expect(r.message).not.toMatch(/mini, above-knee, knee, midi, ankle, floor/);
  });
});

describe('run()', () => {
  it('returns ok:false with the failing command when any command fails', async () => {
    const api = createAgentAPI(createAppStore());
    const r = await api.run('set garment=zzz; show summary');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failedAt).toBe(0);
    expect(r.command).toBe('set garment=zzz');
    expect(r.error).toMatch(/Unknown garment/);
    expect(r.data).toHaveLength(1);
  });

  it('returns ok:true when everything succeeds', async () => {
    const r = await createAgentAPI(createAppStore()).run('reset; measure height=168 bust=92 waist=74 hip=100; design');
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(3);
  });
});

describe('print assembly map', () => {
  const pkg = design({ measurements: { heightCm: 168, bustCm: 92, waistCm: 74, hipCm: 100 }, garment: 'wrap-dress', styleId: 'stockholm-minimal', materialId: 'lyocell-twill' });

  it('recovers the page grid and draws every grid position', () => {
    const pages = renderTiledPrintPages(pkg, { paper: 'A4' });
    const grid = readPageGrid(pages, 'A4');
    expect(grid.pages).toHaveLength(pages.length);
    expect(grid.rows * grid.cols).toBeGreaterThanOrEqual(pages.length);
    expect(grid.overlap).toBeGreaterThan(0);
    const svg = renderAssemblyMapSVG(pkg, pages, 'A4');
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.getElementsByTagName('parsererror').length).toBe(0);
    for (const p of grid.pages) expect(svg).toContain(`>${p.label}</text>`);
    expect(svg).toMatch(/Trim the white margin off the LEFT and TOP edge/);
  });

  it('is part of the print exports and the printable HTML', () => {
    expect(printPageFiles(pkg, 'letter').some((f) => f.filename === 'print-letter-assembly-map.svg')).toBe(true);
    const html = printableHtml(pkg, 'A4');
    expect(html).toContain('How the pages fit together');
    expect(html).not.toContain('trim along the dashed overlap lines');
  });
});
