/**
 * Every garment drafts without throwing for small, mid and large/tall bodies
 * in a European and a Scandinavian combo, and its pattern passes the eval's
 * geometry and seam-matching checks.
 */
import { describe, expect, it } from 'vitest';
import { scoreGeometry, scoreSeams } from '../eval/metrics';
import { ALL_GARMENTS, designFor, expectAspectsPass } from './helpers';

const PROFILE_IDS = ['petite-pear', 'round-54', 'tall-hourglass'];
const GEOMETRY_ASPECTS = ['ids', 'closed', 'simple', 'area', 'encloses', 'edges', 'bounds', 'allowance'];
const SEAM_ASPECTS = ['ids', 'references', 'lengths', 'sleeve-cap'];

describe.each(ALL_GARMENTS)('%s', (garment) => {
  for (const key of ['eu', 'scandi'] as const) {
    it(`${key}: drafts valid geometry with matching seams for petite, plus-size and tall bodies`, { timeout: 30_000 }, () => {
      for (const pid of PROFILE_IDS) {
        const pkg = designFor(garment, pid, key);
        const ctx = `${garment}/${pid}/${key}`;
        expect(pkg.pieces.length, ctx).toBeGreaterThan(0);
        expect(pkg.seams.length, ctx).toBeGreaterThan(0);
        expect(pkg.pieces.every((p) => p.cutCount >= 1), ctx).toBe(true);
        expect(pkg.pieces.some((p) => p.layer === 'self'), ctx).toBe(true);
        expectAspectsPass(scoreGeometry(pkg), GEOMETRY_ASPECTS, ctx);
        expectAspectsPass(scoreSeams(pkg), SEAM_ASPECTS, ctx);
        expect(pkg.silhouette.torso.length, ctx).toBeGreaterThanOrEqual(3);
        expect(pkg.garment.id).toBe(garment);
      }
    });
  }

  it('stress combo (knit or evening fabric, non-default options) drafts valid geometry', { timeout: 30_000 }, () => {
    const pkg = designFor(garment, 'hourglass-plus-48', 'stress');
    expectAspectsPass(scoreGeometry(pkg), GEOMETRY_ASPECTS, `${garment}/stress`);
    expectAspectsPass(scoreSeams(pkg), SEAM_ASPECTS, `${garment}/stress`);
  });
});
