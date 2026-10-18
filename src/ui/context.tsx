import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { AppState, AppStore } from '../console/store';
import type { AgentAPI } from '../console/api';

interface Services {
  store: AppStore;
  api: AgentAPI;
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ store, api, children }: Services & { children: ReactNode }) {
  const value = useMemo(() => ({ store, api }), [store, api]);
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('clothesCAD UI rendered outside <ServicesProvider>.');
  return s;
}

/** Subscribe to a slice of the shared app store. */
export function useApp<T>(selector: (s: AppState) => T): T {
  return useStore(useServices().store, selector);
}

/** Store actions (stable references). */
export function useActions(): AppState {
  return useServices().store.getState();
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
  action?: ToastAction;
}

type Notify = (text: string, tone?: Toast['tone'], action?: ToastAction) => void;

const ToastContext = createContext<Notify>(() => undefined);

/** `scope` (e.g. the visible tab): toasts belong to it and are cleared when it changes. */
export function ToastProvider({ children, scope }: { children: ReactNode; scope?: unknown }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => setToasts([]), [scope]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const notify = useCallback<Notify>(
    (text, tone = 'info', action) => {
      const id = next.current++;
      setToasts((t) => [...t.slice(-2), { id, text, tone, ...(action ? { action } : {}) }]);
      // Toasts with an action stay long enough to be used.
      window.setTimeout(() => dismiss(id), action ? 8000 : tone === 'error' ? 6000 : 3200);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === 'error' ? 'error' : ''}`}>
            <span>{t.text}</span>
            {t.action ? (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Notify {
  return useContext(ToastContext);
}
