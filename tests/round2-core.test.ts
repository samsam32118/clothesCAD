/**
 * Regression tests for the round-2 core fixes: stricter eval checks (each one
 * must flag the defect it targets), trouser suppression and fly front,
 * armhole balance, short sleeves, ball-gown skirt, gown/wrap/waistband ease,
 * fine-silk shells, cloth ranking and beginner-facing instructions.
 */
import { describe, expect, it } from 'vitest';
import { design } from '../src/core/design';
import { renderInstructionsMarkdown } from '../src/core/instructions';
import { recommend, getMaterial, getStyle, getGarment } from '../src/core/presets';
import { renderPieceSVG } from '../src/core/svg';
import { GOWN_BODICE_EASE, WAISTBAND_EASE_MAX, WRAP_BUST_EASE_MAX } from '../src/core/fit/plan';
import { SIDE_SUPPRESSION_MAX } from '../src/core/drafting/blocks/trousers';
import { SEAT_LET_OUT_ALLOWANCE } from '../src/core/drafting/garments/trousers';
import { scoreFit, scoreLayout, scoreWearability, type MetricResult } from '../eval/metrics';
import { getProfile } from '../eval/profiles';
import type { DesignPackage, DesignRequest, GarmentType } from '../src/core/types';
import { failuresIn } from './helpers';

const PEAR = { heightCm: 165, bustCm: 88, waistCm: 70, hipCm: 106 };

function make(garment: GarmentType, styleId: string, materialId: string, measurements = getProfile('hourglass-38').measurements, extra: Partial<DesignRequest> = {}): DesignPackage {
  return design({ measurements, garment, styleId, materialId, ...extra });
}

function mutated(pkg: DesignPackage, f: (p: DesignPackage) => void): DesignPackage {
  const p = structuredClone(pkg);
  f(p);
  return p;
}

function flags(r: MetricResult, aspect: string): boolean {
  return failuresIn(r, [aspect]).length > 0;
}

const armhole = (pkg: DesignPackage, roles: string[]) =>
  pkg.pieces.filter((p) => p.layer === 'self' && roles.includes(p.role)).flatMap((p) => p.edges.filter((e) => e.id.startsWith('armhole'))).reduce((a, e) => a + e.lengthCm, 0);

// ---------------------------------------------------------------------------
// eval: checks that used to be skipped now run and catch their defect
// ---------------------------------------------------------------------------

describe('eval fit metric no longer skips checks', () => {
  const gown = make('ball-gown', 'european-couture-evening', 'silk-mikado');
  const wrap = make('wrap-dress', 'copenhagen-relaxed', 'viscose-crepe');
  const shell = make('shell-top', 'parisian-chic', 'wool-crepe', getProfile('petite-hourglass').measurements);

  it('measures the ball-gown hip on the skirt panels that cross the hip line', () => {
    expect(flags(scoreFit(gown), 'pattern')).toBe(false);
    // Without its skirt panels nothing reaches the hip: that is a failure, not a skipped check.
    const noSkirt = mutated(gown, (p) => (p.pieces = p.pieces.filter((x) => x.role !== 'skirt-panel')));
    expect(failuresIn(scoreFit(noSkirt), ['pattern']).join(' ')).toMatch(/hip/);
  });

  it('checks the wrap dress pattern bust and waist from the CF line (the crossover adds no girth)', () => {
    expect(scoreFit(wrap).details).toEqual([]);
    expect(flags(scoreFit(mutated(wrap, (p) => (p.fit.finished.bust = (p.fit.finished.bust ?? 0) + 6))), 'pattern')).toBe(true);
    expect(flags(scoreFit(mutated(wrap, (p) => (p.fit.finished.waist = (p.fit.finished.waist ?? 0) - 6))), 'pattern')).toBe(true);
  });

  it('fails a planned hip on a top that ends above the hip', () => {
    expect(shell.fit.finished.hip).toBeUndefined();
    expect(flags(scoreFit(mutated(shell, (p) => (p.fit.finished.hip = p.measurements.hipCm + p.fit.ease.hip))), 'pattern')).toBe(true);
  });

  it('fails when the silhouette has no ring at a landmark the garment covers', () => {
    expect(flags(scoreFit(mutated(gown, (p) => (p.silhouette.torso = []))), 'silhouette')).toBe(true);
  });

  it('fails when a body piece loses its waist marks', () => {
    const broken = mutated(wrap, (p) => {
      for (const piece of p.pieces) {
        piece.notches = piece.notches.filter((n) => !/waist|cf/i.test(n.label ?? ''));
        piece.edges = piece.edges.map((e) => (e.id === 'waist' ? { ...e, id: 'bottom' } : e));
      }
    });
    expect(flags(scoreFit(broken), 'pattern')).toBe(true);
  });

  it('holds skimming garments to a waist range their construction can explain', () => {
    const shift = make('shift-dress', 'antwerp-avant-garde', 'baltic-linen-heavyweight');
    expect(flags(scoreFit(shift), 'ranges')).toBe(false);
    expect(flags(scoreFit(mutated(shift, (p) => {
      p.fit.ease.waist += 15;
      p.fit.finished.waist = (p.fit.finished.waist ?? 0) + 15;
    })), 'ranges')).toBe(true);
  });
});

