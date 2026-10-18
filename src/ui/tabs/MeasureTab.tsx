import { useEffect, useId, useMemo, useState } from 'react';
import { MEASUREMENT_FIELDS, REQUIRED_MEASUREMENT_KEYS } from '../../core/schema';
import { resolveMeasurements, validateMeasurements } from '../../core/measurements';
import { analyzeBody } from '../../core/fit/analyze';
import type { BodyAnalysis, MeasurementIssue, MeasurementKey, Measurements, ResolvedMeasurements } from '../../core/types';
import { formatLength, parseLength, type UnitSystem } from '../../console/units';
import { SAMPLE_MEASUREMENTS } from '../../console/store';
import { BodyDiagram } from '../components/BodyDiagram';
import { PageHead, Segmented } from '../components/controls';
import { useActions, useApp } from '../context';
import { SHAPE_LABEL } from '../format';

const OPTIONAL_GROUPS: Array<{ title: string; keys: MeasurementKey[] }> = [
  {
    title: 'Upper body',
    keys: ['underbustCm', 'neckCm', 'shoulderWidthCm', 'shoulderLengthCm', 'backWaistLengthCm', 'frontWaistLengthCm', 'shoulderToBustPointCm', 'bustPointDistanceCm'],
  },
  { title: 'Arms', keys: ['armLengthCm', 'upperArmCm', 'elbowCm', 'wristCm'] },
  {
    title: 'Hips and legs',
    keys: ['highHipCm', 'waistToHipCm', 'waistToKneeCm', 'waistToFloorCm', 'crotchDepthCm', 'inseamCm', 'thighCm', 'kneeCm', 'calfCm', 'ankleCm'],
  },
];

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface Analysis {
  issues: MeasurementIssue[];
  missing: MeasurementKey[];
  resolved: ResolvedMeasurements | null;
  body: BodyAnalysis | null;
}

function analyse(m: Partial<Measurements>): Analysis {
  const missing = REQUIRED_MEASUREMENT_KEYS.filter((k) => typeof m[k] !== 'number');
  if (missing.length) return { issues: [], missing, resolved: null, body: null };
  try {
    const issues = validateMeasurements(m as Measurements);
    if (issues.some((i) => i.severity === 'error')) return { issues, missing, resolved: null, body: null };
    const resolved = resolveMeasurements(m as Measurements);
    return { issues, missing, resolved, body: analyzeBody(resolved) };
  } catch (err) {
    return {
      issues: [{ key: 'general', severity: 'error', message: err instanceof Error ? err.message : String(err) }],
      missing,
      resolved: null,
      body: null,
    };
  }
}

