/**
 * The single application store, shared by the React UI, the in-app console,
 * the `window.clothesCAD` agent API and the Node CLI.
 *
 * Built on zustand's vanilla store so it works without React (CLI, tests);
 * the UI binds to it with `useStore`. Optional persistence (browser
 * localStorage) is injected by the caller and never throws.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { design } from '../core/design';
import { GARMENTS, MATERIALS, STYLES, getGarment, type Region } from '../core/presets';
import { parseDesignRequest, type SchemaIssue } from '../core/schema';
import type {
  DesignPackage,
  DesignRequest,
  GarmentDefinition,
  GarmentOptions,
  GarmentType,
  MeasurementKey,
  Measurements,
  Occasion,
} from '../core/types';
import { effectiveOccasion, materialFits, pickPresets, rankMaterials, rankStyles, styleFits } from './picks';
import type { CommandResult, ConsoleEntry, TabId } from './types';
import type { UnitSystem } from './units';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface Selection {
  garment: GarmentType;
  styleId: string;
  materialId: string;
  occasion: Occasion | null;
  region: Region;
  options: GarmentOptions;
  name: string | null;
  seamAllowanceCm: number | null;
  hemAllowanceCm: number | null;
}

export type MeasurementDraft = Partial<Record<MeasurementKey, number>>;

export interface AppData {
  measurements: MeasurementDraft;
  /** True until the user changes the sample measurements shipped as a starting point. */
  measurementsAreSample: boolean;
  unit: UnitSystem;
  selection: Selection;
  pkg: DesignPackage | null;
  /** Request that produced `pkg` (persisted, so the package is recomputed on reload). */
  designedRequest: DesignRequest | null;
  designError: string | null;
  /** Completed instruction step numbers per package id. */
  progress: Record<string, number[]>;
  tab: TabId;
  consoleLog: ConsoleEntry[];
  consoleHistory: string[];
  lastResult: CommandResult | null;
  /** Outcome of the commands a `#cmd=` link ran at start-up, shown as a banner (not persisted). */
  linkNotice: LinkNotice | null;
}

/** Everything a `#cmd=` link may replace: enough to put the user's own work back. */
export type SessionSnapshot = Pick<
  AppData,
  'measurements' | 'measurementsAreSample' | 'unit' | 'selection' | 'pkg' | 'designedRequest' | 'designError' | 'tab'
>;

export interface LinkNotice {
  ok: boolean;
  /** Plain-language summary for the banner. */
  message: string;
  /** The failing command (when ok is false). */
  failedCommand: string | null;
  /** The user's state from before the link ran, when it can still be restored. */
  undo: SessionSnapshot | null;
}

export type DesignOutcome =
  | { ok: true; pkg: DesignPackage }
  | { ok: false; error: string; issues?: SchemaIssue[] };

export interface AppActions {
  /** Merge measurement values (cm). `undefined` removes a key. */
  setMeasurements(patch: Partial<Record<MeasurementKey, number | undefined>>): void;
  replaceMeasurements(m: MeasurementDraft): void;
  setUnit(unit: UnitSystem): void;
  /** Change garment/style/material/... Options are re-sanitised for the garment. Returns notes on automatic adjustments. */
  select(patch: Partial<Selection>): string[];
  setOption<K extends keyof GarmentOptions>(key: K, value: GarmentOptions[K] | undefined): void;
  /** Build the request from the current state and run the design pipeline. */
  runDesign(): DesignOutcome;
  /** Replace measurements + selection from a full DesignRequest and design it. */
  applyRequest(request: DesignRequest): DesignOutcome;
  toggleStep(pkgId: string, step: number): void;
  setTab(tab: TabId): void;
  appendConsole(entries: Array<Omit<ConsoleEntry, 'id'>>): void;
  clearConsole(): void;
  pushHistory(line: string): void;
  setLastResult(r: CommandResult): void;
  reset(): void;
  /** Copy of the user's measurements, choices and design (for undoing a link that replaced them). */
  snapshot(): SessionSnapshot;
  restore(snapshot: SessionSnapshot): void;
  setLinkNotice(notice: LinkNotice | null): void;
}

export type AppState = AppData & AppActions;
export type AppStore = StoreApi<AppState>;

// ---------------------------------------------------------------------------
// Defaults and sanitising
// ---------------------------------------------------------------------------