describe('eval wearability stride check', () => {
  it('a lining zip is not a walking vent: a too-narrow gown hem is caught', () => {
    const gown = make('ball-gown', 'european-couture-evening', 'silk-mikado');
    expect(flags(scoreWearability(mutated(gown, (p) => (p.fit.finished.hem = 95))), 'stride')).toBe(true);
  });

  it('a vent counts only for its real length', () => {
    const pencil = make('pencil-skirt', 'british-heritage', 'biella-worsted-suiting', getProfile('hourglass-38').measurements, { options: { length: 'midi' } });
    expect(flags(scoreWearability(pencil), 'stride')).toBe(false);
    // Shrink the vent to 2 cm: a 2 cm vent cannot free a midi stride.
    const short = mutated(pencil, (p) => {
      for (const piece of p.pieces) {
        const v = piece.edges.find((e) => e.id === 'vent');
        if (!v) continue;
        const pts = piece.seamLine;
        const top = pts[v.to];
        const bottom = pts[v.from];
        for (let k = v.from; k !== v.to; k = (k + 1) % pts.length) pts[k] = { x: pts[k].x, y: Math.max(pts[k].y, bottom.y - 2) };
        pts[v.to] = { x: top.x, y: bottom.y - 2 };
      }
      p.fit.finished.hem = 80;
      p.silhouette.torso = p.silhouette.torso.map((r) => (r.heightCm < p.body.landmarks.hip ? { ...r, circumferenceCm: Math.min(r.circumferenceCm, 80) } : r));
    });
    expect(flags(scoreWearability(short), 'stride')).toBe(true);
  });

  it('adds no stride check when the hem is above the knee', () => {
    const mini = make('a-line-skirt', 'parisian-chic', 'cotton-poplin', getProfile('hourglass-38').measurements, { options: { length: 'mini' } });
    expect(scoreWearability(mini).details.join(' ')).not.toMatch(/stride/);
    const knee = scoreWearability(mini);
    expect(knee.checks).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// trousers
// ---------------------------------------------------------------------------

describe('trousers: suppression, pleats, fly front, seat seam', () => {
  const wide = make('wide-leg-trousers', 'antwerp-avant-garde', 'baltic-linen-heavyweight', PEAR, { options: { fit: 'relaxed' } });
  const front = wide.pieces.find((p) => p.id === 'front-leg')!;
  const back = wide.pieces.find((p) => p.id === 'back-leg')!;

  it('takes at most ~3 cm off the front side seam and pleats the rest', () => {
    const waist = front.edges.find((e) => e.id === 'waist')!;
    const sideWaist = front.seamLine[waist.from];
    // Front frame: the hip side point sits at x = 0, so the side waist x is the side suppression.
    expect(sideWaist.x).toBeLessThanOrEqual(SIDE_SUPPRESSION_MAX.front + 0.5);
    expect(front.notches.filter((n) => n.label === 'pleat').length).toBeGreaterThanOrEqual(2);
    expect(front.darts).toHaveLength(0);
    expect(renderPieceSVG(front)).toMatch(/pleatfold/);
  });

  it('splits the back intake over two darts of at most 3 cm', () => {
    expect(back.darts).toHaveLength(2);
    for (const d of back.darts) expect(d.intakeCm).toBeLessThanOrEqual(3.01);
  });

  it('has a fly front with a shield, no CB zip, and a let-out seat seam', () => {
    expect(wide.fit.options.closure).toBe('lapped-zip');
    expect(wide.pieces.some((p) => p.id === 'fly-shield')).toBe(true);
    expect(front.edges.some((e) => e.id === 'fly-facing')).toBe(true);
    expect(back.edges.some((e) => e.id === 'cb-zip')).toBe(false);
    const seat = back.edges.find((e) => e.id === 'seat')!;
    expect(seat).toBeDefined();
    const fly = wide.instructions.find((s) => s.seamIds.includes('fly-zip'))!;
    expect(fly.title).toMatch(/fly front/i);
    expect(wide.bom.some((b) => /trouser \(fly\) zip/i.test(b.name))).toBe(true);
    expect(wide.pieces.find((p) => p.id === 'back-leg')!.seamAllowanceCm).toBeLessThan(SEAT_LET_OUT_ALLOWANCE);
  });

  it('puts an invisible zip in the side seam and drops the pockets', () => {
    const side = make('tapered-trousers', 'british-heritage', 'biella-worsted-suiting', PEAR, { options: { closure: 'invisible-zip', pockets: true } });
    expect(side.fit.options.pockets).toBe(false);
    expect(side.seams.find((s) => s.id === 'side-zip')?.type).toBe('zip-invisible');
    expect(side.pieces.find((p) => p.id === 'back-leg')!.edges.some((e) => e.id === 'cb-zip')).toBe(false);
  });

  it('caps waistband ease', () => {
    expect(wide.fit.ease.waist).toBeLessThanOrEqual(WAISTBAND_EASE_MAX);
  });
});

// ---------------------------------------------------------------------------
// bodices, sleeves, gowns, shells
// ---------------------------------------------------------------------------

describe('bodice armholes and sleeves', () => {
  it.each([
    ['sheath-dress', 'parisian-chic', 'wool-crepe'],
    ['shell-top', 'parisian-chic', 'wool-crepe'],
    ['wrap-dress', 'copenhagen-relaxed', 'viscose-crepe'],
  ] as const)('%s: back armhole is not shorter than the front', (g, s, m) => {
    for (const profile of ['petite-hourglass', 'hourglass-38', 'round-54', 'tall-hourglass']) {
      const pkg = make(g, s, m, getProfile(profile).measurements);
      const f = armhole(pkg, ['front-bodice', 'front-dress']);
      const b = armhole(pkg, ['back-bodice', 'back-dress']);
      expect(b).toBeGreaterThanOrEqual(f - 0.5);
      expect(pkg.quality.find((q) => q.id === 'armhole-balance')?.ok).toBe(true);
    }
  });

  it('a short sleeve has an underarm seam of at least 8 cm', () => {
    for (const profile of ['petite-hourglass', 'hourglass-38']) {
      const pkg = make('wrap-dress', 'copenhagen-relaxed', 'viscose-crepe', getProfile(profile).measurements, { options: { sleeve: 'short' } });
      const sleeve = pkg.pieces.find((p) => p.role === 'sleeve')!;
      expect(sleeve.edges.find((e) => e.id === 'underarm-front')!.lengthCm).toBeGreaterThanOrEqual(7.95);
    }
  });
});

describe('ease plan', () => {
  it('fits a boned gown bodice close: bust ≤ 3 cm, waist ≤ 1.5 cm', () => {
    const gown = make('ball-gown', 'european-couture-evening', 'silk-mikado');
    expect(gown.fit.ease.bust).toBeLessThanOrEqual(GOWN_BODICE_EASE.bust);
    expect(gown.fit.ease.waist).toBeLessThanOrEqual(GOWN_BODICE_EASE.waist);
  });

  it('caps crossover bust ease', () => {
    const wrap = make('wrap-dress', 'copenhagen-relaxed', 'cotton-poplin', getProfile('hourglass-38').measurements, { options: { fit: 'relaxed' } });
    expect(wrap.fit.ease.bust).toBeLessThanOrEqual(WRAP_BUST_EASE_MAX);
  });

  it('scales relaxed volume down for a petite frame', () => {
    const petite = make('shell-top', 'mediterranean-summer', 'lyocell-twill', { heightCm: 155, bustCm: 84, waistCm: 66, hipCm: 90 }, { options: { fit: 'relaxed' } });
    const tall = make('shell-top', 'mediterranean-summer', 'lyocell-twill', { heightCm: 172, bustCm: 84, waistCm: 66, hipCm: 90 }, { options: { fit: 'relaxed' } });
    expect(petite.fit.ease.bust).toBeLessThan(tall.fit.ease.bust);
    expect(petite.fit.rationale.join(' ')).toMatch(/155 cm frame/);
  });
});

describe('ball gown skirt', () => {
  const gown = make('ball-gown', 'european-couture-evening', 'silk-mikado');
  const hem = (id: string) => gown.pieces.find((p) => p.id === id)!.edges.find((e) => e.id === 'hem')!.lengthCm;

  it('grades the gores towards the back and adds a back sweep', () => {
    expect(hem('skirt-cb')).toBeGreaterThan(hem('skirt-sf'));
    expect(hem('skirt-sf')).toBeGreaterThan(hem('skirt-cf'));
    const len = (id: string, e: string) => gown.pieces.find((p) => p.id === id)!.edges.find((x) => x.id === e)!.lengthCm;
    expect(len('skirt-sb', 'seam-cb')).toBeGreaterThan(len('skirt-sb', 'side') + 3);
  });

  it('lines the skirt and lays the lining out on the lining cloth width', () => {
    expect(gown.pieces.filter((p) => p.layer === 'lining' && p.role === 'lining').length).toBe(4);
    const lining = gown.layouts.find((l) => l.layer === 'lining')!;
    expect(lining.fabricWidthCm).toBe(getMaterial('silk-habotai-lining').widthCm);
    expect(scoreLayout(gown).details).toEqual([]);
  });

  it('draws the box pleats and gives the waist stay its own step', () => {
    expect(renderPieceSVG(gown.pieces.find((p) => p.id === 'skirt-sf')!)).toMatch(/pleatplace/);
    expect(gown.instructions.some((s) => /waist stay/i.test(s.title))).toBe(true);
  });
});

describe('fine silk shell', () => {
  const shell = make('shell-top', 'parisian-chic', 'silk-crepe-de-chine');

  it('pulls on with no zip and a bias-bound neckline instead of facings', () => {
    expect(shell.fit.options.closure).toBe('none');
    expect(shell.seams.some((s) => s.type === 'zip-invisible' || s.type === 'zip-lapped')).toBe(false);
    expect(shell.pieces.some((p) => p.id === 'neck-binding')).toBe(true);
    expect(shell.pieces.some((p) => /facing/.test(p.id))).toBe(false);
  });

  it('cuts woven bias binding shorter than the concave edge it binds', () => {
    const join = shell.seams.find((s) => s.b?.pieceId === 'armhole-binding')!;
    expect(join.intendedEaseCm).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// presets and instructions
// ---------------------------------------------------------------------------

describe('cloth ranking favours each style signature cloth', () => {
  it.each([
    ['a-line-skirt', 'british-heritage', 'everyday', 'cotton-poplin'],
    ['sheath-dress', 'italian-sartorial', 'work', 'cotton-sateen'],
    ['wrap-dress', 'copenhagen-relaxed', 'everyday', 'cotton-poplin'],
    ['shell-top', 'parisian-chic', 'evening', 'wool-crepe'],
  ] as const)('%s in %s (%s) no longer leads with %s', (garment, styleId, occasion, generic) => {
    const top = recommend({ garment, styleId, occasion }).materials[0]!;
    expect(top.id).not.toBe(generic);
    expect(getStyle(styleId).recommendedMaterials).toContain(top.id);
    if (getGarment(garment).category === 'top') expect(top.fiber).toBe('silk');
  });
});

describe('beginner instructions', () => {
  const skirt = make('a-line-skirt', 'british-heritage', 'cotton-poplin');
  const md = renderInstructionsMarkdown(skirt);
  const all = skirt.instructions.map((s) => `${s.title}\n${s.body}`).join('\n');

  it('makes the waistband closure essential and gives the band an underlap', () => {
    const hook = skirt.bom.find((b) => /hook/i.test(b.name))!;
    expect(hook.essential).toBe(true);
    expect(skirt.pieces.find((p) => p.id === 'waistband')!.edges.some((e) => e.id === 'ext-end')).toBe(true);
  });

  it('says how far from the edge to stitch the waistband ends, trimming before turning', () => {
    const ends = skirt.instructions.find((s) => s.seamIds.includes('waistband-ends'))!;
    expect(ends.body).toMatch(/1\.5 cm from the raw edge/);
    expect(ends.body.indexOf('Trim')).toBeLessThan(ends.body.indexOf('turn right side out'));
    const ditch = skirt.instructions.find((s) => s.seamIds.includes('waistband-inner'))!;
    expect(ditch.body).toMatch(/under by 1\.5 cm/);
    expect(ditch.body.match(/stitch in the ditch/gi)!.length).toBeLessThanOrEqual(2);
  });

  it('lists cloth for the recommended muslin, as an optional item', () => {
    const muslin = skirt.bom.find((b) => /muslin/i.test(b.name))!;
    expect(muslin.essential).toBe(false);
    expect(muslin.quantity).toBeGreaterThan(0.5);
  });

  it('talks about the edges that exist and the waist seam line, not topstitching', () => {
    expect(all).not.toMatch(/necklines?/i);
    expect(all).not.toMatch(/top stitching line/);
    expect(all).toMatch(/waist seam line/);
    expect(skirt.instructions.some((s) => /check and press .* below the zip/i.test(s.title))).toBe(false);
  });

  it('uses an easy double-turn hem on a beginner skirt in a stable woven', () => {
    expect(skirt.seams.filter((s) => s.type.startsWith('hem')).every((s) => s.type === 'hem-double-fold')).toBe(true);
  });

  it('adds the machine safety rule', () => {
    expect(skirt.instructions.flatMap((s) => s.warnings).join(' ')).toMatch(/Switch the machine off/);
  });

  it('tables only the measurements a skirt uses and keeps style details honest', () => {
    expect(md).not.toMatch(/\| Bust point distance \|/);
    expect(md).toMatch(/Not used by this a-line skirt/);
    const details = md.slice(md.indexOf('## Styling and finishing details'), md.indexOf('## Glossary'));
    const ideas = details.slice(details.indexOf('Ideas for a next version'));
    expect(ideas).toMatch(/In-seam pockets/);
    expect(details.slice(0, details.indexOf('Ideas for a next version'))).not.toMatch(/In-seam pockets/);
  });
});
