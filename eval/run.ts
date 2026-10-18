/**
 * clothesCAD evaluation runner — the objective quality gate.
 *
 *   npm run eval                       # full matrix, parallel
 *   npm run eval -- --quick            # 3 profiles × 2 combos per garment
 *   npm run eval -- --garment pencil-skirt,ball-gown --verbose
 *
 * Runs every garment × body profile × style/material combo through
 * `design()`, scores each package (see eval/metrics.ts), prints a table per
 * garment and metric plus the most common concrete failures, writes
 * eval/reports/latest.json and exits 1 when the overall score is below the
 * threshold (default 85) or any case crashed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Command, InvalidArgumentError } from 'commander';
import type { GarmentType } from '../src/core/types';
import { GARMENTS } from '../src/core/presets';
import { buildCases, type EvalCase } from './cases';
import { crashResult, evaluateCase, type CaseResult } from './evaluate';
import { scorePresets, crashedMetric, type MetricResult } from './metrics';
import { PROFILES } from './profiles';
import { formatReport, summarize } from './report';
import type { WorkerRequest, WorkerResponse } from './worker';

const HERE = dirname(fileURLToPath(import.meta.url));

function list(value: string, previous: string[] = []): string[] {
  return [...previous, ...value.split(',').map((s) => s.trim()).filter(Boolean)];
}

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('must be a positive integer');
  return n;
}

function score(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new InvalidArgumentError('must be a number from 0 to 100');
  return n;
}

interface Options {
  garment: string[];
  profile: string[];
  quick: boolean;
  threshold: number;
  workers: number;
  serial: boolean;
  out: string;
  top: number;
  verbose: boolean;
  color: boolean;
}

const program = new Command()
  .name('eval')
  .description('Evaluate clothesCAD design packages and gate on quality.')
  .option('-g, --garment <ids>', 'only these garment types (comma separated, repeatable)', list, [])
  .option('-p, --profile <ids>', 'only these body profiles (comma separated, repeatable)', list, [])
  .option('-q, --quick', 'fast subset: 3 profiles × 2 combos per garment, one deep case per garment', false)
  .option('-t, --threshold <score>', 'minimum overall score (0–100)', score, 85)
  .option('-w, --workers <n>', 'worker threads', positiveInt, Math.max(1, Math.min(4, availableParallelism())))
  .option('--serial', 'evaluate in-process without worker threads (easier debugging)', false)
  .option('-o, --out <file>', 'JSON report path', resolve(HERE, 'reports/latest.json'))
  .option('--top <n>', 'number of failure patterns to list', positiveInt, 20)
  .option('-v, --verbose', 'print every failing detail of every case', false)
  .option('--no-color', 'disable ANSI colours');

/** Run one worker until it exits; resolves with whether it died abnormally. */
function runWorker(cases: EvalCase[], results: CaseResult[], take: () => number, onDone: (r: CaseResult) => void): Promise<void> {
  return new Promise((resolveRun) => {
    const w = new Worker(new URL('./worker-boot.mjs', import.meta.url));
    let current = -1;
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolveRun();
      }
    };
    const feed = () => {
      current = take();
      const req: WorkerRequest = current < 0 ? { type: 'stop' } : { type: 'case', c: cases[current] };
      w.postMessage(req);
    };
    w.on('message', (msg: WorkerResponse) => {
      results[current] = msg.result;
      onDone(msg.result);
      feed();
    });
    const died = (err: unknown) => {
      // The worker died mid-case: record that case as a crash; the slot loop starts a fresh worker.
      if (current >= 0 && !results[current]) {
        const c = cases[current];
        results[current] = crashResult(
          { id: c.id, garment: c.garment, profileId: c.profileId, comboKey: c.combo.key, styleId: c.combo.styleId, materialId: c.combo.materialId, deep: c.deep },
          err,
        );
        onDone(results[current]);
      }
      finish();
    };
    w.on('error', died);
    w.on('exit', (code) => (code === 0 ? finish() : died(new Error(`worker exited with code ${code}`))));
    feed();
  });
}

async function runParallel(cases: EvalCase[], workers: number, onDone: (r: CaseResult) => void): Promise<CaseResult[]> {
  const results: CaseResult[] = new Array(cases.length);
  let next = 0;
  const take = () => (next < cases.length ? next++ : -1);
  const slot = async () => {
    while (next < cases.length) await runWorker(cases, results, take, onDone);
  };
  await Promise.all(Array.from({ length: Math.min(workers, cases.length) }, slot));
  return results.filter(Boolean);
}

async function main(): Promise<number> {
  program.parse(process.argv);
  const o = program.opts<Options>();
  const validGarments = GARMENTS.map((g) => g.id);
  const badG = o.garment.filter((g) => !validGarments.includes(g as GarmentType));
  if (badG.length) {
    console.error(`Unknown garment(s): ${badG.join(', ')}. Valid: ${validGarments.join(', ')}`);
    return 2;
  }
  const badP = o.profile.filter((p) => !PROFILES.some((x) => x.id === p));
  if (badP.length) {
    console.error(`Unknown profile(s): ${badP.join(', ')}. Valid: ${PROFILES.map((x) => x.id).join(', ')}`);
    return 2;
  }

  const cases = buildCases({ garments: o.garment as GarmentType[], quick: o.quick, profiles: o.profile });
  const t0 = performance.now();
  const tty = process.stdout.isTTY && o.color;
  let done = 0;
  const progress = (r: CaseResult) => {
    done++;
    if (tty) process.stdout.write(`\r  evaluating ${done}/${cases.length} ${r.crashed ? 'CRASH ' : ''}${r.id.slice(0, 60).padEnd(60)}`);
  };
  console.log(`clothesCAD eval: ${cases.length} cases (${cases.filter((c) => c.deep).length} deep), ${o.serial ? 'serial' : `${o.workers} workers`}${o.quick ? ', quick' : ''}`);

  let presets: MetricResult;
  try {
    presets = scorePresets();
  } catch (err) {
    presets = crashedMetric('presets', err);
  }
  const results = o.serial || o.workers === 1 ? cases.map((c) => { const r = evaluateCase(c); progress(r); return r; }) : await runParallel(cases, o.workers, progress);
  if (tty) process.stdout.write('\r' + ' '.repeat(80) + '\r');

  const report = summarize(results, presets, { threshold: o.threshold, durationMs: Math.round(performance.now() - t0), topN: o.top });
  console.log(formatReport(report, { color: o.color && !!process.stdout.isTTY }));

  if (o.verbose) {
    for (const r of results) {
      const failing = r.metrics.filter((m) => m.score < 1);
      if (!failing.length) continue;
      console.log(`\n${r.id} (${r.ms} ms)`);
      for (const m of failing) for (const d of m.details) console.log(`  ${m.id.padEnd(12)} ${(m.score * 100).toFixed(0).padStart(3)}%  ${d}`);
    }
  }

  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out, JSON.stringify({ generatedAt: new Date().toISOString(), options: { garment: o.garment, profile: o.profile, quick: o.quick }, ...report }, null, 1));
  console.log(`report written to ${o.out}`);
  return report.passed ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  },
);
