/**
 * Numeric sanity checks of the 3D output, used by the eval:
 *  - no NaN / Infinity in positions or normals, valid indices
 *  - vertex counts within sane bounds
 *  - garment-vs-body clearance per ring (every garment vertex at least
 *    MIN_CLEARANCE_CM radially outside every body part)
 *  - garment within the figure's height range
 * Runs in Node (no DOM).
 */
import type { BufferGeometry } from 'three';
import type { Vec3 } from './bodyModel';
import { MIN_CLEARANCE_CM, buildFigureGeometry, type FigureSource } from './garment';

export interface MeshValidation {
  ok: boolean;
  issues: string[];
  /** Non-blocking observations (e.g. silhouette rings tighter than the body). */
  warnings: string[];
  stats: {
    bodyVertices: number;
    garmentVertices: number;
    garmentParts: string[];
    /** Smallest radial fabric-to-body gap found (cm). */
    minClearanceCm: number;
    armAbductionDeg: number;
    ringsChecked: number;
  };
}

const MAX_LISTED = 12;

function checkFinite(geo: BufferGeometry, label: string, issues: string[]): void {
  for (const attr of ['position', 'normal'] as const) {
    const a = geo.getAttribute(attr);
    if (!a) {
      issues.push(`${label}: missing ${attr} attribute`);
      continue;
    }
    const arr = a.array as ArrayLike<number>;
    let bad = 0;
    for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i]!)) bad++;
    if (bad > 0) issues.push(`${label}: ${bad} non-finite ${attr} values (NaN/Infinity)`);
  }
  const index = geo.getIndex();
  const count = geo.getAttribute('position')?.count ?? 0;
  if (index) {
    const arr = index.array as ArrayLike<number>;
    let bad = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i]! >= count) bad++;
    if (bad > 0) issues.push(`${label}: ${bad} triangle indices out of range`);
    if (arr.length % 3 !== 0) issues.push(`${label}: index count ${arr.length} is not a multiple of 3`);
  }
}

/** Validate the meshes generated for a design package. */
export function validateMeshes(pkg: FigureSource): MeshValidation {
  const issues: string[] = [];
  const warnings: string[] = [];
  const stats: MeshValidation['stats'] = {
    bodyVertices: 0,
    garmentVertices: 0,
    garmentParts: [],
    minClearanceCm: Infinity,
    armAbductionDeg: 0,
    ringsChecked: 0,
  };

  let fig: ReturnType<typeof buildFigureGeometry>;
  try {
    fig = buildFigureGeometry(pkg);
  } catch (err) {
    return {
      ok: false,
      issues: [`3D build failed: ${err instanceof Error ? err.message : String(err)}`],
      warnings,
      stats,
    };
  }
  const { plan, body, garments } = fig;
  const model = plan.model;
  stats.armAbductionDeg = plan.armAbductionDeg;

  // ---- Body ---------------------------------------------------------------
  stats.bodyVertices = body.getAttribute('position').count;
  checkFinite(body, 'body', issues);
  if (stats.bodyVertices < 5000 || stats.bodyVertices > 300000) {
    issues.push(`body: vertex count ${stats.bodyVertices} outside the expected 5k–300k range`);
  }
  for (const [key, f] of Object.entries(model.fittedCircumferences)) {
    if (Math.abs(f.achieved - f.target) > 0.5) {
      issues.push(`body: ${key} girth ${f.achieved.toFixed(1)} cm does not match the measurement ${f.target.toFixed(1)} cm`);
    }
  }

  // ---- Garments -----------------------------------------------------------
  const sil = pkg.silhouette;
  if ((sil.torso?.length ?? 0) >= 2 && !garments.some((g) => g.name === 'garment-torso')) {
    issues.push('garment: silhouette has torso rings but no torso/skirt mesh was produced');
  }
  if ((sil.leg?.length ?? 0) >= 2 && garments.filter((g) => g.name.startsWith('garment-leg')).length !== 2) {
    issues.push('garment: silhouette has leg rings but two trouser-leg meshes were not produced');
  }
  if (sil.sleeve && sil.sleeve.lengthCm > 2 && garments.filter((g) => g.name.startsWith('sleeve')).length !== 2) {
    issues.push('garment: silhouette has sleeves but two sleeve meshes were not produced');
  }
  if (garments.length === 0) issues.push('garment: no garment geometry produced');

  const parts = model.parts;
  const listed: string[] = [];
  let failingRings = 0;
  for (const geo of garments) {
    const label = geo.name || 'garment';
    stats.garmentParts.push(label);
    const pos = geo.getAttribute('position');
    stats.garmentVertices += pos.count;
    checkFinite(geo, label, issues);
    if (pos.count < 200 || pos.count > 400000) {
      issues.push(`${label}: vertex count ${pos.count} outside the expected 200–400k range`);
    }
    // Per-ring clearance: rings are 1 cm height bands (along the arm for sleeves).
    const tube = plan.tubes.find((t) => t.name === label);
    const rings = new Map<number, { min: number; part: string | null; h: number }>();
    for (let i = 0; i < pos.count; i++) {
      const p: Vec3 = [pos.getX(i), pos.getY(i), pos.getZ(i)];
      if (!Number.isFinite(p[0] + p[1] + p[2])) continue;
      if (p[1] < -0.5 || p[1] > model.heightCm + 1) {
        issues.push(`${label}: vertex at height ${p[1].toFixed(1)} cm lies outside the figure (0–${model.heightCm} cm)`);
        break;
      }
      const { depth, part } = model.penetration(p, 0, parts);
      const gap = -depth;
      let ringKey: number;
      if (tube && tube.kind === 'sleeve') {
        const { origin: o, d } = tube.frame;
        ringKey = Math.round((p[0] - o[0]) * d[0] + (p[1] - o[1]) * d[1] + (p[2] - o[2]) * d[2]);
      } else ringKey = Math.round(p[1]);
      const cur = rings.get(ringKey);
      if (!cur || gap < cur.min) rings.set(ringKey, { min: gap, part, h: p[1] });
    }
    stats.ringsChecked += rings.size;
    for (const [key, r] of [...rings.entries()].sort((a, b) => b[0] - a[0])) {
      stats.minClearanceCm = Math.min(stats.minClearanceCm, r.min);
      if (r.min < MIN_CLEARANCE_CM - 1e-3) {
        failingRings++;
        if (listed.length < MAX_LISTED) {
          const where = tube?.kind === 'sleeve' ? `${key} cm along the arm` : `${key} cm from the floor`;
          listed.push(
            `${label}: ring at ${where} is ${r.min < 0 ? `${(-r.min).toFixed(2)} cm inside` : `only ${r.min.toFixed(2)} cm from`} the body (${r.part}); needs >= ${MIN_CLEARANCE_CM} cm`,
          );
        }
      }
    }
  }
  issues.push(...listed);
  if (failingRings > listed.length) issues.push(`…and ${failingRings - listed.length} more rings with insufficient clearance`);

  // ---- Silhouette consistency (warnings) -----------------------------------
  for (const ring of sil.torso ?? []) {
    if (ring.circumferenceCm < ring.bodyCircumferenceCm - 1) {
      warnings.push(
        `silhouette ring at ${ring.heightCm.toFixed(1)} cm is ${(ring.bodyCircumferenceCm - ring.circumferenceCm).toFixed(1)} cm smaller than the body; the 3D fabric was moved out to clear the body`,
      );
    }
  }

  for (const g of garments) g.dispose();
  body.dispose();
  if (!Number.isFinite(stats.minClearanceCm)) stats.minClearanceCm = 0;
  return { ok: issues.length === 0, issues, warnings, stats };
}
