/** Types shared by the command interpreter, agent API, store, UI and CLI. */

/** A file produced by an export (written by the CLI, downloaded by the UI). */
export interface ExportFile {
  /** Canonical file name, e.g. "pattern.svg", "print-A4-page-2.svg", "model.glb". */
  filename: string;
  mime: string;
  data: string | Uint8Array;
}

/** Outcome of one console/CLI command. `data` is always JSON-serialisable. */
export interface CommandResult {
  ok: boolean;
  /** The command line that produced this result (normalised). */
  command: string;
  /** One-paragraph human-readable summary. */
  message: string;
  data?: unknown;
  files?: ExportFile[];
}

export type TabId = 'measure' | 'design' | 'pattern' | 'make' | '3d' | 'console';

export const TAB_IDS: readonly TabId[] = ['measure', 'design', 'pattern', 'make', '3d', 'console'];

export interface ConsoleEntry {
  id: number;
  kind: 'input' | 'result';
  text: string;
  result?: CommandResult;
  source: 'user' | 'hash' | 'api' | 'cli';
}
