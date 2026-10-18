/**
 * The documented console commands (AGENTS.md §4) driven through the shared
 * interpreter, plus the JSON agent API built on it.
 */
import { describe, expect, it } from 'vitest';
import { createAgentAPI } from '../src/console/api';
import { COMMAND_NAMES, executeScript, parseLine, runCommand, splitCommands, tokenize } from '../src/console/commands';
import { createAppStore } from '../src/console/store';
import type { CommandResult } from '../src/console/types';

function fresh() {
  const store = createAppStore();
  return { store, run: (line: string): Promise<CommandResult> => runCommand(line, { store }) };
}

const REQUEST = {
  measurements: { heightCm: 170, bustCm: 90, waistCm: 75, hipCm: 96 },
  garment: 'pencil-skirt',
  styleId: 'parisian-chic',
  materialId: 'wool-crepe',
};

describe('parser', () => {
  it('splits a line into name, positional words and key=value pairs', () => {
    const p = parseLine('design garment=a-line-skirt Style=parisian-chic now');
    expect(p.name).toBe('design');
    expect(p.positional).toEqual(['now']);
    expect(p.pairs).toEqual([
      ['garment', 'a-line-skirt'],
      ['style', 'parisian-chic'],
    ]);
  });

  it('keeps the raw JSON text for `json`', () => {
    const p = parseLine(`json ${JSON.stringify(REQUEST)}`);
    expect(p.name).toBe('json');
    expect(JSON.parse(p.rest)).toEqual(REQUEST);
  });

  it('honours quotes and rejects unclosed ones', () => {
    expect(tokenize(`set name='Linen midi' garment=a-line-skirt`)).toEqual(['set', 'name=Linen midi', 'garment=a-line-skirt']);
    expect(() => tokenize('set name="oops')).toThrow(/quote/i);
  });

  it('splits scripts on ; and newlines but not inside JSON or quotes', () => {
    expect(splitCommands(`measure bust=90\nset name="a;b"; json {"name":"x;y"}`)).toEqual(['measure bust=90', 'set name="a;b"', 'json {"name":"x;y"}']);
  });

  it('knows every documented command', () => {
    for (const c of ['help', 'list', 'recommend', 'measure', 'set', 'design', 'json', 'show', 'export', 'schema', 'go', 'state', 'reset', 'clear']) {
      expect(COMMAND_NAMES).toContain(c);
    }
  });
});

