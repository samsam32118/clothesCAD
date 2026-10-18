import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createAgentAPI, stripFiles, type AgentAPI } from './console/api';
import { executeScript } from './console/commands';
import { createAppStore, safeLocalStorage, type AppStore } from './console/store';
import type { CommandResult } from './console/types';
import { App } from './ui/App';
import { ErrorBoundary } from './ui/components/ErrorBoundary';
import { ServicesProvider } from './ui/context';
import './ui/styles.css';

declare global {
  interface Window {
    clothesCAD: AgentAPI;
  }
}

/** Mirror the last command result into <pre id="agent-output"> for agents that read the DOM. */
function mirrorAgentOutput(store: AppStore): void {
  const pre = document.getElementById('agent-output');
  if (!pre) return;
  const write = (r: CommandResult | null) => {
    try {
      pre.textContent = r ? JSON.stringify(stripFiles(r)) : '';
      pre.dataset.ok = r ? String(r.ok) : '';
    } catch (err) {
      pre.textContent = JSON.stringify({ ok: false, message: `Could not serialise result: ${String(err)}` });
    }
  };
  write(store.getState().lastResult);
  store.subscribe((s, prev) => {
    if (s.lastResult !== prev.lastResult) write(s.lastResult);
  });
}

interface HashScript {
  commands: string;
  /** `keep=1`: build on the saved app state instead of starting from defaults. */
  keep: boolean;
}

/** Commands from the URL hash: #cmd=<url-encoded commands separated by ;>[&keep=1] */
function hashScript(): HashScript | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const cmd = params.get('cmd');
  if (!cmd || !cmd.trim()) return null;
  const keep = params.get('keep');
  return { commands: cmd, keep: keep === '1' || keep === 'true' };
}

/**
 * Run the hash script. For reproducible agent links it starts from the
 * default state (measurements, choices and design reset; sewing progress and
 * console history kept) unless `keep=1` is given. The hash is removed
 * afterwards so reloading the page does not run the commands again.
 */
async function runHash(store: AppStore): Promise<void> {
  const script = hashScript();
  if (!script) return;
  document.documentElement.dataset.clothescad = 'running';
  if (!script.keep) store.getState().reset();
  try {
    await executeScript(script.commands, { store }, { source: 'hash', stopOnError: true });
  } finally {
    try {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    } catch {
      /* sandboxed frames may refuse history changes: harmless */
    }
  }
}

function boot(): void {
  const store = createAppStore({ storage: safeLocalStorage() });
  const api = createAgentAPI(store);
  window.clothesCAD = api;
  mirrorAgentOutput(store);

  const rootEl = document.getElementById('root');
  if (!rootEl) throw new Error('clothesCAD: #root element missing from index.html');
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary area="clothesCAD">
        <ServicesProvider store={store} api={api}>
          <App />
        </ServicesProvider>
      </ErrorBoundary>
    </StrictMode>,
  );

  const finish = () => {
    document.documentElement.dataset.clothescad = 'ready';
  };
  runHash(store).then(finish, (err: unknown) => {
    console.error('clothesCAD: start-up commands failed', err);
    finish();
  });
  window.addEventListener('hashchange', () => {
    void runHash(store).then(finish, finish);
  });
}

boot();
