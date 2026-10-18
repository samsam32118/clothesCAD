/**
 * Interactive WebGL viewer (browser only). Nothing here touches the DOM or
 * WebGL at module load, so importing it from Node is harmless; calling
 * `mountViewer` requires a browser.
 */
import {
  ACESFilmicToneMapping,
  Box3,
  PCFSoftShadowMap,
  PerspectiveCamera,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { FigureSource } from './garment';
import { createDesignScene } from './scene';

export interface ViewerHandle {
  /** Show a new design; the body is rebuilt only if measurements/pose changed. */
  update(pkg: FigureSource): void;
  dispose(): void;
  /** Re-frame the camera on the figure (front three-quarter view). */
  resetView(): void;
  setAutoRotate(on: boolean): void;
  /** Move the camera to a preset view and re-frame the figure. */
  setView(view: ViewName): void;
}

export type ViewName = 'three-quarter' | 'front' | 'side' | 'back';

const VIEW_DIRECTIONS: Record<ViewName, [number, number, number]> = {
  'three-quarter': [0.38, 0.12, 1],
  front: [0, 0.08, 1],
  side: [1, 0.08, 0],
  back: [0, 0.08, -1],
};

export interface ViewerOptions {
  autoRotate?: boolean;
  /** Clear colour; default transparent (the page background shows through). */
  background?: string | null;
  /** Initial camera view (default three-quarter). */
  view?: ViewName;
}

const FOV = 30;

/**
 * Mount a responsive 3D viewer in `container`: orbit with one finger / mouse,
 * pinch or wheel to zoom, two-finger pan; camera auto-fits the figure height.
 */
export function mountViewer(container: HTMLElement, pkg: FigureSource, options: ViewerOptions = {}): ViewerHandle {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    const msg = document.createElement('div');
    msg.setAttribute('role', 'note');
    msg.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;padding:16px;text-align:center;font:14px/1.4 system-ui,sans-serif;opacity:.75';
    msg.textContent = '3D preview is unavailable on this device (WebGL could not start). Patterns and instructions are unaffected.';
    container.appendChild(msg);
    console.warn('clothesCAD viewer: WebGL unavailable', err);
    return {
      update() {},
      dispose() {
        msg.remove();
      },
      resetView() {},
      setAutoRotate() {},
      setView() {},
    };
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  if (options.background) renderer.setClearColor(options.background, 1);
  else renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.touchAction = 'none';
  canvas.setAttribute('aria-label', '3D preview of the garment on a mannequin. Drag to rotate, pinch to zoom.');
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(canvas);

  const design = createDesignScene(pkg);
  const camera = new PerspectiveCamera(FOV, 1, 0.05, 50);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.8;
  controls.zoomSpeed = 0.9;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.maxPolarAngle = Math.PI * 0.53; // just below the horizon: never under the floor
  controls.minPolarAngle = Math.PI * 0.08;
  controls.autoRotateSpeed = 1.2;
  controls.autoRotate = options.autoRotate ?? false;

  let userMoved = false;
  let view: ViewName = options.view ?? 'three-quarter';
  let dirty = true;
  let frame = 0;
  let disposed = false;

  const size = { w: 1, h: 1 };
  const fit = () => {
    const box = new Box3().setFromObject(design.figure);
    const centre = box.getCenter(new Vector3());
    const dims = box.getSize(new Vector3());
    const vFov = (FOV * Math.PI) / 180;
    const aspect = size.w / size.h;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const margin = 1.12;
    const distV = (dims.y * margin) / 2 / Math.tan(vFov / 2);
    const distH = (Math.max(dims.x, dims.z) * margin) / 2 / Math.tan(hFov / 2);
    const dist = Math.max(distV, distH) + dims.z / 2;
    const dir = new Vector3(...VIEW_DIRECTIONS[view]).normalize();
    controls.target.copy(centre);
    camera.position.copy(centre).addScaledVector(dir, dist);
    camera.near = Math.max(0.01, dist / 100);
    camera.far = dist * 20;
    camera.updateProjectionMatrix();
    controls.minDistance = dims.y * 0.25;
    controls.maxDistance = dist * 3;
    controls.update();
    dirty = true;
  };

  const resize = () => {
    const w = Math.max(1, Math.round(container.clientWidth));
    const h = Math.max(1, Math.round(container.clientHeight || w * 1.25));
    if (w === size.w && h === size.h) return;
    size.w = w;
    size.h = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!userMoved) fit();
    dirty = true;
  };

  const onStart = () => {
    userMoved = true;
    if (controls.autoRotate) controls.autoRotate = false;
  };
  const onChange = () => {
    dirty = true;
  };
  controls.addEventListener('start', onStart);
  controls.addEventListener('change', onChange);

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(container);
  const onWindowResize = () => resize();
  if (!ro) window.addEventListener('resize', onWindowResize);
  const onVisibility = () => {
    if (!document.hidden) dirty = true;
  };
  document.addEventListener('visibilitychange', onVisibility);
  resize();
  fit();

  const loop = () => {
    if (disposed) return;
    frame = requestAnimationFrame(loop);
    if (document.hidden) return;
    const moved = controls.update();
    if (moved || dirty || controls.autoRotate) {
      renderer.render(design.scene, camera);
      dirty = false;
    }
  };
  frame = requestAnimationFrame(loop);

  return {
    update(next: FigureSource) {
      if (disposed) return;
      const prevHeight = design.heightM;
      design.update(next);
      if (!userMoved || Math.abs(design.heightM - prevHeight) > 1e-6) fit();
      dirty = true;
    },
    resetView() {
      userMoved = false;
      fit();
    },
    setView(next: ViewName) {
      if (disposed) return;
      view = next;
      userMoved = false;
      fit();
    },
    setAutoRotate(on: boolean) {
      controls.autoRotate = on;
      dirty = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      ro?.disconnect();
      if (!ro) window.removeEventListener('resize', onWindowResize);
      document.removeEventListener('visibilitychange', onVisibility);
      controls.removeEventListener('start', onStart);
      controls.removeEventListener('change', onChange);
      controls.dispose();
      design.dispose();
      renderer.renderLists.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
