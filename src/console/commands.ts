/**
 * Text command interpreter shared by the in-app Console tab, the URL hash
 * (#cmd=...), the agent API (`clothesCAD.run`) and the Node CLI.
 *
 * Every command reads and writes the shared app store, so whatever a command
 * does is immediately visible in the UI. Results are plain JSON.
 *
 *   design garment=a-line-skirt style=parisian-chic material=wool-crepe bust=92 waist=74 hip=100 height=168
 *   set option.length=midi option.flare=0.4
 *   show fit
 *   export print paper=letter
 *   json {"measurements":{...},"garment":"wrap-dress","styleId":"...","materialId":"..."}
 */
import { validateMeasurements } from '../core/measurements';
import { GARMENTS, MATERIALS, STYLES, getGarment, recommend, type Region } from '../core/presets';
import {
  CLOSURES,
  FIT_PREFERENCES,
  LENGTH_PRESETS,
  MEASUREMENT_FIELDS,
  NECKLINES,
  OCCASIONS,
  SLEEVE_TYPES,
  designRequestJSONSchema,
  measurementsJSONSchema,
} from '../core/schema';
import type {
  DesignPackage,
  GarmentOptions,
  GarmentType,
  MeasurementKey,
  Measurements,
  Occasion,
} from '../core/types';
import { EXPORT_DESCRIPTIONS, EXPORT_KINDS, buildExport, type ExportKind, type Paper } from './exports';
import { currentBody, fillMissingPicks } from './picks';
import { isDesignStale, type AppStore, type Selection } from './store';
import {
  designSummary,
  designWarnings,
  fitSummary,
  formatMinutes,
  garmentSummary,
  layoutsSummary,
  materialSummary,
  piecesSummary,
  qualitySummary,
  stateSnapshot,
  stepsSummary,
  styleSummary,
} from './summary';
import { TAB_IDS, type CommandResult, type ConsoleEntry, type TabId } from './types';
import { formatLength, parseLength, resolveMeasurementKey } from './units';

export interface CommandContext {
  store: AppStore;
}

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

export interface ParsedLine {
  name: string;
  /** Words that are not key=value. */
  positional: string[];
  /** key=value pairs in order (keys lower-cased). */
  pairs: Array<[string, string]>;
  /** Raw text after the command name (used by `json`). */
  rest: string;
}

/** Split a line into words, honouring "double" and 'single' quotes. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) throw new Error('Unclosed quote in command.');
  if (has || cur) out.push(cur);
  return out;
}

export function parseLine(line: string): ParsedLine {
  const trimmed = line.trim();
  const m = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
  if (!m) return { name: '', positional: [], pairs: [], rest: '' };
  const name = m[1]!.toLowerCase();
  const rest = m[2] ?? '';
  if (name === 'json') return { name, positional: [], pairs: [], rest };
  const positional: string[] = [];
  const pairs: Array<[string, string]> = [];
  for (const tok of tokenize(rest)) {
    const eq = tok.indexOf('=');
    if (eq > 0) pairs.push([tok.slice(0, eq).toLowerCase(), tok.slice(eq + 1)]);
    else positional.push(tok);
  }
  return { name, positional, pairs, rest };
}

/**
 * Split a script into commands on ';' or newlines, ignoring separators inside
 * quotes or JSON braces/brackets (so `json {...}` can contain anything).
 */
