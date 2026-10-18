import { describe, expect, it } from 'vitest';
import { buildBom, buildInstructions, renderInstructionsMarkdown } from '../src/core/instructions';
import { JARGON, scoreInstructions } from '../eval/metrics';
import { ALL_GARMENTS, designFor, expectAspectsPass, failuresIn } from './helpers';

const PHASES = ['prepare', 'cut', 'mark', 'construct', 'fit', 'finish', 'press'];

describe.each(ALL_GARMENTS)('%s instructions', (g) => {
  it('cover every seam and every piece, with a complete beginner glossary', () => {
    for (const key of ['eu', 'scandi'] as const) {
      const pkg = designFor(g, 'hourglass-38', key);
      const r = scoreInstructions(pkg);
      expectAspectsPass(r, ['steps', 'coverage', 'glossary', 'checkpoints', 'material', 'effort', 'markdown'], `${g}/${key}`);
      const seamIds = new Set(pkg.instructions.flatMap((s) => s.seamIds));
      for (const s of pkg.seams) expect(seamIds.has(s.id), `seam ${s.id}`).toBe(true);
      const cut = new Set(pkg.instructions.filter((s) => s.phase === 'cut').flatMap((s) => s.pieceIds));
      for (const p of pkg.pieces) expect(cut.has(p.id), `piece ${p.id}`).toBe(true);
      for (const s of pkg.instructions) expect(PHASES).toContain(s.phase);
      const text = pkg.instructions.map((s) => `${s.title} ${s.body} ${s.tips.join(' ')} ${s.warnings.join(' ')}`).join(' ');
      for (const j of JARGON) {
        if (j.re.test(text)) expect(Object.keys(pkg.glossary).some((k) => j.re.test(k)), `glossary lacks "${j.term}"`).toBe(true);
      }
    }
  });

  it('run prepare → cut → mark → construct, try on during construction and end with finishing', () => {
    const pkg = designFor(g, 'hourglass-38', 'eu');
    const phaseProblems = failuresIn(scoreInstructions(pkg), ['order']).filter((d) => !d.includes('out of assembly order'));
    expect(phaseProblems).toEqual([]);
  });

  it('sew seams in ascending assembly stage (ARCHITECTURE: "ordered by seam.stage")', () => {
    const pkg = designFor(g, 'hourglass-38', 'eu');
    const stageProblems = failuresIn(scoreInstructions(pkg), ['order']).filter((d) => d.includes('out of assembly order'));
    expect(stageProblems).toEqual([]);
  });

  it('are regenerated identically from the same context', () => {
    const pkg = designFor(g, 'hourglass-38', 'eu');
    const ctx = {
      garment: pkg.garment,
      style: pkg.style,
      material: pkg.material,
      measurements: pkg.measurements,
      body: pkg.body,
      fit: pkg.fit,
      pieces: pkg.pieces,
      seams: pkg.seams,
      layouts: pkg.layouts,
    };
    const again = buildInstructions(ctx);
    expect(again.instructions).toEqual(pkg.instructions);
    expect(again.glossary).toEqual(pkg.glossary);
    expect(buildBom(ctx)).toEqual(pkg.bom);
  });
});

describe('markdown export', () => {
  it('contains every step, the bill of materials and the glossary', () => {
    const pkg = designFor('sheath-dress', 'pear-44', 'eu');
    const md = renderInstructionsMarkdown(pkg);
    for (const s of pkg.instructions) expect(md).toContain(s.title);
    for (const b of pkg.bom.filter((x) => x.essential)) expect(md).toContain(b.name);
    const terms = Object.keys(pkg.glossary);
    expect(terms.filter((t) => md.toLowerCase().includes(t.toLowerCase())).length).toBe(terms.length);
  });
});

describe('bill of materials', () => {
  it.each(ALL_GARMENTS)('%s: buys enough fabric for the layout including shrinkage and lists the notions', (g) => {
    const pkg = designFor(g, 'round-54', 'eu');
    const self = pkg.layouts.find((l) => l.layer === 'self')!;
    const fabric = pkg.bom.filter((b) => b.kind === 'fabric').reduce((s, b) => s + (b.unit === 'cm' ? b.quantity / 100 : b.quantity), 0);
    expect(fabric * 100).toBeGreaterThanOrEqual(self.lengthCm * (1 + pkg.material.shrinkagePct / 100) - 0.5);
    expect(pkg.bom.some((b) => b.kind === 'thread')).toBe(true);
    if (pkg.seams.some((s) => s.type === 'zip-invisible' || s.type === 'zip-lapped')) {
      expect(pkg.bom.some((b) => b.kind === 'notion' && /zip/i.test(`${b.name} ${b.spec ?? ''}`))).toBe(true);
    }
    for (const b of pkg.bom) {
      expect(b.quantity).toBeGreaterThan(0);
      expect(b.name.length).toBeGreaterThan(2);
    }
  });
});
