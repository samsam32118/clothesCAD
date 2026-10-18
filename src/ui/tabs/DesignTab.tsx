import { useMemo, useState } from 'react';
import { GARMENTS, MATERIALS, STYLES, getGarment, recommend } from '../../core/presets';
import type { DesignPackage, GarmentDefinition, GarmentOptions, MaterialPreset, Occasion, StylePreset } from '../../core/types';
import { currentBody, rankMaterials } from '../../console/picks';
import { isDesignStale } from '../../console/store';
import { formatMinutes } from '../../console/summary';
import { formatLength, type UnitSystem } from '../../console/units';
import { ChipGroup, Dots, PageHead, Segmented, Switch } from '../components/controls';
import { CATEGORY_LABEL, GarmentIcon } from '../components/icons';
import { useActions, useApp, useToast } from '../context';
import { CLOSURE_LABEL, FIT_LABEL, LENGTH_LABEL, NECKLINE_LABEL, OCCASION_LABEL, SHAPE_LABEL, SLEEVE_LABEL, formatMoney } from '../format';

const OCCASIONS: Occasion[] = ['everyday', 'work', 'evening', 'runway'];

function StyleCard({ style, selected, onSelect }: { style: StylePreset; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className="style-card" aria-pressed={selected} onClick={onSelect}>
      <div className="palette" aria-label={`Palette: ${style.palette.map((p) => p.name).join(', ')}`}>
        {style.palette.slice(0, 6).map((c) => (
          <span key={c.hex + c.name} className="swatch" style={{ background: c.hex }} title={c.name} />
        ))}
      </div>
      <h3>{style.name}</h3>
      <p>{style.description}</p>
      <div className="chips" style={{ gap: 4 }}>
        {style.keywords.slice(0, 3).map((k) => (
          <span key={k} className="tag">
            {k}
          </span>
        ))}
      </div>
    </button>
  );
}

function GarmentCard({ g, selected, recommended, onSelect }: { g: GarmentDefinition; selected: boolean; recommended: boolean; onSelect: () => void }) {
  return (
    <button type="button" className="option-card" aria-pressed={selected} onClick={onSelect}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
        <GarmentIcon type={g.id} />
        {recommended ? <span className="tag accent">For you</span> : null}
      </div>
      <h3>{g.name}</h3>
      <div className="meta">{CATEGORY_LABEL[g.category]}</div>
      <Dots value={g.difficulty} label="Difficulty" />
    </button>
  );
}

function MaterialRow({ m, selected, onSelect, why }: { m: MaterialPreset; selected: boolean; onSelect: () => void; why?: string }) {
  return (
    <li>
      <button type="button" className="material-item" aria-pressed={selected} onClick={onSelect}>
        <span className="swatch lg" style={{ background: m.render.baseColor }} aria-hidden="true" />
        <span style={{ minWidth: 0 }}>
          <span className="name">{m.name}</span>
          <span className="meta" style={{ display: 'block' }}>
            {m.fiber} · {m.construction} · {m.weightGsm} gsm · {m.widthCm} cm wide
          </span>
          {why ? (
            <span className="meta" style={{ display: 'block', color: 'var(--ink-2)' }}>
              {why}
            </span>
          ) : null}
        </span>
        <span style={{ textAlign: 'right' }}>
          <Dots value={m.beginnerFriendliness} label="Beginner friendly" />
          <span className="meta" style={{ display: 'block', marginTop: 4 }}>
            {formatMoney(m.pricePerMeterEur[0])}–{formatMoney(m.pricePerMeterEur[1])}/m
          </span>
        </span>
      </button>
    </li>
  );
}