/** A mid-range European size 38/40 so a first-time visitor can explore immediately. */
export const SAMPLE_MEASUREMENTS: MeasurementDraft = { heightCm: 168, bustCm: 90, waistCm: 72, hipCm: 98 };

const MAX_LOG = 300;
const MAX_HISTORY = 100;

function firstId<T extends { id: string }>(list: readonly T[], preferred: string): string {
  return list.some((x) => x.id === preferred) ? preferred : (list[0]?.id ?? preferred);
}

export function defaultSelection(): Selection {
  const garment = firstId(GARMENTS, 'a-line-skirt') as GarmentType;
  const styleId = firstId(STYLES, 'parisian-chic');
  const style = STYLES.find((s) => s.id === styleId);
  // The same automatic pick the console and CLI make, so the starting design
  // never carries a "this cloth is unusual" warning.
  const materialId = pickPresets({ garment, styleId }).materialId;
  return {
    garment,
    styleId,
    materialId,
    occasion: null,
    region: style?.region ?? 'european',
    options: {},
    name: null,
    seamAllowanceCm: null,
    hemAllowanceCm: null,
  };
}

function defaultData(): AppData {
  return {
    measurements: { ...SAMPLE_MEASUREMENTS },
    measurementsAreSample: true,
    unit: 'cm',
    selection: defaultSelection(),
    pkg: null,
    designedRequest: null,
    designError: null,
    progress: {},
    tab: 'measure',
    consoleLog: [],
    consoleHistory: [],
    lastResult: null,
    linkNotice: null,
  };
}

/** True when the snapshot holds something the user would not want to lose silently. */
export function hasOwnWork(s: SessionSnapshot): boolean {
  return !s.measurementsAreSample || s.designedRequest !== null;
}

/** Drop option values the garment does not offer; clamp numbers. */
export function sanitizeOptions(garment: GarmentDefinition, options: GarmentOptions): GarmentOptions {
  const out: GarmentOptions = {};
  const a = garment.allowed;
  if (options.length !== undefined && a.length.includes(options.length)) out.length = options.length;
  if (options.sleeve !== undefined && a.sleeve.includes(options.sleeve)) out.sleeve = options.sleeve;
  if (options.neckline !== undefined && a.neckline.includes(options.neckline)) out.neckline = options.neckline;
  if (options.closure !== undefined && a.closure.includes(options.closure)) out.closure = options.closure;
  if (options.lining !== undefined && a.lining) out.lining = options.lining;
  if (options.pockets !== undefined && a.pockets) out.pockets = options.pockets;
  if (options.fit !== undefined) out.fit = options.fit;
  if (options.flare !== undefined && Number.isFinite(options.flare)) out.flare = Math.min(1, Math.max(0, options.flare));
  return out;
}

/** Repair a selection (e.g. from old localStorage) against the current catalogue. */
export function sanitizeSelection(sel: Partial<Selection> | undefined): Selection {
  const d = defaultSelection();
  if (!sel) return d;
  const garment = GARMENTS.some((g) => g.id === sel.garment) ? (sel.garment as GarmentType) : d.garment;
  const g = getGarment(garment);
  const styleId = STYLES.some((s) => s.id === sel.styleId) ? (sel.styleId as string) : d.styleId;
  let materialId = MATERIALS.some((m) => m.id === sel.materialId) ? (sel.materialId as string) : d.materialId;
  const mat = MATERIALS.find((m) => m.id === materialId);
  if (mat && !g.fabricTypes.includes(mat.construction)) {
    materialId = pickPresets({ garment, styleId, occasion: sel.occasion ?? null }).materialId;
  }
  return {
    garment,
    styleId,
    materialId,
    occasion: sel.occasion ?? null,
    region: sel.region === 'scandinavian' || sel.region === 'european' ? sel.region : d.region,
    options: sanitizeOptions(g, sel.options ?? {}),
    name: typeof sel.name === 'string' && sel.name.trim() ? sel.name : null,
    seamAllowanceCm: typeof sel.seamAllowanceCm === 'number' ? sel.seamAllowanceCm : null,
    hemAllowanceCm: typeof sel.hemAllowanceCm === 'number' ? sel.hemAllowanceCm : null,
  };
}

