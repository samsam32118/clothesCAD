import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BomItem, DesignPackage, InstructionStep } from '../../core/types';
import { markdownFile } from '../../console/exports';
import { isDesignStale } from '../../console/store';
import { formatMinutes } from '../../console/summary';
import { EmptyState, PageHead } from '../components/controls';
import { Check } from '../components/icons';
import { useActions, useApp, useToast } from '../context';
import { downloadFile } from '../download';
import { bomTotals, fabricToBuy, groupBom, type IndexedBomItem } from '../bom';
import { formatMoney } from '../format';
import { parseStepBody } from '../stepBody';

const PHASE_LABEL: Record<InstructionStep['phase'], string> = {
  prepare: 'Prepare',
  cut: 'Cut',
  mark: 'Mark',
  construct: 'Sew',
  fit: 'Fit',
  finish: 'Finish',
  press: 'Press',
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Split text so each glossary term's first occurrence becomes a tappable button. */
function linkTerms(text: string, terms: string[], onTerm: (t: string) => void): ReactNode[] {
  const usable = [...new Set(terms)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!usable.length) return [text];
  const re = new RegExp(`\\b(${usable.map(escapeRe).join('|')})\\b`, 'gi');
  const seen = new Set<string>();
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const word = m[0];
    const key = usable.find((t) => t.toLowerCase() === word.toLowerCase()) ?? word;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <button key={`${key}-${at}`} type="button" className="term" onClick={() => onTerm(key)} aria-label={`${word}: show definition`}>
        {word}
      </button>,
    );
    last = at + word.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function GlossarySheet({ term, definition, onClose }: { term: string | null; definition?: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (term && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    } else if (!term && d.open) d.close();
  }, [term]);
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="gloss-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="sheet-inner">
        <p className="eyebrow">Glossary</p>
        <h2 id="gloss-title" style={{ textTransform: 'capitalize' }}>
          {term}
        </h2>
        <p style={{ margin: '10px 0 18px' }}>{definition ?? 'No definition available.'}</p>
        <button type="button" className="btn primary block" onClick={onClose} autoFocus>
          Got it
        </button>
      </div>
    </dialog>
  );
}

function StepBody({ body, terms, onTerm }: { body: string; terms: string[]; onTerm: (t: string) => void }) {
  const blocks = useMemo(() => parseStepBody(body), [body]);
  return (
    <div className="step-body">
      {blocks.map((b, i) => {
        if (b.kind === 'p') return <p key={i}>{linkTerms(b.text, terms, onTerm)}</p>;
        if (b.kind === 'ul')
          return (
            <ul key={i}>
              {b.items.map((it, j) => (
                <li key={j}>{linkTerms(it, terms, onTerm)}</li>
              ))}
            </ul>
          );
        return (
          <ol key={i} start={b.start}>
            {b.items.map((it, j) => (
              <li key={j}>{linkTerms(it, terms, onTerm)}</li>
            ))}
          </ol>
        );
      })}
    </div>
  );
}

