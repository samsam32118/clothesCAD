#!/usr/bin/env node
/**
 * clothesCAD command-line interface. Shares the console command set
 * (src/console/commands.ts) and store with the web app.
 *
 *   npm run cli -- help
 *   npm run cli -- list materials --garment wrap-dress
 *   npm run cli -- design --request req.json --out out/
 *   npm run cli -- design --garment a-line-skirt --style parisian-chic --material wool-crepe \
 *                         --height 168 --bust 92 --waist 74 --hip 100 --out out/
 *   npm run cli -- run "measure bust=92 waist=74 hip=100 height=168; design; show fit"
 *   npm run cli -- schema
 *
 * Exit codes: 0 ok, 1 design/runtime failure, 2 usage or invalid input.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import { executeScript, runCommand } from '../src/console/commands';
import { allFiles, fileBytes, type Paper } from '../src/console/exports';
import { createAppStore, type AppStore } from '../src/console/store';
import { designSummary, formatMinutes, optionSubstitutions } from '../src/console/summary';
import { resolveMeasurementKey, parseLength } from '../src/console/units';
import { parseDesignRequest } from '../src/core/schema';
import { validateMeasurements } from '../src/core/measurements';
import { getGarment, type Region } from '../src/core/presets';
import { pickPresets } from '../src/console/picks';
import type { CommandResult, ExportFile } from '../src/console/types';
import type { DesignPackage, DesignRequest, GarmentOptions, Measurements, Occasion } from '../src/core/types';

const OCCASION_IDS: readonly Occasion[] = ['everyday', 'work', 'evening', 'runway'];

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printResult(r: CommandResult, json: boolean): void {
  if (json) {
    const { files, ...rest } = r;
    const out = files ? { ...rest, files: files.map((f) => ({ filename: f.filename, mime: f.mime, bytes: fileBytes(f).length })) } : rest;
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else if (r.message) {
    (r.ok ? process.stdout : process.stderr).write(`${r.message}\n`);
  }
}

async function writeFiles(dir: string, files: ExportFile[]): Promise<string[]> {
  const out = resolve(dir);
  await mkdir(out, { recursive: true });
  const written: string[] = [];
  for (const f of files) {
    const path = join(out, f.filename);
    await writeFile(path, fileBytes(f));
    written.push(path);
  }
  return written;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function positiveNumber(name: string) {
  return (value: string): number => {
    const cm = parseLength(value, 'cm');
    if (cm === null || cm <= 0) throw new UsageError(`--${name} needs a positive number in cm (or e.g. 36in), got '${value}'.`);
    return cm;
  };
}

// ---------------------------------------------------------------------------
// design: build a request from --request and/or flags
// ---------------------------------------------------------------------------

interface DesignFlags {
  request?: string;
  garment?: string;
  style?: string;
  material?: string;
  occasion?: string;
  region?: Region;
  height?: number;
  bust?: number;
  waist?: number;
  hip?: number;
  measure?: string[];
  option?: string[];
  name?: string;
  paper: string;
  out?: string;
  json?: boolean;
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    if (path === '-') {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      text = Buffer.concat(chunks).toString('utf8');
    } else {
      text = await readFile(resolve(path), 'utf8');
    }
  } catch (err) {
    throw new UsageError(`Cannot read request file '${path}': ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new UsageError(`Request file '${path}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseOptionFlag(raw: string, options: Record<string, unknown>): void {
  const eq = raw.indexOf('=');
  if (eq <= 0) throw new UsageError(`--option expects key=value (e.g. --option length=midi), got '${raw}'.`);
  const key = raw.slice(0, eq).trim();
  const value = raw.slice(eq + 1).trim();
  if (key === 'lining' || key === 'pockets') {
    if (!['true', 'false'].includes(value)) throw new UsageError(`--option ${key} must be true or false.`);
    options[key] = value === 'true';
  } else if (key === 'flare') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new UsageError(`--option flare must be a number 0..1.`);
    options[key] = n;
  } else {
    options[key] = value;
  }
}

async function buildRequestFromFlags(f: DesignFlags): Promise<DesignRequest> {
  const base = (f.request ? await readJson(f.request) : {}) as Record<string, unknown>;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) throw new UsageError('The request file must contain a JSON object.');
  const measurements: Record<string, unknown> = { ...((base.measurements as Record<string, unknown> | undefined) ?? {}) };
  if (f.height !== undefined) measurements.heightCm = f.height;
  if (f.bust !== undefined) measurements.bustCm = f.bust;
  if (f.waist !== undefined) measurements.waistCm = f.waist;
  if (f.hip !== undefined) measurements.hipCm = f.hip;
  for (const m of f.measure ?? []) {
    const eq = m.indexOf('=');
    const key = eq > 0 ? resolveMeasurementKey(m.slice(0, eq)) : null;
    const cm = eq > 0 ? parseLength(m.slice(eq + 1), 'cm') : null;
    if (!key || cm === null) throw new UsageError(`--measure expects name=value in cm (e.g. --measure thigh=58), got '${m}'.`);
    measurements[key] = cm;
  }
  const options: Record<string, unknown> = { ...((base.options as Record<string, unknown> | undefined) ?? {}) };
  for (const o of f.option ?? []) parseOptionFlag(o, options);

  const req: Record<string, unknown> = { ...base, measurements };
  if (f.garment) req.garment = f.garment;
  if (f.style) req.styleId = f.style;
  if (f.material) req.materialId = f.material;
  if (f.occasion) req.occasion = f.occasion;
  if (f.name) req.name = f.name;
  if (Object.keys(options).length) req.options = options as GarmentOptions;

  // Sensible picks when the caller leaves style or material out: the occasion,
  // region and body decide the style first, then the cloth for that style.
  const pickNotes: string[] = [];
  if (typeof req.garment === 'string' && (!req.styleId || !req.materialId)) {
    let garmentKnown = true;
    try {
      getGarment(req.garment);
    } catch {
      garmentKnown = false; // reported by schema validation below
    }
    if (garmentKnown) {
      const occasion = typeof req.occasion === 'string' && OCCASION_IDS.includes(req.occasion as Occasion) ? (req.occasion as Occasion) : null;
      try {
        const pick = pickPresets({
          garment: req.garment as DesignRequest['garment'],
          occasion,
          region: f.region ?? null,
          styleId: typeof req.styleId === 'string' ? req.styleId : null,
          measurements: measurements as Partial<Measurements>,
        });
        if (!req.styleId) req.styleId = pick.styleId;
        if (!req.materialId) req.materialId = pick.materialId;
        if (!req.occasion && pick.occasion) req.occasion = pick.occasion;
        pickNotes.push(...pick.reasons);
      } catch (err) {
        throw new UsageError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  const parsed = parseDesignRequest(req);
  if (!parsed.ok) {
    throw new UsageError(`Invalid design request:\n${parsed.issues.map((i) => `  - ${i.path || '(root)'}: ${i.message}`).join('\n')}`);
  }
  const issues = validateMeasurements(parsed.value.measurements);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    throw new UsageError(`Invalid measurements:\n${errors.map((i) => `  - ${i.key}: ${i.message}`).join('\n')}`);
  }
  for (const w of issues.filter((i) => i.severity === 'warning')) process.stderr.write(`warning: ${w.key}: ${w.message}\n`);
  for (const n of pickNotes) process.stderr.write(`pick: ${n}\n`);
  return parsed.value;
}

function describePackage(pkg: DesignPackage): string {
  const q = pkg.quality.filter((c) => !c.ok);
  return [
    `${pkg.name} (id ${pkg.id})`,
    `  ${pkg.garment.name} · ${pkg.style.name} · ${pkg.material.name}`,
    `  body shape ${pkg.body.shape}; fit ${pkg.fit.fit}; ${pkg.pieces.length} pieces; ${pkg.instructions.length} steps; ~${formatMinutes(pkg.effort.minutes)}; difficulty ${pkg.effort.difficulty}/5`,
    `  fabric: ${pkg.layouts.map((l) => `${l.layer} ${(l.lengthCm / 100).toFixed(2)} m × ${l.fabricWidthCm} cm`).join(', ')}`,
    `  quality: ${pkg.quality.length - q.length}/${pkg.quality.length} checks pass`,
    ...q.map((c) => `    ${c.severity}: ${c.message}`),
    ...optionSubstitutions(pkg).map((x) => `  warning: option ${x.option}=${String(x.requested)} is not offered; ${String(x.used)} was used`),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

function buildProgram(store: AppStore): Command {
  const program = new Command();
  program
    .name('clothescad')
    .description("Made-to-measure women's garment patterns: measurements in; pattern, print pages, layout, instructions and 3D model out.")
    .version('0.1.0')
    .showHelpAfterError('(run "clothescad help" for usage)')
    .exitOverride()
    .configureOutput({ writeErr: (s) => process.stderr.write(s) });

  program
    .command('list')
    .description('List garments, materials or styles')
    .argument('<kind>', 'garments | materials | styles')
    .option('--region <region>', 'european | scandinavian')
    .option('--occasion <occasion>', 'everyday | work | evening | runway')
    .option('--garment <id>', 'only fabrics suitable for this garment (materials)')
    .option('--json', 'machine-readable output')
    .action(async (kind: string, o: { region?: string; occasion?: string; garment?: string; json?: boolean }) => {
      const parts = ['list', kind];
      if (o.region) parts.push(`region=${o.region}`);
      if (o.occasion) parts.push(`occasion=${o.occasion}`);
      if (o.garment) parts.push(`garment=${o.garment}`);
      const r = await runCommand(parts.join(' '), { store });
      if (o.json && r.ok) process.stdout.write(`${JSON.stringify(r.data, null, 2)}\n`);
      else printResult(r, Boolean(o.json));
      if (!r.ok) process.exitCode = EXIT_USAGE;
    });

  program
    .command('design')
    .description('Draft a garment and write every artifact (package.json, pattern.svg, layout-<layer>.svg, print pages, instructions.md, model.obj, model.glb)')
    .option('-r, --request <file>', "DesignRequest JSON file ('-' for stdin); flags below override its fields")
    .option('-g, --garment <id>', 'garment type, e.g. a-line-skirt')
    .option('-s, --style <id>', 'style preset id (default: best match)')
    .option('-m, --material <id>', 'material preset id (default: best match)')
    .addOption(new Option('--occasion <occasion>', 'occasion (steers the default style and cloth)').choices([...OCCASION_IDS]))
    .addOption(new Option('--region <region>', 'style tradition for the default style').choices(['european', 'scandinavian']))
    .option('--height <cm>', 'height (cm, or e.g. 66in)', positiveNumber('height'))
    .option('--bust <cm>', 'bust (cm)', positiveNumber('bust'))
    .option('--waist <cm>', 'natural waist (cm)', positiveNumber('waist'))
    .option('--hip <cm>', 'fullest hip (cm)', positiveNumber('hip'))
    .option('--measure <name=value>', 'any other measurement, repeatable (e.g. --measure thigh=58)', collect)
    .option('--option <key=value>', 'garment option, repeatable (length, sleeve, neckline, closure, lining, pockets, fit, flare)', collect)
    .option('--name <name>', 'name for the design')
    .addOption(new Option('--paper <paper>', 'print page size').choices(['A4', 'letter']).default('A4'))
    .option('-o, --out <dir>', 'output directory (omit to only print the summary)')
    .option('--json', 'print the design summary as JSON')
    .action(async (f: DesignFlags) => {
      const request = await buildRequestFromFlags(f);
      const r = store.getState().applyRequest(request);
      if (!r.ok) {
        process.stderr.write(`Design failed: ${r.error}\n`);
        process.exitCode = EXIT_FAIL;
        return;
      }
      const pkg = r.pkg;
      let written: string[] = [];
      if (f.out) written = await writeFiles(f.out, await allFiles(pkg, f.paper as Paper));
      if (f.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, design: designSummary(pkg), files: written }, null, 2)}\n`);
      } else {
        process.stdout.write(`${describePackage(pkg)}\n`);
        if (written.length) process.stdout.write(`Wrote ${written.length} files to ${resolve(f.out!)}\n`);
        else process.stdout.write('Add --out <dir> to write the pattern, print pages, instructions and 3D model.\n');
      }
    });

  program
    .command('run')
    .description('Run console commands (";" separated), e.g. "measure bust=92 waist=74 hip=100 height=168; design; show fit"')
    .argument('<commands...>', 'command script')
    .option('-o, --out <dir>', 'directory for files produced by export commands', '.')
    .option('--json', 'print each result as JSON')
    .option('--keep-going', 'continue after a failing command')
    .action(async (parts: string[], o: { out: string; json?: boolean; keepGoing?: boolean }) => {
      const results = await executeScript(parts.join(' '), { store }, { source: 'cli', stopOnError: !o.keepGoing });
      for (const r of results) {
        printResult(r, Boolean(o.json));
        if (r.files?.length) {
          const paths = await writeFiles(o.out, r.files);
          if (!o.json) process.stdout.write(paths.map((p) => `  wrote ${p}`).join('\n') + '\n');
        }
      }
      if (results.some((r) => !r.ok)) process.exitCode = EXIT_FAIL;
    });

  program
    .command('schema')
    .description('Print the JSON Schema of DesignRequest (or Measurements)')
    .argument('[which]', 'request | measurements', 'request')
    .action(async (which: string) => {
      if (!['request', 'measurements'].includes(which)) throw new UsageError("schema takes 'request' or 'measurements'.");
      const r = await runCommand(`schema ${which}`, { store });
      process.stdout.write(`${JSON.stringify(r.data, null, 2)}\n`);
    });

  program
    .command('commands')
    .description('List the console commands usable with "run"')
    .action(async () => {
      printResult(await runCommand('help', { store }), false);
    });

  program.addHelpText(
    'after',
    `
Examples:
  $ clothescad list garments --occasion evening
  $ clothescad design --garment wrap-dress --height 165 --bust 90 --waist 72 --hip 98 --out out/
  $ clothescad design --request request.json --out out/ --paper letter
  $ clothescad run "measure height=170 bust=95 waist=80 hip=104; set garment=shift-dress; design; export md"
  $ clothescad schema > design-request.schema.json

Exit codes: 0 ok, 1 design failed, 2 usage or invalid input.`,
  );
  return program;
}

async function main(argv: string[]): Promise<number> {
  const store = createAppStore();
  const program = buildProgram(store);
  if (argv.length <= 2) {
    program.outputHelp();
    return EXIT_OK;
  }
  try {
    await program.parseAsync(argv);
    return typeof process.exitCode === 'number' ? process.exitCode : EXIT_OK;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help / version requested explicitly exit 0; parse errors are usage errors.
      return err.exitCode === 0 ? EXIT_OK : EXIT_USAGE;
    }
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT_USAGE;
    }
    process.stderr.write(`clothescad: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_FAIL;
  }
}

main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`clothescad: ${String(err)}\n`);
    process.exitCode = EXIT_FAIL;
  },
);