function MeasureInput({
  k,
  valueCm,
  unit,
  estimateCm,
  issues,
  showHint,
  onFocus,
  onCommit,
}: {
  k: MeasurementKey;
  valueCm: number | undefined;
  unit: UnitSystem;
  estimateCm?: number;
  issues: MeasurementIssue[];
  showHint: boolean;
  onFocus: () => void;
  onCommit: (cm: number | undefined) => void;
}) {
  const id = useId();
  const field = MEASUREMENT_FIELDS[k];
  const external = valueCm === undefined ? '' : formatLength(valueCm, unit, false);
  const [text, setText] = useState(external);
  const [focused, setFocused] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  // A new stored value (e.g. "Use sample", the console or a conversion) replaces any invalid draft.
  useEffect(() => {
    setParseError(null);
  }, [external]);

  // Follow the stored value unless the user is typing or left invalid text to fix.
  useEffect(() => {
    if (!focused && !parseError) setText(external);
  }, [external, focused, parseError]);

  const commit = (raw: string) => {
    if (raw.trim() === '') {
      setParseError(field.required ? 'Required' : null);
      if (!field.required) onCommit(undefined);
      return;
    }
    const cm = parseLength(raw, unit);
    if (cm === null || cm <= 0) {
      setParseError(
        `“${raw.trim()}” is not a number. Enter a number in ${unit}${external ? `; until then ${external} ${unit} is used` : ''}.`,
      );
      return;
    }
    setParseError(null);
    onCommit(cm);
  };

  const errs = issues.filter((i) => i.severity !== 'info');
  const invalid = Boolean(parseError) || errs.some((i) => i.severity === 'error');
  const describedBy = `${id}-hint ${id}-msg`;
  const placeholder = estimateCm !== undefined ? `≈ ${formatLength(estimateCm, unit, false)}` : '';

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        <span>{capital(field.label)}</span>
        {field.required ? <span className="muted small">required</span> : null}
      </label>
      <div className="input-wrap">
        <input
          id={id}
          className="input"
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="next"
          value={text}
          placeholder={placeholder}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onFocus={() => {
            setFocused(true);
            onFocus();
          }}
          onBlur={() => {
            setFocused(false);
            commit(text);
          }}
          onChange={(e) => {
            setText(e.target.value);
            const cm = parseLength(e.target.value, unit);
            if (cm !== null && cm > 0) {
              setParseError(null);
              onCommit(cm);
            }
          }}
        />
        <span className="input-unit" aria-hidden="true">
          {unit}
        </span>
      </div>
      <p className="hint" id={`${id}-hint`} hidden={!showHint}>
        {field.howTo}
      </p>
      <div id={`${id}-msg`} aria-live="polite">
        {parseError ? <p className="hint" style={{ color: 'var(--error)' }}>{parseError}</p> : null}
        {errs.map((i, n) => (
          <p key={n} className="hint" style={{ color: i.severity === 'error' ? 'var(--error)' : 'var(--warn)' }}>
            {i.message}
          </p>
        ))}
        {unit === 'cm' && valueCm !== undefined && errs.some((i) => /looks like inches/i.test(i.message)) ? (
          <button
            type="button"
            className="btn small"
            style={{ marginTop: 6 }}
            onClick={() => {
              setParseError(null);
              onCommit(Math.round(valueCm * 2.54 * 10) / 10);
            }}
          >
            Convert {formatLength(valueCm, 'cm', false)} in to {formatLength(valueCm * 2.54, 'cm')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function BodyCard({ analysis, unit }: { analysis: Analysis; unit: UnitSystem }) {
  const { body, resolved, missing } = analysis;
  const setTab = useActions().setTab;
  if (!body || !resolved) {
    return (
      <section className="card" aria-labelledby="body-card-title">
        <h2 id="body-card-title">Your proportions</h2>
        <p className="muted">
          {missing.length
            ? `Add ${missing.map((k) => MEASUREMENT_FIELDS[k].label).join(', ')} to see your body shape and what flatters it.`
            : 'Fix the highlighted measurements to see your body shape.'}
        </p>
      </section>
    );
  }
  const r = body.ratios;
  return (
    <section className="card accent" aria-labelledby="body-card-title">
      <div className="card-head">
        <h2 id="body-card-title">Your proportions</h2>
        <span className="shape-badge">{SHAPE_LABEL[body.shape] ?? body.shape}</span>
      </div>
      <div className="ratio-row">
        <div className="ratio">
          <b>{r.waistToHip.toFixed(2)}</b>
          <span>waist : hip</span>
        </div>
        <div className="ratio">
          <b>{r.bustToHip.toFixed(2)}</b>
          <span>bust : hip</span>
        </div>
        <div className="ratio">
          <b>{Math.round(r.legToHeight * 100)}%</b>
          <span>leg : height</span>
        </div>
      </div>
      <ul className="notes">
        {body.notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
      {resolved.estimated.length ? (
        <p className="hint" style={{ marginTop: 12 }}>
          {resolved.estimated.length} other measurements are estimated from these (e.g. waist to floor ≈{' '}
          {formatLength(resolved.waistToFloorCm, unit)}). Add your own below for a closer fit.
        </p>
      ) : null}
      <button type="button" className="btn primary block" style={{ marginTop: 16 }} onClick={() => setTab('design')}>
        Continue to design
      </button>
    </section>
  );
}

export function MeasureTab() {
  const measurements = useApp((s) => s.measurements);
  const unit = useApp((s) => s.unit);
  const isSample = useApp((s) => s.measurementsAreSample);
  const { setMeasurements, setUnit, replaceMeasurements } = useActions();
  const [active, setActive] = useState<MeasurementKey | null>('bustCm');

  const analysis = useMemo(() => analyse(measurements), [measurements]);
  const issuesFor = (k: MeasurementKey) => analysis.issues.filter((i) => i.key === k);
  const general = analysis.issues.filter((i) => i.key === 'general' && i.severity !== 'info');
  const info = analysis.issues.filter((i) => i.severity === 'info');
  const optionalCount = OPTIONAL_GROUPS.flatMap((g) => g.keys).filter((k) => typeof measurements[k] === 'number').length;

  const commit = (k: MeasurementKey) => (cm: number | undefined) => setMeasurements({ [k]: cm });

  return (
    <div>
      <PageHead
        eyebrow="Step 1 · Measure"
        title="Your measurements"
        lede="Four numbers are enough to start. Measure over underwear, tape level and snug but not tight."
        action={
          <Segmented
            label="Units"
            value={unit}
            options={[
              { value: 'cm', label: 'cm' },
              { value: 'in', label: 'in' },
            ]}
            onChange={setUnit}
          />
        }
      />

      {isSample ? (
        <p className="notice" style={{ marginBottom: 16 }}>
          These are sample measurements (European size 38) so you can explore. Replace them with your own for a pattern that fits you.
        </p>
      ) : null}

      <div className="grid-2 wide-left">
        <div className="stack">
          <section className="card" aria-labelledby="essentials-title">
            <div className="card-head">
              <h2 id="essentials-title">The essential four</h2>
              {!isSample ? (
                <button type="button" className="link-btn small" onClick={() => replaceMeasurements({ ...SAMPLE_MEASUREMENTS })}>
                  Use sample
                </button>
              ) : null}
            </div>
            <div className="measure-layout">
              <BodyDiagram active={active} label={active ? `Where to measure your ${MEASUREMENT_FIELDS[active].label}` : undefined} />
              <div className="measure-grid">
                {REQUIRED_MEASUREMENT_KEYS.map((k) => (
                  <MeasureInput
                    key={k}
                    k={k}
                    valueCm={measurements[k]}
                    unit={unit}
                    issues={issuesFor(k)}
                    showHint={active === k}
                    onFocus={() => setActive(k)}
                    onCommit={commit(k)}
                  />
                ))}
              </div>
            </div>
            {general.length || analysis.missing.length ? (
              <ul className="issues" style={{ marginTop: 16 }} aria-live="polite">
                {analysis.missing.map((k) => (
                  <li key={k} className="issue error">
                    {capital(MEASUREMENT_FIELDS[k].label)} is required.
                  </li>
                ))}
                {general.map((i, n) => (
                  <li key={n} className={`issue ${i.severity}`}>
                    {i.message}
                    {/looks like inches/i.test(i.message) ? (
                      <button
                        type="button"
                        className="btn small"
                        style={{ display: 'flex', marginTop: 8 }}
                        onClick={() => {
                          const patch: Partial<Record<MeasurementKey, number>> = {};
                          for (const [k, v] of Object.entries(measurements) as Array<[MeasurementKey, number | undefined]>) {
                            if (typeof v === 'number') patch[k] = Math.round(v * 2.54 * 10) / 10;
                          }
                          setMeasurements(patch);
                        }}
                      >
                        Convert all from inches to cm
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="card" aria-labelledby="optional-title">
            <h2 id="optional-title">More measurements</h2>
            <p className="hint" style={{ marginBottom: 8 }}>
              Optional. Anything you leave empty is estimated from the essential four ({optionalCount} added).
              {active && !MEASUREMENT_FIELDS[active].required ? ` ${capital(MEASUREMENT_FIELDS[active].label)}: ${MEASUREMENT_FIELDS[active].howTo}` : ''}
            </p>
            {OPTIONAL_GROUPS.map((g) => (
              <details key={g.title} className="disclosure">
                <summary>
                  {g.title}
                  <span className="muted small" style={{ marginLeft: 'auto', marginRight: 12, fontWeight: 400 }}>
                    {g.keys.filter((k) => typeof measurements[k] === 'number').length}/{g.keys.length}
                  </span>
                </summary>
                <div className="measure-grid optional" style={{ padding: '4px 0 16px' }}>
                  {g.keys.map((k) => (
                    <MeasureInput
                      key={k}
                      k={k}
                      valueCm={measurements[k]}
                      unit={unit}
                      estimateCm={analysis.resolved ? (analysis.resolved[k] as number) : undefined}
                      issues={issuesFor(k)}
                      showHint={active === k}
                      onFocus={() => setActive(k)}
                      onCommit={commit(k)}
                    />
                  ))}
                </div>
              </details>
            ))}
            {info.length ? (
              <ul className="issues" style={{ marginTop: 12 }}>
                {info.map((i, n) => (
                  <li key={n} className="issue info">
                    {i.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </div>

        <div className="sticky-col">
          <BodyCard analysis={analysis} unit={unit} />
        </div>
      </div>
    </div>
  );
}

