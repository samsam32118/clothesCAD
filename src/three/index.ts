/**
 * clothesCAD 3D module.
 *
 * Geometry builders work in centimetres (y up, floor at y = 0, figure faces +z),
 * matching the core contract. Scenes and exports are in metres (the figure
 * group is scaled by 0.01), the glTF convention.
 *
 * Every function that takes a package accepts a full `DesignPackage` (or the
 * structural subset `FigureSource`). Everything except `mountViewer` runs in
 * Node without a DOM.
 *
 * Contract exports (ARCHITECTURE.md):
 *   buildBodyGeometry(measurements, landmarks) · buildGarmentGeometry(pkg)
 *   createDesignScene(pkg) · mountViewer(container, pkg) · exportGLB(pkg) · exportOBJ(pkg)
 */
export { buildBodyGeometry } from './body';
export { buildGarmentGeometry, buildFigureGeometry, planFigure, MIN_CLEARANCE_CM } from './garment';
export { createDesignScene, buildFigureGroup, disposeObject, CM_TO_M } from './scene';
export { mountViewer } from './viewer';
export { exportGLB, exportOBJ } from './export';
export { validateMeshes } from './validate';
export { createGarmentMaterial, createBodyMaterial } from './materials';
export { BodyModel } from './bodyModel';

export type { FigureSource, GarmentTube, FigurePlan, FigureGeometry } from './garment';
export type { DesignScene, DesignSceneOptions } from './scene';
export type { ViewerHandle, ViewerOptions, ViewName } from './viewer';
export type { MeshValidation } from './validate';
export type { BodyModelOptions } from './bodyModel';
