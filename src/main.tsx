import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createAgentAPI, stripFiles, type AgentAPI } from './console/api';
import { executeScript } from './console/commands';
import { createAppStore, hasOwnWork, safeLocalStorage, type AppStore } from './console/store';
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

/** Ensure a message ends like a sentence so text can follow it. */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?:)]$/.test(t) ? t : `${t}.`;
}

/**
 * Run the hash script. For reproducible agent links it starts from the
 * default state (measurements, choices and design reset; sewing progress and
 * console history kept) unless `keep=1` is given. The hash is removed
 * afterwards so reloading the page does not run the commands again.
 *
 * A person may open such a link on top of their own work, so the state from
 * before the link is kept aside:
 * - if any command fails, that state is put back (a broken link never costs
 *   the user their measurements) and a banner names the failing command;
 * - if the link succeeds and replaced the user's own measurements or design,
 *   the banner offers to undo it.
 * Agents still read the failure from <pre id="agent-output" data-ok="false">.
 */
async function runHash(store: AppStore): Promise<void> {
  const script = hashScript();
  if (!script) return;
  document.documentElement.dataset.clothescad = 'running';
  const before = store.getState().snapshot();
  store.getState().setLinkNotice(null);
  if (!script.keep) store.getState().reset();
  try {
    const results = await executeScript(script.commands, { store }, { source: 'hash', stopOnError: true });
    const failed = results.find((r) => !r.ok);
    const st = store.getState();
    if (failed) {
      if (!script.keep) st.restore(before);
      st.setLinkNotice({
        ok: false,
        failedCommand: failed.command,
        message: script.keep
          ? `The link's command “${failed.command}” failed: ${sentence(failed.message)} Commands before it were applied; the rest did not run.`
          : `The link's command “${failed.command}” failed: ${sentence(failed.message)} Nothing was changed: your own measurements and design are as you left them.`,
        undo: null,
      });
    } else if (!script.keep && hasOwnWork(before)) {
      st.setLinkNotice({
        ok: true,
        failedCommand: null,
        message: `A link ran ${results.length} command${results.length === 1 ? '' : 's'} and replaced your measurements and design.`,
        undo: before,
      });
    }
  } catch (err) {
    if (!script.keep) store.getState().restore(before);
    store.getState().setLinkNotice({
      ok: false,
      failedCommand: null,
      message: `The link's commands could not run: ${err instanceof Error ? err.message : String(err)}`,
      undo: null,
    });
    throw err;
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
