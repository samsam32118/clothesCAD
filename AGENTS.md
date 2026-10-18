# clothesCAD for AI agents

clothesCAD turns body measurements and garment/style/material choices into a full make-it package:
pattern pieces, 1:1 tiled print pages, cutting layouts, a bill of materials, beginner instructions, a fit rationale and a 3D model.
All lengths are **centimetres**. Every interface below goes through the same command set (`src/console/commands.ts`)
and the same shared store, so whatever an agent does shows up in the visible app.

## 1. Minimal request

```json
{
  "measurements": { "heightCm": 168, "bustCm": 92, "waistCm": 74, "hipCm": 100 },
  "garment": "wrap-dress",
  "styleId": "stockholm-minimal",
  "materialId": "lyocell-twill",
  "occasion": "work",
  "options": { "length": "midi", "sleeve": "elbow", "fit": "regular", "flare": 0.3 }
}
```

Only the four measurements plus `garment`, `styleId` and `materialId` are required. Optional measurements
(`thighCm`, `waistToFloorCm`, …) are estimated when omitted. Get the full JSON Schema (draft 2020-12) from
`clothesCAD.schema()`, the `schema` command, or `npm run cli -- schema`. Valid ids come from `list garments|materials|styles`.
Option values a garment does not offer are handled differently per interface:

- **Console / CLI `set option.*` / `design option.*`**: rejected; the error lists the values *this garment* offers.
- **`design(request)` / `json {...}` / `npm run cli -- design --request`**: the closest offered value is used and the
  result says so in `data.substitutions` (`[{option, requested, used, allowed}]`) and `data.warnings`. The result is
  still `ok: true`, so check `substitutions`. Pass `clothesCAD.design(req, { strict: true })` to get `ok: false`
  (with `issues` naming each option) instead.

If you leave out `styleId` or `materialId` (CLI, or `set garment=` in the console), clothesCAD picks them for you:
the occasion (inferred from the garment when not given: a ball gown is evening wear), region and body shape choose the
style first, then a cloth *for that style*. Cloths that do not suit the garment or occasion are never picked
automatically (no runway gown in shirting cotton). Changing the garment or occasion with `set` swaps an unsuitable
style or cloth and says so in `notes`.

## 2. In the browser: `window.clothesCAD`

The API is ready as soon as the page loads. Every method accepts a plain object or a JSON string and returns
`{ ok: true, data }` or `{ ok: false, error, issues? }`. The export methods marked async return a Promise.

| Method | Returns |
|---|---|
| `help()` | methods, console commands, hash and DOM conventions |
| `listGarments()` / `listMaterials({region?, occasion?, garment?})` / `listStyles({region?, occasion?})` | catalogue summaries |
| `recommend({garment?, styleId?, occasion?, region?, measurements?, limit?})` | ranked ids + plain-language reasons |
| `validate(measurements)` | `{valid, issues, estimated, body}` |
| `design(request, {strict?})` | design summary (id, fit rationale, pieces, BOM, quality, `substitutions`, `warnings`); also updates the app |
| `getState()` / `setState(patch)` | app state; patch `{measurements?, garment?, styleId?, materialId?, occasion?, region?, options?, name?, unit?, tab?}` |
| `exportSVG('pattern' \| 'layout' \| 'print' \| 'piece', opts?)` | SVG string (`print` → string[] of pages; opts `{paper}`, `{layer}`, `{pieceId, realSize}`) |
| `exportPrintHTML({paper})`, `exportMarkdown()`, `exportJSON()` | strings / the full `DesignPackage` |
| `exportOBJ()`, `exportGLB()`, `exportZip({paper})` (async) | OBJ text; `{base64, bytes}` |
| `run('reset; measure bust=92; design; show fit')` (async) | `{ok, data: [result per command]}`; file contents are replaced by their sizes. `ok` is `false` if **any** command failed: then `error` is that command's message, `failedAt` its index and `command` its text, and `data` holds the results up to and including the failure (later commands did not run). |

