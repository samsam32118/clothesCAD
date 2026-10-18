import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGesture } from '@use-gesture/react';
import { Fit, Minus, Plus } from './icons';

interface View {
  x: number;
  y: number;
  scale: number;
}

const MIN = 0.5;
const MAX = 16;
/** Pixels of the drawing that always stay inside the frame while panning. */
const KEEP_VISIBLE = 48;
const FIT: View = { x: 0, y: 0, scale: 1 };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Width/height ratio of an SVG from its viewBox (falls back to A-series portrait). */
export function svgAspect(svg: string): number {
  const m = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(svg);
  const w = m ? Number(m[1]) : NaN;
  const h = m ? Number(m[2]) : NaN;
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w / h : 1 / Math.SQRT2;
}

/**
 * Pinch / drag / wheel pan-zoom around trusted SVG markup produced by
 * src/core/svg. Scale 1 (100 %) is the whole drawing fitted inside the frame;
 * the frame takes the drawing's aspect ratio (capped at 70 % of the viewport
 * height), so nothing is clipped and there is no dead space on first view.
 * The view re-fits on resize until the user pans or zooms.
 */
export function PanZoom({ svg, label, resetKey }: { svg: string; label: string; resetKey?: unknown }) {
  const frame = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FIT);
  const viewRef = useRef(view);
  viewRef.current = view;
  const touched = useRef(false);
  const aspect = useMemo(() => svgAspect(svg), [svg]);

  const fit = useCallback(() => {
    touched.current = false;
    setView(FIT);
  }, []);

  useEffect(fit, [resetKey, fit]);

  // Keep the drawing fitted while the frame changes size (rotation, resize), unless the user moved it.
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!touched.current) setView(FIT);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Keep part of the drawing on screen whatever the pan. */
  const bound = useCallback((v: View): View => {
    const r = frame.current?.getBoundingClientRect();
    if (!r) return v;
    const w = r.width * v.scale;
    const h = r.height * v.scale;
    return {
      scale: v.scale,
      x: clamp(v.x, KEEP_VISIBLE - w, r.width - KEEP_VISIBLE),
      y: clamp(v.y, KEEP_VISIBLE - h, r.height - KEEP_VISIBLE),
    };
  }, []);

  const apply = useCallback(
    (next: View | ((v: View) => View)) => {
      touched.current = true;
      setView((v) => bound(typeof next === 'function' ? next(v) : next));
    },
    [bound],
  );

  /** Zoom by factor k keeping the frame-local point (px, py) fixed. */
  const zoomAt = useCallback(
    (k: number, px: number, py: number) => {
      apply((v) => {
        const scale = clamp(v.scale * k, MIN, MAX);
        const f = scale / v.scale;
        return { scale, x: px - (px - v.x) * f, y: py - (py - v.y) * f };
      });
    },
    [apply],
  );

  const zoomCentre = (k: number) => {
    const r = frame.current?.getBoundingClientRect();
    zoomAt(k, (r?.width ?? 0) / 2, (r?.height ?? 0) / 2);
  };

  useGesture(
    {
      onDrag: ({ offset: [x, y], pinching, cancel, tap }) => {
        if (pinching) {
          cancel();
          return;
        }
        if (tap) return;
        apply((v) => ({ ...v, x, y }));
      },
      onPinch: ({ origin: [ox, oy], first, offset: [s], memo }) => {
        const rect = frame.current!.getBoundingClientRect();
        const m = (first || !memo ? { ...viewRef.current, px: ox - rect.left, py: oy - rect.top } : memo) as View & { px: number; py: number };
        const f = s / m.scale;
        apply({ scale: s, x: m.px - (m.px - m.x) * f, y: m.py - (m.py - m.y) * f });
        return m;
      },
      onWheel: ({ event, delta: [, dy] }) => {
        if (event.ctrlKey) return; // trackpad pinch arrives as onPinch
        event.preventDefault();
        const rect = frame.current!.getBoundingClientRect();
        zoomAt(Math.exp(-dy * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
      },
    },
    {
      target: frame,
      eventOptions: { passive: false },
      drag: { from: () => [viewRef.current.x, viewRef.current.y], filterTaps: true },
      pinch: { from: () => [viewRef.current.scale, 0], scaleBounds: { min: MIN, max: MAX }, rubberband: true },
    },
  );

  const onKey = (e: React.KeyboardEvent) => {
    const step = 40;
    if (e.key === '+' || e.key === '=') zoomCentre(1.25);
    else if (e.key === '-') zoomCentre(0.8);
    else if (e.key === '0') fit();
    else if (e.key === 'ArrowLeft') apply((v) => ({ ...v, x: v.x + step }));
    else if (e.key === 'ArrowRight') apply((v) => ({ ...v, x: v.x - step }));
    else if (e.key === 'ArrowUp') apply((v) => ({ ...v, y: v.y + step }));
    else if (e.key === 'ArrowDown') apply((v) => ({ ...v, y: v.y - step }));
    else return;
    e.preventDefault();
  };

  const fitted = view.scale === 1 && view.x === 0 && view.y === 0;
  return (
    <div className="panzoom">
      <div
        ref={frame}
        className="sheet-frame"
        style={{ aspectRatio: `${aspect}` }}
        role="img"
        aria-label={`${label}. Drag to move, pinch or scroll to zoom, or use + and - keys.`}
        tabIndex={0}
        onKeyDown={onKey}
      >
        <div
          className="canvas"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          // Markup comes from our own deterministic renderer (escaped text), never from user HTML.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="zoom-bar">
        <span className="zoom-level" aria-live="polite">
          {fitted ? 'Whole sheet' : `${Math.round(view.scale * 100)}%`}
        </span>
        <span className="hint hide-mobile">Drag to move · scroll or pinch to zoom</span>
        <div className="zoom-controls">
          <button type="button" className="icon-btn" aria-label="Zoom out" onClick={() => zoomCentre(1 / 1.4)}>
            <Minus width={20} height={20} />
          </button>
          <button type="button" className="icon-btn" aria-label="Zoom in" onClick={() => zoomCentre(1.4)}>
            <Plus width={20} height={20} />
          </button>
          <button type="button" className="icon-btn" aria-label="Fit whole sheet" onClick={fit} disabled={fitted}>
            <Fit width={20} height={20} />
          </button>
        </div>
      </div>
    </div>
  );
}
