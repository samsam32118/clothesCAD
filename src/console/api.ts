/**
 * `window.clothesCAD`: a JSON-in / JSON-out API for AI agents and scripts.
 *
 * Every method accepts plain objects or JSON strings and returns an envelope
 *   { ok: true, data }  |  { ok: false, error, issues? }
 * (async for exports that need three.js). Calls go through the shared store,
 * so the visible app follows whatever an agent does.
 */
import { validateMeasurements, resolveMeasurements } from '../core/measurements';
import { analyzeBody } from '../core/fit/analyze';
import { GARMENTS, MATERIALS, STYLES, recommend as rankPresets, type Region } from '../core/presets';
import {
  designRequestJSONSchema,
  garmentOptionsSchema,
  measurementsJSONSchema,
  measurementsSchema,
  parseMeasurements,
  type SchemaIssue,
} from '../core/schema';
import type { DesignPackage, FabricLayer, GarmentType, MeasurementIssue, Occasion } from '../core/types';
import { z } from 'zod';
import { commandHelp, executeScript, currentBody } from './commands';
import { buildExport, glbFile, objFile, printableHtml, toBase64, type Paper } from './exports';
import { renderCuttingLayoutSVG, renderPatternSheetSVG, renderPieceSVG, renderTiledPrintPages } from '../core/svg';
import { renderInstructionsMarkdown } from '../core/instructions';
import { fillMissingPicks, type AutoPicks } from './picks';
import { createAppStore, type AppStore } from './store';
import { designSummary, garmentSummary, materialSummary, stateSnapshot, styleSummary } from './summary';
import { TAB_IDS, type CommandResult } from './types';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; issues?: SchemaIssue[] };

const success = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const failure = (error: string, issues?: SchemaIssue[]): ApiResult<never> => ({ ok: false, error, ...(issues?.length ? { issues } : {}) });

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Accept an object or a JSON string. */
function input(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (!t) return undefined;
  return JSON.parse(t) as unknown;
}

function guard<T>(fn: () => ApiResult<T>): ApiResult<T> {
  try {
    return fn();
  } catch (err) {
    return failure(message(err));
  }
}

async function guardAsync<T>(fn: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  try {
    return await fn();
  } catch (err) {
    return failure(message(err));
  }
}

const issuesOf = (e: z.ZodError): SchemaIssue[] => e.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));