```js
const r = clothesCAD.design({ measurements: { heightCm: 165, bustCm: 88, waistCm: 70, hipCm: 96 },
  garment: 'a-line-skirt', styleId: 'parisian-chic', materialId: 'wool-crepe' });
if (!r.ok) console.log(r.error, r.issues);
if (r.ok && r.data.substitutions.length) console.log('Not exactly as requested:', r.data.warnings);
const svg = clothesCAD.exportSVG('pattern').data;

const s = await clothesCAD.run('reset; measure height=168 bust=92 waist=74 hip=100; set garment=shift-dress; design');
if (!s.ok) console.log(`command ${s.failedAt} (${s.command}) failed: ${s.error}`);
```

**State is shared and persisted.** The app remembers measurements, choices, units and seam allowances in browser
storage, and `run()`, `setState()` and console commands build on whatever is there. Start scripts with `reset` (or
send a full request with `design(request)` / `json {...}`, which replaces everything that affects the design) when
you need repeatable results.

## 3. URL hash and DOM

Open `/#cmd=<url-encoded commands separated by ;>` to run commands on load. For example:

```
/#cmd=measure%20height%3D168%20bust%3D92%20waist%3D74%20hip%3D100%3Bset%20garment%3Dshift-dress%3Bdesign%3Bgo%20pattern
```

- A hash script **starts from defaults** (as if it began with `reset`; sewing progress and console history are kept),
  so the same link always gives the same design. Add `&keep=1` (`#cmd=...&keep=1`) to build on the saved state instead.
- After the commands run, the hash is removed from the address bar, so reloading the page does not run them again.
  Setting a new hash runs the new commands.
- `<html data-clothescad="ready">` is set once the start-up commands have finished (`running` while they run).
- `<pre id="agent-output">` (hidden) always holds the last command result as JSON, with `data-ok="true|false"`.
- Commands stop at the first failure.

## 4. Commands (Console tab, `run()`, hash, CLI `run`)

```
help [command]            list [garments|materials|styles] [region=] [occasion=] [garment=]
recommend [occasion=] [region=] [garment=|any] [style=|any]
measure key=value ...     bare numbers are cm; add "in" for inches (bust=36in); thigh=none removes
set key=value ...         garment= style= material= occasion= region= name= unit= sa= hem= option.<length|sleeve|neckline|closure|lining|pockets|fit|flare>=
design [key=value ...]    runs the pipeline (accepts the same keys as set/measure)
json {DesignRequest}      replace everything and design
show summary|fit|body|bom|steps|step N|pieces|seams|layout|quality|glossary|request|state|measurements
export svg|print|html|layout|md|json|glb|obj|zip|all [paper=A4|letter] [layer=self|lining|interfacing]
schema [request|measurements]    go <measure|design|pattern|make|3d|console>    state    reset    clear
```

Ids accept unique prefixes (`style=stockholm` → `stockholm-minimal`).

## 5. CLI (Node, no browser)

```bash
npm run cli -- list materials --garment wrap-dress --json
npm run cli -- design --request request.json --out out/            # '-' reads stdin
npm run cli -- design --garment a-line-skirt --height 168 --bust 92 --waist 74 --hip 100 \
                      --option length=midi --measure thigh=58 --paper letter --out out/ --json
npm run cli -- design --garment ball-gown --occasion runway --region scandinavian --height 172 --bust 90 --waist 72 --hip 98 --out gown/
npm run cli -- run "measure height=170 bust=95 waist=80 hip=104; set garment=shift-dress; design; show fit" --json
npm run cli -- schema > design-request.schema.json
```

`design --out` writes `package.json` (the full DesignPackage), `pattern.svg`, `layout-<layer>.svg`,
`print-<paper>-page-N.svg`, `print-<paper>-assembly-map.svg` (how the pages fit together), `print-<paper>.html`
(assembly map + pages), `instructions.md`, `model.obj` and `model.glb`. If you leave out `--style` or `--material`,
they are picked for the garment, `--occasion`, `--region` and measurements (the picks are explained on stderr as
`pick: ...` lines). Options the garment does not offer are reported as `warning:` lines and in the JSON summary's
`substitutions`.
Exit codes: `0` ok, `1` design or runtime failure, `2` usage error or invalid request/measurements (the messages name the field).

## 6. Tips

- Check `quality` in the design summary. Errors there mean the pattern needs attention.
- `measurementIssues` with severity `warning` (for example "looks like inches") deserve a second look even though the design still runs.
- The design is deterministic: the same request always produces the same `id` and the same files. Console scripts,
  `run()` and hash links depend on the app state they start from, so begin them with `reset` (hash links do this for you).
