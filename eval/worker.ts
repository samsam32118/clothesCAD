/**
 * Worker thread for `eval/run.ts`: receives one case at a time and replies
 * with its `CaseResult`. Errors inside a case are captured by
 * `evaluateCase`; anything escaping is reported as a crash of that case.
 */
import { parentPort } from 'node:worker_threads';
import type { EvalCase } from './cases';
import { crashResult, evaluateCase } from './evaluate';

export type WorkerRequest = { type: 'case'; c: EvalCase } | { type: 'stop' };
export type WorkerResponse = { type: 'result'; result: ReturnType<typeof evaluateCase> };

if (!parentPort) throw new Error('eval/worker.ts must be started as a worker thread');
const port = parentPort;

port.on('message', (msg: WorkerRequest) => {
  if (msg.type === 'stop') {
    port.close();
    return;
  }
  const c = msg.c;
  let result: ReturnType<typeof evaluateCase>;
  try {
    result = evaluateCase(c);
  } catch (err) {
    result = crashResult(
      { id: c.id, garment: c.garment, profileId: c.profileId, comboKey: c.combo.key, styleId: c.combo.styleId, materialId: c.combo.materialId, deep: c.deep },
      err,
    );
  }
  const response: WorkerResponse = { type: 'result', result };
  port.postMessage(response);
});
