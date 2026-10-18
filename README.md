# clothesCAD

Made-to-measure garment design for women, from everyday wear to runway couture. It runs as a mobile-first web app and as a console that an agent can drive.

Enter four body measurements (height, bust, waist, hip), then choose a garment, a style and a fabric. clothesCAD gives you everything an absolute beginner needs to make the piece:

- **Pattern pieces** drafted to your body. You get a full pattern sheet (SVG) and 1:1 tiled print pages (A4 or US Letter, with a 5 cm test square), which download as printable HTML or PDF.
- **Cutting layouts** for each fabric layer, with grainlines, folds and one-way (with-nap) fabrics handled correctly.
- **Bill of materials**: fabric length, lining, interfacing, zip, thread and notions.
- **Step-by-step instructions** ordered as you would actually sew. They cover each fabric's needs (needle, pressing, seam finish) and include try-on checkpoints and a beginner glossary.
- **Fit rationale** explaining why the ease, hem length, neckline and silhouette flatter *your* body shape.
- **A 3D model** of your figure wearing the garment, with GLB/OBJ export.

The catalogue covers 11 garments: A-line, pencil and circle skirts, wide-leg and tapered trousers, shell top, and shift, sheath and wrap dresses, plus column and ball gowns. Styles and fabrics start from European and Scandinavian presets.

## Quick start

```bash
npm install
npm run dev        # web app at http://localhost:5173 (best at phone width)
npm test           # vitest unit + integration tests
npm run eval       # quality eval over 333 garment × body × style/fabric cases
npm run build      # typecheck + production build to dist/
```

To produce a full design from the command line:

```bash
npm run cli -- design --garment a-line-skirt --style parisian-chic \
  --material belgian-linen-midweight --height 168 --bust 92 --waist 74 --hip 100 --out out/
npm run cli -- list garments      # also: materials, styles
npm run cli -- schema             # JSON Schema of a DesignRequest
```

`out/` then holds `package.json` (the full design package), `pattern.svg`, `layout-<layer>.svg`, `print-A4-page-N.svg`, `print-A4.html`, `instructions.md`, `model.glb` and `model.obj`.

In the browser, agents can call `window.clothesCAD` (for example `clothesCAD.design({...})`) or open `/#cmd=<commands>`.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): modules, the `src/core/types.ts` contract, the pipeline and the libraries used.
- [AGENTS.md](AGENTS.md): how an AI agent drives clothesCAD through the browser API, URL hash commands, the console and the CLI.

## Layout

| Path | What |
|---|---|
| `src/core` | Pure, deterministic engine: measurements, fit planning, drafting, layout, SVG/print, instructions, presets |
| `src/three` | 3D body and garment meshes, viewer, GLB/OBJ export |
| `src/ui`, `src/console` | React app, shared zustand store, command parser, `window.clothesCAD` API |
| `cli` | Node CLI (`commander`) |
| `eval`, `tests` | Quality-eval harness and vitest suites |
