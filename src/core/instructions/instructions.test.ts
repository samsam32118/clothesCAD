import { describe, expect, it } from 'vitest';
import type {
  BodyAnalysis, CuttingLayout, DesignPackage, FabricLayer, FitPlan, PatternPiece, PieceRole, ResolvedMeasurements, SeamSpec, Closure,
} from '../types';
import { getGarment, getMaterial, getStyle } from '../presets';
import { buildBom, buildInstructions, renderInstructionsMarkdown, type InstructionContext } from './index';
import { resolveSeamTypes } from '../drafting/seams';

function rect(id: string, role: PieceRole, name: string, w: number, h: number, edges: [string, string, string, string], o: Partial<PatternPiece> = {}, layer: FabricLayer = 'self'): PatternPiece {
  const sa = 1.5;
  const hem = 3;
  const kinds = edges.map((e) => (e === 'hem' ? 'hem' : e === 'cf' ? 'fold' : 'seam')) as Array<PatternPiece['edges'][number]['kind']>;
  const lens = [w, h, w, h];
  return {
    id, role, name, layer, cutCount: 1, cutOnFold: false, mirrorPair: false,
    seamLine: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }],
    cutLine: [{ x: -sa, y: -sa }, { x: w + sa, y: -sa }, { x: w + sa, y: h + hem }, { x: -sa, y: h + hem }],
    edges: edges.map((e, i) => ({ id: e, from: i, to: (i + 1) % 4, lengthCm: lens[i]!, kind: kinds[i]! })),
    grainline: [{ x: w / 2, y: 5 }, { x: w / 2, y: h - 5 }],
    notches: [{ at: { x: w, y: 20 }, edgeId: edges[1], count: 1 }],
    darts: [], labels: [], seamAllowanceCm: sa,
    bounds: { minX: -sa, minY: -sa, maxX: w + sa, maxY: h + hem }, ...o,
  };
}

function skirt(materialId: string, closure: Closure): InstructionContext {
  const dart = { id: 'dart-1', apex: { x: 8, y: 12 }, legs: [{ x: 6, y: 0 }, { x: 10, y: 0 }] as [{ x: number; y: number }, { x: number; y: number }], intakeCm: 2, lengthCm: 12 };
  const pieces = [
    rect('front-skirt', 'front-skirt', 'Front skirt', 26, 60, ['waist', 'side', 'hem', 'cf'], { cutOnFold: true, darts: [dart] }),
    rect('back-skirt', 'back-skirt', 'Back skirt', 26, 60, ['waist', 'side', 'hem', 'cb'], { cutCount: 2, mirrorPair: true, darts: [dart] }),
    rect('waistband', 'waistband', 'Waistband', 74, 8, ['top', 'end-r', 'bottom', 'end-l']),
    rect('waistband-if', 'waistband', 'Waistband interfacing', 74, 4, ['top', 'end-r', 'bottom', 'end-l'], {}, 'interfacing'),
  ];
  const seams: SeamSpec[] = [
    { id: 'dart-front', type: 'dart', a: { pieceId: 'front-skirt', edgeId: 'dart-1' }, intendedEaseCm: 0, stage: 1, finish: 'press toward centre' },
    { id: 'dart-back', type: 'dart', a: { pieceId: 'back-skirt', edgeId: 'dart-1' }, intendedEaseCm: 0, stage: 1, finish: 'press toward centre' },
    { id: 'cb-zip', type: 'zip-invisible', a: { pieceId: 'back-skirt', edgeId: 'cb' }, b: { pieceId: 'back-skirt', edgeId: 'cb' }, intendedEaseCm: 0, stage: 2, finish: 'zigzag' },
    { id: 'side', type: 'plain', a: { pieceId: 'front-skirt', edgeId: 'side' }, b: { pieceId: 'back-skirt', edgeId: 'side' }, intendedEaseCm: 0, stage: 3, finish: 'zigzag, press open' },
    { id: 'band', type: 'plain', a: { pieceId: 'waistband', edgeId: 'bottom' }, b: { pieceId: 'front-skirt', edgeId: 'waist' }, intendedEaseCm: 0, stage: 4, finish: 'press into band' },
    { id: 'hem-front', type: 'hem-blind', a: { pieceId: 'front-skirt', edgeId: 'hem' }, intendedEaseCm: 0, stage: 5, finish: 'blind' },
    { id: 'hem-back', type: 'hem-blind', a: { pieceId: 'back-skirt', edgeId: 'hem' }, intendedEaseCm: 0, stage: 5, finish: 'blind' },
  ];
  const layouts: CuttingLayout[] = [
    { layer: 'self', fabricWidthCm: 150, fold: 'folded', lengthCm: 140, placements: [], efficiency: 0.7 },
    { layer: 'interfacing', fabricWidthCm: 90, fold: 'single', lengthCm: 10, placements: [], efficiency: 0.5 },
  ];
  const garment = getGarment('a-line-skirt');
  const measurements = {
    heightCm: 168, bustCm: 92, waistCm: 72, hipCm: 100, underbustCm: 78, highHipCm: 90, neckCm: 36, shoulderWidthCm: 39,
    shoulderLengthCm: 12.5, backWaistLengthCm: 41, frontWaistLengthCm: 44, shoulderToBustPointCm: 26, bustPointDistanceCm: 19,
    armLengthCm: 59, upperArmCm: 28, elbowCm: 24, wristCm: 16, waistToHipCm: 21, waistToKneeCm: 59, waistToFloorCm: 105,
    crotchDepthCm: 27, inseamCm: 78, thighCm: 58, kneeCm: 37, calfCm: 36, ankleCm: 23, estimated: ['calfCm'],
  } as ResolvedMeasurements;
  const fit: FitPlan = {
    fit: 'regular', options: { ...garment.defaults, closure },
    ease: { bust: 0, waist: 2, hip: 5, upperArm: 0, thigh: 0 },
    finished: { waist: 74, hip: 105, hem: 150, lengthFromWaist: 60 }, hemHeightFromFloorCm: 45,
    rationale: ['Knee length ends above the widest part of the calf.'],
  };
  const body = { shape: 'pear', ratios: { waistToHip: 0.72, waistToBust: 0.78, bustToHip: 0.92, legToHeight: 0.62, torsoToLeg: 0.6 }, landmarks: {}, notes: [] } as unknown as BodyAnalysis;
  return { garment, style: getStyle('parisian-chic'), material: getMaterial(materialId), measurements, body, fit, pieces, seams, layouts };
}

