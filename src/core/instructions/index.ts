import type { FabricLayer, InstructionStep, MaterialPreset, PatternPiece, SeamSpec } from '../types';
import { suggestLining } from '../presets';
import { buildBom, metresForLayer, FABRIC_MARGIN } from './bom';
import { buildGlossary, detectTerms } from './glossary';
import { outlineGroups, printPageCount } from '../svg';
import {
  allowanceAtEdge,
  buttonCount,
  capitalize,
  elasticLengthCm,
  fmt,
  indexPieces,
  listJoin,
  materialTimeFactor,
  materialTraits,
  minutes,
  openingEdge,
  pieceName,
  sewInInterfacing,
  zipInfo,
  type InstructionContext,
  type PieceIndex,
} from './shared';
import {
  basteStep,
  effectiveSeamType,
  groupSeams,
  machineSetup,
  seamGroupStep,
  seamStep,
  type StepDraft,
  type TechniqueEnv,
} from './techniques';

export type { InstructionContext } from './shared';
export { buildBom } from './bom';
export { renderInstructionsMarkdown } from './markdown';
export { GLOSSARY_TERMS } from './glossary';

export interface InstructionResult {
  instructions: InstructionStep[];
  glossary: Record<string, string>;
  effort: { minutes: number; difficulty: 1 | 2 | 3 | 4 | 5 };
}

const LAYER_ORDER: FabricLayer[] = ['self', 'lining', 'interfacing'];

function draft(
  phase: StepDraft['phase'],
  title: string,
  lines: Array<string | null | undefined | false>,
  extra: Partial<StepDraft> & { minutes: number },
): StepDraft {
  return {
    phase,
    title,
    body: lines.filter((l): l is string => typeof l === 'string' && l.length > 0).join('\n'),
    tips: extra.tips ?? [],
    warnings: extra.warnings ?? [],
    seamIds: extra.seamIds ?? [],
    pieceIds: extra.pieceIds ?? [],
    minutes: extra.minutes,
    ...(extra.checkpoint ? { checkpoint: extra.checkpoint } : {}),
  };
}

