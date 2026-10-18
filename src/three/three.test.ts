import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { resolveMeasurements, computeLandmarks } from '../core/measurements';
import { design } from '../core/design';
import { GARMENTS, MATERIALS, STYLES } from '../core/presets';
import {
  BodyModel,
  buildBodyGeometry,
  buildGarmentGeometry,
  createDesignScene,
  exportGLB,
  exportOBJ,
  planFigure,
  validateMeshes,
} from './index';
import {
  FIXTURE_KINDS,
  FIXTURE_MATERIALS,
  REFERENCE_LANDMARKS,
  REFERENCE_MEASUREMENTS,
  fixtureSource,
} from './fixtures';

function allFinite(geo: BufferGeometry): boolean {
  const arr = geo.getAttribute('position').array as ArrayLike<number>;
  for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i]!)) return false;
  return true;
}

describe('body model', () => {
  it('matches measured girths at the landmark stations', () => {
    const model = new BodyModel(REFERENCE_MEASUREMENTS, REFERENCE_LANDMARKS);
    for (const f of Object.values(model.fittedCircumferences)) {
      expect(Math.abs(f.achieved - f.target)).toBeLessThan(0.2);
    }
  });

  it('builds a finite, outward-facing mannequin of the right height', () => {
    const geo = buildBodyGeometry(REFERENCE_MEASUREMENTS, REFERENCE_LANDMARKS);
    expect(allFinite(geo)).toBe(true);
    geo.computeBoundingBox();
    const box = geo.boundingBox!;
    expect(box.min.y).toBeGreaterThanOrEqual(-0.01);
    expect(box.max.y).toBeCloseTo(REFERENCE_MEASUREMENTS.heightCm, 0);
    // A point on the front of the bust has a normal pointing forward (+z).
    const pos = geo.getAttribute('position');
    const nor = geo.getAttribute('normal');
    let best = -1;
    let bestZ = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getY(i) - REFERENCE_LANDMARKS.waist) < 1 && pos.getZ(i) > bestZ) {
        bestZ = pos.getZ(i);
        best = i;
      }
    }
    expect(best).toBeGreaterThanOrEqual(0);
    expect(nor.getZ(best)).toBeGreaterThan(0.8);
  });
});

describe('garments', () => {
  it.each(FIXTURE_KINDS)('%s clears the body and has sane meshes', (kind) => {
    const v = validateMeshes(fixtureSource(kind, FIXTURE_MATERIALS.wool));
    expect(v.issues).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.stats.minClearanceCm).toBeGreaterThanOrEqual(0.5);
  });

  it('works for very different bodies', () => {
    const bodies = [
      { heightCm: 150, bustCm: 118, waistCm: 104, hipCm: 126 },
      { heightCm: 188, bustCm: 80, waistCm: 61, hipCm: 86 },
      { heightCm: 163, bustCm: 86, waistCm: 70, hipCm: 112 },
      { heightCm: 170, bustCm: 150, waistCm: 138, hipCm: 160 },
    ];
    for (const m of bodies) {
      const r = resolveMeasurements(m);
      const L = computeLandmarks(r);
      for (const kind of ['ball-gown', 'wide-leg-trousers', 'sheath-dress'] as const) {
        const v = validateMeshes(fixtureSource(kind, FIXTURE_MATERIALS.silk, r, L));
        expect(v.issues, `${kind} on ${JSON.stringify(m)}`).toEqual([]);
      }
    }
  });

  it('never puts fabric inside the body even when the silhouette is too tight', () => {
    const src = fixtureSource('pencil-skirt');
    const tight = {
      ...src,
      silhouette: {
        ...src.silhouette,
        torso: src.silhouette.torso.map((r) => ({ ...r, circumferenceCm: r.bodyCircumferenceCm - 8 })),
      },
    };
    const v = validateMeshes(tight);
    expect(v.ok).toBe(true);
    expect(v.warnings.length).toBeGreaterThan(0);
  });

  it('produces one mesh per garment part', () => {
    const names = (kind: Parameters<typeof fixtureSource>[0]) =>
      buildGarmentGeometry(fixtureSource(kind) as never).map((g) => g.name);
    expect(names('a-line-skirt')).toEqual(['garment-torso']);
    expect(names('wide-leg-trousers')).toEqual(['garment-torso', 'garment-leg-left', 'garment-leg-right']);
    expect(names('sheath-dress')).toEqual(['garment-torso', 'sleeve-left', 'sleeve-right']);
  });

  it('drapes soft fabric in deeper folds than crisp fabric, with no folds at the waist', () => {
    const hemRelief = (mat: keyof typeof FIXTURE_MATERIALS) => {
      const plan = planFigure(fixtureSource('circle-skirt', FIXTURE_MATERIALS[mat]));
      const t = plan.tubes[0]!;
      const row = (i: number) => Array.from(t.radius.subarray(i * t.cols, (i + 1) * t.cols));
      const relief = (r: number[]) => {
        // Peak-to-peak of the high-frequency part (radius minus a moving average).
        const w = Math.max(3, Math.round(t.cols / 24));
        let max = 0;
        for (let j = 0; j < r.length; j++) {
          let avg = 0;
          for (let k = -w; k <= w; k++) avg += r[(j + k + r.length) % r.length]!;
          max = Math.max(max, Math.abs(r[j]! - avg / (2 * w + 1)));
        }
        return max;
      };
      return { hem: relief(row(t.nS - 1)), waist: relief(row(0)) };
    };
    const silk = hemRelief('silk');
    const taffeta = hemRelief('taffeta');
    expect(silk.hem).toBeGreaterThan(taffeta.hem);
    expect(silk.hem).toBeGreaterThan(1);
    expect(silk.waist).toBeLessThan(0.3);
  });

  it('lets fluid fabric fall closer to the body than crisp fabric; a ball gown keeps its supported bell', () => {
    const meanHemRadius = (src: Parameters<typeof planFigure>[0]) => {
      const t = planFigure(src).tubes[0]!;
      const row = t.radius.subarray((t.nS - 1) * t.cols, t.nS * t.cols);
      return row.reduce((a, b) => a + b, 0) / row.length;
    };
    const soft = meanHemRadius(fixtureSource('circle-skirt', FIXTURE_MATERIALS.silk));
    const crisp = meanHemRadius(fixtureSource('circle-skirt', FIXTURE_MATERIALS.taffeta));
    expect(crisp).toBeGreaterThan(soft + 5);
    const gown = fixtureSource('ball-gown', FIXTURE_MATERIALS.silk);
    const loose = meanHemRadius(gown);
    const supported = meanHemRadius({ ...gown, garment: { id: 'ball-gown', category: 'gown' } });
    expect(supported).toBeGreaterThan(loose + 5);
  });

  it('is deterministic', () => {
    const a = buildGarmentGeometry(fixtureSource('ball-gown', FIXTURE_MATERIALS.silk) as never);
    const b = buildGarmentGeometry(fixtureSource('ball-gown', FIXTURE_MATERIALS.silk) as never);
    expect(a.length).toBe(b.length);
    const pa = a[0]!.getAttribute('position').array as Float32Array;
    const pb = b[0]!.getAttribute('position').array as Float32Array;
    expect(pa.length).toBe(pb.length);
    expect(Buffer.from(pa.buffer).equals(Buffer.from(pb.buffer))).toBe(true);
  });
});

