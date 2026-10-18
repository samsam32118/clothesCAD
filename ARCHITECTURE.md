# clothesCAD architecture

Mobile-first web app + agent console for designing women's garments (everyday → runway).
Input: body measurements + garment/style/material choices. Output: a complete
`DesignPackage` a total beginner can sew from — pattern pieces (SVG, 1:1 tiled
print pages), cutting layouts, bill of materials, step-by-step instructions with
glossary, fit rationale, and a 3D model (GLB/OBJ).

- Language: TypeScript (strict), ESM. React 19 + Vite for the web app, three.js for 3D.
- Units: **centimetres**. Pattern space: x right, y **down**.
- `src/core` is pure (no DOM, no three.js) and deterministic; it runs in browser and Node.
- The contract is `src/core/types.ts`. Do not change existing fields; additive optional fields only.
- Pipeline: `src/core/design.ts` → `design(request): DesignPackage`.

## Module ownership and required exports

### Drafting engine (owner: drafting)
| File | Exports |
|---|---|
| `src/core/geometry.ts` | `hashString(s): string` (deterministic short hash), `pathLength(p, from?, to?)`, `polygonArea(p)`, `pathBounds(p)`, `offsetClosedPath(p, dist)` (outward), `resample`, bezier/arc helpers, `segmentsIntersect`, `isSimplePolygon(p)` |
| `src/core/measurements.ts` | `validateMeasurements(m: Measurements): MeasurementIssue[]`, `resolveMeasurements(m): ResolvedMeasurements` (estimate missing from height/bust/waist/hip with standard anthropometric ratios), `computeLandmarks(r: ResolvedMeasurements): BodyLandmarks` |
| `src/core/fit/analyze.ts` | `analyzeBody(r: ResolvedMeasurements): BodyAnalysis` |
| `src/core/fit/plan.ts` | `planFit(ctx: {request, garment, style, material, measurements, body}): FitPlan` — merges garment defaults ← style preferences ← user options; computes ease (fit pref + style modifier + material stretch/stiffness), hem height that avoids unflattering lines (e.g. widest calf), and rationale |
| `src/core/drafting/index.ts` | `draftGarment(ctx: DraftContext): { pieces: PatternPiece[]; seams: SeamSpec[]; silhouette: Silhouette }` and `export interface DraftContext { request; garment; style; material; measurements; body; fit; seamAllowanceCm; hemAllowanceCm }`. One drafter per `GarmentType` (shared blocks: bodice block w/ darts, skirt block, trouser block, sleeve block). |
| `src/core/layout.ts` | `layoutPieces(pieces, fabricWidthCm, layer): CuttingLayout` — deterministic shelf/skyline packing honouring grainline (only 0/180° rotation for directional wovens), cutCount, cutOnFold (fold layout) |
| `src/core/svg.ts` | `renderPieceSVG(piece, opts?)`, `renderPatternSheetSVG(pkg)`, `renderCuttingLayoutSVG(pkg, layer?)`, `renderTiledPrintPages(pkg, {paper: 'A4'|'letter'}): string[]` (1:1 scale in mm, overlap margins, page grid labels A1/A2…, 5 cm test square on page 1) |
| `src/core/quality.ts` | `runQualityChecks(pkg): QualityCheck[]` — self-checks (closed paths, seam length matches within `intendedEaseCm` ± 0.3, ease within range, garment can be put on, layout fits) |

### Presets + instructions (owner: presets)
| File | Exports |
|---|---|
| `src/core/presets/garments.ts` | `GARMENTS: GarmentDefinition[]` (all 11 `GarmentType`s) |
| `src/core/presets/materials.ts` | `MATERIALS: MaterialPreset[]` (≥ 16; European + Scandinavian; everyday → runway) |
| `src/core/presets/styles.ts` | `STYLES: StylePreset[]` (≥ 8: Parisian, Italian, British, Belgian/Antwerp avant-garde, Spanish, Scandi minimal, Nordic hygge, Danish/Copenhagen street, Finnish/Icelandic functional, Scandi evening) |
| `src/core/presets/index.ts` | re-exports + `getGarment(id)`, `getMaterial(id)`, `getStyle(id)` (throw helpful errors listing valid ids), `recommend({body?, garment?, styleId?, occasion?}): { materials: MaterialPreset[]; styles: StylePreset[]; garments: GarmentDefinition[]; reasons: string[] }` |
| `src/core/instructions/index.ts` | `buildInstructions(ctx: InstructionContext): { instructions: InstructionStep[]; glossary: Record<string,string>; effort: {minutes; difficulty} }`, `buildBom(ctx): BomItem[]`, `renderInstructionsMarkdown(pkg): string`, `export interface InstructionContext { garment; style; material; measurements; body; fit; pieces; seams; layouts }` |

Instructions must be generated from the actual `pieces` and `seams` (every seam id appears in ≥1 step, every piece in a cut step), ordered by `seam.stage`, with prepare/cut/mark/construct/fit/finish/press phases, beginner glossary, material-specific handling (needle, pressing, finish), and try-on checkpoints.

### 3D (owner: three)
`src/three/` — must build meshes in Node (no DOM) for eval; only `mountViewer` touches DOM/WebGL.
- `buildBodyGeometry(measurements: ResolvedMeasurements, landmarks: BodyLandmarks): THREE.BufferGeometry`
- `buildGarmentGeometry(pkg: DesignPackage): THREE.BufferGeometry[]` (from `pkg.silhouette`; never inside the body)
- `createDesignScene(pkg): { scene: THREE.Scene; dispose(): void }`
- `mountViewer(container: HTMLElement, pkg): { update(pkg): void; dispose(): void }` — orbit by touch/mouse, pinch zoom, auto-fit camera
- `exportGLB(pkg): Promise<ArrayBuffer>`, `exportOBJ(pkg): string`

### Web app + agent console (owner: ui)
- `index.html`, `src/main.tsx`, `src/ui/**` — mobile-first (390 px first, scales to desktop), bottom tab nav: Measure → Design → Pattern → Make → 3D → Console.
- `src/console/api.ts` — `createAgentAPI()` → object installed as `window.clothesCAD` with JSON-in/JSON-out methods: `help()`, `listGarments()`, `listMaterials()`, `listStyles()`, `recommend()`, `validate(m)`, `design(req)`, `getState()`, `setState(patch)`, `exportSVG(kind)`, `exportMarkdown()`, `exportGLB()`, `exportOBJ()`, `exportJSON()`, `schema()` (JSON Schema of DesignRequest).
- `src/console/commands.ts` — text command parser used by the in-app Console tab and CLI (`design garment=a-line-skirt style=parisian-chic ...`, `json {...}`).
- `cli/index.ts` — Node CLI (`npm run cli -- design --request req.json --out out/`) writing all artifacts.
- `AGENTS.md` — how an agent drives the app (browser console + CLI), with examples.

### Eval (owner: eval)
- `eval/profiles.ts` — ≥ 12 diverse body profiles (petite→tall, XS→4XL, all body shapes, partial measurement sets).
- `eval/metrics.ts` — scorers: geometry validity, seam matching, fit/ease, wearability (openings), proportion/aesthetics, layout validity + BOM consistency, instruction completeness/novice readability, preset integrity, 3D sanity (no NaN, garment ≥ body), determinism.
- `eval/run.ts` — runs every garment × profiles × representative style/material combos, prints a table, writes `eval/reports/latest.json`, exits non-zero if overall < threshold.
- `tests/*.test.ts` — vitest unit tests per module.

## Commands
`npm run dev` · `npm run build` · `npm run typecheck` · `npm test` · `npm run eval` · `npm run cli -- help`