export function splitCommands(script: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (const ch of script) {
    if (quote) {
      cur += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
    if ((ch === ';' || ch === '\n') && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((c) => !c.startsWith('#'));
}

// ---------------------------------------------------------------------------
// Assignments: key=value routed to measurements, selection or options
// ---------------------------------------------------------------------------

const OPTION_KEYS = ['length', 'sleeve', 'neckline', 'closure', 'lining', 'pockets', 'fit', 'flare'] as const;
type OptionKey = (typeof OPTION_KEYS)[number];

const CLEAR_WORDS = new Set(['', 'none', 'unset', 'null', 'default', 'auto']);

function parseBool(v: string): boolean | null {
  const s = v.toLowerCase();
  if (['true', 'yes', 'on', '1', 'y'].includes(s)) return true;
  if (['false', 'no', 'off', '0', 'n'].includes(s)) return false;
  return null;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], what: string): T {
  const v = value.toLowerCase() as T;
  if (!allowed.includes(v)) throw new Error(`${what} must be one of: ${allowed.join(', ')} (got '${value}').`);
  return v;
}

function closestId(kind: string, value: string, ids: string[]): string {
  const v = value.toLowerCase();
  if (ids.includes(v)) return v;
  const partial = ids.filter((id) => id.includes(v));
  if (partial.length === 1) return partial[0]!;
  const hint = partial.length > 1 ? ` Matches: ${partial.join(', ')}.` : ` Valid: ${ids.join(', ')}.`;
  throw new Error(`Unknown ${kind} '${value}'.${hint}`);
}

interface PendingChanges {
  measurements: Partial<Record<MeasurementKey, number | undefined>>;
  selection: Partial<Selection>;
  /** Option values; an explicit `undefined` clears the option back to the default. */
  options: GarmentOptions;
  unit?: 'cm' | 'in';
  tab?: TabId;
}

/** Validate key=value pairs against the catalogue; throws a helpful Error on the first problem. */
function collectAssignments(pairs: Array<[string, string]>, current: Selection): PendingChanges {
  const ch: PendingChanges = { measurements: {}, selection: {}, options: {} };
  // Garment first so option checks use the new garment.
  const ordered = [...pairs].sort(([a], [b]) => Number(b === 'garment' || b === 'g') - Number(a === 'garment' || a === 'g'));
  for (const [rawKey, value] of ordered) {
    const key = rawKey.replace(/^options?\./, 'option.');
    switch (key) {
      case 'garment':
      case 'g':
        ch.selection.garment = closestId('garment', value, GARMENTS.map((g) => g.id)) as GarmentType;
        continue;
      case 'style':
      case 'styleid':
        ch.selection.styleId = closestId('style', value, STYLES.map((s) => s.id));
        continue;
      case 'material':
      case 'materialid':
      case 'fabric':
        ch.selection.materialId = closestId('material', value, MATERIALS.map((m) => m.id));
        continue;
      case 'occasion':
        ch.selection.occasion = CLEAR_WORDS.has(value.toLowerCase()) ? null : oneOf(value, OCCASIONS, 'occasion');
        continue;
      case 'region':
        ch.selection.region = oneOf(value, ['european', 'scandinavian'] as const, 'region');
        continue;
      case 'name':
        ch.selection.name = CLEAR_WORDS.has(value.toLowerCase()) ? null : value;
        continue;
      case 'unit':
        ch.unit = oneOf(value, ['cm', 'in'] as const, 'unit');
        continue;
      case 'tab':
        ch.tab = oneOf(value, TAB_IDS, 'tab');
        continue;
      case 'sa':
      case 'seamallowance':
      case 'seamallowancecm': {
        if (CLEAR_WORDS.has(value.toLowerCase())) ch.selection.seamAllowanceCm = null;
        else {
          const cm = parseLength(value, 'cm');
          if (cm === null || cm < 0.5 || cm > 3) throw new Error(`Seam allowance must be 0.5-3 cm (got '${value}').`);
          ch.selection.seamAllowanceCm = cm;
        }
        continue;
      }
      case 'hem':
      case 'hemallowance':
      case 'hemallowancecm': {
        if (CLEAR_WORDS.has(value.toLowerCase())) ch.selection.hemAllowanceCm = null;
        else {
          const cm = parseLength(value, 'cm');
          if (cm === null || cm < 0.5 || cm > 8) throw new Error(`Hem allowance must be 0.5-8 cm (got '${value}').`);
          ch.selection.hemAllowanceCm = cm;
        }
        continue;
      }
    }
    const optName = key.startsWith('option.') ? key.slice(7) : key;
    if ((OPTION_KEYS as readonly string[]).includes(optName)) {
      (ch.options as Record<string, unknown>)[optName] = parseOption(optName as OptionKey, value, ch.selection.garment ?? current.garment);
      continue;
    }
    const mKey = resolveMeasurementKey(rawKey);
    if (mKey) {
      if (CLEAR_WORDS.has(value.toLowerCase())) {
        if (MEASUREMENT_FIELDS[mKey].required) throw new Error(`${mKey} is required and cannot be removed.`);
        ch.measurements[mKey] = undefined;
      } else {
        const cm = parseLength(value, 'cm');
        if (cm === null || cm <= 0) throw new Error(`${mKey} needs a positive number, e.g. ${mKey}=92 or ${mKey}=36in (got '${value}').`);
        ch.measurements[mKey] = cm;
      }
      continue;
    }
    throw new Error(
      `Unknown setting '${rawKey}'. Use garment=, style=, material=, occasion=, region=, name=, unit=, sa=, hem=, option.<${OPTION_KEYS.join('|')}>= or a measurement such as bust=92.`,
    );
  }
  return ch;
}

function parseOption(key: OptionKey, value: string, garmentId: GarmentType): GarmentOptions[OptionKey] | undefined {
  if (CLEAR_WORDS.has(value.toLowerCase())) return undefined;
  const g = getGarment(garmentId);
  /** Check against the garment's own values first so the error lists what this garment offers. */
  const offered = <T extends string>(allowed: readonly T[], all: readonly T[]): T => {
    const v = value.toLowerCase() as T;
    if (allowed.includes(v)) return v;
    const known = all.includes(v) ? '' : ` ('${value}' is not a ${key} value at all)`;
    throw new Error(`${g.name} offers ${key}: ${allowed.length ? allowed.join(', ') : '(none)'}; got '${value}'${known}.`);
  };
  switch (key) {
    case 'length':
      return offered(g.allowed.length, LENGTH_PRESETS);
    case 'sleeve':
      return offered(g.allowed.sleeve, SLEEVE_TYPES);
    case 'neckline':
      return offered(g.allowed.neckline, NECKLINES);
    case 'closure':
      return offered(g.allowed.closure, CLOSURES);
    case 'fit':
      return oneOf(value, FIT_PREFERENCES, 'fit');
    case 'lining':
    case 'pockets': {
      const b = parseBool(value);
      if (b === null) throw new Error(`${key} must be true or false (got '${value}').`);
      if (b && !g.allowed[key]) throw new Error(`${g.name} does not offer ${key}.`);
      return b;
    }
    case 'flare': {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`flare must be a number from 0 to 1 (got '${value}').`);
      return n;
    }
  }
}

/** Apply validated changes to the store. Returns notes about automatic adjustments. */
function applyChanges(store: AppStore, ch: PendingChanges): string[] {
  const s = store.getState();
  const notes: string[] = [];
  if (Object.keys(ch.measurements).length) s.setMeasurements(ch.measurements);
  const hasSel = Object.keys(ch.selection).length > 0 || Object.keys(ch.options).length > 0;
  if (hasSel) {
    // select() merges options and drops undefined values, so explicit clears take effect.
    notes.push(...s.select({ ...ch.selection, options: ch.options }));
  }
  if (ch.unit) s.setUnit(ch.unit);
  if (ch.tab) s.setTab(ch.tab);
  return notes;
}

function describeChanges(ch: PendingChanges): string[] {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(ch.measurements)) parts.push(v === undefined ? `${k} cleared` : `${k}=${formatLength(v, 'cm')}`);
  for (const [k, v] of Object.entries(ch.selection)) parts.push(`${k}=${v === null ? 'default' : String(v)}`);
  for (const [k, v] of Object.entries(ch.options)) parts.push(`option.${k}=${v === undefined ? 'default' : String(v)}`);
  if (ch.unit) parts.push(`unit=${ch.unit}`);
  if (ch.tab) parts.push(`tab=${ch.tab}`);
  return parts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(command: string, message: string, data?: unknown, files?: CommandResult['files']): CommandResult {
  return { ok: true, command, message, ...(data !== undefined ? { data } : {}), ...(files ? { files } : {}) };
}

function fail(command: string, message: string, data?: unknown): CommandResult {
  return { ok: false, command, message, ...(data !== undefined ? { data } : {}) };
}

/** Body analysis from the current measurements, or null when they are incomplete/invalid. */
export { currentBody };

function requirePkg(ctx: CommandContext, command: string): { pkg: DesignPackage; stale: boolean } | CommandResult {
  const s = ctx.store.getState();
  if (!s.pkg) return fail(command, 'No design yet. Run `design` first (after `measure` and `set`).');
  return { pkg: s.pkg, stale: isDesignStale(s) };
}

const STALE_NOTE = ' (Note: settings changed since this design was made; run `design` to update.)';

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface CommandSpec {
  name: string;
  aliases?: string[];
  usage: string;
  summary: string;
  examples?: string[];
  run(p: ParsedLine, ctx: CommandContext, line: string): CommandResult | Promise<CommandResult>;
}

const SHOW_TOPICS = ['summary', 'fit', 'body', 'bom', 'steps', 'step', 'pieces', 'seams', 'layout', 'quality', 'glossary', 'request', 'state', 'measurements'] as const;

const COMMANDS: CommandSpec[] = [
  {
    name: 'help',
    aliases: ['?'],
    usage: 'help [command]',
    summary: 'List commands, or explain one command.',
    run(p, _ctx, line) {
      const target = p.positional[0]?.toLowerCase();
      if (target) {
        const spec = findCommand(target);
        if (!spec) return fail(line, `No command '${target}'. Type \`help\` for the list.`);
        return ok(line, `${spec.usage}\n  ${spec.summary}${spec.examples ? `\n  e.g. ${spec.examples.join('\n       ')}` : ''}`, {
          usage: spec.usage,
          summary: spec.summary,
          examples: spec.examples ?? [],
        });
      }
      const rows = COMMANDS.map((c) => ({ usage: c.usage, summary: c.summary }));
      const width = Math.max(...rows.map((r) => r.usage.length));
      const text = rows.map((r) => `${r.usage.padEnd(width)}  ${r.summary}`).join('\n');
      return ok(
        line,
        `${text}\n\nSeparate several commands with ';'. Bare measurement numbers are centimetres; add 'in' for inches (bust=36in).`,
        { commands: rows },
      );
    },
  },
  {
    name: 'list',
    aliases: ['ls'],
    usage: 'list garments|materials|styles [region=] [occasion=] [garment=]',
    summary: 'Show the catalogue, optionally filtered.',
    examples: ['list garments occasion=evening', 'list materials garment=wrap-dress region=scandinavian', 'list styles region=european'],
    run(p, _ctx, line) {
      const kind = (p.positional[0] ?? '').toLowerCase().replace(/s$/, '');
      const filters = Object.fromEntries(p.pairs);
      const region = filters.region ? oneOf(filters.region, ['european', 'scandinavian'] as const, 'region') : undefined;
      const occasion = filters.occasion ? oneOf(filters.occasion, OCCASIONS, 'occasion') : undefined;
      const garment = filters.garment ? getGarment(closestId('garment', filters.garment, GARMENTS.map((g) => g.id))) : undefined;
      if (kind === 'garment') {
        const list = GARMENTS.filter((g) => !occasion || g.occasions.includes(occasion));
        const text = list.map((g) => `${g.id.padEnd(18)} ${'●'.repeat(g.difficulty)}${'○'.repeat(5 - g.difficulty)}  ${g.name} - ${g.occasions.join(', ')}`).join('\n');
        return ok(line, `${list.length} garments\n${text}`, list.map(garmentSummary));
      }
      if (kind === 'material' || kind === 'fabric') {
        const list = MATERIALS.filter(
          (m) =>
            (!region || m.regions.includes(region)) &&
            (!occasion || m.occasions.includes(occasion)) &&
            (!garment || garment.fabricTypes.includes(m.construction)),
        );
        const text = list.map((m) => `${m.id.padEnd(26)} ${String(m.weightGsm).padStart(3)} gsm  ease ${m.beginnerFriendliness}/5  ${m.name}`).join('\n');
        return ok(line, `${list.length} materials\n${text}`, list.map(materialSummary));
      }
      if (kind === 'style') {
        const list = STYLES.filter((s) => (!region || s.region === region) && (!occasion || s.occasions.includes(occasion)));
        const text = list.map((s) => `${s.id.padEnd(26)} ${s.region.padEnd(12)} ${s.name}`).join('\n');
        return ok(line, `${list.length} styles\n${text}`, list.map(styleSummary));
      }
      return fail(line, 'Usage: list garments|materials|styles [region=european|scandinavian] [occasion=everyday|work|evening|runway] [garment=<id>]');
    },
  },
  {
    name: 'recommend',
    aliases: ['rec'],
    usage: 'recommend [occasion=] [region=] [garment=|any] [style=|any] [limit=5]',
    summary: 'Rank garments, styles and fabrics for these measurements, with reasons.',
    examples: ['recommend occasion=evening', 'recommend garment=any style=any region=scandinavian'],
    run(p, ctx, line) {
      const s = ctx.store.getState();
      const f = Object.fromEntries(p.pairs);
      const any = (v: string | undefined) => v !== undefined && ['any', 'none', ''].includes(v.toLowerCase());
      const garment = any(f.garment) ? undefined : f.garment ? (closestId('garment', f.garment, GARMENTS.map((g) => g.id)) as GarmentType) : s.selection.garment;
      const styleId = any(f.style) ? undefined : f.style ? closestId('style', f.style, STYLES.map((x) => x.id)) : s.selection.styleId;
      const occasion: Occasion | undefined = any(f.occasion) ? undefined : f.occasion ? oneOf(f.occasion, OCCASIONS, 'occasion') : (s.selection.occasion ?? undefined);
      const region: Region | undefined = any(f.region) ? undefined : f.region ? oneOf(f.region, ['european', 'scandinavian'] as const, 'region') : s.selection.region;
      const limit = Math.max(1, Math.min(50, Number(f.limit ?? 5) || 5));
      const body = currentBody(s.measurements);
      const r = recommend({ ...(body ? { body } : {}), garment, styleId, occasion, region });
      const data = {
        bodyShape: body?.shape ?? null,
        query: { garment: garment ?? null, styleId: styleId ?? null, occasion: occasion ?? null, region: region ?? null },
        garments: r.garments.slice(0, limit).map((g) => g.id),
        styles: r.styles.slice(0, limit).map((x) => x.id),
        materials: r.materials.slice(0, limit).map((m) => m.id),
        reasons: r.reasons,
      };
      const text = [
        body ? `Body shape: ${body.shape}` : 'Tip: add measurements (measure height=.. bust=.. waist=.. hip=..) for body-aware picks.',
        `Garments:  ${data.garments.join(', ')}`,
        `Styles:    ${data.styles.join(', ')}`,
        `Fabrics:   ${data.materials.join(', ')}`,
        ...r.reasons.map((x) => `- ${x}`),
      ].join('\n');
      return ok(line, text, data);
    },
  },
  {
    name: 'measure',
    aliases: ['m', 'validate'],
    usage: 'measure [key=value ...]',
    summary: 'Set measurements (cm, or add "in") and show validation + body shape.',
    examples: ['measure height=168 bust=92 waist=74 hip=100', 'measure bust=36in thigh=58', 'measure thigh=none'],
    run(p, ctx, line) {
      if (p.pairs.length) {
        const ch = collectAssignments(p.pairs, ctx.store.getState().selection);
        applyChanges(ctx.store, ch);
      }
      const m = ctx.store.getState().measurements;
      const required = ['heightCm', 'bustCm', 'waistCm', 'hipCm'] as const;
      const missing = required.filter((k) => typeof m[k] !== 'number');
      const issues = missing.length ? [] : validateMeasurements(m as Measurements);
      const body = currentBody(m);
      const errors = issues.filter((i) => i.severity === 'error');
      const lines = [
        Object.entries(m).map(([k, v]) => `${k}=${v}`).join(' ') || '(no measurements)',
        ...missing.map((k) => `error  ${k}: required`),
        ...issues.map((i) => `${i.severity.padEnd(7)}${i.key}: ${i.message}`),
        body ? `Body shape: ${body.shape}` : '',
        ...(body?.notes ?? []).map((n) => `- ${n}`),
      ].filter(Boolean);
      const data = { measurementsCm: m, missing, issues, body: body ? { shape: body.shape, ratios: body.ratios, notes: body.notes } : null };
      return missing.length || errors.length ? fail(line, lines.join('\n'), data) : ok(line, lines.join('\n'), data);
    },
  },
  {
    name: 'set',
    usage: 'set key=value ...',
    summary: 'Choose garment, style, material, occasion, region, options (option.length=midi), unit, name.',
    examples: ['set garment=wrap-dress style=stockholm-minimal material=lyocell-twill', 'set option.sleeve=elbow option.flare=0.3 lining=true', 'set occasion=none'],
    run(p, ctx, line) {
      if (!p.pairs.length) {
        const s = ctx.store.getState();
        return ok(line, JSON.stringify(s.selection, null, 2), s.selection);
      }
      const ch = collectAssignments(p.pairs, ctx.store.getState().selection);
      const notes = applyChanges(ctx.store, ch);
      const sel = ctx.store.getState().selection;
      return ok(line, [`Set ${describeChanges(ch).join(', ')}.`, ...notes].join('\n'), { selection: sel, notes });
    },
  },
  {
    name: 'design',
    aliases: ['make', 'run'],
    usage: 'design [key=value ...]',
    summary: 'Run the full pipeline on the current state (accepts the same key=value as set/measure).',
    examples: ['design', 'design garment=a-line-skirt style=parisian-chic material=wool-crepe height=168 bust=92 waist=74 hip=100'],
    run(p, ctx, line) {
      let notes: string[] = [];
      if (p.pairs.length) notes = applyChanges(ctx.store, collectAssignments(p.pairs, ctx.store.getState().selection));
      const r = ctx.store.getState().runDesign();
      if (!r.ok) return fail(line, `Design failed: ${r.error}`, { error: r.error, issues: r.issues ?? [] });
      const pkg = r.pkg;
      const q = qualitySummary(pkg);
      const text = [
        ...notes,
        `Designed "${pkg.name}" (id ${pkg.id}).`,
        `${pkg.pieces.length} pattern pieces, ${pkg.instructions.length} steps, about ${formatMinutes(pkg.effort.minutes)}, difficulty ${pkg.effort.difficulty}/5.`,
        `Fabric: ${pkg.layouts.map((l) => `${l.layer} ${(l.lengthCm / 100).toFixed(2)} m`).join(', ')}.`,
        `Quality: ${q.passed}/${q.total} checks pass${q.errors.length ? `, ${q.errors.length} error(s)` : ''}${q.warnings.length ? `, ${q.warnings.length} warning(s)` : ''}.`,
        ...designWarnings(pkg).map((w) => `Warning: ${w}`),
        'Next: show fit | show bom | show steps | export print',
      ].join('\n');
      return ok(line, text, designSummary(pkg));
    },
  },
  {
    name: 'json',
    usage: 'json <DesignRequest JSON>',
    summary: 'Replace everything with a full DesignRequest (see `schema`) and design it.',
    examples: ['json {"measurements":{"heightCm":165,"bustCm":88,"waistCm":70,"hipCm":96},"garment":"shift-dress","styleId":"stockholm-minimal","materialId":"belgian-linen-midweight"}'],
    run(p, ctx, line) {
      const text = p.rest.trim();
      if (!text) return fail(line, 'Usage: json {"measurements":{...},"garment":"...","styleId":"...","materialId":"..."}');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return fail(line, `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      const filled = fillMissingPicks(parsed);
      const r = ctx.store.getState().applyRequest(filled.request as never);
      if (!r.ok) {
        const issueText = r.issues?.length ? `\n${r.issues.map((i) => `- ${i.path || '(root)'}: ${i.message}`).join('\n')}` : '';
        return fail(line, `Request rejected: ${r.error}${issueText}`, { error: r.error, issues: r.issues ?? [] });
      }
      const warnings = designWarnings(r.pkg).map((w) => `\nWarning: ${w}`).join('');
      const picked = filled.picks ? filled.picks.reasons.map((x) => `\nPicked: ${x}`).join('') : '';
      return ok(
        line,
        `Designed "${r.pkg.name}" (id ${r.pkg.id}): ${r.pkg.pieces.length} pieces, ${r.pkg.instructions.length} steps.${picked}${warnings}`,
        { ...designSummary(r.pkg), ...(filled.picks ? { picks: filled.picks } : {}) },
      );
    },
  },
  {
    name: 'show',
    aliases: ['get'],
    usage: `show ${SHOW_TOPICS.join('|')} [n]`,
    summary: 'Inspect the current design (or app state).',
    examples: ['show fit', 'show steps', 'show step 4', 'show quality'],
    run(p, ctx, line) {
      const topic = (p.positional[0] ?? 'summary').toLowerCase();
      const s = ctx.store.getState();
      if (topic === 'state') {
        const snap = stateSnapshot(s);
        return ok(line, JSON.stringify(snap, null, 2), snap);
      }
      if (topic === 'measurements') {
        return ok(line, Object.entries(s.measurements).map(([k, v]) => `${k}=${v}`).join(' '), s.measurements);
      }
      if (!(SHOW_TOPICS as readonly string[]).includes(topic)) return fail(line, `Unknown topic '${topic}'. Try: ${SHOW_TOPICS.join(', ')}.`);
      const got = requirePkg(ctx, line);
      if ('ok' in got) return got;
      const { pkg, stale } = got;
      const note = stale ? STALE_NOTE : '';
      switch (topic) {
        case 'summary': {
          const d = designSummary(pkg);
          return ok(line, `${pkg.name} (${pkg.id}) - ${pkg.garment.name}, ${pkg.style.name}, ${pkg.material.name}.${note}`, d);
        }
        case 'fit': {
          const f = fitSummary(pkg);
          const fin = Object.entries(f.finishedCm)
            .filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]))
            .map(([k, v]) => `${k} ${formatLength(v, 'cm')}`)
            .join(', ');
          return ok(line, [`Body: ${f.bodyShape}. Fit: ${f.fit}.${note}`, `Finished: ${fin}`, ...f.rationale.map((r) => `- ${r}`)].join('\n'), f);
        }
        case 'body':
          return ok(line, [`Shape: ${pkg.body.shape}`, ...pkg.body.notes.map((n) => `- ${n}`)].join('\n'), pkg.body);
        case 'bom': {
          const text = pkg.bom
            .map((b) => `${b.essential ? '[ ]' : '[-]'} ${b.quantity} ${b.unit} ${b.name}${b.spec ? ` - ${b.spec}` : ''}${b.estCostEur ? ` (~€${b.estCostEur.toFixed(0)})` : ''}`)
            .join('\n');
          return ok(line, text + note, pkg.bom);
        }
        case 'steps': {
          const st = stepsSummary(pkg);
          return ok(line, st.map((x) => `${String(x.n).padStart(2)}. [${x.phase}] ${x.title} (${x.minutes} min)${x.checkpoint ? ' ✓ checkpoint' : ''}`).join('\n') + note, st);
        }
        case 'step': {
          const n = Number(p.positional[1]);
          const step = pkg.instructions.find((x) => x.n === n);
          if (!step) return fail(line, `No step ${p.positional[1] ?? ''}. Steps run 1-${pkg.instructions.length}.`);
          const text = [
            `${step.n}. ${step.title} [${step.phase}, ${step.minutes} min]`,
            step.body,
            ...step.tips.map((t) => `Tip: ${t}`),
            ...step.warnings.map((w) => `Warning: ${w}`),
            ...(step.checkpoint ? [`Checkpoint: ${step.checkpoint}`] : []),
            ...(step.terms.length ? [`Terms: ${step.terms.join(', ')}`] : []),
          ].join('\n');
          return ok(line, text, step);
        }
        case 'pieces': {
          const ps = piecesSummary(pkg);
          return ok(line, ps.map((x) => `${x.id.padEnd(20)} cut ${x.cutCount}${x.cutOnFold ? ' on fold' : ''} (${x.layer}) ${x.sizeCm.width}×${x.sizeCm.height} cm`).join('\n') + note, ps);
        }
        case 'seams':
          return ok(line, pkg.seams.map((x) => `${String(x.stage).padStart(2)} ${x.id.padEnd(24)} ${x.type}`).join('\n'), pkg.seams);
        case 'layout': {
          const ls = layoutsSummary(pkg);
          return ok(line, ls.map((l) => `${l.layer}: ${l.fabricWidthCm} cm wide, ${l.fold}, ${l.lengthCm} cm long, ${l.efficiencyPct}% used`).join('\n'), ls);
        }
        case 'quality': {
          const q = qualitySummary(pkg);
          const text = [`${q.passed}/${q.total} checks pass.`, ...q.errors.map((e) => `error: ${e.message}`), ...q.warnings.map((w) => `warning: ${w.message}`), ...q.info.map((w) => `info: ${w.message}`)].join('\n');
          return ok(line, text, q);
        }
        case 'glossary':
          return ok(line, Object.entries(pkg.glossary).map(([k, v]) => `${k}: ${v}`).join('\n'), pkg.glossary);
        case 'request':
          return ok(line, JSON.stringify(pkg.request, null, 2), pkg.request);
      }
      return fail(line, `Unknown topic '${topic}'.`);
    },
  },
  {
    name: 'export',
    aliases: ['download', 'save'],
    usage: `export ${EXPORT_KINDS.join('|')} [paper=A4|letter] [layer=self|lining|interfacing]`,
    summary: 'Produce downloadable files for the current design.',
    examples: ['export svg', 'export print paper=letter', 'export layout layer=self', 'export zip'],
    async run(p, ctx, line) {
      const kind = (p.positional[0] ?? '').toLowerCase() as ExportKind;
      if (!(EXPORT_KINDS as readonly string[]).includes(kind)) {
        return fail(line, `Usage: export <kind>. Kinds:\n${EXPORT_KINDS.map((k) => `  ${k.padEnd(7)} ${EXPORT_DESCRIPTIONS[k]}`).join('\n')}`);
      }
      const got = requirePkg(ctx, line);
      if ('ok' in got) return got;
      const f = Object.fromEntries(p.pairs);
      const paper: Paper = f.paper ? (f.paper.toLowerCase() === 'letter' ? 'letter' : f.paper.toUpperCase() === 'A4' ? 'A4' : (() => { throw new Error('paper must be A4 or letter.'); })()) : 'A4';
      const layer = f.layer ? oneOf(f.layer, ['self', 'lining', 'interfacing'] as const, 'layer') : undefined;
      if (layer && !got.pkg.layouts.some((l) => l.layer === layer)) {
        return fail(line, `This design has no ${layer} layer. Layers: ${got.pkg.layouts.map((l) => l.layer).join(', ')}.`);
      }
      const files = await buildExport(got.pkg, kind, { paper, ...(layer ? { layer } : {}) });
      const listing = files.map((x) => ({ filename: x.filename, mime: x.mime, bytes: typeof x.data === 'string' ? new TextEncoder().encode(x.data).length : x.data.length }));
      const text = listing.map((x) => `${x.filename}  ${(x.bytes / 1024).toFixed(1)} kB`).join('\n');
      return ok(line, `${files.length} file${files.length === 1 ? '' : 's'} ready${got.stale ? STALE_NOTE : ''}\n${text}`, { files: listing }, files);
    },
  },
  {
    name: 'schema',
    usage: 'schema [request|measurements]',
    summary: 'JSON Schema (draft 2020-12) of DesignRequest or Measurements.',
    run(p, _ctx, line) {
      const which = (p.positional[0] ?? 'request').toLowerCase();
      const schema = which.startsWith('measure') ? measurementsJSONSchema() : designRequestJSONSchema();
      return ok(line, JSON.stringify(schema, null, 2), schema);
    },
  },
  {
    name: 'go',
    aliases: ['tab', 'open'],
    usage: `go ${TAB_IDS.join('|')}`,
    summary: 'Switch the visible app tab.',
    run(p, ctx, line) {
      const tab = oneOf(p.positional[0] ?? '', TAB_IDS, 'tab');
      ctx.store.getState().setTab(tab);
      return ok(line, `Showing ${tab}.`, { tab });
    },
  },
  {
    name: 'state',
    usage: 'state',
    summary: 'Current app state as JSON (measurements, selection, request, design id).',
    run(_p, ctx, line) {
      const snap = stateSnapshot(ctx.store.getState());
      return ok(line, JSON.stringify(snap, null, 2), snap);
    },
  },
  {
    name: 'reset',
    usage: 'reset',
    summary: 'Start from defaults: forget measurements, choices and the current design (sample measurements return; sewing progress is kept).',
    run(_p, ctx, line) {
      ctx.store.getState().reset();
      return ok(line, 'Reset to defaults.', stateSnapshot(ctx.store.getState()));
    },
  },
  {
    name: 'clear',
    aliases: ['cls'],
    usage: 'clear',
    summary: 'Clear the console output.',
    run(_p, ctx, line) {
      ctx.store.getState().clearConsole();
      return ok(line, '');
    },
  },
];

function findCommand(name: string): CommandSpec | undefined {
  const n = name.toLowerCase();
  return COMMANDS.find((c) => c.name === n || c.aliases?.includes(n));
}

export const COMMAND_NAMES: readonly string[] = COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);

export function commandHelp(): Array<{ name: string; usage: string; summary: string; examples: string[] }> {
  return COMMANDS.map((c) => ({ name: c.name, usage: c.usage, summary: c.summary, examples: c.examples ?? [] }));
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Run one command line. Never throws: problems come back as `{ ok: false }`. */
export async function runCommand(line: string, ctx: CommandContext): Promise<CommandResult> {
  const trimmed = line.trim();
  if (!trimmed) return fail('', 'Empty command. Type `help`.');
  let parsed: ParsedLine;
  try {
    parsed = parseLine(trimmed);
  } catch (err) {
    return fail(trimmed, err instanceof Error ? err.message : String(err));
  }
  const spec = findCommand(parsed.name);
  if (!spec) {
    const near = COMMANDS.map((c) => c.name).filter((n) => n.startsWith(parsed.name.slice(0, 2)));
    return fail(trimmed, `Unknown command '${parsed.name}'.${near.length ? ` Did you mean ${near.join(' or ')}?` : ''} Type \`help\`.`);
  }
  try {
    return await spec.run(parsed, ctx, trimmed);
  } catch (err) {
    return fail(trimmed, err instanceof Error ? err.message : String(err));
  }
}

export interface ExecuteOptions {
  source?: ConsoleEntry['source'];
  /** Stop at the first failing command (default true). */
  stopOnError?: boolean;
}

/**
 * Run a script of one or more commands (';' or newline separated), logging
 * each to the console history and recording the last result in the store.
 */
export async function executeScript(script: string, ctx: CommandContext, opts: ExecuteOptions = {}): Promise<CommandResult[]> {
  const source = opts.source ?? 'user';
  const stop = opts.stopOnError ?? true;
  const results: CommandResult[] = [];
  for (const line of splitCommands(script)) {
    const st = ctx.store.getState();
    st.appendConsole([{ kind: 'input', text: line, source }]);
    if (source === 'user') st.pushHistory(line);
    const r = await runCommand(line, ctx);
    const after = ctx.store.getState();
    if (parseLine(line).name !== 'clear' && parseLine(line).name !== 'cls') {
      after.appendConsole([{ kind: 'result', text: r.message, result: r, source }]);
    }
    after.setLastResult(r);
    results.push(r);
    if (!r.ok && stop) break;
  }
  return results;
}