const recommendQuery = z
  .strictObject({
    garment: z.string().optional(),
    styleId: z.string().optional(),
    occasion: z.enum(['everyday', 'work', 'evening', 'runway']).optional(),
    region: z.enum(['european', 'scandinavian']).optional(),
    measurements: z.unknown().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .optional();

const statePatchSchema = z.strictObject({
  measurements: measurementsSchema.partial().optional(),
  replaceMeasurements: z.boolean().optional(),
  unit: z.enum(['cm', 'in']).optional(),
  garment: z.string().optional(),
  styleId: z.string().optional(),
  materialId: z.string().optional(),
  occasion: z.enum(['everyday', 'work', 'evening', 'runway']).nullable().optional(),
  region: z.enum(['european', 'scandinavian']).optional(),
  options: garmentOptionsSchema.optional(),
  name: z.string().max(120).nullable().optional(),
  seamAllowanceCm: z.number().min(0.5).max(3).nullable().optional(),
  hemAllowanceCm: z.number().min(0.5).max(8).nullable().optional(),
  tab: z.enum(TAB_IDS as unknown as [string, ...string[]]).optional(),
});
export type StatePatch = z.infer<typeof statePatchSchema>;

const designOptions = z.strictObject({ strict: z.boolean().optional() });

export type DesignData = ReturnType<typeof designSummary> & { picks?: AutoPicks };

/** In strict mode: every requested option value must be one the garment offers. */
function strictOptionIssues(request: unknown): SchemaIssue[] {
  if (typeof request !== 'object' || request === null) return [];
  const r = request as { garment?: unknown; options?: unknown };
  const g = GARMENTS.find((x) => x.id === r.garment);
  if (!g || typeof r.options !== 'object' || r.options === null) return [];
  const o = r.options as Record<string, unknown>;
  const issues: SchemaIssue[] = [];
  for (const key of ['length', 'sleeve', 'neckline', 'closure'] as const) {
    const v = o[key];
    const allowed: readonly string[] = g.allowed[key];
    if (typeof v === 'string' && !allowed.includes(v)) {
      issues.push({ path: `options.${key}`, message: `${g.name} offers ${key}: ${allowed.join(', ')} (got '${v}').` });
    }
  }
  for (const key of ['lining', 'pockets'] as const) {
    if (o[key] === true && !g.allowed[key]) issues.push({ path: `options.${key}`, message: `${g.name} does not offer ${key}.` });
  }
  return issues;
}

export interface ValidationData {
  valid: boolean;
  issues: MeasurementIssue[];
  /** Measurement keys that will be estimated from height/bust/waist/hip. */
  estimated: string[];
  body: { shape: string; notes: string[] } | null;
}

export type SvgKind = 'pattern' | 'layout' | 'print' | 'piece';

export type RunCommandResult = Omit<CommandResult, 'files'> & { files?: Array<{ filename: string; mime: string; bytes: number }> };

export type RunResult =
  | { ok: true; data: RunCommandResult[] }
  | { ok: false; error: string; failedAt: number; command: string | null; data: RunCommandResult[] };

export interface AgentAPI {
  readonly version: string;
  help(): ApiResult<{ methods: Record<string, string>; commands: ReturnType<typeof commandHelp>; hash: string; dom: string }>;
  listGarments(): ApiResult<ReturnType<typeof garmentSummary>[]>;
  listMaterials(filter?: unknown): ApiResult<ReturnType<typeof materialSummary>[]>;
  listStyles(filter?: unknown): ApiResult<ReturnType<typeof styleSummary>[]>;
  recommend(query?: unknown): ApiResult<{ bodyShape: string | null; garments: string[]; styles: string[]; materials: string[]; reasons: string[] }>;
  validate(measurements: unknown): ApiResult<ValidationData>;
  /**
   * Run a DesignRequest. Option values the garment does not offer are replaced
   * by the closest offered value and listed in `data.substitutions` and
   * `data.warnings`; pass `{ strict: true }` to get `ok: false` instead.
   * A missing styleId / materialId is picked automatically (as in the console
   * and CLI) and reported in `data.picks`. Explicit choices that the picks
   * would never make (e.g. a day cotton for a ball gown) are kept but warned
   * about in `data.warnings`.
   */
  design(request: unknown, opts?: unknown): ApiResult<DesignData>;
  getState(): ApiResult<ReturnType<typeof stateSnapshot>>;
  setState(patch: unknown): ApiResult<{ state: ReturnType<typeof stateSnapshot>; notes: string[] }>;
  exportSVG(kind?: SvgKind, opts?: unknown): ApiResult<string | string[]>;
  exportPrintHTML(opts?: unknown): ApiResult<string>;
  exportMarkdown(): ApiResult<string>;
  exportJSON(): ApiResult<DesignPackage>;
  exportOBJ(): Promise<ApiResult<string>>;
  exportGLB(): Promise<ApiResult<{ base64: string; bytes: number; mime: string }>>;
  exportZip(opts?: unknown): Promise<ApiResult<{ base64: string; bytes: number; filename: string }>>;
  schema(which?: 'request' | 'measurements'): ApiResult<Record<string, unknown>>;
  /**
   * Run console commands (';' separated). `ok` is true only when every command
   * succeeded; on failure `error` is the failing command's message, `failedAt`
   * its index, and `data` still holds the results up to and including it.
   */
  run(commands: string): Promise<RunResult>;
  /** The underlying shared store (for in-page integrations). */
  readonly store: AppStore;
}

const METHOD_DOCS: Record<string, string> = {
  help: 'This overview.',
  listGarments: 'All garment types with difficulty, occasions and allowed options.',
  listMaterials: 'Fabrics. Filter: {region?, occasion?, garment?}.',
  listStyles: 'Style presets. Filter: {region?, occasion?}.',
  recommend: 'Ranked ids + reasons. Query: {garment?, styleId?, occasion?, region?, measurements?, limit?}; defaults to current app state.',
  validate: 'Check measurements (cm): issues, estimated keys, body shape.',
  design:
    'Run a DesignRequest (see schema()); updates the app and returns a summary. styleId/materialId may be left out: they are picked like the console/CLI do and reported in data.picks. Unsuitable explicit cloth/style choices are kept but explained in data.warnings. Unsupported option values are replaced and listed in data.substitutions + data.warnings; design(req, {strict:true}) rejects them instead. Full package: exportJSON().',
  getState: 'Current measurements, selection, request and design id.',
  setState: 'Patch {measurements?, unit?, garment?, styleId?, materialId?, occasion?, region?, options?, name?, tab?}. Does not redesign.',
  exportSVG: "kind 'pattern' | 'layout' (opts {layer}) | 'print' (opts {paper}) -> string[] | 'piece' (opts {pieceId, realSize}).",
  exportPrintHTML: 'Printable multi-page HTML of the 1:1 tiled pattern. opts {paper}.',
  exportMarkdown: 'Beginner sewing booklet (markdown).',
  exportJSON: 'The complete DesignPackage.',
  exportOBJ: 'Async. Wavefront OBJ text of body + garment.',
  exportGLB: 'Async. Binary glTF as base64.',
  exportZip: 'Async. Every artifact zipped, as base64. opts {paper}.',
  schema: "JSON Schema of 'request' (default) or 'measurements'.",
  run: "Async. Console commands, e.g. run('reset; measure bust=92; design; show fit'). ok is false if any command failed (error, failedAt; data keeps every result). Starts from the current app state, so begin with `reset` for repeatable results.",
};

function requirePkg(store: AppStore): DesignPackage {
  const pkg = store.getState().pkg;
  if (!pkg) throw new Error('No design yet: call design(request) or run("design") first.');
  return pkg;
}

function readPaper(opts: unknown): Paper {
  const o = (input(opts) ?? {}) as { paper?: unknown };
  if (o.paper === undefined) return 'A4';
  if (o.paper === 'A4' || o.paper === 'letter') return o.paper;
  throw new Error("paper must be 'A4' or 'letter'.");
}

export function createAgentAPI(store: AppStore = createAppStore()): AgentAPI {
  const api: AgentAPI = {
    version: '1',
    store,

    help: () =>
      success({
        methods: METHOD_DOCS,
        commands: commandHelp(),
        hash: 'Open the app with #cmd=<url-encoded commands separated by ;> to run them on load, e.g. #cmd=measure%20bust%3D92%3Bdesign. Hash scripts start from default state (add &keep=1 to build on the saved state); the hash is cleared after running so a reload does not repeat it. If a command fails, the state from before the link is restored and a banner shows the failing command (agent-output keeps the failure).',
        dom: 'The last command result is mirrored as JSON in <pre id="agent-output">; <html data-clothescad="ready"> once start-up commands finished.',
      }),

    listGarments: () => success(GARMENTS.map(garmentSummary)),

    listMaterials: (filter) =>
      guard(() => {
        const f = (input(filter) ?? {}) as { region?: Region; occasion?: Occasion; garment?: GarmentType };
        const g = f.garment ? GARMENTS.find((x) => x.id === f.garment) : undefined;
        if (f.garment && !g) throw new Error(`Unknown garment '${f.garment}'.`);
        return success(
          MATERIALS.filter(
            (m) =>
              (!f.region || m.regions.includes(f.region)) &&
              (!f.occasion || m.occasions.includes(f.occasion)) &&
              (!g || g.fabricTypes.includes(m.construction)),
          ).map(materialSummary),
        );
      }),

    listStyles: (filter) =>
      guard(() => {
        const f = (input(filter) ?? {}) as { region?: Region; occasion?: Occasion };
        return success(STYLES.filter((s) => (!f.region || s.region === f.region) && (!f.occasion || s.occasions.includes(f.occasion))).map(styleSummary));
      }),

    recommend: (query) =>
      guard(() => {
        const q = recommendQuery.safeParse(input(query));
        if (!q.success) return failure('Invalid recommend query.', issuesOf(q.error));
        const s = store.getState();
        const opts = q.data ?? {};
        let body = currentBody(s.measurements);
        if (opts.measurements !== undefined) {
          const m = parseMeasurements(opts.measurements);
          if (!m.ok) return failure('Invalid measurements.', m.issues);
          body = analyzeBody(resolveMeasurements(m.value));
        }
        const r = rankPresets({
          ...(body ? { body } : {}),
          garment: (opts.garment ?? s.selection.garment) as GarmentType,
          styleId: opts.styleId ?? s.selection.styleId,
          occasion: opts.occasion ?? s.selection.occasion ?? undefined,
          region: opts.region ?? s.selection.region,
        });
        const limit = opts.limit ?? 5;
        return success({
          bodyShape: body?.shape ?? null,
          garments: r.garments.slice(0, limit).map((g) => g.id),
          styles: r.styles.slice(0, limit).map((x) => x.id),
          materials: r.materials.slice(0, limit).map((m) => m.id),
          reasons: r.reasons,
        });
      }),

    validate: (measurements) =>
      guard<ValidationData>(() => {
        const parsed = parseMeasurements(input(measurements));
        if (!parsed.ok) {
          return success({ valid: false, issues: parsed.issues.map((i) => ({ key: 'general' as const, severity: 'error' as const, message: `${i.path}: ${i.message}` })), estimated: [], body: null });
        }
        const issues = validateMeasurements(parsed.value);
        const valid = !issues.some((i) => i.severity === 'error');
        if (!valid) return success({ valid, issues, estimated: [], body: null });
        const resolved = resolveMeasurements(parsed.value);
        const body = analyzeBody(resolved);
        return success({ valid, issues, estimated: resolved.estimated, body: { shape: body.shape, notes: body.notes } });
      }),

    design: (request, opts) =>
      guard(() => {
        const o = designOptions.safeParse(input(opts) ?? {});
        if (!o.success) return failure('Invalid design options.', issuesOf(o.error));
        const { request: parsed, picks } = fillMissingPicks(input(request));
        if (o.data.strict) {
          const problems = strictOptionIssues(parsed);
          if (problems.length) return failure(`Option values not offered by this garment: ${problems.map((p) => p.message).join(' ')}`, problems);
        }
        const r = store.getState().applyRequest(parsed as never);
        if (!r.ok) return failure(r.error, r.issues);
        const data: DesignData = designSummary(r.pkg);
        if (picks) data.picks = picks;
        return success(data);
      }),

    getState: () => success(stateSnapshot(store.getState())),

    setState: (patch) =>
      guard(() => {
        const p = statePatchSchema.safeParse(input(patch));
        if (!p.success) return failure('Invalid state patch.', issuesOf(p.error));
        const d = p.data;
        const s = store.getState();
        if (d.measurements) {
          if (d.replaceMeasurements) s.replaceMeasurements(d.measurements);
          else s.setMeasurements(d.measurements);
        }
        if (d.unit) s.setUnit(d.unit);
        const notes: string[] = [];
        const sel: Parameters<typeof s.select>[0] = {};
        if (d.garment !== undefined) {
          if (!GARMENTS.some((g) => g.id === d.garment)) throw new Error(`Unknown garment '${d.garment}'. Valid: ${GARMENTS.map((g) => g.id).join(', ')}.`);
          sel.garment = d.garment as GarmentType;
        }
        if (d.styleId !== undefined) {
          if (!STYLES.some((x) => x.id === d.styleId)) throw new Error(`Unknown style '${d.styleId}'. Valid: ${STYLES.map((x) => x.id).join(', ')}.`);
          sel.styleId = d.styleId;
        }
        if (d.materialId !== undefined) {
          if (!MATERIALS.some((x) => x.id === d.materialId)) throw new Error(`Unknown material '${d.materialId}'. Valid: ${MATERIALS.map((x) => x.id).join(', ')}.`);
          sel.materialId = d.materialId;
        }
        if (d.occasion !== undefined) sel.occasion = d.occasion;
        if (d.region !== undefined) sel.region = d.region;
        if (d.options !== undefined) sel.options = d.options;
        if (d.name !== undefined) sel.name = d.name;
        if (d.seamAllowanceCm !== undefined) sel.seamAllowanceCm = d.seamAllowanceCm;
        if (d.hemAllowanceCm !== undefined) sel.hemAllowanceCm = d.hemAllowanceCm;
        if (Object.keys(sel).length) notes.push(...store.getState().select(sel));
        if (d.tab) store.getState().setTab(d.tab as (typeof TAB_IDS)[number]);
        return success({ state: stateSnapshot(store.getState()), notes });
      }),

    exportSVG: (kind = 'pattern', opts) =>
      guard<string | string[]>(() => {
        const pkg = requirePkg(store);
        const o = (input(opts) ?? {}) as { layer?: FabricLayer; pieceId?: string; realSize?: boolean };
        switch (kind) {
          case 'pattern':
            return success(renderPatternSheetSVG(pkg));
          case 'layout': {
            const layer = o.layer ?? 'self';
            if (!pkg.layouts.some((l) => l.layer === layer)) throw new Error(`No ${layer} layout. Layers: ${pkg.layouts.map((l) => l.layer).join(', ')}.`);
            return success(renderCuttingLayoutSVG(pkg, layer));
          }
          case 'print':
            return success(renderTiledPrintPages(pkg, { paper: readPaper(opts) }));
          case 'piece': {
            const piece = pkg.pieces.find((x) => x.id === o.pieceId);
            if (!piece) throw new Error(`Unknown pieceId '${String(o.pieceId)}'. Pieces: ${pkg.pieces.map((x) => x.id).join(', ')}.`);
            return success(renderPieceSVG(piece, { realSize: o.realSize ?? false }));
          }
          default:
            throw new Error("kind must be 'pattern', 'layout', 'print' or 'piece'.");
        }
      }),

    exportPrintHTML: (opts) => guard(() => success(printableHtml(requirePkg(store), readPaper(opts)))),

    exportMarkdown: () => guard(() => success(renderInstructionsMarkdown(requirePkg(store)))),

    exportJSON: () => guard(() => success(requirePkg(store))),

    exportOBJ: () =>
      guardAsync(async () => {
        const f = await objFile(requirePkg(store));
        return success(f.data as string);
      }),

    exportGLB: () =>
      guardAsync(async () => {
        const f = await glbFile(requirePkg(store));
        const bytes = f.data as Uint8Array;
        return success({ base64: toBase64(bytes), bytes: bytes.length, mime: f.mime });
      }),

    exportZip: (opts) =>
      guardAsync(async () => {
        const [zip] = await buildExport(requirePkg(store), 'zip', { paper: readPaper(opts) });
        const bytes = zip!.data as Uint8Array;
        return success({ base64: toBase64(bytes), bytes: bytes.length, filename: zip!.filename });
      }),

    schema: (which = 'request') => success(which === 'measurements' ? measurementsJSONSchema() : designRequestJSONSchema()),

    run: async (commands): Promise<RunResult> => {
      if (typeof commands !== 'string') {
        return { ok: false, error: 'run() takes a string of commands separated by ;', failedAt: -1, command: null, data: [] };
      }
      try {
        const results = (await executeScript(commands, { store }, { source: 'api' })).map(stripFiles);
        const failedAt = results.findIndex((r) => !r.ok);
        if (failedAt < 0) return { ok: true, data: results };
        const failed = results[failedAt]!;
        return { ok: false, error: failed.message || `Command failed: ${failed.command}`, failedAt, command: failed.command, data: results };
      } catch (err) {
        return { ok: false, error: message(err), failedAt: -1, command: null, data: [] };
      }
    },
  };
  return api;
}

/** Replace file payloads by their size so results stay small and JSON-friendly. */
export function stripFiles(r: CommandResult): Omit<CommandResult, 'files'> & { files?: Array<{ filename: string; mime: string; bytes: number }> } {
  const { files, ...rest } = r;
  if (!files) return rest;
  return {
    ...rest,
    files: files.map((f) => ({ filename: f.filename, mime: f.mime, bytes: typeof f.data === 'string' ? new TextEncoder().encode(f.data).length : f.data.length })),
  };
}
