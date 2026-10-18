/**
 * Aggregation and formatting of eval results.
 *
 * Per metric m (over every case it applies to; crashed cases count 0):
 *   mean(m)  = average score,
 *   clean(m) = fraction of cases with no major failure,
 *   value(m) = (mean(m) + clean(m)) / 2.
 * Overall (0–100) = 100 · Σ weight(m) · value(m) / Σ weight(m); the global
 * presets metric enters once with its own weight. Blending in the clean rate
 * keeps the gate sensitive: a defect that hits 20 % of designs costs ~10
 * points of that metric instead of vanishing in an average of check ratios.
 */
import type { CaseResult } from './evaluate';
import { METRIC_LABELS, METRIC_WEIGHTS, type MetricId, type MetricResult } from './metrics';

export interface MetricSummary {
  id: MetricId;
  label: string;
  weight: number;
  mean: number; // 0..1
  cleanRate: number; // 0..1
  value: number; // (mean + cleanRate) / 2
  cases: number;
  failingCases: number;
}

export interface GarmentSummary {
  garment: string;
  cases: number;
  crashes: number;
  score: number; // 0..100 (case metrics only)
  metrics: Partial<Record<MetricId, number>>; // blended value 0..1
}

export interface FailurePattern {
  metric: MetricId;
  pattern: string;
  cases: number;
  /** Lost overall points attributable to this metric across its failing cases (approximate). */
  example: string;
  exampleCase: string;
}

export interface EvalReport {
  overall: number;
  threshold: number;
  passed: boolean;
  crashes: number;
  caseCount: number;
  durationMs: number;
  metrics: MetricSummary[];
  garments: GarmentSummary[];
  presets: MetricResult;
  topFailures: FailurePattern[];
  crashed: Array<{ id: string; error: string }>;
  cases: CaseResult[];
}

const ORDER: MetricId[] = ['geometry', 'seams', 'fit', 'wearability', 'proportion', 'layout', 'instructions', 'mesh3d', 'determinism', 'svg', 'presets'];

/** Blended value (mean score + clean rate) / 2 of a set of results, or null if none applies. */
function valueOf(results: MetricResult[]): { mean: number; clean: number; value: number } | null {
  const a = results.filter((r) => r.applicable);
  if (!a.length) return null;
  const mean = a.reduce((s, r) => s + r.score, 0) / a.length;
  const clean = a.filter((r) => r.clean).length / a.length;
  return { mean, clean, value: (mean + clean) / 2 };
}

function weighted(means: Partial<Record<MetricId, number>>): number {
  let w = 0;
  let s = 0;
  for (const id of ORDER) {
    const v = means[id];
    if (v === undefined) continue;
    w += METRIC_WEIGHTS[id];
    s += METRIC_WEIGHTS[id] * v;
  }
  return w ? (100 * s) / w : 0;
}

