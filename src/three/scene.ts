/**
 * Design scene: posed mannequin + garment, soft studio lighting and a ground
 * shadow. Geometry is authored in centimetres; the `figure` group scales it
 * to metres (glTF convention), so everything in the scene is in metres.
 * Builds in Node (no DOM): the ground gradient is a procedurally filled DataTexture.
 */
import {
  CircleGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  RGBAFormat,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Box3,
  Vector3,
  type BufferGeometry,
  type Material,
  type Texture,
} from 'three';
import { bodyGeometryFromModel } from './body';
import { garmentTubeGeometry, planFigure, type FigureSource } from './garment';
import { createBodyMaterial, createGarmentMaterial } from './materials';

export const CM_TO_M = 0.01;

export interface FigureObjects {
  /** Group in metres containing `body` and the `garment` group. */
  figure: Group;
  body: Mesh;
  garments: Mesh[];
  armAbductionDeg: number;
}

function bodyKey(src: FigureSource, armAbductionDeg: number): string {
  return JSON.stringify([src.measurements, src.body.landmarks, armAbductionDeg]);
}

/** Build the figure (body + garment meshes) as a self-contained group in metres. */
export function buildFigureGroup(src: FigureSource): FigureObjects {
  const plan = planFigure(src);
  const figure = new Group();
  figure.name = 'clothesCAD-figure';
  figure.scale.setScalar(CM_TO_M);
  const body = new Mesh(bodyGeometryFromModel(plan.model), createBodyMaterial());
  body.name = 'body';
  body.castShadow = true;
  body.receiveShadow = true;
  figure.add(body);
  const garmentGroup = new Group();
  garmentGroup.name = 'garment';
  figure.add(garmentGroup);
  const fabric = createGarmentMaterial(src.material);
  const garments = plan.tubes.map((t) => {
    const mesh = new Mesh(garmentTubeGeometry(t), fabric);
    mesh.name = t.name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    garmentGroup.add(mesh);
    return mesh;
  });
  figure.userData = { units: 'm', sourceUnits: 'cm', armAbductionDeg: plan.armAbductionDeg, bodyKey: bodyKey(src, plan.armAbductionDeg) };
  figure.updateMatrixWorld(true);
  return { figure, body, garments, armAbductionDeg: plan.armAbductionDeg };
}

/** Dispose every geometry, material and texture under `root`. */
export function disposeObject(root: Object3D): void {
  const geos = new Set<BufferGeometry>();
  const mats = new Set<Material>();
  const texs = new Set<Texture>();
  root.traverse((o) => {
    const mesh = o as Partial<Mesh>;
    if (mesh.geometry) geos.add(mesh.geometry as BufferGeometry);
    const m = mesh.material as Material | Material[] | undefined;
    if (m) for (const mm of Array.isArray(m) ? m : [m]) mats.add(mm);
  });
  for (const m of mats) {
    for (const v of Object.values(m as unknown as Record<string, unknown>)) {
      if (v && typeof v === 'object' && (v as Texture).isTexture) texs.add(v as Texture);
    }
  }
  geos.forEach((g) => g.dispose());
  mats.forEach((m) => m.dispose());
  texs.forEach((t) => t.dispose());
}

function radialShadowTexture(size = 64): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const r = Math.min(1, Math.hypot(dx, dy) * 2);
      const a = Math.pow(1 - r, 1.8);
      const k = (y * size + x) * 4;
      data[k] = 40;
      data[k + 1] = 34;
      data[k + 2] = 30;
      data[k + 3] = Math.round(255 * a);
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat);
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export interface DesignScene {
  scene: Scene;
  /** Body + garment group in metres (feet at y = 0, centred on x/z = 0). */
  figure: Group;
  /** Figure bounds in metres. */
  bounds: Box3;
  heightM: number;
  armAbductionDeg: number;
  /** Rebuild the garment for a new package; the body is rebuilt only if measurements or pose change. */
  update(pkg: FigureSource): void;
  dispose(): void;
}

export interface DesignSceneOptions {
  /** Add studio lights (default true). */
  lights?: boolean;
  /** Add the ground shadow disc (default true). */
  ground?: boolean;
}

