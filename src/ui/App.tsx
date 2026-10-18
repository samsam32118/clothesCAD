import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { TAB_IDS, type TabId } from '../console/types';
import { isDesignStale } from '../console/store';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TabIcons } from './components/icons';
import { ToastProvider, useActions, useApp } from './context';
import { MeasureTab } from './tabs/MeasureTab';
import { DesignTab } from './tabs/DesignTab';
import { PatternTab } from './tabs/PatternTab';
import { MakeTab } from './tabs/MakeTab';
import { ConsoleTab } from './tabs/ConsoleTab';

// The 3D tab pulls in three.js only when opened.
const ViewerTab = lazy(() => import('./tabs/ViewerTab').then((m) => ({ default: m.ViewerTab })));

const TAB_LABEL: Record<TabId, string> = {
  measure: 'Measure',
  design: 'Design',
  pattern: 'Pattern',
  make: 'Make',
  '3d': '3D',
  console: 'Console',
};

const TAB_VIEWS: Record<TabId, () => ReactNode> = {
  measure: () => <MeasureTab />,
  design: () => <DesignTab />,
  pattern: () => <PatternTab />,
  make: () => <MakeTab />,
  '3d': () => (
    <Suspense fallback={<p className="muted">Loading 3D…</p>}>
      <ViewerTab />
    </Suspense>
  ),
  console: () => <ConsoleTab />,
};

function TabBar({ tab, onChange }: { tab: TabId; onChange: (t: TabId) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    let j = i;
    if (e.key === 'ArrowRight') j = (i + 1) % TAB_IDS.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + TAB_IDS.length) % TAB_IDS.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = TAB_IDS.length - 1;
    else return;
    e.preventDefault();
    onChange(TAB_IDS[j]!);
    refs.current[j]?.focus();
  };
  return (
    <nav className="tabbar" aria-label="Sections">
      <div role="tablist" aria-label="Sections" style={{ display: 'contents' }}>
        {TAB_IDS.map((t, i) => {
          const Icon = TabIcons[t];
          return (
            <button
              key={t}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${t}`}
              aria-controls="panel"
              aria-selected={t === tab}
              tabIndex={t === tab ? 0 : -1}
              className="tab"
              onClick={() => onChange(t)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <Icon />
              <span>{TAB_LABEL[t]}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/** Result of a `#cmd=` link, so a person who opened one sees what happened (and can undo it). */
function LinkBanner() {
  const notice = useApp((s) => s.linkNotice);
  const { restore, setLinkNotice } = useActions();
  if (!notice) return null;
  const undo = notice.undo;
  return (
    <div className={`notice link-banner ${notice.ok ? '' : 'error'}`} role={notice.ok ? 'status' : 'alert'}>
      <span>{notice.message}</span>
      <span className="link-banner-actions">
        {undo ? (
          <button
            type="button"
            className="btn small"
            onClick={() => {
              restore(undo);
              setLinkNotice(null);
            }}
          >
            Restore my measurements
          </button>
        ) : null}
        <button type="button" className="btn small" onClick={() => setLinkNotice(null)}>
          Dismiss
        </button>
      </span>
    </div>
  );
}

function Status() {
  const pkg = useApp((s) => s.pkg);
  const stale = useApp((s) => isDesignStale(s));
  if (!pkg) return <span className="topbar-status">Made-to-measure patterns</span>;
  return (
    <span className="topbar-status" title={pkg.name}>
      {pkg.name}
      {stale ? ' · changed' : ''}
    </span>
  );
}

export function App() {
  const tab = useApp((s) => s.tab);
  const pkgId = useApp((s) => s.pkg?.id ?? null);
  const setTab = useActions().setTab;
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    window.scrollTo({ top: 0 });
    document.title = `${TAB_LABEL[tab]} · clothesCAD`;
  }, [tab]);

  return (
    <ToastProvider scope={tab}>
      <div className="app">
        <header className="topbar">
          <p className="brand">
            clothes<em>CAD</em>
          </p>
          <Status />
        </header>
        <main className="content" id="panel" role="tabpanel" aria-labelledby={`tab-${tab}`} ref={main} tabIndex={-1}>
          <LinkBanner />
          <ErrorBoundary area={TAB_LABEL[tab]} resetKey={`${tab}:${pkgId ?? ''}`}>
            {TAB_VIEWS[tab]()}
          </ErrorBoundary>
        </main>
        <TabBar tab={tab} onChange={setTab} />
      </div>
    </ToastProvider>
  );
}