const REQUIRED: MeasurementKey[] = ['heightCm', 'bustCm', 'waistCm', 'hipCm'];

/** The DesignRequest the current state describes, or a plain-language reason it is incomplete. */
export function buildRequest(
  data: Pick<AppData, 'measurements' | 'selection'>,
): { ok: true; request: DesignRequest } | { ok: false; error: string; issues: SchemaIssue[] } {
  const missing = REQUIRED.filter((k) => !(typeof data.measurements[k] === 'number' && data.measurements[k]! > 0));
  if (missing.length) {
    return {
      ok: false,
      error: `Missing required measurement${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`,
      issues: missing.map((k) => ({ path: `measurements.${k}`, message: `${k} is required` })),
    };
  }
  const sel = data.selection;
  const measurements = Object.fromEntries(
    Object.entries(data.measurements).filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v > 0),
  ) as unknown as Measurements;
  const raw: DesignRequest = {
    measurements,
    garment: sel.garment,
    styleId: sel.styleId,
    materialId: sel.materialId,
    ...(sel.occasion ? { occasion: sel.occasion } : {}),
    ...(Object.keys(sel.options).length ? { options: sanitizeOptions(getGarment(sel.garment), sel.options) } : {}),
    ...(sel.seamAllowanceCm !== null ? { seamAllowanceCm: sel.seamAllowanceCm } : {}),
    ...(sel.hemAllowanceCm !== null ? { hemAllowanceCm: sel.hemAllowanceCm } : {}),
    ...(sel.name ? { name: sel.name } : {}),
  };
  const parsed = parseDesignRequest(raw);
  if (!parsed.ok) {
    return { ok: false, error: parsed.issues.map((i) => `${i.path || 'request'}: ${i.message}`).join('; '), issues: parsed.issues };
  }
  return { ok: true, request: parsed.value };
}