/** Normalise a failure detail into a pattern: numbers → #, so the same defect groups across bodies. */
export function failurePattern(detail: string): string {
  return detail
    .replace(/-?\d+(?:\.\d+)?/g, '#')
    .replace(/#(?:\s*[,/×x]\s*#)+/g, '#…')
    .replace(/\s+/g, ' ')
    .trim();
}

export function summarize(cases: CaseResult[], presets: MetricResult, opts: { threshold: number; durationMs: number; topN?: number }): EvalReport {
  const byMetric = new Map<MetricId, MetricResult[]>();
  for (const c of cases) for (const m of c.metrics) byMetric.set(m.id, [...(byMetric.get(m.id) ?? []), m]);
  byMetric.set('presets', [presets]);

  const metrics: MetricSummary[] = [];
  const means: Partial<Record<MetricId, number>> = {};
  for (const id of ORDER) {
    const rs = byMetric.get(id) ?? [];
    const v = valueOf(rs);
    if (v === null) continue;
    means[id] = v.value;
    metrics.push({
      id,
      label: METRIC_LABELS[id],
      weight: METRIC_WEIGHTS[id],
      mean: v.mean,
      cleanRate: v.clean,
      value: v.value,
      cases: rs.length,
      failingCases: rs.filter((r) => r.applicable && r.score < 1).length,
    });
  }

  const garments: GarmentSummary[] = [];
  for (const g of [...new Set(cases.map((c) => c.garment))]) {
    const gc = cases.filter((c) => c.garment === g);
    const gm: Partial<Record<MetricId, number>> = {};
    for (const id of ORDER) {
      const v = valueOf(gc.flatMap((c) => c.metrics.filter((m) => m.id === id)));
      if (v !== null) gm[id] = v.value;
    }
    garments.push({ garment: g, cases: gc.length, crashes: gc.filter((c) => c.crashed).length, score: weighted(gm), metrics: gm });
  }

  const patterns = new Map<string, FailurePattern & { caseSet: Set<string> }>();
  for (const c of cases) {
    for (const m of c.metrics) {
      for (const d of m.details) {
        if (d.startsWith('(warning)') || /…and \d+ more$/.test(d)) continue;
        const key = `${m.id}|${failurePattern(d)}`;
        let p = patterns.get(key);
        if (!p) {
          p = { metric: m.id, pattern: failurePattern(d), cases: 0, example: d, exampleCase: c.id, caseSet: new Set() };
          patterns.set(key, p);
        }
        p.caseSet.add(c.id);
      }
    }
  }
  for (const d of presets.details) {
    patterns.set(`presets|${d}`, { metric: 'presets', pattern: d, cases: 1, example: d, exampleCase: '(global)', caseSet: new Set(['(global)']) });
  }
  const topFailures = [...patterns.values()]
    .map(({ caseSet, ...p }) => ({ ...p, cases: caseSet.size }))
    .sort((a, b) => b.cases * METRIC_WEIGHTS[b.metric] - a.cases * METRIC_WEIGHTS[a.metric] || a.pattern.localeCompare(b.pattern))
    .slice(0, opts.topN ?? 20);

  const overall = Math.round(weighted(means) * 10) / 10;
  const crashed = cases.filter((c) => c.crashed).map((c) => ({ id: c.id, error: c.error ?? 'unknown error' }));
  return {
    overall,
    threshold: opts.threshold,
    passed: overall >= opts.threshold && crashed.length === 0,
    crashes: crashed.length,
    caseCount: cases.length,
    durationMs: opts.durationMs,
    metrics,
    garments,
    presets,
    topFailures,
    crashed,
    cases,
  };
}

// ---------------------------------------------------------------------------
// Text formatting
// ---------------------------------------------------------------------------

const SHORT: Record<MetricId, string> = {
  geometry: 'geom',
  seams: 'seam',
  fit: 'fit',
  wearability: 'wear',
  proportion: 'prop',
  layout: 'layout',
  instructions: 'instr',
  presets: 'preset',
  mesh3d: '3d',
  determinism: 'determ',
  svg: 'svg',
};

const pct = (v: number | undefined) => (v === undefined ? '   -' : `${Math.round(v * 100)}`.padStart(4));

export function formatReport(r: EvalReport, opts: { color?: boolean } = {}): string {
  const color = opts.color ?? false;
  const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const grade = (v: number | undefined, s: string) => (v === undefined ? s : v >= 0.95 ? paint(32, s) : v >= 0.8 ? paint(33, s) : paint(31, s));
  const cols = ORDER.filter((id) => id !== 'presets' && r.metrics.some((m) => m.id === id));
  const lines: string[] = [];
  const gw = Math.max(18, ...r.garments.map((g) => g.garment.length));
  lines.push(`${'garment'.padEnd(gw)} cases ${cols.map((c) => SHORT[c].padStart(6)).join('')}  score`);
  lines.push('-'.repeat(gw + 6 + cols.length * 6 + 8));
  for (const g of r.garments) {
    const cells = cols.map((c) => grade(g.metrics[c], pct(g.metrics[c]).padStart(6))).join('');
    const crash = g.crashes ? paint(31, ` ${g.crashes} crash`) : '';
    lines.push(`${g.garment.padEnd(gw)} ${String(g.cases).padStart(5)} ${cells}  ${grade(g.score / 100, g.score.toFixed(1).padStart(5))}${crash}`);
  }
  lines.push('-'.repeat(gw + 6 + cols.length * 6 + 8));
  const all = Object.fromEntries(r.metrics.map((m) => [m.id, m.value])) as Partial<Record<MetricId, number>>;
  lines.push(`${'ALL'.padEnd(gw)} ${String(r.caseCount).padStart(5)} ${cols.map((c) => grade(all[c], pct(all[c]).padStart(6))).join('')}`);
  lines.push('');
  lines.push('metric                    weight  value  mean  clean  failing cases   (value = (mean + clean) / 2)');
  for (const m of r.metrics) {
    lines.push(
      `${m.label.padEnd(25)} ${String(m.weight).padStart(6)}  ${grade(m.value, pct(m.value))}% ${pct(m.mean)}% ${pct(m.cleanRate)}%   ${m.failingCases}/${m.cases}`,
    );
  }
  if (r.topFailures.length) {
    lines.push('');
    lines.push('top failures (cases affected × metric weight):');
    for (const f of r.topFailures) {
      lines.push(`  ${String(f.cases).padStart(4)}× ${SHORT[f.metric].padEnd(6)} ${f.example}`);
      lines.push(`         e.g. ${f.exampleCase}`);
    }
  }
  if (r.crashed.length) {
    lines.push('');
    lines.push(paint(31, `crashes (${r.crashed.length}):`));
    for (const c of r.crashed.slice(0, 15)) lines.push(`  ${c.id}: ${c.error}`);
    if (r.crashed.length > 15) lines.push(`  …and ${r.crashed.length - 15} more`);
  }
  lines.push('');
  const verdict = r.passed ? paint(32, 'PASS') : paint(31, 'FAIL');
  lines.push(
    `overall ${r.overall.toFixed(1)} / 100 (threshold ${r.threshold}, ${r.crashes} crashes) → ${verdict}  [${r.caseCount} cases in ${(r.durationMs / 1000).toFixed(1)} s]`,
  );
  return lines.join('\n');
}
