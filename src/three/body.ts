/**
 * Mannequin body mesh built from the parametric BodyModel.
 * Units: centimetres, y up, floor at y = 0, figure faces +z.
 */
import type { BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BodyLandmarks, ResolvedMeasurements } from '../core/types';
import { BodyModel, type BodyModelOptions } from './bodyModel';
import { tubePartGeometry } from './grid';

/** Mesh every part of a body model and merge into one geometry (smooth normals per part). */
export function bodyGeometryFromModel(model: BodyModel): BufferGeometry {
  const geos = model.parts.map((p) => tubePartGeometry(p));
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) throw new Error('clothesCAD 3D: failed to merge body geometry');
  merged.name = 'body';
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  merged.userData = {
    kind: 'body',
    heightCm: model.heightCm,
    armAbductionDeg: model.armAbductionDeg,
  };
  return merged;
}

/**
 * Parametric female mannequin lofted from elliptical cross-sections at the
 * body landmarks; girths match the (resolved) measurements.
 */
export function buildBodyGeometry(
  measurements: ResolvedMeasurements,
  landmarks: BodyLandmarks,
  options: BodyModelOptions = {},
): BufferGeometry {
  return bodyGeometryFromModel(new BodyModel(measurements, landmarks, options));
}