describe('documented commands', () => {
  it('help and help <command>', async () => {
    const { run } = fresh();
    const all = await run('help');
    expect(all.ok).toBe(true);
    expect(all.message).toContain('design');
    const one = await run('help design');
    expect(one.ok).toBe(true);
    expect(one.message.toLowerCase()).toContain('design');
  });

  it('list garments | materials region= | styles region=', async () => {
    const { run } = fresh();
    const g = await run('list garments');
    expect(g.ok).toBe(true);
    expect((g.data as unknown[]).length).toBe(11);
    const m = await run('list materials region=scandinavian');
    expect(m.ok).toBe(true);
    for (const x of m.data as Array<{ regions?: string[] }>) if (x.regions) expect(x.regions).toContain('scandinavian');
    const s = await run('list styles region=european');
    expect((s.data as Array<{ region: string }>).every((x) => x.region === 'european')).toBe(true);
  });

  it('recommend garment=', async () => {
    const { run } = fresh();
    const r = await run('recommend garment=wrap-dress');
    expect(r.ok).toBe(true);
    expect(r.message.length).toBeGreaterThan(20);
  });

  it('measure: centimetres by default, inches with "in", "none" removes', async () => {
    const { store, run } = fresh();
    expect((await run('measure height=166 bust=36in waist=72 hip=99 thigh=58')).ok).toBe(true);
    const m = store.getState().measurements;
    expect(m.bustCm).toBeCloseTo(91.44, 2);
    expect(m.thighCm).toBe(58);
    await run('measure thigh=none');
    expect(store.getState().measurements.thighCm).toBeUndefined();
    const bad = await run('measure bust=abc');
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('bust');
  });

  it('set accepts id prefixes and option.* keys; rejects unknown ids', async () => {
    const { store, run } = fresh();
    const r = await run('set garment=wrap style=stockholm material=viscose-crepe option.length=midi option.flare=0.4');
    expect(r.ok).toBe(true);
    const sel = store.getState().selection;
    expect(sel.garment).toBe('wrap-dress');
    expect(sel.styleId).toBe('stockholm-minimal');
    expect(sel.options.length).toBe('midi');
    expect(sel.options.flare).toBeCloseTo(0.4, 5);
    const bad = await run('set garment=nope');
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('a-line-skirt');
  });

  it('design, show, export run the pipeline and expose its outputs', { timeout: 60_000 }, async () => {
    const { store, run } = fresh();
    const d = await run('design garment=a-line-skirt style=parisian-chic material=wool-crepe height=168 bust=92 waist=74 hip=100');
    expect(d.ok).toBe(true);
    const pkg = store.getState().pkg!;
    expect(pkg.garment.id).toBe('a-line-skirt');
    expect(pkg.request.measurements.bustCm).toBe(92);
    for (const what of ['summary', 'fit', 'body', 'bom', 'steps', 'step 2', 'pieces', 'seams', 'layout', 'quality', 'glossary', 'request', 'measurements']) {
      const s = await run(`show ${what}`);
      expect(s.ok, `show ${what}: ${s.message}`).toBe(true);
    }
    const svg = await run('export svg');
    expect(svg.ok).toBe(true);
    expect(svg.files?.[0]?.filename).toMatch(/\.svg$/);
    const print = await run('export print paper=letter');
    expect(print.ok).toBe(true);
    expect(print.files!.length).toBeGreaterThan(0);
    expect(print.files!.every((f) => /letter/i.test(f.filename))).toBe(true);
    const md = await run('export md');
    expect(md.ok).toBe(true);
    expect(String(md.files?.[0]?.data)).toContain(pkg.instructions[0].title);
    const json = await run('export json');
    expect(JSON.parse(String(json.files?.[0]?.data)).id).toBe(pkg.id);
    const layout = await run('export layout layer=self');
    expect(layout.ok).toBe(true);
  });

  it('json {DesignRequest} replaces everything and designs', async () => {
    const { store, run } = fresh();
    const r = await run(`json ${JSON.stringify(REQUEST)}`);
    expect(r.ok).toBe(true);
    expect(store.getState().pkg?.garment.id).toBe('pencil-skirt');
    expect(store.getState().measurements.heightCm).toBe(170);
    const bad = await run('json {"garment": "pencil-skirt"');
    expect(bad.ok).toBe(false);
  });

  it('schema, go, state, reset', async () => {
    const { store, run } = fresh();
    const s = await run('schema');
    expect(s.ok).toBe(true);
    expect((s.data as { $schema?: string }).$schema).toContain('json-schema.org');
    const ms = await run('schema measurements');
    expect(JSON.stringify(ms.data)).toContain('bustCm');
    expect((await run('go 3d')).ok).toBe(true);
    expect(store.getState().tab).toBe('3d');
    expect((await run('go nowhere')).ok).toBe(false);
    const st = await run('state');
    expect(st.ok).toBe(true);
    await run('measure bust=101');
    await run('reset');
    expect(store.getState().measurements.bustCm).not.toBe(101);
  });

  it('reports unknown commands without throwing', async () => {
    const { run } = fresh();
    const r = await run('frobnicate');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('help');
    expect((await run('   ')).ok).toBe(false);
  });

  it('scripts stop at the first failing command', async () => {
    const store = createAppStore();
    const results = await executeScript('measure bust=90; set garment=nope; design', { store });
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(store.getState().lastResult?.ok).toBe(false);
  });
});

describe('agent API', () => {
  it('validates, designs and exports JSON', () => {
    const api = createAgentAPI(createAppStore());
    const v = api.validate({ heightCm: 168, bustCm: 880, waistCm: 70, hipCm: 94 });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.data.issues.some((i) => i.severity === 'error' && i.key === 'bustCm')).toBe(true);
    const d = api.design(REQUEST);
    expect(d.ok).toBe(true);
    const j = api.exportJSON();
    expect(j.ok).toBe(true);
    if (j.ok) expect(j.data.garment.id).toBe('pencil-skirt');
    const bad = api.design({ ...REQUEST, garment: 'cape' });
    expect(bad.ok).toBe(false);
    const schema = api.schema();
    expect(schema.ok && JSON.stringify(schema.data)).toContain('materialId');
  });
});