/** True when the visible choices differ from the request that produced the current package. */
export function isDesignStale(s: Pick<AppData, 'measurements' | 'selection' | 'designedRequest'>): boolean {
  if (!s.designedRequest) return false;
  const r = buildRequest(s);
  return !r.ok || JSON.stringify(r.request) !== JSON.stringify(s.designedRequest);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

/** Persisted subset (the package itself is recomputed deterministically). */
type PersistedData = Pick<
  AppData,
  'measurements' | 'measurementsAreSample' | 'unit' | 'selection' | 'designedRequest' | 'progress' | 'tab' | 'consoleHistory'
>;

export interface CreateStoreOptions {
  /** Key/value storage for persistence (e.g. a guarded localStorage). Omit for an in-memory store. */
  storage?: StateStorage;
  storageKey?: string;
}

export function createAppStore(opts: CreateStoreOptions = {}): AppStore {
  const init = (set: StoreApi<AppState>['setState'], get: StoreApi<AppState>['getState']): AppState => {
    const runWith = (request: DesignRequest): DesignOutcome => {
      try {
        const pkg = design(request);
        set({ pkg, designedRequest: request, designError: null });
        return { ok: true, pkg };
      } catch (err) {
        const error = errorMessage(err);
        set({ designError: error });
        return { ok: false, error };
      }
    };

    return {
      ...defaultData(),

      setMeasurements(patch) {
        const next: MeasurementDraft = { ...get().measurements };
        for (const [k, v] of Object.entries(patch) as Array<[MeasurementKey, number | undefined]>) {
          if (v === undefined || !Number.isFinite(v)) delete next[k];
          else next[k] = Math.round(v * 100) / 100;
        }
        set({ measurements: next, measurementsAreSample: false });
      },

      replaceMeasurements(m) {
        set({ measurements: { ...m }, measurementsAreSample: false });
      },

      setUnit(unit) {
        set({ unit });
      },

      select(patch) {
        const notes: string[] = [];
        const cur = get().selection;
        const merged: Selection = { ...cur, ...patch, options: { ...cur.options, ...(patch.options ?? {}) } };
        const garment = getGarment(merged.garment);
        if (patch.styleId && !patch.region) {
          const style = STYLES.find((s) => s.id === patch.styleId);
          if (style) merged.region = style.region;
        }
        // When the brief changes (garment or occasion) keep the style and cloth only if
        // they still suit it; otherwise pick the best match and say so. Explicit
        // style/material choices in the same patch are respected.
        const briefChanged =
          (patch.garment !== undefined && patch.garment !== cur.garment) ||
          (patch.occasion !== undefined && patch.occasion !== cur.occasion);
        const occasion = effectiveOccasion(garment, merged.occasion);
        const ctx = { garment: garment.id, occasion: merged.occasion, region: merged.region, measurements: get().measurements };
        const style = STYLES.find((s) => s.id === merged.styleId);
        if (briefChanged && patch.styleId === undefined && style && !styleFits(style, occasion)) {
          const alt = rankStyles(ctx)[0];
          if (alt && alt.id !== style.id) {
            notes.push(`${style.name} is not a ${occasion} style, so ${alt.name} was selected instead.`);
            merged.styleId = alt.id;
            merged.region = alt.region;
          }
        }
        const mat = MATERIALS.find((m) => m.id === merged.materialId);
        const wrongConstruction = !!mat && !garment.fabricTypes.includes(mat.construction);
        const unsuited = !!mat && briefChanged && patch.materialId === undefined && !materialFits(mat, garment, occasion);
        if (!mat || wrongConstruction || unsuited) {
          const alt = rankMaterials({ ...ctx, styleId: merged.styleId })[0];
          if (alt && alt.id !== merged.materialId) {
            if (mat && wrongConstruction) {
              notes.push(`${mat.name} is a ${mat.construction}; a ${garment.name.toLowerCase()} needs ${garment.fabricTypes.join(' or ')} fabric, so ${alt.name} was selected instead.`);
            } else if (mat) {
              notes.push(`${mat.name} is not suited to a ${garment.name.toLowerCase()}${occasion ? ` for ${occasion} wear` : ''}, so ${alt.name} was selected instead.`);
            }
            merged.materialId = alt.id;
          }
        }
        const clean = sanitizeOptions(garment, merged.options);
        for (const k of Object.keys(merged.options) as Array<keyof GarmentOptions>) {
          if (merged.options[k] !== undefined && clean[k] === undefined) {
            notes.push(`Option ${k}=${String(merged.options[k])} is not offered for a ${garment.name.toLowerCase()} and was cleared.`);
          }
        }
        set({ selection: { ...merged, options: clean } });
        return notes;
      },

      setOption(key, value) {
        const sel = get().selection;
        const options: GarmentOptions = { ...sel.options };
        if (value === undefined) delete options[key];
        else options[key] = value;
        set({ selection: { ...sel, options: sanitizeOptions(getGarment(sel.garment), options) } });
      },

      runDesign() {
        const r = buildRequest(get());
        if (!r.ok) {
          set({ designError: r.error });
          return r;
        }
        return runWith(r.request);
      },

      applyRequest(request) {
        const parsed = parseDesignRequest(request);
        if (!parsed.ok) {
          const error = parsed.issues.map((i) => `${i.path || 'request'}: ${i.message}`).join('; ');
          set({ designError: error });
          return { ok: false, error, issues: parsed.issues };
        }
        const req = parsed.value;
        let selection: Selection;
        try {
          selection = sanitizeSelection({
            garment: req.garment,
            styleId: req.styleId,
            materialId: req.materialId,
            occasion: req.occasion ?? null,
            region: STYLES.find((s) => s.id === req.styleId)?.region ?? get().selection.region,
            options: req.options ?? {},
            name: req.name ?? null,
            seamAllowanceCm: req.seamAllowanceCm ?? null,
            hemAllowanceCm: req.hemAllowanceCm ?? null,
          });
        } catch (err) {
          const error = errorMessage(err);
          set({ designError: error });
          return { ok: false, error };
        }
        set({ measurements: { ...req.measurements }, measurementsAreSample: false, selection });
        // Run the request exactly as given (the pipeline explains unknown ids and option substitutions).
        return runWith(req);
      },

      toggleStep(pkgId, step) {
        const progress = { ...get().progress };
        const done = new Set(progress[pkgId] ?? []);
        if (done.has(step)) done.delete(step);
        else done.add(step);
        progress[pkgId] = [...done].sort((a, b) => a - b);
        set({ progress });
      },

      setTab(tab) {
        set({ tab });
      },

      appendConsole(entries) {
        const log = get().consoleLog;
        let id = log.length ? log[log.length - 1]!.id : 0;
        const next = [...log, ...entries.map((e) => ({ ...e, id: ++id }))];
        set({ consoleLog: next.length > MAX_LOG ? next.slice(next.length - MAX_LOG) : next });
      },

      clearConsole() {
        set({ consoleLog: [] });
      },

      pushHistory(line) {
        const trimmed = line.trim();
        if (!trimmed) return;
        const hist = get().consoleHistory.filter((h) => h !== trimmed);
        hist.push(trimmed);
        set({ consoleHistory: hist.slice(-MAX_HISTORY) });
      },

      setLastResult(r) {
        set({ lastResult: r });
      },

      reset() {
        // Sewing progress is keyed by design id, so keeping it is harmless and saves work.
        const { consoleHistory, consoleLog, progress, lastResult, linkNotice } = get();
        set({ ...defaultData(), consoleHistory, consoleLog, progress, lastResult, linkNotice });
      },

      snapshot() {
        const s = get();
        return {
          measurements: { ...s.measurements },
          measurementsAreSample: s.measurementsAreSample,
          unit: s.unit,
          selection: { ...s.selection, options: { ...s.selection.options } },
          pkg: s.pkg,
          designedRequest: s.designedRequest,
          designError: s.designError,
          tab: s.tab,
        };
      },

      restore(snap) {
        set({
          measurements: { ...snap.measurements },
          measurementsAreSample: snap.measurementsAreSample,
          unit: snap.unit,
          selection: sanitizeSelection(snap.selection),
          pkg: snap.pkg,
          designedRequest: snap.designedRequest,
          designError: snap.designError,
          tab: snap.tab,
        });
      },

      setLinkNotice(notice) {
        set({ linkNotice: notice });
      },
    };
  };

  if (!opts.storage) return createStore<AppState>()((set, get) => init(set, get));

  const storage = opts.storage;
  const store = createStore<AppState>()(
    persist((set, get) => init(set, get), {
      name: opts.storageKey ?? 'clothescad:v1',
      version: 1,
      storage: createJSONStorage<PersistedData>(() => storage),
      partialize: (s): PersistedData => ({
        measurements: s.measurements,
        measurementsAreSample: s.measurementsAreSample,
        unit: s.unit,
        selection: s.selection,
        designedRequest: s.designedRequest,
        progress: s.progress,
        tab: s.tab,
        consoleHistory: s.consoleHistory,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PersistedData>;
        const measurements: MeasurementDraft = {};
        if (p.measurements && typeof p.measurements === 'object') {
          for (const [k, v] of Object.entries(p.measurements)) {
            if (typeof v === 'number' && Number.isFinite(v) && v > 0) measurements[k as MeasurementKey] = v;
          }
        }
        return {
          ...current,
          measurements: Object.keys(measurements).length ? measurements : current.measurements,
          measurementsAreSample: p.measurementsAreSample ?? current.measurementsAreSample,
          unit: p.unit === 'in' ? 'in' : 'cm',
          selection: sanitizeSelection(p.selection),
          designedRequest: p.designedRequest ?? null,
          progress: p.progress && typeof p.progress === 'object' ? p.progress : {},
          tab: p.tab ?? current.tab,
          consoleHistory: Array.isArray(p.consoleHistory) ? p.consoleHistory.filter((x) => typeof x === 'string') : [],
        };
      },
    }),
  );
  // Restore the last design (deterministic, so recomputing reproduces it exactly).
  const restored = store.getState().designedRequest;
  if (restored) {
    try {
      store.setState({ pkg: design(restored), designError: null });
    } catch (err) {
      store.setState({ designedRequest: null, designError: `Could not restore the last design: ${errorMessage(err)}` });
    }
  }
  return store;
}

/** localStorage wrapped so private mode / blocked storage never throws. */
export function safeLocalStorage(): StateStorage {
  const ls = (): Storage | null => {
    try {
      return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
    } catch {
      return null;
    }
  };
  return {
    getItem(name) {
      try {
        return ls()?.getItem(name) ?? null;
      } catch {
        return null;
      }
    },
    setItem(name, value) {
      try {
        ls()?.setItem(name, value);
      } catch {
        /* quota exceeded or storage blocked: keep working in memory */
      }
    },
    removeItem(name) {
      try {
        ls()?.removeItem(name);
      } catch {
        /* ignore */
      }
    },
  };
}
