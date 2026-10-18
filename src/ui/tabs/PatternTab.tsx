import { useMemo, useState } from 'react';
import { renderCuttingLayoutSVG, renderPatternSheetSVG, renderPieceSVG } from '../../core/svg';
import type { DesignPackage, FabricLayer } from '../../core/types';
import { buildExport, printableHtml, type Paper } from '../../console/exports';
import { isDesignStale } from '../../console/store';
import { formatLength } from '../../console/units';
import { EmptyState, PageHead, Segmented } from '../components/controls';
import { PanZoom } from '../components/PanZoom';
import { Download } from '../components/icons';
import { useActions, useApp, useToast } from '../context';
import { downloadFile, downloadFiles, openHtmlWindow } from '../download';

type View = 'sheet' | 'pieces' | 'layout';

const LAYER_LABEL: Record<FabricLayer, string> = { self: 'Main fabric', lining: 'Lining', interfacing: 'Interfacing' };

function PieceList({ pkg }: { pkg: DesignPackage }) {
  const unit = useApp((s) => s.unit);
  const thumbs = useMemo(() => pkg.pieces.map((p) => ({ piece: p, svg: renderPieceSVG(p) })), [pkg]);
  return (
    <ul className="piece-list">
      {thumbs.map(({ piece: p, svg }) => (
        <li key={p.id} className="piece-item">
          <div className="piece-thumb" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
          <div style={{ minWidth: 0, display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{p.name}</div>
              <div className="hint">
                Cut {p.cutCount}
                {p.cutOnFold ? ' on the fold' : p.mirrorPair ? ' (mirror pair)' : ''} · {LAYER_LABEL[p.layer]} ·{' '}
                {formatLength(p.bounds.maxX - p.bounds.minX, unit, false)} × {formatLength(p.bounds.maxY - p.bounds.minY, unit)}
                {p.darts.length ? ` · ${p.darts.length} dart${p.darts.length > 1 ? 's' : ''}` : ''}
              </div>
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Download ${p.name} at full size (SVG)`}
              onClick={() => downloadFile({ filename: `piece-${p.id}.svg`, mime: 'image/svg+xml', data: renderPieceSVG(p, { realSize: true }) }, pkg)}
            >
              <Download width={20} height={20} />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function LayoutView({ pkg }: { pkg: DesignPackage }) {
  const [layer, setLayer] = useState<FabricLayer>(pkg.layouts[0]?.layer ?? 'self');
  const layout = pkg.layouts.find((l) => l.layer === layer) ?? pkg.layouts[0];
  const svg = useMemo(() => (layout ? renderCuttingLayoutSVG(pkg, layout.layer) : ''), [pkg, layout]);
  if (!layout) return <p className="muted">No cutting layout.</p>;
  return (
    <div className="stack">
      {pkg.layouts.length > 1 ? (
        <Segmented label="Fabric layer" value={layout.layer} options={pkg.layouts.map((l) => ({ value: l.layer, label: LAYER_LABEL[l.layer] }))} onChange={setLayer} />
      ) : null}
      <div className="stat-row">
        <div className="stat">
          <b>{(layout.lengthCm / 100).toFixed(2)} m</b>
          <span>length to buy</span>
        </div>
        <div className="stat">
          <b>{layout.fabricWidthCm} cm</b>
          <span>fabric width</span>
        </div>
        <div className="stat">
          <b>{layout.fold === 'folded' ? 'Folded' : 'Single'}</b>
          <span>layer</span>
        </div>
        <div className="stat">
          <b>{Math.round(layout.efficiency * 100)}%</b>
          <span>fabric used</span>
        </div>
      </div>
      <PanZoom svg={svg} label={`Cutting layout for ${LAYER_LABEL[layout.layer].toLowerCase()}`} resetKey={`${pkg.id}-${layout.layer}`} />
      <p className="hint">
        {layout.fold === 'folded'
          ? 'Fold the fabric in half lengthwise, selvedges together, right sides facing. The fold is on the left.'
          : 'Lay the fabric flat in a single layer, right side up.'}{' '}
        Keep every grainline arrow parallel to the selvedge.
      </p>
    </div>
  );
}

function Downloads({ pkg }: { pkg: DesignPackage }) {
  const [paper, setPaper] = useState<Paper>('A4');
  const [busy, setBusy] = useState<string | null>(null);
  const notify = useToast();

  const run = async (key: string, fn: () => Promise<void> | void) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card" aria-labelledby="dl-title">
      <div className="card-head" style={{ flexWrap: 'wrap' }}>
        <h2 id="dl-title">Print &amp; download</h2>
        <Segmented
          label="Paper size"
          value={paper}
          options={[
            { value: 'A4', label: 'A4' },
            { value: 'letter', label: 'Letter' },
          ]}
          onChange={setPaper}
        />
      </div>
      <p className="hint" style={{ marginBottom: 12 }}>
        Print at 100 % (“actual size”) and check the 5 cm test square on page A1. The first sheet is an assembly map: trim the left and top
        margin of each page along the grey frame, lay it on the dashed line of the page to its left or above, and tape.
      </p>
      <div className="btn-row">
        <button
          type="button"
          className="btn primary"
          disabled={busy !== null}
          onClick={() =>
            run('print', () => {
              const opened = openHtmlWindow(printableHtml(pkg, paper), `print-${paper}.html`);
              if (!opened) notify('Pop-up blocked, so the printable pages were downloaded instead.');
            })
          }
        >
          Print tiled pages
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() =>
            run('pdf', async () => {
              const { buildPatternPdf } = await import('../pdf');
              downloadFile(await buildPatternPdf(pkg, paper));
            })
          }
        >
          {busy === 'pdf' ? 'Building PDF…' : 'PDF (1:1)'}
        </button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => run('pages', async () => downloadFiles(await buildExport(pkg, 'print', { paper }), pkg))}>
          Page SVGs
        </button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => run('svg', async () => downloadFiles(await buildExport(pkg, 'svg'), pkg))}>
          Pattern sheet SVG
        </button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => run('layout', async () => downloadFiles(await buildExport(pkg, 'layout'), pkg))}>
          Cutting layout SVG
        </button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => run('zip', async () => downloadFiles(await buildExport(pkg, 'zip', { paper }), pkg))}>
          {busy === 'zip' ? 'Packing…' : 'Everything (.zip)'}
        </button>
      </div>
    </section>
  );
}

export function PatternTab() {
  const pkg = useApp((s) => s.pkg);
  const stale = useApp((s) => isDesignStale(s));
  const setTab = useActions().setTab;
  const [view, setView] = useState<View>('sheet');
  const sheet = useMemo(() => (pkg ? renderPatternSheetSVG(pkg) : ''), [pkg]);

  if (!pkg) {
    return (
      <div>
        <PageHead eyebrow="Step 3 · Pattern" title="Pattern" />
        <EmptyState
          title="No pattern yet"
          action={
            <button type="button" className="btn primary" onClick={() => setTab('design')}>
              Choose a design
            </button>
          }
        >
          Create a design first; its pattern pieces, cutting layout and printable pages appear here.
        </EmptyState>
      </div>
    );
  }

  const selfPieces = pkg.pieces.filter((p) => p.layer === 'self').reduce((n, p) => n + p.cutCount, 0);
  return (
    <div>
      <PageHead
        eyebrow="Step 3 · Pattern"
        title="Pattern"
        lede={`${pkg.name}: ${pkg.pieces.length} pattern pieces (${selfPieces} pieces to cut from the main fabric). Seam allowance ${pkg.pieces[0]?.seamAllowanceCm ?? 1.5} cm is included.`}
      />
      {stale ? (
        <p className="notice" style={{ marginBottom: 16 }}>
          Your choices changed since this pattern was drafted. Update the design on the Design tab.
        </p>
      ) : null}
      <div className="grid-2 wide-left">
        <section className="card stack" aria-label="Pattern views">
          <Segmented
            label="View"
            value={view}
            options={[
              { value: 'sheet', label: 'Sheet' },
              { value: 'pieces', label: 'Pieces' },
              { value: 'layout', label: 'Cutting layout' },
            ]}
            onChange={setView}
          />
          {view === 'sheet' ? <PanZoom svg={sheet} label="Pattern sheet with all pieces" resetKey={pkg.id} /> : null}
          {view === 'pieces' ? <PieceList pkg={pkg} /> : null}
          {view === 'layout' ? <LayoutView pkg={pkg} /> : null}
        </section>
        <div className="sticky-col stack">
          <Downloads pkg={pkg} />
          <section className="card">
            <h3>Reading the pattern</h3>
            <ul className="notes small" style={{ marginTop: 8 }}>
              <li>Solid outer line: cut here. Dashed inner line: sew here.</li>
              <li>Long arrow: grainline, keep it parallel to the fabric edge (selvedge).</li>
              <li>Small triangles (notches): match them between pieces when pinning.</li>
              <li>“Place on fold”: put this edge exactly on the folded edge of the fabric.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