describe('instructions', () => {
  for (const mat of ['belgian-linen-midweight', 'silk-crepe-de-chine', 'nordic-boiled-wool', 'ponte-knit']) {
    it(`covers every seam and piece for ${mat}`, () => {
      const ctx = skirt(mat, 'invisible-zip');
      const { instructions, glossary, effort } = buildInstructions(ctx);
      for (const s of ctx.seams) expect(instructions.some((st) => st.seamIds.includes(s.id)), s.id).toBe(true);
      for (const p of ctx.pieces) expect(instructions.some((st) => st.phase === 'cut' && st.pieceIds.includes(p.id)), p.id).toBe(true);
      expect(instructions.map((s) => s.n)).toEqual(instructions.map((_, i) => i + 1));
      for (const st of instructions) {
        for (const t of st.terms) expect(glossary[t], t).toBeTruthy();
        expect(st.minutes).toBeGreaterThan(0);
        expect(st.body.length).toBeGreaterThan(20);
      }
      expect(Object.keys(glossary).length).toBeGreaterThanOrEqual(25);
      const phases = instructions.map((s) => s.phase);
      for (const ph of ['prepare', 'cut', 'mark', 'construct', 'fit', 'finish', 'press'] as const) expect(phases).toContain(ph);
      // Try-on after side seams are basted, and a hem checkpoint before hemming.
      const baste = instructions.findIndex((s) => /baste/i.test(s.title));
      const fitIdx = instructions.findIndex((s) => s.phase === 'fit');
      const firstHem = instructions.findIndex((s) => s.seamIds.includes('hem-front') && s.phase === 'construct');
      expect(baste).toBeGreaterThan(-1);
      expect(fitIdx).toBeGreaterThan(baste);
      expect(instructions[firstHem - 1]!.phase).toBe('fit');
      expect(instructions[firstHem - 1]!.checkpoint).toMatch(/45 cm/);
      // Construct steps follow seam stage order.
      const stageOf = new Map(ctx.seams.map((s) => [s.id, s.stage]));
      const stages = instructions.filter((s) => s.phase === 'construct' && s.seamIds.length && !/baste/i.test(s.title)).map((s) => Math.min(...s.seamIds.map((id) => stageOf.get(id)!)));
      expect([...stages].sort((a, b) => a - b)).toEqual(stages);
      expect(effort.difficulty).toBeGreaterThanOrEqual(1);
      expect(effort.minutes).toBeGreaterThan(180);
    });
  }

  it('uses French seams on sheer silk and knit stitches on knits', () => {
    // The drafter proposes French seams on light silks and resolveSeamTypes keeps
    // them only where they can be sewn: the waistband join must become plain.
    const silkCtx = skirt('silk-crepe-de-chine', 'invisible-zip');
    const proposed = silkCtx.seams.map((s) => (s.id === 'side' || s.id === 'band' ? { ...s, type: 'french' as const } : s));
    const resolved = resolveSeamTypes(silkCtx.pieces, proposed, silkCtx.material);
    expect(resolved.find((s) => s.id === 'side')!.type).toBe('french');
    expect(resolved.find((s) => s.id === 'band')!.type).toBe('plain');
    const silk = buildInstructions({ ...silkCtx, seams: resolved }).instructions;
    expect(silk.some((s) => s.seamIds.includes('side') && /French seam/.test(s.body))).toBe(true);
    expect(silk.some((s) => s.seamIds.includes('band') && /French/.test(s.title))).toBe(false);
    const knit = buildInstructions(skirt('ponte-knit', 'invisible-zip')).instructions;
    expect(knit.some((s) => s.seamIds.includes('side') && /zigzag or stretch stitch/.test(s.body))).toBe(true);
  });

  it('groups repeated operations and adapts lining, hand-finish and sleeve techniques', () => {
    const base = skirt('wool-crepe', 'invisible-zip');
    const lining = (id: string, role: PieceRole, edges: [string, string, string, string], o: Partial<PatternPiece> = {}) =>
      rect(id, role, id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), 26, 55, edges, o, 'lining');
    const pieces = [
      ...base.pieces,
      lining('front-skirt-lining', 'front-skirt', ['waist', 'side', 'hem', 'cf'], { cutOnFold: true }),
      lining('back-skirt-lining', 'back-skirt', ['waist', 'side', 'hem', 'cb-zip'], { cutCount: 2, mirrorPair: true }),
      rect('sleeve', 'sleeve', 'Sleeve', 30, 20, ['cap-front', 'cap-back', 'hem', 'underarm'], { cutCount: 2, mirrorPair: true }),
    ];
    const seams: SeamSpec[] = [
      ...base.seams.filter((s) => s.id !== 'band'),
      { id: 'band-front', type: 'plain', a: { pieceId: 'front-skirt', edgeId: 'waist' }, b: { pieceId: 'waistband', edgeId: 'bottom' }, intendedEaseCm: 0, stage: 66, finish: 'press into band' },
      { id: 'band-back', type: 'plain', a: { pieceId: 'back-skirt', edgeId: 'waist' }, b: { pieceId: 'waistband', edgeId: 'bottom' }, intendedEaseCm: 0, stage: 66, finish: 'press into band' },
      { id: 'band-ends', type: 'plain', a: { pieceId: 'waistband', edgeId: 'end-r' }, intendedEaseCm: 0, stage: 68, finish: 'Fold the waistband right sides together and stitch across the ends; trim, turn and press.' },
      { id: 'lining-side', type: 'plain', a: { pieceId: 'front-skirt-lining', edgeId: 'side' }, b: { pieceId: 'back-skirt-lining', edgeId: 'side' }, intendedEaseCm: 0, stage: 60, finish: 'zigzag, press open' },
      { id: 'lining-zip', type: 'plain', a: { pieceId: 'back-skirt-lining', edgeId: 'cb-zip' }, intendedEaseCm: 0, stage: 62, finish: 'Turn the lining edges under and slip-stitch them to the zip tape.' },
      { id: 'lining-waist-f', type: 'plain', a: { pieceId: 'front-skirt-lining', edgeId: 'waist' }, b: { pieceId: 'front-skirt', edgeId: 'waist' }, intendedEaseCm: 0, stage: 63, finish: 'Baste within the seam allowance.', note: 'Baste lining to skirt at the waist, wrong sides together.' },
      { id: 'lining-waist-b', type: 'plain', a: { pieceId: 'back-skirt-lining', edgeId: 'waist' }, b: { pieceId: 'back-skirt', edgeId: 'waist' }, intendedEaseCm: 0, stage: 63, finish: 'Baste within the seam allowance.', note: 'Baste lining to skirt at the waist, wrong sides together.' },
      { id: 'cap-f', type: 'set-in-sleeve', a: { pieceId: 'sleeve', edgeId: 'cap-front' }, b: { pieceId: 'front-skirt', edgeId: 'side' }, intendedEaseCm: 1.2, stage: 50, finish: 'press towards sleeve' },
      { id: 'cap-b', type: 'set-in-sleeve', a: { pieceId: 'sleeve', edgeId: 'cap-back' }, b: { pieceId: 'back-skirt', edgeId: 'side' }, intendedEaseCm: 1.4, stage: 50, finish: 'press towards sleeve' },
    ];
    const { instructions } = buildInstructions({ ...base, pieces, seams });
    for (const s of seams) expect(instructions.some((st) => st.seamIds.includes(s.id)), s.id).toBe(true);
    const band = instructions.filter((s) => s.seamIds.includes('band-front') || s.seamIds.includes('band-back'));
    expect(band).toHaveLength(1);
    expect(band[0]!.title).toBe('Attach the waistband');
    expect(band[0]!.body).toMatch(/2 sections/);
    const sleeve = instructions.filter((s) => s.phase === 'construct' && s.seamIds.includes('cap-f'));
    expect(sleeve).toHaveLength(1);
    expect(sleeve[0]!.seamIds).toContain('cap-b');
    expect(sleeve[0]!.body).toMatch(/2\.6 cm longer/);
    const sleeveIdx = instructions.indexOf(sleeve[0]!);
    expect(instructions[sleeveIdx + 1]!.phase).toBe('fit');
    const liningBaste = instructions.find((s) => s.seamIds.includes('lining-waist-f'))!;
    expect(liningBaste.seamIds).toContain('lining-waist-b');
    expect(liningBaste.body).toMatch(/WRONG sides together/);
    expect(liningBaste.body).not.toMatch(/right sides together/);
    expect(instructions.find((s) => s.seamIds.includes('lining-zip'))!.body).toMatch(/slip stitches/);
    expect(instructions.find((s) => s.seamIds.includes('band-ends'))!.body).toMatch(/point turner/);
    // No two consecutive steps share a title (repeats are grouped).
    for (let i = 1; i < instructions.length; i++) expect(instructions[i]!.title).not.toBe(instructions[i - 1]!.title);
  });

  it('builds a BOM with margins, notions and tools', () => {
    const bom = buildBom(skirt('belgian-linen-midweight', 'invisible-zip'));
    const fabric = bom.find((b) => b.kind === 'fabric')!;
    expect(fabric.quantity).toBeCloseTo(1.6, 5); // 140 cm * 1.1 = 154 -> 1.6 m
    // The fixture's zip seam spans the whole 60 cm centre-back edge: the BOM
    // buys the standard zip for exactly that drafted opening (same rule as the drafter).
    expect(bom.find((b) => /invisible zip$/i.test(b.name))!.spec).toMatch(/^65 cm .*60 cm opening/);
    expect(bom.some((b) => b.kind === 'thread')).toBe(true);
    for (const tool of ['Fabric shears', 'Tape measure', 'Seam ripper', 'Press cloth', 'Machine needles']) {
      expect(bom.some((b) => b.kind === 'tool' && b.name === tool), tool).toBe(true);
    }
    const elastic = buildBom(skirt('belgian-linen-midweight', 'elastic')).find((b) => /elastic/i.test(b.name))!;
    expect(elastic.quantity).toBe(Math.round(72 * 0.92 + 2.5));
  });

  it('renders a complete markdown booklet', () => {
    const ctx = skirt('belgian-linen-midweight', 'invisible-zip');
    const res = buildInstructions(ctx);
    const pkg = {
      version: 1, id: 'test', name: 'Test skirt', request: { measurements: ctx.measurements, garment: 'a-line-skirt', styleId: 'parisian-chic', materialId: 'belgian-linen-midweight' },
      ...ctx, measurementIssues: [], bom: buildBom(ctx), instructions: res.instructions, glossary: res.glossary,
      silhouette: { torso: [], neckline: null, topHeightCm: 105, hemHeightCm: 45 }, effort: res.effort, quality: [],
    } as DesignPackage;
    const md = renderInstructionsMarkdown(pkg);
    for (const h of ['# Test skirt', '## Overview', '## Why this design suits you', '## Your measurements', '## Shopping list', '## Pattern pieces and cutting', '## Step by step', '## Glossary']) {
      expect(md).toContain(h);
    }
    expect(md).toMatch(/Calf \| 36 \| estimated/);
    expect(md).toContain('Checkpoint');
  });
});