function OptionsCard({ garment, options, styleFit }: { garment: GarmentDefinition; options: GarmentOptions; styleFit: string }) {
  const { setOption, select } = useActions();
  const d = garment.defaults;
  const a = garment.allowed;
  const showFlare = garment.category === 'skirt' || garment.category === 'dress' || garment.category === 'gown';
  const flare = options.flare ?? d.flare;
  return (
    <section className="card" aria-labelledby="options-title">
      <div className="card-head">
        <h2 id="options-title">Details</h2>
        {Object.keys(options).length ? (
          <button type="button" className="link-btn small" onClick={() => select({ options: {} })}>
            Reset to style defaults
          </button>
        ) : null}
      </div>
      <div className="options-grid">
        {a.length.length > 1 ? (
          <ChipGroup label="Length" value={options.length ?? d.length} options={a.length.map((v) => ({ value: v, label: LENGTH_LABEL[v] }))} onChange={(v) => setOption('length', v)} />
        ) : null}
        {a.sleeve.length > 1 ? (
          <ChipGroup label="Sleeve" value={options.sleeve ?? d.sleeve} options={a.sleeve.map((v) => ({ value: v, label: SLEEVE_LABEL[v] }))} onChange={(v) => setOption('sleeve', v)} />
        ) : null}
        {a.neckline.length > 1 ? (
          <ChipGroup label="Neckline" value={options.neckline ?? d.neckline} options={a.neckline.map((v) => ({ value: v, label: NECKLINE_LABEL[v] }))} onChange={(v) => setOption('neckline', v)} />
        ) : null}
        {a.closure.length > 1 ? (
          <ChipGroup label="Closure" value={options.closure ?? d.closure} options={a.closure.map((v) => ({ value: v, label: CLOSURE_LABEL[v] }))} onChange={(v) => setOption('closure', v)} />
        ) : null}
        <div className="field">
          <span className="field-label">
            Fit <span className="muted small">style default: {styleFit}</span>
          </span>
          <Segmented
            label="Fit"
            value={options.fit ?? (styleFit as GarmentOptions['fit']) ?? d.fit}
            options={(['fitted', 'regular', 'relaxed'] as const).map((v) => ({ value: v, label: FIT_LABEL[v] }))}
            onChange={(v) => setOption('fit', v)}
          />
        </div>
        {showFlare ? (
          <div className="field">
            <label className="field-label" htmlFor="flare">
              <span>Hem fullness</span>
              <span className="muted small">{flare <= 0.05 ? 'straight' : flare < 0.4 ? 'gentle' : flare < 0.75 ? 'full' : 'dramatic'}</span>
            </label>
            <input
              id="flare"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={flare}
              aria-valuetext={`${Math.round(flare * 100)} percent`}
              onChange={(e) => setOption('flare', Number(e.target.value))}
            />
          </div>
        ) : null}
        {a.lining ? (
          <Switch label="Lining" description="Smoother inside, hangs better, more work." checked={options.lining ?? d.lining} onChange={(v) => setOption('lining', v)} />
        ) : null}
        {a.pockets ? (
          <Switch label="Pockets" description="In-seam side pockets." checked={options.pockets ?? d.pockets} onChange={(v) => setOption('pockets', v)} />
        ) : null}
      </div>
    </section>
  );
}