describe('scene and export', () => {
  it('creates a lit scene and rebuilds only the garment on update', () => {
    const s = createDesignScene(fixtureSource('a-line-skirt') as never);
    expect(s.scene.getObjectByName('key')).toBeTruthy();
    expect(s.scene.getObjectByName('hemisphere')).toBeTruthy();
    expect(s.scene.getObjectByName('shadow-catcher')).toBeTruthy();
    const body = s.figure.getObjectByName('body') as unknown as { geometry: BufferGeometry };
    const bodyGeo = body.geometry;
    expect(s.bounds.max.y).toBeCloseTo(1.68, 2);
    s.update(fixtureSource('pencil-skirt', FIXTURE_MATERIALS.linen));
    expect(body.geometry).toBe(bodyGeo);
    s.update(fixtureSource('ball-gown', FIXTURE_MATERIALS.silk)); // wider skirt: arms re-posed
    expect(s.armAbductionDeg).toBeGreaterThan(10);
    s.dispose();
  });

  it('exports a valid binary glTF in Node', async () => {
    const glb = await exportGLB(fixtureSource('sheath-dress') as never);
    const view = new DataView(glb);
    expect(view.getUint32(0, true)).toBe(0x46546c67); // 'glTF'
    expect(view.getUint32(4, true)).toBe(2);
    expect(view.getUint32(8, true)).toBe(glb.byteLength);
    const jsonLen = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLen))) as {
      nodes: Array<{ name?: string }>;
      meshes: unknown[];
    };
    expect(json.meshes.length).toBeGreaterThanOrEqual(4);
    const names = json.nodes.map((n) => n.name);
    expect(names).toContain('body');
    expect(names).toContain('garment-torso');
  });

  it('exports OBJ in metres', () => {
    const obj = exportOBJ(fixtureSource('wide-leg-trousers') as never);
    expect(obj).toMatch(/^# clothesCAD export/);
    expect(obj).toContain('o body');
    expect(obj).toContain('o garment-leg-left');
    let maxY = 0;
    for (const line of obj.split('\n')) {
      if (line.startsWith('v ')) maxY = Math.max(maxY, Number(line.split(' ')[2]));
    }
    expect(maxY).toBeGreaterThan(1.6);
    expect(maxY).toBeLessThan(1.7);
  });
});

describe('real design pipeline', () => {
  it('every garment type yields valid, body-clearing meshes', () => {
    const measurements = { heightCm: 166, bustCm: 94, waistCm: 76, hipCm: 102 };
    for (const g of GARMENTS) {
      const mat = MATERIALS.find((m) => m.suitableFor.includes(g.id)) ?? MATERIALS[0]!;
      const style = STYLES.find((st) => st.recommendedGarments.includes(g.id)) ?? STYLES[0]!;
      const pkg = design({ measurements, garment: g.id, styleId: style.id, materialId: mat.id });
      const v = validateMeshes(pkg);
      expect(v.issues, `${g.id} / ${mat.id}`).toEqual([]);
      expect(v.stats.garmentVertices).toBeGreaterThan(0);
    }
    // Eleven full design pipelines: allow for a loaded CI machine running other test files in parallel.
  }, 60_000);
});