function StepCard({
  step,
  done,
  open,
  onToggleDone,
  onToggleOpen,
  onTerm,
  glossary,
}: {
  step: InstructionStep;
  done: boolean;
  open: boolean;
  onToggleDone: () => void;
  onToggleOpen: () => void;
  onTerm: (t: string) => void;
  glossary: Record<string, string>;
}) {
  const terms = step.terms.filter((t) => glossary[t]);
  const bodyId = `step-body-${step.n}`;
  return (
    <article className={`step-card ${done ? 'done' : ''} ${open ? 'open' : ''}`} aria-labelledby={`step-${step.n}`}>
      <div className="step-head">
        <button type="button" className="step-check" role="checkbox" aria-checked={done} aria-label={`Step ${step.n} done`} onClick={onToggleDone}>
          {done ? <Check width={20} height={20} /> : step.n}
        </button>
        <button type="button" className="step-toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggleOpen}>
          <span className="step-title" id={`step-${step.n}`}>
            {step.title}
          </span>
          <span className="hint">
            {done ? 'Done · ' : ''}
            {PHASE_LABEL[step.phase]} · about {formatMinutes(step.minutes)}
            {step.checkpoint ? ' · try-on' : ''}
          </span>
        </button>
      </div>
      {open ? (
        <div id={bodyId}>
          <StepBody body={step.body} terms={terms} onTerm={onTerm} />
          {step.tips.map((t, i) => (
            <div key={`t${i}`} className="callout tip">
              <b>Tip</b>
              {t}
            </div>
          ))}
          {step.warnings.map((w, i) => (
            <div key={`w${i}`} className="callout warning" role="note">
              <b>Careful</b>
              {w}
            </div>
          ))}
          {step.checkpoint ? (
            <div className="callout checkpoint">
              <b>Try-on checkpoint</b>
              {step.checkpoint}
            </div>
          ) : null}
          {terms.length ? (
            <div className="term-chips" aria-label="Terms used in this step">
              {terms.map((t) => (
                <button key={t} type="button" className="term-chip" onClick={() => onTerm(t)}>
                  {t}
                </button>
              ))}
            </div>
          ) : null}
          <div className="step-actions">
            <button type="button" className={`btn ${done ? '' : 'accent'}`} onClick={onToggleDone}>
              {done ? 'Mark as not done' : (
                <>
                  <Check width={18} height={18} /> Done, next step
                </>
              )}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function BomCard({ pkg, defaultOpen }: { pkg: DesignPackage; defaultOpen: boolean }) {
  const key = `bom:${pkg.id}`;
  const checked = useApp((s) => s.progress[key]);
  const toggle = useActions().toggleStep;
  const done = new Set(checked ?? []);
  const groups = groupBom(pkg.bom);
  const totals = bomTotals(pkg.bom);
  const fabric = fabricToBuy(pkg);
  const fmtQty = (b: BomItem) => `${Number.isInteger(b.quantity) ? b.quantity : b.quantity.toFixed(2)} ${b.unit}`;
  const renderItems = (items: IndexedBomItem[]) => (
    <ul className="checklist">
      {items.map(({ item: b, index }) => (
        <li key={`${b.name}-${index}`}>
          <label className="check-row">
            <input type="checkbox" checked={done.has(index)} onChange={() => toggle(key, index)} />
            <span>
              <span style={{ fontWeight: 500 }}>{b.name}</span>
              {!b.essential ? <span className="tag" style={{ marginLeft: 6 }}>optional</span> : null}
              {b.spec ? <span className="hint" style={{ display: 'block' }}>{b.spec}</span> : null}
            </span>
            <span className="qty">{fmtQty(b)}</span>
          </label>
        </li>
      ))}
    </ul>
  );
  return (
    <section className="card" aria-labelledby="bom-title">
      <details className="disclosure plain" open={defaultOpen}>
        <summary>
          <span>
            <span className="h2-like" id="bom-title">
              Shopping list
            </span>
            <span className="muted small" style={{ display: 'block', fontWeight: 400 }}>
              {done.size} of {pkg.bom.length} ticked
              {totals.materialsEur > 0 ? ` · materials ≈ ${formatMoney(totals.materialsEur)}` : ''} · get these before step 1
            </span>
          </span>
        </summary>
        <h3 className="bom-group">
          Materials{totals.materialsEur > 0 ? <span className="muted small"> ≈ {formatMoney(totals.materialsEur)}</span> : null}
        </h3>
        {fabric && fabric.layoutM !== null && fabric.buyM > fabric.layoutM + 0.005 ? (
          <p className="hint">
            Buy {fabric.buyM.toFixed(2)} m although the layout uses {fabric.layoutM.toFixed(2)} m: the extra covers shrinkage when you pre-wash
            and straightening the cut end.
          </p>
        ) : null}
        {renderItems(groups.materials)}
        {groups.tools.length ? (
          <>
            <h3 className="bom-group">
              Tools
              {totals.essentialToolsEur > 0 ? (
                <span className="muted small"> ≈ {formatMoney(totals.essentialToolsEur)} if you own none</span>
              ) : null}
            </h3>
            <p className="hint">Reusable equipment: tick off what you already have. Optional tools make the work neater but are not needed.</p>
            {renderItems(groups.tools)}
          </>
        ) : null}
      </details>
    </section>
  );
}

function HandlingCard({ pkg }: { pkg: DesignPackage }) {
  const h = pkg.material.handling;
  const rows: Array<[string, string]> = [
    ['Before cutting', h.preTreatment],
    ['Needle', h.needle],
    ['Thread', h.thread],
    ['Stitch length', `${h.stitchLengthMm} mm`],
    ['Pressing', h.pressing],
    ['Interfacing', h.interfacing],
    ['Seam finish', h.seamFinish],
    ['Cutting', h.cuttingTips],
  ];
  return (
    <section className="card" aria-labelledby="handling-title">
      <details className="disclosure plain">
        <summary>
          <span>
            <span className="h2-like" id="handling-title">
              Working with {pkg.material.name.toLowerCase()}
            </span>
            <span className="muted small" style={{ display: 'block', fontWeight: 400 }}>
              Needle, thread, pressing and cutting tips
            </span>
          </span>
        </summary>
      <table className="data">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row" style={{ width: '34%', verticalAlign: 'top' }}>
                {k}
              </th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </details>
    </section>
  );
}

export function MakeTab() {
  const pkg = useApp((s) => s.pkg);
  const stale = useApp((s) => isDesignStale(s));
  const progress = useApp((s) => (s.pkg ? s.progress[s.pkg.id] : undefined));
  const bomTicked = useApp((s) => (s.pkg ? (s.progress[`bom:${s.pkg.id}`]?.length ?? 0) : 0));
  const { toggleStep, setTab } = useActions();
  const notify = useToast();
  const [term, setTerm] = useState<string | null>(null);
  const [expandAll, setExpandAll] = useState(false);
  /** Steps the user explicitly opened (true) or closed (false); others follow the default. */
  const [manual, setManual] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const pendingScroll = useRef<number | null>(null);

  const groups = useMemo(() => {
    const out: Array<{ phase: InstructionStep['phase']; steps: InstructionStep[] }> = [];
    for (const s of pkg?.instructions ?? []) {
      const last = out[out.length - 1];
      if (last && last.phase === s.phase) last.steps.push(s);
      else out.push({ phase: s.phase, steps: [s] });
    }
    return out;
  }, [pkg]);

  useEffect(() => {
    setManual({});
    setExpandAll(false);
  }, [pkg?.id]);

  useEffect(() => {
    const n = pendingScroll.current;
    if (n === null) return;
    pendingScroll.current = null;
    document.getElementById(`step-${n}`)?.closest('article')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  if (!pkg) {
    return (
      <div>
        <PageHead eyebrow="Step 4 · Make" title="Make it" />
        <EmptyState
          title="Nothing to sew yet"
          action={
            <button type="button" className="btn primary" onClick={() => setTab('design')}>
              Choose a design
            </button>
          }
        >
          Your shopping list, step-by-step instructions and fitting checkpoints appear here once you create a design.
        </EmptyState>
      </div>
    );
  }

  const done = new Set(progress ?? []);
  const total = pkg.instructions.length;
  const doneCount = pkg.instructions.filter((s) => done.has(s.n)).length;
  const remaining = pkg.instructions.filter((s) => !done.has(s.n)).reduce((m, s) => m + s.minutes, 0);
  const next = pkg.instructions.find((s) => !done.has(s.n));
  const isOpen = (n: number) => manual[n] ?? (expandAll || n === next?.n);

  const toggleDone = (s: InstructionStep) => {
    const wasDone = done.has(s.n);
    toggleStep(pkg.id, s.n);
    // Finished steps fold away and the next unfinished one opens.
    setManual((m) => {
      const copy = { ...m };
      delete copy[s.n];
      return copy;
    });
    if (!wasDone) {
      const following = pkg.instructions.find((x) => x.n > s.n && !done.has(x.n));
      if (following) pendingScroll.current = following.n;
    }
  };

  const goToNext = () => {
    if (!next) return;
    setManual((m) => ({ ...m, [next.n]: true }));
    pendingScroll.current = next.n;
  };

  const downloadBooklet = async () => {
    setBusy(true);
    try {
      const { buildBookletPdf } = await import('../pdf');
      downloadFile(await buildBookletPdf(pkg));
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHead
        eyebrow="Step 4 · Make"
        title="Make it"
        lede={`${total} steps for ${pkg.name}. Get the shopping list first, then work through one step at a time. Tap a dotted word for its meaning.`}
        action={
          <div className="btn-row">
            <button type="button" className="btn small primary" disabled={busy} onClick={() => void downloadBooklet()}>
              {busy ? 'Building PDF…' : 'Booklet (PDF)'}
            </button>
            <button type="button" className="btn small" onClick={() => downloadFile(markdownFile(pkg), pkg)}>
              Markdown
            </button>
          </div>
        }
      />
      {stale ? (
        <p className="notice" style={{ marginBottom: 16 }}>
          Your choices changed since these instructions were written. Update the design to refresh them.
        </p>
      ) : null}

      <div className="make-layout">
        <section className="card make-progress" aria-label="Progress">
          <div className="card-head">
            <h2>
              {doneCount} of {total} done
            </h2>
            <span className="muted small">{remaining > 0 ? `${formatMinutes(remaining)} to go` : 'Finished!'}</span>
          </div>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={doneCount} aria-label="Sewing progress">
            <i style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }} />
          </div>
          <div className="btn-row" style={{ marginTop: 12 }}>
            {next ? (
              <button type="button" className="btn small accent" onClick={goToNext}>
                Go to step {next.n}
              </button>
            ) : null}
            <button
              type="button"
              className="btn small"
              aria-pressed={expandAll}
              onClick={() => {
                setExpandAll((v) => !v);
                setManual({});
              }}
            >
              {expandAll ? 'Fold steps away' : 'Open all steps'}
            </button>
          </div>
          {next ? (
            <p className="hint" style={{ marginTop: 8 }}>
              Next: {next.n}. {next.title}
            </p>
          ) : null}
        </section>

        <div className="make-side stack">
          <BomCard pkg={pkg} defaultOpen={doneCount === 0 && bomTicked < pkg.bom.length} />
          <HandlingCard pkg={pkg} />
          <section className="card" aria-labelledby="glossary-title">
            <details className="disclosure plain">
              <summary>
                <span className="h2-like" id="glossary-title">
                  Glossary ({Object.keys(pkg.glossary).length} terms)
                </span>
              </summary>
              <dl style={{ margin: 0 }}>
                {Object.entries(pkg.glossary)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([k, v]) => (
                    <div key={k} style={{ padding: '8px 0', borderTop: '1px solid var(--line-2)' }}>
                      <dt style={{ fontWeight: 600, textTransform: 'capitalize' }}>{k}</dt>
                      <dd style={{ margin: '2px 0 0', color: 'var(--ink-2)' }}>{v}</dd>
                    </div>
                  ))}
              </dl>
            </details>
          </section>
        </div>

        <div className="make-steps">
          {groups.map((g, gi) => (
            <section key={`${g.phase}-${gi}`} aria-label={PHASE_LABEL[g.phase]}>
              <h2 className="phase-label">{PHASE_LABEL[g.phase]}</h2>
              {g.steps.map((s) => (
                <StepCard
                  key={s.n}
                  step={s}
                  done={done.has(s.n)}
                  open={isOpen(s.n)}
                  onToggleDone={() => toggleDone(s)}
                  onToggleOpen={() => setManual((m) => ({ ...m, [s.n]: !isOpen(s.n) }))}
                  onTerm={setTerm}
                  glossary={pkg.glossary}
                />
              ))}
            </section>
          ))}
        </div>
      </div>
      <GlossarySheet term={term} definition={term ? pkg.glossary[term] : undefined} onClose={() => setTerm(null)} />
    </div>
  );
}
