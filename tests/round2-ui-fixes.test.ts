import { describe, expect, it } from 'vitest';
import { createAgentAPI } from '../src/console/api';
import { runCommand } from '../src/console/commands';
import { pickPresets, suitabilityWarnings } from '../src/console/picks';
import { createAppStore, hasOwnWork } from '../src/console/store';
import { GARMENTS, STYLES } from '../src/core/presets';
import { design } from '../src/core/design';
import { renderInstructionsMarkdown } from '../src/core/instructions';
import type { Occasion } from '../src/core/types';
import { bomTotals, fabricToBuy, groupBom } from '../src/ui/bom';
import { printSheetsNote } from '../src/console/assembly';
import { printableHtml } from '../src/console/exports';

const M = { heightCm: 168, bustCm: 90, waistCm: 72, hipCm: 98 };

describe('picks respect a chosen cloth', () => {
  it('picks a style whose own cloths include the chosen one, and gives no cloth reason', () => {
    const pick = pickPresets({ garment: 'shell-top', materialId: 'silk-crepe-de-chine' });
    expect(pick.materialId).toBe('silk-crepe-de-chine');
    expect(STYLES.find((s) => s.id === pick.styleId)!.recommendedMaterials).toContain('silk-crepe-de-chine');
    expect(pick.reasons).toHaveLength(1);
    expect(pick.reasons[0]).toMatch(/was chosen for the shell top/);
    expect(pick.reasons.join(' ')).not.toMatch(/linen/i);
  });

  it('gives no reasons when nothing was picked', () => {
    expect(pickPresets({ garment: 'shell-top', styleId: 'parisian-chic', materialId: 'cotton-poplin' }).reasons).toEqual([]);
  });

  it('rejects an unknown cloth id with the valid ids', () => {
    expect(() => pickPresets({ garment: 'shell-top', materialId: 'nope' })).toThrow(/Valid: .*silk-crepe-de-chine/);
  });
});

