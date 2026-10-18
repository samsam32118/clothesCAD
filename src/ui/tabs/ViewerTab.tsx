import { useEffect, useRef, useState } from 'react';
import type { DesignPackage } from '../../core/types';
import type { ViewName, ViewerHandle } from '../../three';
import { glbFile, objFile } from '../../console/exports';
import { EmptyState, PageHead, Segmented } from '../components/controls';
import { useActions, useApp, useToast } from '../context';
import { downloadFile } from '../download';

type Status = 'loading' | 'ready' | 'error';

/** The three.js viewer is loaded on demand so the main bundle stays small. */
function Viewer({ pkg }: { pkg: DesignPackage }) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<ViewerHandle | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewName>('three-quarter');
  const [spin, setSpin] = useState(false);
  const latest = useRef(pkg);
  latest.current = pkg;

  useEffect(() => {
    let cancelled = false;
    import('../../three')
      .then(({ mountViewer }) => {
        if (cancelled || !host.current) return;
        handle.current = mountViewer(host.current, latest.current, { view: 'three-quarter' });
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      });
    return () => {
      cancelled = true;
      handle.current?.dispose();
      handle.current = null;
    };
  }, []);

  useEffect(() => {
    if (!handle.current) return;
    try {
      handle.current.update(pkg);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, [pkg]);

  return (
    <div className="viewer-frame">
      <div ref={host} className="viewer-host" role="img" aria-label={`3D model of ${pkg.name} on your figure. Drag to turn, pinch to zoom.`} />
      {status !== 'ready' ? (
        <div className="viewer-overlay" aria-live="polite">
          {status === 'loading' ? 'Loading 3D model…' : `3D preview unavailable: ${error ?? 'unknown error'}`}
        </div>
      ) : (
        <div className="viewer-views">
          <Segmented
            label="Camera view"
            value={view}
            options={[
              { value: 'front', label: 'Front' },
              { value: 'three-quarter', label: '¾' },
              { value: 'side', label: 'Side' },
              { value: 'back', label: 'Back' },
            ]}
            onChange={(v) => {
              setView(v);
              handle.current?.setView(v);
            }}
          />
        </div>
      )}
      {status === 'ready' ? (
        <button
          type="button"
          className="btn small viewer-spin"
          aria-pressed={spin}
          onClick={() => {
            setSpin(!spin);
            handle.current?.setAutoRotate(!spin);
          }}
        >
          {spin ? 'Stop turning' : 'Turn'}
        </button>
      ) : null}
    </div>
  );
}

export function ViewerTab() {
  const pkg = useApp((s) => s.pkg);
  const setTab = useActions().setTab;
  const notify = useToast();
  const [busy, setBusy] = useState<'glb' | 'obj' | null>(null);

  if (!pkg) {
    return (
      <div>
        <PageHead eyebrow="Preview · 3D" title="3D preview" />
        <EmptyState
          title="Nothing to preview yet"
          action={
            <button type="button" className="btn primary" onClick={() => setTab('design')}>
              Choose a design
            </button>
          }
        >
          Create a design to see it on a figure built from your measurements.
        </EmptyState>
      </div>
    );
  }

  const exportModel = async (kind: 'glb' | 'obj') => {
    setBusy(kind);
    try {
      downloadFile(kind === 'glb' ? await glbFile(pkg) : await objFile(pkg), pkg);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <PageHead
        eyebrow="Preview · 3D"
        title="On your figure"
        lede="A figure built from your measurements wearing the finished garment. Drag to turn, pinch to zoom."
      />
      <div className="grid-2 wide-left">
        <Viewer pkg={pkg} />
        <section className="card stack">
          <h2>{pkg.name}</h2>
          <p className="muted small" style={{ margin: 0 }}>
            {pkg.material.name}, {pkg.material.weightGsm} gsm. Drape is approximated from the cloth’s weight and stiffness; seams and darts are
            not modelled.
          </p>
          <div className="btn-row">
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void exportModel('glb')}>
              {busy === 'glb' ? 'Exporting…' : 'Download GLB'}
            </button>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void exportModel('obj')}>
              {busy === 'obj' ? 'Exporting…' : 'Download OBJ'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
