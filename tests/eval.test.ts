/**
 * Self-tests of the evaluation harness: geometry helpers, SVG parsing, the
 * scoring model, case generation and report aggregation — and mutation tests
 * proving each metric flags the defect it is meant to catch.
 */
import { describe, expect, it } from 'vitest';
import type { DesignPackage, Path } from '../src/core/types';
import { GARMENTS, getMaterial } from '../src/core/presets';
import { FULL_PROFILE_GARMENTS, buildCases } from '../eval/cases';
import { evaluateCase, type CaseResult } from '../eval/evaluate';
import {
  applyPlacement,
  checkSimple,
  differenceArea,
  edgeLength,
  extentAtY,
  intersectionArea,
  signedArea,
} from '../eval/geom';
import {
  MetricBuilder,
  METRIC_WEIGHTS,
  firstDifference,
  reverseKeys,
  scoreFit,
  scoreGeometry,
  scoreInstructions,
  scoreLayout,
  scoreProportion,
  scoreSeams,
  scoreSvg,
  scoreWearability,
  sentences,
  type MetricResult,
} from '../eval/metrics';
import { CORE_PROFILE_IDS, PROFILES } from '../eval/profiles';
import { failurePattern, summarize } from '../eval/report';
import { parseXml, transformScale } from '../eval/xml';
import { designFor, failuresIn } from './helpers';

const square: Path = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

describe('eval geometry helpers', () => {
  it('recognises simple and self-intersecting polygons', () => {
    expect(checkSimple(square).ok).toBe(true);
    const bowtie: Path = [square[0], square[2], square[1], square[3]];
    const r = checkSimple(bowtie);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/cross/);
    const spike: Path = [square[0], { x: 5, y: 0 }, { x: 3, y: 0 }, square[1], square[2], square[3]];
    expect(checkSimple(spike).ok).toBe(false);
    expect(checkSimple([square[0], square[1]]).ok).toBe(false);
    expect(checkSimple([...square.slice(0, 3), { x: NaN, y: 1 }]).ok).toBe(false);
  });

  it('measures areas, edge lengths and slices', () => {
    expect(signedArea(square)).toBe(100); // clockwise on screen (y down) is positive
    expect(edgeLength(square, 3, 0)).toBe(10); // wraps through the implicit closing segment
    expect(edgeLength(square, 1, 3)).toBe(20);
    expect(extentAtY(square, 5)).toEqual({ minX: 0, maxX: 10 });
    expect(extentAtY(square, 20)).toBeNull();
    const shifted = square.map((p) => ({ x: p.x + 5, y: p.y }));
    expect(intersectionArea(square, shifted)).toBeCloseTo(50, 6);
    expect(differenceArea(square, shifted)).toBeCloseTo(50, 6);
  });

  it('applies placements as flip → rotate → translate', () => {
    const [p] = applyPlacement([{ x: 2, y: 3 }], { x: 10, y: 20, rotationDeg: 180, flipped: true });
    expect(p.x).toBeCloseTo(12, 9); // flip: (-2, 3); rotate 180: (2, -3); translate
    expect(p.y).toBeCloseTo(17, 9);
  });
});

describe('SVG helpers', () => {
  it('accepts well-formed SVG and rejects broken XML', () => {
    expect(parseXml('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>').ok).toBe(true);
    expect(parseXml('<svg><g></svg>').ok).toBe(false);
    expect(parseXml('<html></html>').ok).toBe(false);
    expect(parseXml('').ok).toBe(false);
  });

  it('computes uniform transform scale', () => {
    expect(transformScale('translate(3 4) scale(10)')).toBe(10);
    expect(transformScale('scale(2,8)')).toBe(4);
    expect(transformScale(null)).toBe(1);
  });
});