describe('suitability of explicit choices', () => {
  it('warns about a day cotton ball gown and names couture alternatives', () => {
    const r = createAgentAPI(createAppStore()).design({ measurements: M, garment: 'ball-gown', styleId: 'parisian-chic', materialId: 'cotton-poplin' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.data.warnings.join(' ');
    expect(w).toMatch(/Cotton poplin is an unusual choice for a ball gown/);
    expect(w).toMatch(/silk-/);
  });

  it('warns about a lining cloth used as the outer fabric and an everyday style for evening wear', () => {
    const w = suitabilityWarnings({ garment: 'ball-gown', styleId: 'nordic-hygge', materialId: 'cupro-lining' });
    expect(w.some((x) => /lining cloth/.test(x))).toBe(true);
    expect(w.some((x) => /Nordic hygge/.test(x) && /evening wear/.test(x))).toBe(true);
  });

  it('never warns about a combination the automatic picks make', () => {
    for (const g of GARMENTS) {
      for (const occasion of [null, ...g.occasions] as Array<Occasion | null>) {
        const p = pickPresets({ garment: g.id, occasion, measurements: M });
        expect(suitabilityWarnings({ garment: g.id, styleId: p.styleId, materialId: p.materialId, occasion }), `${g.id}/${occasion}`).toEqual([]);
      }
    }
  });

  it('the default starting design carries no warnings', () => {
    const store = createAppStore();
    const r = store.getState().runDesign();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(suitabilityWarnings({ garment: r.pkg.garment.id, styleId: r.pkg.style.id, materialId: r.pkg.material.id })).toEqual([]);
  });
});

describe('design() auto-picks like the console and CLI', () => {
  it('fills styleId and materialId and reports them in data.picks', () => {
    const r = createAgentAPI(createAppStore()).design({ measurements: M, garment: 'wrap-dress' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.picks?.filled).toEqual(['styleId', 'materialId']);
    expect(r.data.style).toBe(r.data.picks?.styleId);
    expect(r.data.material).toBe(r.data.picks?.materialId);
    expect(r.data.picks?.reasons.length).toBe(2);
  });

  it('keeps a given cloth and picks the occasion of an evening-only garment', () => {
    const r = createAgentAPI(createAppStore()).design({ measurements: M, garment: 'ball-gown', materialId: 'silk-organza' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.material).toBe('silk-organza');
    expect(r.data.picks?.filled).toEqual(['styleId', 'occasion']);
    expect(r.data.warnings).toEqual([]);
  });

  it('the json command auto-picks too', async () => {
    const store = createAppStore();
    const r = await runCommand(`json ${JSON.stringify({ measurements: M, garment: 'shift-dress' })}`, { store });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Picked: /);
  });

  it('still names the field when the garment is missing', () => {
    const r = createAgentAPI(createAppStore()).design({ measurements: M });
    expect(r.ok).toBe(false);
  });
});

describe('shopping-list totals', () => {
  const pkg = design({ measurements: M, garment: 'a-line-skirt', styleId: 'parisian-chic', materialId: 'cotton-poplin' });

  it('separates materials from tools and matches the booklet', () => {
    const t = bomTotals(pkg.bom);
    const all = pkg.bom.reduce((s, b) => s + (b.estCostEur ?? 0), 0);
    expect(t.materialsEur).toBeLessThan(all);
    expect(t.materialsEur + t.essentialToolsEur + t.optionalToolsEur).toBeCloseTo(all, 6);
    const md = renderInstructionsMarkdown(pkg);
    const m = /Materials total \(est\.\): €?\s?([\d.,]+)/.exec(md);
    expect(m).not.toBeNull();
    expect(Math.round(Number(m![1]!.replace(',', '')))).toBe(Math.round(t.materialsEur));
  });

  it('groups keep the original bom indices', () => {
    const g = groupBom(pkg.bom);
    expect(g.materials.length + g.tools.length).toBe(pkg.bom.length);
    for (const { item, index } of [...g.materials, ...g.tools]) expect(pkg.bom[index]).toBe(item);
    expect(g.tools.every(({ item }) => item.kind === 'tool')).toBe(true);
  });

  it('fabric to buy is the shopping-list quantity, not the layout length', () => {
    const f = fabricToBuy(pkg)!;
    expect(f.buyM).toBe(pkg.bom.find((b) => b.kind === 'fabric')!.quantity);
    expect(f.layoutM).toBeCloseTo(pkg.layouts.find((l) => l.layer === 'self')!.lengthCm / 100, 6);
    expect(f.buyM).toBeGreaterThanOrEqual(f.layoutM!);
  });
});

describe('printing guidance', () => {
  const pkg = design({ measurements: M, garment: 'a-line-skirt', styleId: 'parisian-chic', materialId: 'cotton-poplin' });

  it('names the paper, counts the assembly map and warns against the other size', () => {
    expect(printSheetsNote(18, 'letter')).toMatch(/^19 sheets of US Letter paper: sheet 1 is the assembly map/);
    expect(printSheetsNote(18, 'letter')).toMatch(/for A4 paper, choose A4/);
    const html = printableHtml(pkg, 'letter');
    expect(html).toMatch(/sheets of US Letter paper/);
    expect(html).toMatch(/LEFT and TOP/);
  });
});

describe('snapshot / restore (undo for #cmd= links)', () => {
  it('restores measurements, choices and the design after a reset', () => {
    const store = createAppStore();
    store.getState().setMeasurements({ bustCm: 101 });
    store.getState().select({ garment: 'wrap-dress' });
    store.getState().runDesign();
    const snap = store.getState().snapshot();
    expect(hasOwnWork(snap)).toBe(true);
    const id = store.getState().pkg!.id;
    store.getState().reset();
    expect(store.getState().measurements.bustCm).toBe(90);
    store.getState().restore(snap);
    expect(store.getState().measurements.bustCm).toBe(101);
    expect(store.getState().selection.garment).toBe('wrap-dress');
    expect(store.getState().pkg?.id).toBe(id);
  });

  it('a fresh visitor has no own work to protect', () => {
    expect(hasOwnWork(createAppStore().getState().snapshot())).toBe(false);
  });
});