export function FitRationaleCard({ pkg, unit, stale }: { pkg: DesignPackage; unit: UnitSystem; stale: boolean }) {
  const setTab = useActions().setTab;
  const fabric = pkg.layouts.find((l) => l.layer === 'self');
  const cost = pkg.bom.reduce((sum, b) => sum + (b.estCostEur ?? 0), 0);
  const fin = pkg.fit.finished;
  const rows: Array<[string, number | undefined]> = [
    ['Bust', fin.bust],
    ['Waist', fin.waist],
    ['Hip', fin.hip],
    ['Hem circumference', fin.hem],
    ['Length from waist', fin.lengthFromWaist],
    ['Length from shoulder', fin.lengthFromShoulder],
    ['Sleeve length', fin.sleeveLength],
    ['Inseam', fin.inseam],
  ];
  return (
    <section className="card accent" aria-labelledby="fit-title" aria-live="polite">
      <p className="eyebrow">Why it flatters you</p>
      <h2 id="fit-title">{pkg.name}</h2>
      {stale ? (
        <p className="notice" style={{ marginTop: 10 }}>
          You changed something since this design was made. Tap “Update design” to apply it.
        </p>
      ) : null}
      <div className="stat-row">
        <div className="stat">
          <b>{SHAPE_LABEL[pkg.body.shape] ?? pkg.body.shape}</b>
          <span>body shape</span>
        </div>
        <div className="stat">
          <b>{FIT_LABEL[pkg.fit.fit]}</b>
          <span>fit</span>
        </div>
        <div className="stat">
          <b>{fabric ? `${(fabric.lengthCm / 100).toFixed(2)} m` : '–'}</b>
          <span>fabric</span>
        </div>
        <div className="stat">
          <b>{formatMinutes(pkg.effort.minutes)}</b>
          <span>sewing time</span>
        </div>
        <div className="stat">
          <b>{pkg.effort.difficulty}/5</b>
          <span>difficulty</span>
        </div>
        {cost > 0 ? (
          <div className="stat">
            <b>{formatMoney(cost)}</b>
            <span>est. materials</span>
          </div>
        ) : null}
      </div>
      <ul className="rationale">
        {pkg.fit.rationale.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
      <details className="disclosure" style={{ marginTop: 14 }}>
        <summary>Finished garment measurements</summary>
        <table className="data">
          <tbody>
            {rows
              .filter((r): r is [string, number] => typeof r[1] === 'number' && Number.isFinite(r[1]))
              .map(([label, v]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td className="num">{formatLength(v, unit)}</td>
                </tr>
              ))}
            <tr>
              <th scope="row">Hem from floor</th>
              <td className="num">{formatLength(pkg.fit.hemHeightFromFloorCm, unit)}</td>
            </tr>
          </tbody>
        </table>
      </details>
      <div className="btn-row" style={{ marginTop: 16 }}>
        <button type="button" className="btn primary" onClick={() => setTab('pattern')}>
          See the pattern
        </button>
        <button type="button" className="btn" onClick={() => setTab('make')}>
          Start sewing
        </button>
        <button type="button" className="btn" onClick={() => setTab('3d')}>
          View in 3D
        </button>
      </div>
    </section>
  );
}

export function DesignTab() {
  const selection = useApp((s) => s.selection);
  const measurements = useApp((s) => s.measurements);
  const pkg = useApp((s) => s.pkg);
  const unit = useApp((s) => s.unit);
  const designError = useApp((s) => s.designError);
  const stale = useApp((s) => isDesignStale(s));
  const { select, runDesign, setTab } = useActions();
  const notify = useToast();
  const [showAllFabrics, setShowAllFabrics] = useState(false);

  const garment = getGarment(selection.garment);
  const style = STYLES.find((s) => s.id === selection.styleId) ?? STYLES[0]!;
  const body = useMemo(() => currentBody(measurements), [measurements]);

  const rec = useMemo(
    () =>
      recommend({
        ...(body ? { body } : {}),
        garment: selection.garment,
        styleId: selection.styleId,
        occasion: selection.occasion ?? undefined,
        region: selection.region,
      }),
    [body, selection.garment, selection.styleId, selection.occasion, selection.region],
  );
  // Garments that flatter this body regardless of the current pick.
  const forYou = useMemo(() => {
    const r = recommend({ ...(body ? { body } : {}), occasion: selection.occasion ?? undefined, region: selection.region });
    return new Set(r.garments.slice(0, 3).map((g) => g.id));
  }, [body, selection.occasion, selection.region]);

  const styles = STYLES.filter((s) => s.region === selection.region && (!selection.occasion || s.occasions.includes(selection.occasion)));
  const garments = GARMENTS.filter((g) => !selection.occasion || g.occasions.includes(selection.occasion));
  const fabricReasons = new Map<string, string>();
  for (const line of rec.reasons) {
    const m = /^Fabric - (.+?): (.+)$/.exec(line);
    if (m) fabricReasons.set(m[1]!, m[2]!);
  }
  // Cloths that suit this garment and occasion first (style-aware), then the rest of the ranking.
  const suited = useMemo(
    () =>
      rankMaterials({
        garment: selection.garment,
        styleId: selection.styleId,
        occasion: selection.occasion,
        region: selection.region,
        body,
      }),
    [body, selection.garment, selection.styleId, selection.occasion, selection.region],
  );
  const fabrics = [...suited, ...rec.materials.filter((m) => !suited.includes(m))];
  const visibleFabrics = showAllFabrics ? fabrics : fabrics.slice(0, 6);
  const selectedMaterial = MATERIALS.find((m) => m.id === selection.materialId);
  if (selectedMaterial && !visibleFabrics.includes(selectedMaterial) && fabrics.includes(selectedMaterial)) visibleFabrics.push(selectedMaterial);

  const doSelect = (patch: Parameters<typeof select>[0]) => {
    for (const note of select(patch)) notify(note);
  };

  const create = () => {
    const r = runDesign();
    if (!r.ok) {
      notify(r.error, 'error');
      return;
    }
    notify(`“${r.pkg.name}” is ready: ${r.pkg.pieces.length} pattern pieces, ${r.pkg.instructions.length} steps.`, 'info', {
      label: 'See your pattern →',
      onClick: () => setTab('pattern'),
    });
    // Show the result (why it flatters, next-step buttons) right away.
    window.requestAnimationFrame(() => document.getElementById('fit-title')?.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <div>
      <PageHead eyebrow="Step 2 · Design" title="Choose your piece" lede="Pick a house style, a garment and a cloth. Every choice is checked against your proportions." />

      <div className="grid-2 wide-left">
        <div className="stack">
          <section className="card" aria-labelledby="style-title">
            <div className="card-head" style={{ flexWrap: 'wrap' }}>
              <h2 id="style-title">House style</h2>
              <Segmented
                label="Region"
                value={selection.region}
                options={[
                  { value: 'european', label: 'European' },
                  { value: 'scandinavian', label: 'Scandinavian' },
                ]}
                onChange={(region) => {
                  const first = STYLES.find((s) => s.region === region && s.id === selection.styleId) ?? STYLES.find((s) => s.region === region);
                  doSelect({ region, ...(first ? { styleId: first.id } : {}) });
                }}
              />
            </div>
            <div className="chips" role="radiogroup" aria-label="Occasion" style={{ marginBottom: 12 }}>
              <button type="button" className="chip" role="radio" aria-checked={selection.occasion === null} onClick={() => doSelect({ occasion: null })}>
                All occasions
              </button>
              {OCCASIONS.map((o) => (
                <button key={o} type="button" className="chip" role="radio" aria-checked={selection.occasion === o} onClick={() => doSelect({ occasion: o })}>
                  {OCCASION_LABEL[o]}
                </button>
              ))}
            </div>
            <div className="scroller" role="radiogroup" aria-label="Style">
              {(styles.length ? styles : STYLES.filter((s) => s.region === selection.region)).map((s) => (
                <StyleCard key={s.id} style={s} selected={s.id === selection.styleId} onSelect={() => doSelect({ styleId: s.id })} />
              ))}
            </div>
            {style.stylingNotes[0] ? <p className="hint">{style.stylingNotes[0]}</p> : null}
          </section>

          <section className="card" aria-labelledby="garment-title">
            <div className="card-head">
              <h2 id="garment-title">Garment</h2>
              <span className="muted small">{garments.length} shapes</span>
            </div>
            <div className="garment-grid">
              {garments.map((g) => (
                <GarmentCard key={g.id} g={g} selected={g.id === selection.garment} recommended={forYou.has(g.id)} onSelect={() => doSelect({ garment: g.id })} />
              ))}
            </div>
            <p className="hint" style={{ marginTop: 12 }}>
              {garment.description}
            </p>
          </section>

          <section className="card" aria-labelledby="fabric-title">
            <div className="card-head">
              <h2 id="fabric-title">Cloth</h2>
              <span className="muted small">ranked for you</span>
            </div>
            {fabrics.length ? (
              <ul className="material-list">
                {visibleFabrics.map((m) => (
                  <MaterialRow key={m.id} m={m} selected={m.id === selection.materialId} why={fabricReasons.get(m.name)} onSelect={() => doSelect({ materialId: m.id })} />
                ))}
              </ul>
            ) : (
              <p className="muted">No fabric matches every filter; try another occasion.</p>
            )}
            {fabrics.length > 6 ? (
              <button type="button" className="btn small" style={{ marginTop: 12 }} onClick={() => setShowAllFabrics((v) => !v)}>
                {showAllFabrics ? 'Show fewer' : `Show all ${fabrics.length} fabrics`}
              </button>
            ) : null}
            {selectedMaterial ? <p className="hint" style={{ marginTop: 12 }}>{selectedMaterial.description}</p> : null}
          </section>

          <OptionsCard garment={garment} options={selection.options} styleFit={style.silhouette.defaultFit} />
        </div>

        <div className="sticky-col stack">
          <section className="card" aria-labelledby="summary-title">
            <h2 id="summary-title">Your choice</h2>
            <p style={{ margin: '6px 0 0' }}>
              <b>{garment.name}</b> in <b>{selectedMaterial?.name ?? selection.materialId}</b>, {style.name}.
            </p>
            {body ? (
              <p className="hint">Drafted for a {SHAPE_LABEL[body.shape]?.toLowerCase() ?? body.shape} figure.</p>
            ) : (
              <p className="notice error" style={{ marginTop: 10 }}>
                Measurements are incomplete or need checking on the Measure tab.
              </p>
            )}
            {designError && !pkg ? <p className="notice error" style={{ marginTop: 10 }}>{designError}</p> : null}
            <div className="sticky-action">
              <button type="button" className="btn accent block" onClick={create} disabled={!body}>
                {pkg ? (stale ? 'Update design' : 'Redesign') : 'Create design'}
              </button>
            </div>
          </section>
          {pkg ? <FitRationaleCard pkg={pkg} unit={unit} stale={stale} /> : null}
        </div>
      </div>
    </div>
  );
}