/** Scene with soft studio lighting (hemisphere + key/fill/rim), ground shadow, body and garment. */
export function createDesignScene(pkg: FigureSource, options: DesignSceneOptions = {}): DesignScene {
  const scene = new Scene();
  scene.name = 'clothesCAD';
  const owned: Object3D[] = [];

  if (options.lights !== false) {
    const hemi = new HemisphereLight(new Color('#fdfaf5'), new Color('#b4ab9e'), 1.15);
    hemi.name = 'hemisphere';
    const key = new DirectionalLight(new Color('#fff2e3'), 2.3);
    key.name = 'key';
    key.position.set(1.9, 3.4, 2.7);
    key.target.position.set(0, 0.9, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -1.2;
    key.shadow.camera.right = 1.2;
    key.shadow.camera.top = 2.2;
    key.shadow.camera.bottom = -0.6;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 8;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 5;
    const fill = new DirectionalLight(new Color('#e6edfb'), 0.75);
    fill.name = 'fill';
    fill.position.set(-3.0, 1.8, 2.2);
    fill.target.position.set(0, 0.9, 0);
    const rim = new DirectionalLight(new Color('#ffffff'), 1.5);
    rim.name = 'rim';
    rim.position.set(-1.2, 2.9, -3.4);
    rim.target.position.set(0, 1.0, 0);
    const rim2 = new DirectionalLight(new Color('#fff7ee'), 0.9);
    rim2.name = 'rim-2';
    rim2.position.set(1.6, 2.4, -3.0);
    rim2.target.position.set(0, 1.0, 0);
    for (const l of [hemi, key, key.target, fill, fill.target, rim, rim.target, rim2, rim2.target]) {
      scene.add(l);
      owned.push(l);
    }
  }

  if (options.ground !== false) {
    const contact = new Mesh(
      new CircleGeometry(0.55, 64),
      new MeshBasicMaterial({ map: radialShadowTexture(), transparent: true, depthWrite: false, opacity: 0.55 }),
    );
    contact.name = 'contact-shadow';
    contact.rotation.x = -Math.PI / 2;
    contact.position.y = 0.001;
    contact.renderOrder = -1;
    const catcher = new Mesh(new CircleGeometry(1.4, 64), new ShadowMaterial({ opacity: 0.16, depthWrite: false }));
    catcher.name = 'shadow-catcher';
    catcher.rotation.x = -Math.PI / 2;
    catcher.position.y = 0.002;
    catcher.receiveShadow = true;
    scene.add(contact, catcher);
    owned.push(contact, catcher);
  }

  let current = buildFigureGroup(pkg);
  scene.add(current.figure);
  const bounds = new Box3();
  const state: DesignScene = {
    scene,
    figure: current.figure,
    bounds,
    heightM: pkg.measurements.heightCm * 0.01,
    armAbductionDeg: current.armAbductionDeg,
    update(next: FigureSource) {
      const plan = planFigure(next);
      const key = bodyKey(next, plan.armAbductionDeg);
      const fig = current.figure;
      const garmentGroup = fig.getObjectByName('garment') as Group;
      // Garment: always rebuilt.
      disposeObject(garmentGroup);
      garmentGroup.clear();
      const fabric = createGarmentMaterial(next.material);
      const garments = plan.tubes.map((t) => {
        const mesh = new Mesh(garmentTubeGeometry(t), fabric);
        mesh.name = t.name;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        garmentGroup.add(mesh);
        return mesh;
      });
      // Body: only when measurements or the arm pose changed.
      if (fig.userData.bodyKey !== key) {
        current.body.geometry.dispose();
        current.body.geometry = bodyGeometryFromModel(plan.model);
        fig.userData.bodyKey = key;
        fig.userData.armAbductionDeg = plan.armAbductionDeg;
      }
      current = { figure: fig, body: current.body, garments, armAbductionDeg: plan.armAbductionDeg };
      state.armAbductionDeg = plan.armAbductionDeg;
      state.heightM = next.measurements.heightCm * 0.01;
      fig.updateMatrixWorld(true);
      bounds.setFromObject(fig);
    },
    dispose() {
      disposeObject(scene);
      for (const o of owned) o.removeFromParent();
      scene.clear();
    },
  };
  bounds.setFromObject(current.figure);
  return state;
}

/** Centre of the figure bounds (m) — convenient camera target. */
export function figureTarget(bounds: Box3): Vector3 {
  const c = new Vector3();
  bounds.getCenter(c);
  return c;
}