function layerMaterial(layer: FabricLayer, main: MaterialPreset, lining: MaterialPreset): MaterialPreset | null {
  if (layer === 'self') return main;
  if (layer === 'lining') return lining;
  return null;
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

function finishedSummary(ctx: InstructionContext): string[] {
  const f = ctx.fit.finished;
  const m = ctx.measurements;
  const out: string[] = [];
  const add = (label: string, fin: number | undefined, body: number, ease: number) => {
    if (fin === undefined || !Number.isFinite(fin)) return;
    out.push(`${label}: ${fmt(fin)} cm finished (your ${fmt(body)} cm + ${fmt(ease)} cm ease)`);
  };
  const cat = ctx.garment.category;
  if (cat !== 'skirt' && cat !== 'trousers') add('Bust', f.bust, m.bustCm, ctx.fit.ease.bust);
  add('Waist', f.waist, m.waistCm, ctx.fit.ease.waist);
  add('Hip', f.hip, m.hipCm, ctx.fit.ease.hip);
  if (f.lengthFromWaist !== undefined) out.push(`Length from waist: ${fmt(f.lengthFromWaist)} cm`);
  if (f.lengthFromShoulder !== undefined) out.push(`Length from shoulder: ${fmt(f.lengthFromShoulder)} cm`);
  if (f.inseam !== undefined) out.push(`Inside leg: ${fmt(f.inseam)} cm`);
  if (f.sleeveLength !== undefined && f.sleeveLength > 0) out.push(`Sleeve length: ${fmt(f.sleeveLength)} cm`);
  out.push(hemHeightLine(ctx));
  return out;
}

/** Hem height in plain words: in the planned shoes for floor lengths, flagged when it rests on estimates. */
export function hemHeightLine(ctx: InstructionContext): string {
  const { fit } = ctx;
  const heel = fit.shoeHeelCm ?? 0;
  const h = fit.hemHeightFromFloorCm;
  const base =
    fit.options.length === 'floor' && heel > 0
      ? `Hem height: ${fmt(h + heel)} cm above the floor in your ${fmt(heel)} cm heels (${h < 0 ? `barefoot it rests ${fmt(-h)} cm on the floor` : `${fmt(h)} cm barefoot`})`
      : `Hem height: ${fmt(h)} cm above the floor`;
  return hemFromEstimate(ctx) ? `${base}. This height is estimated from your height: check it at the hem step.` : base;
}

/** Whether the planned hem height depends on estimated leg measurements. */
export function hemFromEstimate(ctx: InstructionContext): boolean {
  const est = new Set(ctx.measurements.estimated);
  return ctx.garment.category !== 'top' && (est.has('waistToFloorCm') || est.has('waistToKneeCm') || est.has('inseamCm'));
}

/** Seams that decide the fit (side, inseam, crotch); used to decide whether a muslin is worth it. */
function hasFitSeams(ctx: InstructionContext): boolean {
  const idx = indexPieces(ctx.pieces);
  return ctx.seams.some((s) => isFitSeam(s, idx));
}

const SAFETY: string[] = [
  'Safety: keep your fingers at least 2 cm from the needle and guide the fabric, never push it under the foot.',
  'Never sew over pins: pull each pin out just before it reaches the presser foot (a needle hitting a pin can snap and fly).',
  'A steam iron runs at 150-230 °C and the steam burns: keep your hand away from the steam holes, stand the iron upright between presses and unplug it when you stop.',
  'Close your shears and keep pins in a pin cushion or magnetic dish, away from children and pets.',
];

function prepareSteps(ctx: InstructionContext, env: TechniqueEnv): StepDraft[] {
  const { material: m, garment, style, fit } = ctx;
  const t = materialTraits(m);
  const steps: StepDraft[] = [];
  const hasLining = ctx.pieces.some((p) => p.layer === 'lining');
  const opts = fit.options;

  const choices = [
    `${garment.name} in ${m.name}, ${style.name} style`,
    `${opts.fit} fit`,
    garment.allowed.length.length ? `${opts.length} length` : null,
    garment.allowed.neckline.length ? `${opts.neckline} neckline` : null,
    garment.allowed.sleeve.length > 1 ? (opts.sleeve === 'none' ? 'sleeveless' : `${opts.sleeve} sleeves`) : null,
    opts.closure !== 'none' ? `${opts.closure.replace('-', ' ')} closure` : null,
    opts.lining ? 'lined' : null,
    opts.pockets ? 'with pockets' : null,
  ].filter((x): x is string => !!x);

  steps.push(
    draft(
      'prepare',
      'Read through your plan',
      [
        `You are making: ${choices.join(', ')}.`,
        `Your pattern has ${ctx.pieces.length} pieces and ${ctx.seams.length} seams and finishing operations. Read every step once before you start; it takes 10 minutes and prevents most mistakes.`,
        'Your finished garment measurements:',
        ...finishedSummary(ctx).map((l) => `- ${l}`),
        'Ease is the extra room beyond your body measurement that lets you move and sit comfortably; it is already built into the pattern.',
      ],
      {
        tips: [
          ...(fit.rationale.length ? [`Why it is designed this way: ${fit.rationale[0]}`] : []),
          ...(hasFitSeams(ctx) || garment.difficulty >= 3 || (m.pricePerMeterEur[0] + m.pricePerMeterEur[1]) / 2 > 40
            ? [
                `Sew a quick muslin (a practice version in cheap cotton) of the main pieces first${garment.difficulty <= 2 ? ': even on a first garment it is the surest way to check the fit' : ''}. Fix the fit on the muslin, transfer the changes to the paper pieces, then cut your good fabric.`,
              ]
            : []),
        ],
        minutes: 10,
      },
    ),
  );

  const pre = m.handling.preTreatment;
  const steamOnly = t.noWash || (/steam/i.test(pre) && !/machine wash at|hand wash|wash at|tumble/i.test(pre));
  const selfM = metresForLayer('self', ctx.layouts, ctx.pieces, m.widthCm, FABRIC_MARGIN);
  const shrinkCm = (selfM * 100 * m.shrinkagePct) / 100;
  steps.push(
    draft(
      'prepare',
      steamOnly ? 'Pre-shrink your fabric with steam' : 'Pre-wash your fabric',
      [
        m.handling.preTreatment,
        m.shrinkagePct > 0
          ? `${m.name} can shrink about ${fmt(m.shrinkagePct)} %: on ${fmt(selfM)} m that is roughly ${fmt(shrinkCm, 0)} cm. Shrinking it now means your finished garment keeps its size.`
          : null,
        hasLining
          ? `Treat the lining (${env.lining.name}) the same way: ${env.lining.handling.preTreatment}`
          : null,
        'When it is dry, press out all creases on the wrong side; folds and wrinkles distort pattern pieces when you cut.',
        `Pressing: ${m.handling.pressing}`,
      ],
      {
        warnings: t.noWash ? ['Do not put this fabric in the washing machine: it will lose its finish or felt.'] : [],
        tips: [`Care for the finished garment: ${m.care}`],
        minutes: t.noWash ? 25 : 20,
      },
    ),
  );

  const tools = buildBom(ctx).filter((b) => b.kind === 'tool');
  steps.push(
    draft(
      'prepare',
      'Collect your tools and set up the machine',
      [
        'Collect these tools before you start:',
        ...tools.map((b) => `- ${b.name}${b.essential ? '' : ' (helpful, optional)'}${b.spec ? `: ${b.spec}` : ''}`),
        machineSetup(m),
        hasLining ? `For the lining you will later switch to: ${machineSetup(env.lining)}` : null,
        'Sew a test seam on two layers of fabric scrap. The stitches should look the same on both sides; if loops show on one side, adjust the tension dial a little and test again.',
      ],
      { tips: ['Wind two bobbins now so you do not run out halfway through a seam.'], warnings: SAFETY, minutes: 15 },
    ),
  );

  steps.push(
    draft(
      'prepare',
      'Print the pattern and check the test square',
      [
        `Print the ${printPageCount(ctx.pieces, 'A4')} tiled pattern pages (A4; Letter paper also works) at 100 % ("actual size"). Switch off any "fit to page" or scaling option in the print dialogue.`,
        'On page 1, measure the test square with a ruler. It must be exactly 5 cm on each side (within 1 mm).',
        'If it is wrong, check the print settings and print page 1 again before printing the rest.',
      ],
      {
        warnings: ['If the test square is off by even 2 mm, every piece will be off too, and over a whole garment that adds up to several centimetres.'],
        minutes: 10,
      },
    ),
  );

  // Pieces with an identical outline (a waistband and its interfacing) share
  // one printed paper piece: list it once and say what else it is used for.
  const ordered = LAYER_ORDER.flatMap((layer) => ctx.pieces.filter((p) => p.layer === layer));
  const pieceLines = outlineGroups(ordered, true).map((g) => {
    const [first, ...rest] = g;
    const reuse = rest.length ? ` (also used to cut the ${listJoin(rest.map((p) => `${p.layer === 'interfacing' ? 'interfacing' : p.layer}`))}: there is no separate paper piece for it)` : '';
    return `- ${first!.name}${first!.layer === 'self' ? '' : ` (${first!.layer})`}${reuse}`;
  });
  steps.push(
    draft(
      'prepare',
      'Tape the tiled pages together and cut out the paper pieces',
      [
        'Lay the pages out in order using the grid labels in the corners (A1, A2, B1 ...): letters are rows, numbers are columns.',
        'Trim the margin on one side of each overlap, line up the printed lines exactly, and tape the pages together on the front and back.',
        `Cut out each paper piece along the outer cutting line (the seam allowance is already included). You should have ${pieceLines.length} paper pieces:`,
        ...pieceLines,
        'Write the piece name and "right side up" on any piece where it is not already printed.',
      ],
      {
        pieceIds: ctx.pieces.map((p) => p.id),
        tips: ['Work on a big table or the floor; slide pages under each other rather than lifting them.'],
        minutes: minutes(15 + ctx.pieces.length * 5),
      },
    ),
  );
  return steps;
}

// ---------------------------------------------------------------------------
// Cut + mark
// ---------------------------------------------------------------------------

function cutInstruction(p: PatternPiece, folded: boolean, paperOf?: PatternPiece): string {
  const n = p.cutCount;
  const parts: string[] = [`${p.name}: cut ${n}`];
  if (paperOf) parts.push(`using the ${paperOf.name} paper piece again`);
  if (folded && !p.cutOnFold && n % 2 === 1) {
    parts.push(
      n === 1
        ? '— cut through ONE layer only: cut it last, lift the top layer away around it and cut the bottom layer alone (cutting both layers would give you two)'
        : `— ${n - 1} come from cutting through both layers; cut the last one through ONE layer only (lift the top layer away first)`,
    );
  }
  if (p.cutOnFold) {
    parts.push(
      folded
        ? 'with the edge marked "place on fold" exactly on the folded edge'
        : 'on the fold (fold just enough fabric, selvedge parallel to the fold, to fit the piece, and place the "fold" edge on it)',
    );
  }
  if (p.mirrorPair && n >= 2) {
    parts.push(
      folded
        ? '(cutting through both layers gives you a mirrored left and right pair)'
        : '(cut one, then turn the paper piece over, printed side down, and cut the next so you get a mirrored left and right pair)',
    );
  }
  return `- ${parts.join(' ')}`;
}

/** The printed piece whose paper this piece is cut from, when it has no paper piece of its own. */
function paperPieceOf(p: PatternPiece, all: PatternPiece[]): PatternPiece | undefined {
  const ordered = LAYER_ORDER.flatMap((layer) => all.filter((q) => q.layer === layer));
  const g = outlineGroups(ordered, true).find((x) => x.includes(p));
  return g && g[0] !== p ? g[0] : undefined;
}

function cutSteps(ctx: InstructionContext, env: TechniqueEnv): StepDraft[] {
  const steps: StepDraft[] = [];
  for (const layer of LAYER_ORDER) {
    const pieces = ctx.pieces.filter((p) => p.layer === layer);
    if (!pieces.length) continue;
    const layout = ctx.layouts.find((l) => l.layer === layer);
    const mat = layerMaterial(layer, env.main, env.lining);
    const t = mat ? materialTraits(mat) : null;
    const folded = layout?.fold === 'folded';
    const fabricLabel = layer === 'self' ? mat!.name : layer === 'lining' ? `lining (${mat!.name})` : 'interfacing';
    const width = layout?.fabricWidthCm ?? (layer === 'self' ? env.main.widthCm : layer === 'lining' ? 140 : 90);
    const copies = pieces.reduce((a, p) => a + Math.max(1, p.cutCount), 0);

    const lines: Array<string | null> = [
      folded
        ? `Fold the ${fabricLabel} in half lengthwise, selvedge to selvedge, right sides together, giving a folded width of ${fmt(width / 2)} cm. Smooth it flat so the fold is perfectly straight.`
        : `Lay the ${fabricLabel} out flat in a single layer, ${layer === 'interfacing' ? 'glue side (rough or shiny dots) down' : 'right side up'}.`,
      layout
        ? `Follow the ${layer} cutting layout diagram: it uses about ${fmt(layout.lengthCm, 0)} cm of fabric length.`
        : null,
      layer === 'interfacing' && layout?.placements.some((pl) => pl.rotationDeg % 180 !== 0)
        ? 'Interfacing has no grain: place the paper pieces exactly as in the layout diagram, turned across the width where shown.'
        : 'Place each paper piece so its grainline arrow is exactly parallel to the selvedge: measure from both ends of the arrow to the selvedge; the two numbers must be the same.',
      'Cut these pieces:',
      ...pieces.map((p) => cutInstruction(p, folded, paperPieceOf(p, ctx.pieces))),
      folded && pieces.some((p) => !p.cutOnFold && p.cutCount % 2 === 1)
        ? 'On the layout, single-layer pieces are drawn with a dashed red outline.'
        : null,
      'Cut with long, smooth strokes, keeping the lower blade on the table. Cut notches as small outward triangles or snip them later (next step); never cut them off.',
      'Leave each paper piece attached to its fabric piece until it has been marked.',
    ];
    const tips: string[] = [];
    const warnings: string[] = [];
    if (t && mat) {
      if (t.directional) lines.push('This fabric has a nap or sheen that changes with direction: place every piece with its top pointing the same way.');
      if (t.knit) lines.push('The greatest stretch must go around the body, across each piece (at right angles to the grainline arrow).');
      if (t.needsMatching) lines.push('Line up the checks, stripes or print motifs at the notches of pieces that will be sewn together before you cut.');
      tips.push(mat.handling.cuttingTips);
      if (t.slippery) warnings.push('This fabric slides: cut a single layer at a time, ideally on top of paper or a cotton sheet, and use pattern weights.');
      if (t.pinInAllowanceOnly) warnings.push('Pins leave holes: use pattern weights and pin only within the seam allowance.');
    } else if (layout?.placements.some((pl) => pl.rotationDeg % 180 !== 0)) {
      tips.push('Fusible interfacing has no grain, so long strips are laid across its width as in the layout: it saves most of the interfacing.');
    } else {
      tips.push('Cut the interfacing on the same grain as the fabric piece it supports, so they behave together.');
    }
    steps.push(
      draft('cut', `Cut the ${layer === 'self' ? 'main fabric' : layer}`, lines, {
        pieceIds: pieces.map((p) => p.id),
        tips,
        warnings,
        minutes: minutes((10 + copies * 5) * (mat ? materialTimeFactor(mat) : 1)),
      }),
    );
  }
  return steps;
}

function markSteps(ctx: InstructionContext, env: TechniqueEnv): StepDraft[] {
  const steps: StepDraft[] = [];
  const t = materialTraits(env.main);
  const marked = ctx.pieces.filter((p) => p.notches.length || p.darts.length || p.cutOnFold);
  if (marked.length) {
    const notchCount = marked.reduce((a, p) => a + p.notches.length, 0);
    const dartPieces = marked.filter((p) => p.darts.length);
    const dartTotal = dartPieces.reduce((a, p) => a + p.darts.length * Math.max(1, p.cutOnFold ? p.cutCount * 2 : p.cutCount), 0);
    const front = dartPieces.find((p) => /front-bodice|front-dress/.test(p.role));
    const r = ctx.measurements;
    const lines: Array<string | null> = [
      notchCount
        ? `Mark the ${notchCount} notches on ${listJoin(marked.filter((p) => p.notches.length).map((p) => p.name.toLowerCase()))}: snip 3 mm straight into the seam allowance at each one${t.noFray ? '' : ' (no deeper, or it will fray into the seam)'}. A double notch marks a back edge, a single notch a front edge.`
        : null,
      marked.some((p) => p.cutOnFold)
        ? 'On pieces cut on the fold, snip a tiny 3 mm notch at both ends of the fold to mark the centre front or centre back.'
        : null,
      dartTotal
        ? `Mark the ${dartTotal} darts on ${listJoin(dartPieces.map((p) => p.name.toLowerCase()))}: snip the two dart legs at the raw edge, then push a pin straight down through the paper at the dart point and make a ${t.tailorTacks || env.main.fiber === 'silk' ? "tailor's tack" : 'chalk dot'} on the wrong side of each fabric layer where the pin comes out. Join the legs to the point with a ruler and chalk.`
        : null,
      front
        ? `The bust dart points stop about 2 cm short of your bust point (apex). Your bust points are about ${fmt(r.bustPointDistanceCm)} cm apart and about ${fmt(r.shoulderToBustPointCm)} cm down from where your neck meets your shoulder; hold the ${front.name.toLowerCase()} against you to check.`
        : null,
      'Mark the right side of fabrics where both sides look alike with a small chalk cross, so you always know which side is which.',
      'Now unpin the paper pieces and keep them flat; you may need them again.',
    ];
    steps.push(
      draft('mark', 'Transfer the markings', lines, {
        pieceIds: marked.map((p) => p.id),
        tips: [
          t.tailorTacks || env.main.fiber === 'silk'
            ? "Chalk and pens may stain or not show on this fabric: tailor's tacks in a contrasting silk or cotton thread are safest."
            : 'Test your marking pen or chalk on a scrap first to make sure it comes out.',
        ],
        minutes: minutes((5 + marked.length * 3 + dartTotal * 2) * materialTimeFactor(env.main)),
      }),
    );
  }

  const interfacing = ctx.pieces.filter((p) => p.layer === 'interfacing');
  if (interfacing.length) {
    const sewIn = sewInInterfacing(env.main);
    const pairs = interfacing.map((p) => {
      const target = ctx.pieces.find((q) => q.layer === 'self' && q.role === p.role) ?? null;
      return { p, target };
    });
    const lines: Array<string | null> = [
      'Match each interfacing piece to its fabric piece:',
      ...pairs.map(
        ({ p, target }) =>
          `- ${p.name}${target ? ` goes on the wrong side of the ${target.name.toLowerCase()}` : ' goes on the wrong side of its matching fabric piece'}.`,
      ),
      sewIn
        ? 'This fabric needs a sew-in interfacing: lay it on the wrong side of the fabric piece, pin, and hand baste around the edge within the seam allowance. From now on treat the two layers as one.'
        : 'Place the interfacing glue side down on the wrong side of the fabric piece. Cover with the press cloth and press: hold the iron still for 10-15 seconds, lift, move to the next spot overlapping slightly. Never slide the iron or the interfacing shifts.',
      sewIn ? null : 'Let the piece cool flat for a few minutes before handling, then check the edges are fully stuck.',
      `Interfacing for this fabric: ${env.main.handling.interfacing}`,
    ];
    steps.push(
      draft('mark', sewIn ? 'Baste the interfacing in place' : 'Fuse the interfacing', lines, {
        pieceIds: [...interfacing.map((p) => p.id), ...pairs.flatMap(({ target }) => (target ? [target.id] : []))],
        tips: ['Test-fuse a scrap first: if the fabric bubbles or changes colour, lower the heat or use less steam.'],
        warnings: sewIn ? [] : ['Glue on the iron soleplate ruins fabric: always use the press cloth.'],
        minutes: minutes(10 + interfacing.length * 4),
      }),
    );
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Construct + fit
// ---------------------------------------------------------------------------

const FIT_EDGE_RE = /side|inseam|outseam|crotch|rise/i;

function isFitSeam(s: SeamSpec, idx: PieceIndex): boolean {
  if (!s.b) return false;
  if (s.type !== 'plain' && s.type !== 'french') return false;
  if (idx.get(s.a.pieceId)?.layer !== 'self') return false;
  const roles = [idx.get(s.a.pieceId)?.role, idx.get(s.b.pieceId)?.role];
  if (roles.some((r) => !r || /pocket-bag|waistband|wrap-tie|binding|facing/.test(r))) return false;
  return FIT_EDGE_RE.test(`${s.a.edgeId} ${s.b.edgeId}`);
}

function staystitchStep(ctx: InstructionContext, env: TechniqueEnv): StepDraft | null {
  const targets = ctx.pieces
    .filter((p) => p.layer !== 'interfacing' && !/waistband|facing|binding|tie/.test(p.role))
    .map((p) => ({ p, edges: p.edges.filter((e) => e.kind !== 'fold' && /neck|armhole|waist|wrap/i.test(e.id)) }))
    .filter((x) => x.edges.length);
  if (!targets.length) return null;
  const sa = targets[0]!.p.seamAllowanceCm || 1.5;
  const lines = [
    `Before anything else, staystitch the curved edges so they cannot stretch while you handle the pieces: ${listJoin(
      targets.map(({ p, edges }) => `the ${listJoin(edges.map((e) => e.id.replace(/[-_]/g, ' ')))} of the ${p.name.toLowerCase()}`),
    )}.`,
    `Working on one layer, sew ${fmt(Math.max(0.5, sa - 0.3))} cm from the raw edge (just inside the seam line) with normal stitch length. Sew each curve from the high point towards the centre (from shoulder to centre on necklines, from side to centre on waists).`,
    'Do not press these curves yet; handle them as little as possible.',
  ];
  const t = materialTraits(env.main);
  return draft('construct', 'Staystitch the curved edges', lines, {
    pieceIds: targets.map(({ p }) => p.id),
    tips: t.slippery || t.knit ? ['On this fabric staystitching is essential: do it within an hour of cutting.'] : [],
    minutes: minutes(targets.length * 5),
  });
}

function fallbackPieceSteps(ctx: InstructionContext, env: TechniqueEnv): { early: StepDraft[]; late: StepDraft[] } {
  const referenced = new Set(ctx.seams.flatMap((s) => [s.a.pieceId, ...(s.b ? [s.b.pieceId] : [])]));
  const unref = ctx.pieces.filter((p) => !referenced.has(p.id) && p.layer !== 'interfacing');
  const early: StepDraft[] = [];
  const late: StepDraft[] = [];
  const sa = (p: PatternPiece) => fmt(p.seamAllowanceCm || 1.5);
  const pockets = unref.filter((p) => p.role === 'pocket-bag');
  if (pockets.length) {
    early.push(
      draft(
        'construct',
        'Add the in-seam pockets',
        [
          `Pin one ${pockets[0]!.name.toLowerCase()} to each side edge of the front and back pieces, right sides together, matching the pocket notches, and sew at 1 cm. Finish the edges and press the pocket bags away from the garment.`,
          `Later, when you sew the side seams, sew around the pocket bags in one go: pivot at the top pocket notch, sew around the bag ${sa(pockets[0]!)} cm from the edge, pivot at the lower notch and continue down the side seam.`,
          'Clip the back seam allowance just above and below the pocket so you can press the pocket towards the front.',
        ],
        { pieceIds: pockets.map((p) => p.id), minutes: minutes(30 * materialTimeFactor(env.main)) },
      ),
    );
  }
  const ties = unref.filter((p) => p.role === 'wrap-tie');
  if (ties.length) {
    early.push(
      draft(
        'construct',
        'Make the ties',
        [
          `Fold each ${ties[0]!.name.toLowerCase()} in half lengthwise, right sides together. Sew the long edge and one short end at ${sa(ties[0]!)} cm, leaving the other short end open.`,
          'Trim the corners diagonally, turn the tie right side out with a safety pin or point turner, and press flat with the seam along one edge.',
          'Baste the open end to the matching notch on the wrap edge so it is caught in the next seam.',
        ],
        { pieceIds: ties.map((p) => p.id), minutes: minutes(25 * materialTimeFactor(env.main)) },
      ),
    );
  }
  const lining = unref.filter((p) => p.layer === 'lining' || p.role === 'lining');
  if (lining.length) {
    late.push(
      draft(
        'finish',
        'Make and attach the lining',
        [
          `Sew the ${listJoin(lining.map((p) => p.name.toLowerCase()))} together exactly like the main fabric (darts as small tucks, side seams), leaving the zip opening ${fmt(2)} cm longer than in the main garment.`,
          `${machineSetup(env.lining)}`,
          'Slip the lining into the garment wrong sides together. Pin it along the top edge (waist or neckline and armholes) and baste it there within the seam allowance, so it is caught when you attach the waistband or facing.',
          'Turn under the lining edges beside the zip so they clear the zip teeth by 5 mm and slip stitch them to the zip tape.',
        ],
        { pieceIds: lining.map((p) => p.id), minutes: minutes(60 * materialTimeFactor(env.lining)) },
      ),
    );
  }
  const others = unref.filter((p) => !pockets.includes(p) && !ties.includes(p) && !lining.includes(p));
  for (const p of others) {
    late.push(
      draft(
        'finish',
        `Attach the ${p.name.toLowerCase()}`,
        [
          `Finish the raw edges of the ${p.name.toLowerCase()}, then pin it in place matching its notches, right sides together, and sew at ${sa(p)} cm. Press the seam allowances towards the piece.`,
        ],
        { pieceIds: [p.id], minutes: minutes(20 * materialTimeFactor(env.main)) },
      ),
    );
  }
  return { early, late };
}

function fitCheckStep(ctx: InstructionContext, env: TechniqueEnv, zipPending: boolean, fitSeams: SeamSpec[]): StepDraft {
  const { fit, measurements: m, garment } = ctx;
  const cat = garment.category;
  const lower = cat === 'skirt' || cat === 'trousers';
  const checks: string[] = [];
  const short: string[] = [];
  const area = (label: string, fin: number | undefined, body: number, ease: number) => {
    if (fin === undefined || !Number.isFinite(fin)) return;
    const pinch = ease / 4;
    checks.push(
      ease > 0.5
        ? `${label}: the garment measures ${fmt(fin)} cm around and your ${label.toLowerCase()} is ${fmt(body)} cm, so there is ${fmt(ease)} cm of ease. You should be able to pinch about ${fmt(pinch)} cm of fabric at each side seam.`
        : ease < -0.5
          ? `${label}: the garment measures ${fmt(fin)} cm around against your ${fmt(body)} cm; this stretch fabric is meant to be ${fmt(-ease)} cm smaller, so it should feel snug and smooth, without wrinkles or strain lines.`
          : `${label}: the garment measures ${fmt(fin)} cm around, almost exactly your ${fmt(body)} cm; it should feel close but you must still be able to breathe and sit.`,
    );
    short.push(`${label.toLowerCase()} ${fmt(fin)} cm (body ${fmt(body)} + ${fmt(ease)} ease)`);
  };
  if (!lower) area('Bust', fit.finished.bust, m.bustCm, fit.ease.bust);
  area('Waist', fit.finished.waist, m.waistCm, fit.ease.waist);
  area('Hip', fit.finished.hip, m.hipCm, fit.ease.hip);

  const sa = fitSeams.length ? (env.idx.get(fitSeams[0]!.a.pieceId)?.seamAllowanceCm ?? 1.5) : 1.5;
  const letOut = Math.max(0, sa - 1) * 2 * Math.max(2, fitSeams.length);
  const lines: Array<string | null> = [
    `Put the garment on right side out, carefully, because basting is fragile.${zipPending ? ' The zip is not in yet: pin the opening closed exactly along the seam line.' : ''}`,
    lower ? 'Tie a piece of elastic or ribbon round your natural waist to hold the garment where it will sit.' : null,
    'Stand in front of a full-length mirror (ideally with a helper) and check:',
    ...checks.map((c) => `- ${c}`),
    '- The side seams hang straight down, at right angles to the floor, without swinging forward or back.',
    cat === 'trousers'
      ? '- Sit, squat and climb a step. The crotch must not pull or cut in. Folds pointing towards the crotch mean the crotch curve needs more room; ask your helper to pin where it pulls.'
      : '- Sit down and lift your arms. Nothing should pull tight or ride up.',
    '- No diagonal drag lines. Lines pointing to a spot mean it is too tight there; loose folds mean too much fabric.',
    `Too loose? Pin out the extra fabric evenly at both side seams, mark the new line with chalk and sew there. Too tight? Sew closer to the edge: the seam allowances give you up to about ${fmt(letOut)} cm extra in total.`,
    'Take the garment off carefully and adjust the seam lines before sewing them permanently in the next steps.',
  ];
  return draft('fit', 'Try on and check the fit', lines, {
    seamIds: fitSeams.map((s) => s.id),
    pieceIds: [...new Set(fitSeams.flatMap((s) => [s.a.pieceId, ...(s.b ? [s.b.pieceId] : [])]))],
    tips: [
      ...(fit.rationale.slice(0, 2).map((r) => `Fit plan: ${r}`)),
      'Make adjustments equally on both sides so the garment stays symmetrical.',
    ],
    warnings: ['Do not cut away any seam allowance until you are happy with the fit.'],
    checkpoint: `Try it on: ${short.join('; ') || 'it should feel comfortable and hang straight'}. Side seams vertical, no pulling when you sit${cat === 'trousers' ? ' or squat' : ''}.`,
    minutes: 20,
  });
}

function hemCheckStep(ctx: InstructionContext, env: TechniqueEnv, hemSeams: SeamSpec[]): StepDraft {
  const { fit, garment } = ctx;
  const hemPiece = hemSeams[0] ? env.idx.get(hemSeams[0].a.pieceId) : undefined;
  const H = hemSeams[0] ? allowanceAtEdge(hemPiece, hemSeams[0].a.edgeId, 3) : 3;
  const curved = garment.id === 'circle-skirt' || garment.id === 'ball-gown' || fit.options.flare >= 0.6;
  const floor = fit.options.length === 'floor';
  const lines: Array<string | null> = [
    curved
      ? 'Hang the garment on a hanger for at least 24 hours first: the bias parts of the hem stretch and drop, and you want that to happen before hemming, not after.'
      : null,
    `Put the garment on with the shoes and underwear you will wear with it${floor ? ' (heel height changes a floor-length hem completely)' : ''}.`,
    `The planned hem sits ${fmt(fit.hemHeightFromFloorCm + (floor ? (fit.shoeHeelCm ?? 0) : 0))} cm above the floor${floor && (fit.shoeHeelCm ?? 0) > 0 ? ` in your ${fmt(fit.shoeHeelCm ?? 0)} cm heels` : ''}${
      fit.finished.lengthFromWaist !== undefined ? `, ${fmt(fit.finished.lengthFromWaist)} cm below your natural waist` : ''
    }${fit.finished.inseam !== undefined ? ` (inside leg ${fmt(fit.finished.inseam)} cm)` : ''}.`,
    'Ask your helper to stand a long ruler upright on the floor and pin along the hem fold at that height all the way round, while you turn slowly. Do not look down; it changes how the hem falls.',
    H - 1 >= 0.5
      ? `Check in the mirror. You can move the hem up by several centimetres or down by up to about ${fmt(H - 1)} cm (the hem allowance is ${fmt(H)} cm).`
      : `Check in the mirror. You can shorten the hem freely, but there is almost no room to lengthen it (the hem allowance is only ${fmt(H)} cm).`,
    curved ? 'If the hem is now uneven after hanging, trim the raw edge so the allowance is the same depth all the way round.' : null,
    hemFromEstimate(ctx)
      ? 'Your leg length was estimated from your height, so trust the mirror and the ruler here rather than the planned number.'
      : null,
  ];
  return draft('fit', 'Check the hem length', lines, {
    seamIds: hemSeams.map((s) => s.id),
    pieceIds: [...new Set(hemSeams.map((s) => s.a.pieceId))],
    tips: [
      ...(fit.rationale.filter((r) => /\bhem\b|\bcalf|\bknee|\bankle|\bfloor\b|\bmidi\b|\bmini\b/i.test(r)).slice(0, 2).map((r) => `Why this length: ${r}`)),
      'A hem marker or a friend with a ruler gives a far more even hem than measuring the garment flat.',
    ],
    warnings: [],
    checkpoint: `Before hemming: hem fold at ${fmt(fit.hemHeightFromFloorCm + (floor ? (fit.shoeHeelCm ?? 0) : 0))} cm from the floor, level all round, wearing the right shoes.`,
    minutes: curved ? 25 : 15,
  });
}

function sleeveCheckStep(ctx: InstructionContext, sleeveSeams: SeamSpec[]): StepDraft {
  const { fit, measurements: m } = ctx;
  const lines = [
    'Try the garment on and look at the sleeves in the mirror.',
    `- The sleeve cap should be smooth, with no dimples or tucks, and the seam should sit on the edge of your shoulder.`,
    `- Reach forward, hug yourself and lift your arms to shoulder height: there should be no pulling across the back or at the armhole.`,
    fit.finished.sleeveLength
      ? `- The sleeve should end about ${fmt(fit.finished.sleeveLength)} cm from your shoulder point.`
      : null,
    `- Around the upper arm there is ${fmt(fit.ease.upperArm)} cm of ease on your ${fmt(m.upperArmCm)} cm arm; you should be able to pinch about ${fmt(Math.max(0, fit.ease.upperArm) / 2)} cm of fabric.`,
  ];
  return draft('fit', 'Check the sleeves', lines, {
    seamIds: sleeveSeams.map((s) => s.id),
    pieceIds: [...new Set(sleeveSeams.flatMap((s) => [s.a.pieceId, ...(s.b ? [s.b.pieceId] : [])]))],
    checkpoint: 'Sleeves: smooth cap, seam on the shoulder edge, free arm movement when reaching forward.',
    minutes: 10,
  });
}

function constructSteps(ctx: InstructionContext, env: TechniqueEnv): { steps: StepDraft[]; late: StepDraft[] } {
  const steps: StepDraft[] = [];
  const stay = staystitchStep(ctx, env);
  if (stay) steps.push(stay);
  const fallback = fallbackPieceSteps(ctx, env);
  steps.push(...fallback.early);

  const sorted = ctx.seams
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.stage - b.s.stage || a.i - b.i)
    .map((x) => x.s);
  const fitSeams = sorted.filter((s) => isFitSeam(s, env.idx));
  const fitIds = new Set(fitSeams.map((s) => s.id));
  const fitStage = fitSeams.length ? Math.max(...fitSeams.map((s) => s.stage)) : null;
  const zipSeams = sorted.filter((s) => s.type === 'zip-invisible' || s.type === 'zip-lapped');
  let fitDone = fitStage === null;
  let hemChecked = false;
  // Fit seams are basted at their own assembly stage (consecutive ones merged
  // into one step) so the step order follows seam.stage even when other seams
  // (zips, pocket bags) are staged between them. The try-on and the permanent
  // stitching follow once the last fit seam is basted.
  const basted = new Set<string>();
  let pendingBaste: SeamSpec[] = [];
  const flushBaste = () => {
    if (!pendingBaste.length) return;
    steps.push(basteStep(pendingBaste, env, basted.size > 0));
    for (const s of pendingBaste) basted.add(s.id);
    pendingBaste = [];
  };

  const emitFit = () => {
    if (fitDone) return;
    fitDone = true;
    pendingBaste.push(...fitSeams.filter((s) => !basted.has(s.id) && !pendingBaste.includes(s)));
    flushBaste();
    const zipPending = zipSeams.some((z) => z.stage > (fitStage ?? 0));
    steps.push(fitCheckStep(ctx, env, zipPending, fitSeams));
    for (const s of fitSeams) {
      const st = seamStep(s, env);
      const prefix =
        effectiveSeamType(s, env) === 'french'
          ? 'After the fitting: mark any changed seam line with chalk and pull out the basting stitches, then sew the seam for real as follows.'
          : 'After the fitting: sew the final seam on your (possibly adjusted) seam line with normal stitch length, right over the basting, then pull the basting threads out.';
      steps.push({ ...st, body: `${prefix}\n${st.body}` });
    }
  };

  const stages = [...new Set(sorted.map((s) => s.stage))];
  const lastSleeveStage = Math.max(-Infinity, ...sorted.filter((s) => s.type === 'set-in-sleeve').map((s) => s.stage));
  for (const stage of stages) {
    if (!fitDone && fitStage !== null && stage > fitStage) emitFit();
    if (!fitDone) pendingBaste.push(...sorted.filter((s) => s.stage === stage && fitIds.has(s.id)));
    const here = sorted.filter((s) => s.stage === stage && !fitIds.has(s.id));
    for (const group of groupSeams(here, env)) {
      const first = group[0]!;
      if (first.type.startsWith('hem') && !hemChecked) {
        emitFit();
        hemChecked = true;
        steps.push(hemCheckStep(ctx, env, sorted.filter((x) => x.type.startsWith('hem'))));
      }
      flushBaste();
      steps.push(seamGroupStep(group, env));
      if (first.type === 'set-in-sleeve' && stage === lastSleeveStage) {
        steps.push(sleeveCheckStep(ctx, sorted.filter((x) => x.type === 'set-in-sleeve')));
      }
    }
  }
  emitFit();
  return { steps, late: fallback.late };
}

// ---------------------------------------------------------------------------
// Finish + press
// ---------------------------------------------------------------------------

function finishSteps(ctx: InstructionContext, env: TechniqueEnv): StepDraft[] {
  const steps: StepDraft[] = [];
  const closure = ctx.fit.options.closure;
  const zip = zipInfo(ctx, env.idx);
  const factor = materialTimeFactor(env.main);

  if (closure === 'elastic') {
    const len = elasticLengthCm(ctx.measurements.waistCm);
    const band = ctx.pieces.find((p) => p.role === 'waistband');
    steps.push(
      draft(
        'finish',
        'Insert the waist elastic',
        [
          `Cut the elastic to ${len} cm. Wrap it round your waist first: it should feel comfortably snug, not tight, with the ends overlapping 2.5 cm.`,
          `Leave (or unpick) a 5 cm gap in the ${band ? band.name.toLowerCase() : 'waist casing'} seam near the centre back. Fix a bodkin or large safety pin to one end of the elastic and thread it through the casing all the way round, holding the other end with a pin so it is not pulled inside.`,
          'Check the elastic is not twisted. Overlap the ends by 2.5 cm and sew them together with a box of zigzag stitches.',
          'Let the elastic slip inside, spread the gathers evenly, and sew the gap closed.',
          'Stitch through all layers exactly in the side seams (in the groove) so the elastic can never twist.',
        ],
        { pieceIds: band ? [band.id] : [], minutes: minutes(25 * factor) },
      ),
    );
  }

  if (closure === 'buttons') {
    const n = buttonCount(ctx);
    const op = openingEdge(ctx);
    const gown = ctx.garment.category === 'gown';
    const spacing = op ? op.edge.lengthCm / Math.max(1, n - 1) : gown ? 2.5 : 7;
    steps.push(
      draft(
        'finish',
        gown ? 'Make the button loops and sew on the buttons' : 'Make the buttonholes and sew on the buttons',
        gown
          ? [
              `Cover ${n} buttons with scraps of your fabric following the button-kit instructions.`,
              `Make a row of ${n} narrow fabric loops (rouleau) and baste them to the edge of the overlap, ${fmt(spacing)} cm apart, before the facing or lining is attached; if that is already done, use thread loops sewn by hand.`,
              'Sew the buttons on the opposite edge, in line with the loops, with a short thread shank so they sit on top of the fabric.',
            ]
          : [
              `Mark ${n} buttonholes on the overlapping edge${op ? ` of the ${op.piece.name.toLowerCase()}` : ''}, evenly about ${fmt(spacing)} cm apart, the first 1.5 cm below the top edge. Each buttonhole is the button diameter plus 3 mm.`,
              'Practise on a scrap with interfacing first. Then sew each buttonhole with your machine buttonhole foot.',
              'Put a pin across the end of each buttonhole as a stopper and cut it open with the seam ripper.',
              'Lap the edges, push a pin through each buttonhole to mark the button position, and sew each button on with a short thread shank (wrap the thread round the stitches under the button 5 times).',
            ],
        { pieceIds: op ? [op.piece.id] : [], minutes: minutes(n * 8 * factor) },
      ),
    );
  }

  if (zip) {
    steps.push(
      draft(
        'finish',
        'Sew a hook and eye above the zip',
        [
          'On the inside, at the very top of the zip, sew a small hook to one side 2 mm in from the edge and the eye (loop) on the other side so the edges meet without a gap when closed.',
          'Use a doubled thread and 5-6 small stitches through each hole, catching only the facing, lining or seam allowance so nothing shows on the outside.',
        ],
        { minutes: 10, tips: ['This stops the top of the zip from slipping open and takes strain off the slider.'] },
      ),
    );
  }

  if (closure === 'wrap-tie') {
    steps.push(
      draft(
        'finish',
        'Add a snap to the inner wrap',
        [
          'Try the dress on and tie it. Mark where the inner front edge meets the opposite side seam at the waist.',
          'Sew a small snap there (the ball half on the wrap edge, the socket on the inside of the side seam), catching only the inside layers, so the wrap never gapes.',
        ],
        { minutes: 10 },
      ),
    );
  }

  steps.push(
    draft(
      'finish',
      'Tidy up and final try-on',
      [
        'Pull out all basting threads and tailor tacks, and brush or sponge away chalk marks (test first).',
        'Trim every loose thread end inside and out to 5 mm.',
        'Turn the garment inside out and check each seam: no holes, no skipped stitches, every raw edge finished.',
        'Try it on one last time with the shoes and accessories you plan to wear.',
      ],
      {
        tips: ctx.style.stylingNotes.slice(0, 3).map((n) => `Styling (${ctx.style.name}): ${n}`),
        checkpoint: 'Final check: the garment closes easily, hangs straight and you can sit, walk and lift your arms comfortably.',
        minutes: 15,
      },
    ),
  );
  return steps;
}

function pressStep(env: TechniqueEnv): StepDraft {
  const m = env.main;
  const t = materialTraits(m);
  return draft(
    'press',
    'Give it a final press',
    [
      `Press the whole garment on the wrong side, section by section: ${m.handling.pressing}`,
      "Press seams over a seam roll or rolled towel and curved areas over the tailor's ham so their shape is kept.",
      t.knit
        ? 'Let it cool and dry flat, then fold it; hanging can stretch knits.'
        : 'Hang it on a padded or wide hanger and let it cool and dry for 30 minutes before wearing, so the pressing sets.',
      `Care from now on: ${m.care}`,
    ],
    {
      tips: ['Sew a small care label into a side seam with the fabric and washing instructions; your future self will thank you.'],
      warnings: t.dryPressOnly ? ['Use a dry iron on this fabric: water drops can leave permanent marks.'] : [],
      minutes: minutes(20 * materialTimeFactor(m)),
    },
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function combinedDifficulty(garmentDifficulty: number, beginnerFriendliness: number): 1 | 2 | 3 | 4 | 5 {
  const materialDifficulty = 6 - beginnerFriendliness; // 1 easy .. 5 hard
  const d = Math.round((garmentDifficulty * 2 + materialDifficulty) / 3);
  return Math.min(5, Math.max(1, d)) as 1 | 2 | 3 | 4 | 5;
}

/**
 * Step-by-step instructions generated from the actual pattern pieces and seams:
 * prepare -> cut -> mark -> construct (ordered by seam stage, with try-on
 * checkpoints) -> finish -> press. Every seam appears in at least one step and
 * every piece in a cut step.
 */
export function buildInstructions(ctx: InstructionContext): InstructionResult {
  const idx = indexPieces(ctx.pieces);
  const env: TechniqueEnv = { ctx, idx, main: ctx.material, lining: suggestLining(ctx.material) };

  const construct = constructSteps(ctx, env);
  const drafts: StepDraft[] = [
    ...prepareSteps(ctx, env),
    ...cutSteps(ctx, env),
    ...markSteps(ctx, env),
    ...construct.steps,
    ...construct.late,
    ...finishSteps(ctx, env),
    pressStep(env),
  ];

  // Safety net: every seam must be covered (all seam types are handled above,
  // so this only triggers if a drafted seam was somehow skipped).
  const covered = new Set(drafts.flatMap((d) => d.seamIds));
  const missing = ctx.seams.filter((s) => !covered.has(s.id));
  if (missing.length) {
    const firstFinish = drafts.findIndex((d) => d.phase === 'finish');
    const extra = missing.map((s) => seamStep(s, env));
    drafts.splice(firstFinish === -1 ? drafts.length : firstFinish, 0, ...extra);
  }

  const used = new Set<string>();
  const instructions: InstructionStep[] = drafts.map((d, i) => {
    const text = [d.title, d.body, ...d.tips, ...d.warnings, d.checkpoint ?? ''].join('\n');
    const terms = detectTerms(text);
    for (const t of terms) used.add(t);
    return { n: i + 1, ...d, terms };
  });

  const total = instructions.reduce((a, s) => a + s.minutes, 0);
  return {
    instructions,
    glossary: buildGlossary(used),
    effort: {
      minutes: total,
      difficulty: combinedDifficulty(ctx.garment.difficulty, ctx.material.beginnerFriendliness),
    },
  };
}

/** Human summary of how pieces are used, e.g. for UI tooltips. */
export function describePiece(p: PatternPiece): string {
  const parts = [`cut ${p.cutCount}`];
  if (p.cutOnFold) parts.push('on the fold');
  if (p.mirrorPair) parts.push('as a mirrored pair');
  return `${capitalize(pieceName(p, p.id))}: ${parts.join(' ')} (${p.layer})`;
}
