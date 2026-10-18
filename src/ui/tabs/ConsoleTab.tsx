import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { COMMAND_NAMES, executeScript } from '../../console/commands';
import type { ConsoleEntry } from '../../console/types';
import { PageHead } from '../components/controls';
import { useApp, useServices } from '../context';
import { downloadFile } from '../download';

const QUICK = ['help', 'measure', 'recommend', 'design', 'show fit', 'show bom', 'show steps', 'show quality', 'export print', 'export zip', 'schema', 'state'];

function Entry({ e }: { e: ConsoleEntry }) {
  const pkg = useApp((s) => s.pkg);
  if (e.kind === 'input') {
    return (
      <p className="console-entry input">
        {e.text}
        {e.source !== 'user' ? <span style={{ color: '#8d8576' }}> ({e.source})</span> : null}
      </p>
    );
  }
  const r = e.result;
  const json = r?.data !== undefined ? JSON.stringify(r.data, null, 2) : null;
  return (
    <div className={`console-entry ${r && !r.ok ? 'err' : ''}`}>
      {e.text}
      {r?.files?.length ? (
        <div className="console-files">
          {r.files.map((f) => (
            <button key={f.filename} type="button" onClick={() => downloadFile(f, pkg)}>
              ↓ {f.filename}
            </button>
          ))}
        </div>
      ) : null}
      {json && json.length > 2 ? (
        <details>
          <summary>JSON ({json.length > 1024 ? `${(json.length / 1024).toFixed(1)} kB` : `${json.length} chars`})</summary>
          <pre className="json">{json.length > 200_000 ? `${json.slice(0, 200_000)}\n… (truncated; use the API for the full result)` : json}</pre>
        </details>
      ) : null}
    </div>
  );
}

export function ConsoleTab() {
  const { store } = useServices();
  const log = useApp((s) => s.consoleLog);
  const history = useApp((s) => s.consoleHistory);
  const [line, setLine] = useState('');
  const [cursor, setCursor] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  const run = async (text: string) => {
    if (!text.trim() || running) return;
    setRunning(true);
    setLine('');
    setCursor(null);
    try {
      await executeScript(text, { store }, { source: 'user' });
    } finally {
      setRunning(false);
      inputRef.current?.focus();
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void run(line);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') {
      if (!history.length) return;
      e.preventDefault();
      const next = cursor === null ? history.length - 1 : Math.max(0, cursor - 1);
      setCursor(next);
      setLine(history[next] ?? '');
    } else if (e.key === 'ArrowDown') {
      if (cursor === null) return;
      e.preventDefault();
      const next = cursor + 1;
      if (next >= history.length) {
        setCursor(null);
        setLine('');
      } else {
        setCursor(next);
        setLine(history[next] ?? '');
      }
    } else if (e.key === 'Tab') {
      const word = line.trim();
      if (!word || word.includes(' ')) return;
      const match = COMMAND_NAMES.filter((c) => c.startsWith(word.toLowerCase()));
      if (match.length === 1) {
        e.preventDefault();
        setLine(`${match[0]} `);
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      store.getState().clearConsole();
    }
  };

  return (
    <div>
      <PageHead
        eyebrow="Agents & power users"
        title="Console"
        compact
        lede={
          <>
            Drive everything with text commands; the app follows along. Type <code>help</code>. Agents can also call <code>window.clothesCAD</code> or open the app with{' '}
            <code>#cmd=…</code>.
          </>
        }
      />
      <section className="console" aria-label="Command console">
        <div className="console-log" ref={logRef} role="log" aria-live="polite" aria-relevant="additions">
          {log.length === 0 ? (
            <p className="console-entry" style={{ color: '#8d8576' }}>
              clothesCAD console. Try: measure height=168 bust=92 waist=74 hip=100; set garment=a-line-skirt; design; show fit
            </p>
          ) : (
            log.map((e) => <Entry key={e.id} e={e} />)
          )}
        </div>
        <div className="quick-cmds" aria-label="Quick commands">
          {QUICK.map((q) => (
            <button key={q} type="button" onClick={() => void run(q)} disabled={running}>
              {q}
            </button>
          ))}
        </div>
        <form className="console-form" onSubmit={onSubmit}>
          <label htmlFor="console-input" className="sr-only">
            Command
          </label>
          <input
            id="console-input"
            ref={inputRef}
            value={line}
            onChange={(e) => {
              setLine(e.target.value);
              setCursor(null);
            }}
            onKeyDown={onKeyDown}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="send"
            placeholder={running ? 'running…' : 'type a command, e.g. help'}
          />
          <button type="submit" disabled={running || !line.trim()}>
            Run
          </button>
        </form>
      </section>
    </div>
  );
}