describe('scoring model', () => {
  it('penalises each failure and zeros an aspect after three', () => {
    const m = new MetricBuilder('geometry');
    for (let i = 0; i < 10; i++) m.check('a', i !== 0, 'one failure');
    m.check('b', true, '');
    const r = m.result();
    expect(r.score).toBeCloseTo((0.66 + 1) / 2, 3);
    expect(r.clean).toBe(false);
    expect(r.details).toEqual(['[a] one failure']);
    const z = new MetricBuilder('seams');
    for (let i = 0; i < 4; i++) z.fail('a', `f${i}`);
    expect(z.result().score).toBe(0);
  });

  it('keeps minor aspects out of the clean flag and marks empty metrics not applicable', () => {
    const m = new MetricBuilder('layout').aspect('cosmetic', { minor: true });
    m.fail('cosmetic', 'x');
    m.check('major', true, '');
    const r = m.result();
    expect(r.clean).toBe(true);
    expect(r.score).toBeLessThan(1);
    expect(new MetricBuilder('fit').result().applicable).toBe(false);
  });

  it('weights sum to 100', () => {
    expect(Object.values(METRIC_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('splits instruction text into sentences per line and list item', () => {
    expect(sentences('You need:\n- Shears\n- Pins\nPress it. Then sew.')).toEqual(['You need:', 'Shears', 'Pins', 'Press it.', 'Then sew.']);
  });
});

// ---------------------------------------------------------------------------
// Mutation tests: a defect injected into a good package must be flagged.
// ---------------------------------------------------------------------------

function base(garment: Parameters<typeof designFor>[0] = 'pencil-skirt'): DesignPackage {
  return structuredClone(designFor(garment, 'hourglass-38', 'eu'));
}

function expectFlags(scorer: (p: DesignPackage) => MetricResult, aspect: string, mutate: (p: DesignPackage) => void, garment: Parameters<typeof designFor>[0] = 'pencil-skirt'): void {
  const good = base(garment);
  expect(failuresIn(scorer(good), [aspect]), `baseline ${aspect}`).toEqual([]);
  const bad = base(garment);
  mutate(bad);
  const r = scorer(bad);
  expect(failuresIn(r, [aspect]).length, `${aspect} should flag the mutation`).toBeGreaterThan(0);
  expect(r.score).toBeLessThan(1);
}

describe('geometry metric catches', () => {
  it('a crossing stitch line', () =>
    expectFlags(scoreGeometry, 'simple', (p) => {
      const s = p.pieces[0].seamLine;
      const i = Math.floor(s.length / 3);
      const j = Math.floor((2 * s.length) / 3);
      [s[i], s[j]] = [s[j], s[i]];
    }));
  it('a stored edge length that does not match the path', () => expectFlags(scoreGeometry, 'edges', (p) => (p.pieces[0].edges[0].lengthCm += 2)));
  it('edge indices out of range', () => expectFlags(scoreGeometry, 'edges', (p) => (p.pieces[0].edges[0].to = 99999)));
  it('a cut line that does not enclose the stitch line', () =>
    expectFlags(scoreGeometry, 'encloses', (p) => {
      const pc = p.pieces[1];
      const cx = (pc.bounds.minX + pc.bounds.maxX) / 2;
      const cy = (pc.bounds.minY + pc.bounds.maxY) / 2;
      pc.cutLine = pc.cutLine.map((q) => ({ x: cx + (q.x - cx) * 0.8, y: cy + (q.y - cy) * 0.8 }));
    }));
});

describe('seam metric catches', () => {
  it('seams that no longer match in length', () =>
    expectFlags(scoreSeams, 'lengths', (p) => {
      const s = p.seams.find((x) => x.b && x.intendedEaseCm === 0 && x.a.pieceId !== x.b.pieceId)!;
      s.intendedEaseCm = 2;
    }));
  it('a seam pointing at a missing edge', () => expectFlags(scoreSeams, 'references', (p) => (p.seams[0].a = { pieceId: p.seams[0].a.pieceId, edgeId: 'nope' })));
  it('a sleeve cap with no ease', () =>
    expectFlags(
      scoreSeams,
      'sleeve-cap',
      (p) => {
        for (const s of p.seams.filter((x) => x.type === 'set-in-sleeve')) {
          const sleeve = p.pieces.find((x) => x.id === s.a.pieceId)!;
          const e = sleeve.edges.find((x) => x.id === s.a.edgeId)!;
          // collapse the cap edge to a straight chord: far less length than the armhole
          const from = sleeve.seamLine[e.from];
          for (let k = e.from + 1; k !== e.to; k = (k + 1) % sleeve.seamLine.length) {
            const t = 0.001 * (k - e.from);
            sleeve.seamLine[k] = { x: from.x + t, y: from.y };
          }
        }
      },
      'wrap-dress',
    ));
});

describe('fit metric catches', () => {
  it('ease that does not add up', () => expectFlags(scoreFit, 'arithmetic', (p) => (p.fit.ease.hip += 3)));
  it('implausible ease', () =>
    expectFlags(scoreFit, 'ranges', (p) => {
      p.fit.ease.hip = 40;
      p.fit.finished.hip = p.measurements.hipCm + 40;
    }));
  it('a plan that the pattern does not implement', () => expectFlags(scoreFit, 'pattern', (p) => (p.fit.finished.hip = (p.fit.finished.hip ?? 0) + 8)));
});

describe('wearability metric catches', () => {
  it('a fitted skirt with no opening', () =>
    expectFlags(scoreWearability, 'hip-pass', (p) => {
      p.seams = p.seams.filter((s) => s.type !== 'zip-invisible' && s.type !== 'zip-lapped');
      p.fit.options.closure = 'none';
    }));
  it('a hobble hem without a vent', () =>
    expectFlags(scoreWearability, 'stride', (p) => {
      p.fit.finished.hem = 60;
      for (const pc of p.pieces) pc.edges = pc.edges.map((e) => (e.kind === 'opening' ? { ...e, kind: 'seam', id: e.id.replace(/vent|slit/, 'edge') } : { ...e, id: e.id.replace(/vent|slit/, 'edge') }));
      p.fit.hemHeightFromFloorCm = p.body.landmarks.calf - 8;
    }));
});

describe('proportion metric catches', () => {
  it('a hem across the widest part of the calf', () => expectFlags(scoreProportion, 'calf', (p) => (p.fit.hemHeightFromFloorCm = p.body.landmarks.calf + 1)));
  it('a missing rationale', () => expectFlags(scoreProportion, 'rationale', (p) => (p.fit.rationale = ['Looks nice.'])));
});

describe('layout metric catches', () => {
  it('overlapping pieces', () =>
    expectFlags(scoreLayout, 'overlap', (p) => {
      const l = p.layouts[0];
      l.placements[1] = { ...l.placements[1], x: l.placements[0].x, y: l.placements[0].y, rotationDeg: l.placements[0].rotationDeg, flipped: l.placements[0].flipped, pieceId: l.placements[0].pieceId };
    }));
  it('a piece hanging off the fabric', () => expectFlags(scoreLayout, 'inside', (p) => (p.layouts[0].placements[0].x += p.layouts[0].fabricWidthCm)));
  it('a missing copy', () => expectFlags(scoreLayout, 'copies', (p) => p.layouts[0].placements.pop()));
  it('a piece turned off grain', () => expectFlags(scoreLayout, 'grain', (p) => (p.layouts[0].placements[0].rotationDeg = 90)));
  it('too little fabric in the bill of materials', () =>
    expectFlags(scoreLayout, 'bom', (p) => {
      for (const b of p.bom.filter((x) => x.kind === 'fabric')) b.quantity = 0.2;
    }));
});

describe('instructions metric catches', () => {
  it('a seam without a step', () => expectFlags(scoreInstructions, 'coverage', (p) => p.instructions.forEach((s) => (s.seamIds = s.seamIds.filter((x) => x !== p.seams[0].id)))));
  it('jargon without a glossary entry', () =>
    expectFlags(scoreInstructions, 'glossary', (p) => {
      for (const k of Object.keys(p.glossary)) if (/notch/i.test(k)) delete p.glossary[k];
      p.instructions[p.instructions.length - 1].body += ' Match the notches.';
    }));
  it('cutting after sewing', () =>
    expectFlags(scoreInstructions, 'order', (p) => {
      const i = p.instructions.findIndex((s) => s.phase === 'cut');
      const [cut] = p.instructions.splice(i, 1);
      p.instructions.push(cut);
      p.instructions.forEach((s, k) => (s.n = k + 1));
    }));
});

describe('svg metric', () => {
  it('passes on a real package (valid XML, A4 + letter pages at 1:1 with a 5 cm test square)', () => {
    const r = scoreSvg(base('a-line-skirt'));
    expect(failuresIn(r, ['pieces', 'sheet', 'layout', 'print', 'scale'])).toEqual([]);
  });
});

describe('determinism helpers', () => {
  it('finds the first differing path', () => {
    expect(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBeNull();
    expect(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toMatch(/^a\.1\.b/);
  });
  it('reverses key order without changing data', () => {
    const v = { b: 1, a: { d: [1, 2], c: 'x' } };
    const r = reverseKeys(v) as typeof v;
    expect(r).toEqual(v);
    expect(Object.keys(r)).toEqual(['a', 'b']);
  });
});

describe('case matrix', () => {
  const cases = buildCases();

  it('runs every garment with European and Scandinavian combos valid for its fabric types', () => {
    for (const g of GARMENTS) {
      const gc = cases.filter((c) => c.garment === g.id);
      expect(new Set(gc.map((c) => c.combo.region))).toEqual(new Set(['european', 'scandinavian']));
      for (const c of gc) expect(g.fabricTypes).toContain(getMaterial(c.combo.materialId).construction);
      const profiles = new Set(gc.map((c) => c.profileId));
      if (FULL_PROFILE_GARMENTS.includes(g.id)) expect(profiles.size).toBe(PROFILES.length);
      else expect(profiles.size).toBeGreaterThanOrEqual(5);
      expect(gc.some((c) => c.deep)).toBe(true);
    }
  });

  it('has unique case ids, ≥ 14 profiles and a diverse core set', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(PROFILES.length).toBeGreaterThanOrEqual(14);
    const heights = PROFILES.map((p) => p.measurements.heightCm);
    expect(Math.min(...heights)).toBeLessThanOrEqual(150);
    expect(Math.max(...heights)).toBeGreaterThanOrEqual(185);
    const sizes = PROFILES.map((p) => p.euSize);
    expect(Math.min(...sizes)).toBeLessThanOrEqual(32);
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(54);
    expect(new Set(PROFILES.map((p) => p.completeness))).toEqual(new Set(['required', 'partial', 'full']));
    const core = PROFILES.filter((p) => CORE_PROFILE_IDS.includes(p.id));
    expect(new Set(core.map((p) => p.expectedShape)).size).toBe(5);
  });

  it('quick mode is a strict subset', () => {
    const quick = buildCases({ quick: true });
    expect(quick.length).toBeLessThan(cases.length / 3);
    expect(quick.filter((c) => c.deep).length).toBe(GARMENTS.length);
  });
});

describe('case evaluation and report', () => {
  it('evaluates a case into scored metrics, and a broken request into a crash', { timeout: 30_000 }, () => {
    const c = buildCases({ garments: ['a-line-skirt'], profiles: ['hourglass-38'] })[0];
    const ok = evaluateCase(c);
    expect(ok.crashed).toBe(false);
    expect(ok.metrics.map((m) => m.id)).toEqual(expect.arrayContaining(['geometry', 'seams', 'fit', 'wearability', 'proportion', 'layout', 'instructions']));
    const broken = evaluateCase({ ...c, id: 'broken', request: { ...c.request, styleId: 'no-such-style' } });
    expect(broken.crashed).toBe(true);
    expect(broken.error).toContain('no-such-style');
    expect(broken.metrics.every((m) => m.score === 0)).toBe(true);
  });

  it('blends mean score and clean rate, and fails the gate on any crash', () => {
    const metric = (id: MetricResult['id'], score: number, clean: boolean): MetricResult => ({ id, score, weight: METRIC_WEIGHTS[id], details: clean ? [] : [`[x] broken 3.5 cm`], checks: 1, failed: clean ? 0 : 1, applicable: true, clean });
    const mk = (id: string, s: number, crashed = false): CaseResult => ({
      id,
      garment: 'a-line-skirt',
      profileId: 'p',
      comboKey: 'eu',
      styleId: 's',
      materialId: 'm',
      deep: false,
      ms: 1,
      crashed,
      metrics: [metric('geometry', s, s === 1)],
      selfCheckFailures: [],
    });
    const presets = metric('presets', 1, true);
    const r = summarize([mk('a', 1), mk('b', 0.5)], presets, { threshold: 85, durationMs: 1 });
    const geo = r.metrics.find((m) => m.id === 'geometry')!;
    expect(geo.mean).toBeCloseTo(0.75, 6);
    expect(geo.cleanRate).toBeCloseTo(0.5, 6);
    expect(geo.value).toBeCloseTo(0.625, 6);
    const expected = (100 * (14 * 0.625 + 4 * 1)) / 18;
    expect(r.overall).toBeCloseTo(Math.round(expected * 10) / 10, 6);
    expect(r.topFailures[0].pattern).toBe('[x] broken # cm');
    const crashed = summarize([mk('a', 1), mk('c', 1, true)], presets, { threshold: 0, durationMs: 1 });
    expect(crashed.passed).toBe(false);
  });

  it('normalises numbers in failure patterns', () => {
    expect(failurePattern('[lengths] side: 12.3 vs 14 cm')).toBe('[lengths] side: # vs # cm');
  });
});
