import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { buildBodyGeometry, buildGarmentGeometry, createDesignScene, exportGLB, exportOBJ, validateMeshes } from '../src/three';
import { scoreMesh3D } from '../eval/metrics';
import { designFor } from './helpers';

function positions(g: BufferGeometry): ArrayLike<number> {
  return g.getAttribute('position').array as ArrayLike<number>;
}

function allFinite(a: ArrayLike<number>): boolean {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}

describe('3D meshes (Node, no DOM)', () => {
  it('builds a finite body mesh as tall as the person', () => {
    const pkg = designFor('sheath-dress', 'tall-hourglass', 'eu');
    const body = buildBodyGeometry(pkg.measurements, pkg.body.landmarks);
    const p = positions(body);
    expect(p.length).toBeGreaterThan(3 * 1000);
    expect(allFinite(p)).toBe(true);
    body.computeBoundingBox();
    const bb = body.boundingBox!;
    const height = bb.max.y - bb.min.y;
    expect(Math.abs(height - pkg.measurements.heightCm) / pkg.measurements.heightCm).toBeLessThan(0.03);
    body.dispose();
  });

  it.each(['a-line-skirt', 'wide-leg-trousers', 'wrap-dress', 'ball-gown'] as const)('%s: garment meshes are finite and clear the body', { timeout: 30_000 }, (g) => {
    const pkg = designFor(g, 'round-54', 'eu');
    const garments = buildGarmentGeometry(pkg);
    expect(garments.length).toBeGreaterThan(0);
    for (const geo of garments) {
      expect(allFinite(positions(geo))).toBe(true);
      geo.dispose();
    }
    const v = validateMeshes(pkg);
    expect(v.issues).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.stats.minClearanceCm).toBeGreaterThanOrEqual(0);
    const score = scoreMesh3D(pkg);
    expect(score.details.filter((d) => !d.startsWith('(warning)'))).toEqual([]);
  });

  it('builds a scene that can be disposed', () => {
    const pkg = designFor('shift-dress', 'petite-pear', 'eu');
    const { scene, dispose } = createDesignScene(pkg);
    let meshes = 0;
    scene.traverse((o) => {
      if ((o as { isMesh?: boolean }).isMesh) meshes++;
    });
    expect(meshes).toBeGreaterThanOrEqual(2);
    expect(() => dispose()).not.toThrow();
  });

  it('exports OBJ text and binary glTF', { timeout: 30_000 }, async () => {
    const pkg = designFor('pencil-skirt', 'hourglass-38', 'eu');
    const obj = exportOBJ(pkg);
    expect(obj.length).toBeGreaterThan(1000);
    expect(obj).toMatch(/^v /m);
    expect(obj).toMatch(/^f /m);
    expect(obj).not.toMatch(/NaN|Infinity/);
    const glb = await exportGLB(pkg);
    expect(glb.byteLength).toBeGreaterThan(1000);
    const magic = new TextDecoder().decode(new Uint8Array(glb, 0, 4));
    expect(magic).toBe('glTF');
  });
});
