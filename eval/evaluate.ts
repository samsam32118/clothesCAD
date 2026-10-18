/**
 * Evaluates one case: runs the design pipeline, then every scorer.
 * Shared by the worker threads, the serial runner and the tests.
 */
import { design } from '../src/core/design';
import type { EvalCase } from './cases';
import { CASE_METRICS, DEEP_METRICS, crashedMetric, errorText, scorePackage, type MetricResult } from './metrics';

export interface CaseResult {
  id: string;
  garment: string;
  profileId: string;
  comboKey: string;
  styleId: string;
  materialId: string;
  deep: boolean;
  ms: number;
  crashed: boolean;
  error?: string;
  metrics: MetricResult[];
  /** Ids of the package's own failing self-checks (`pkg.quality`), for cross-reference. */
  selfCheckFailures: string[];
}

export function evaluateCase(c: EvalCase): CaseResult {
  const t0 = performance.now();
  const base = {
    id: c.id,
    garment: c.garment,
    profileId: c.profileId,
    comboKey: c.combo.key,
    styleId: c.combo.styleId,
    materialId: c.combo.materialId,
    deep: c.deep,
  };
  try {
    const pkg = design(structuredClone(c.request));
    const metrics = scorePackage(c.request, pkg, c.deep);
    return {
      ...base,
      ms: Math.round(performance.now() - t0),
      crashed: false,
      metrics,
      selfCheckFailures: pkg.quality.filter((q) => !q.ok).map((q) => `${q.id}: ${q.message}`),
    };
  } catch (err) {
    return crashResult(base, err, Math.round(performance.now() - t0));
  }
}

export function crashResult(base: Omit<CaseResult, 'ms' | 'crashed' | 'metrics' | 'selfCheckFailures'>, err: unknown, ms = 0): CaseResult {
  const ids = [...CASE_METRICS, ...(base.deep ? DEEP_METRICS : [])];
  return {
    ...base,
    ms,
    crashed: true,
    error: errorText(err),
    metrics: ids.map((id) => crashedMetric(id, err)),
    selfCheckFailures: [],
  };
}
