/**
 * Garments with a bodice: shell top, shift dress, sheath dress, wrap dress,
 * column gown and ball gown.
 *
 * - Shell & shift: one-piece block (bust darts, side shaping), CF on fold.
 * - Sheath & column: princess panels from shoulder... armhole to hem.
 * - Wrap: darted waist-length bodice with crossover fronts + A-line skirt
 *   with overlapping fronts and ties.
 * - Ball gown: princess bodice + four-panel-type gored skirt gathered into
 *   the waist, lined and underlined bodice.
 */
import type { Path, PatternPiece, Point, SeamType } from '../../types';
import type { DraftContext } from '../context';
import { buildPiece, type EdgeDraft, type PieceDraft } from '../piece';
import { bodiceFrame, blockHalves, princessPanels, type BodiceFrame, type BodiceHalf, type LowerInput } from '../blocks/bodice';
import { draftSkirtBlock, flareToHem } from '../blocks/skirt';
import { draftSleeve, type ArmholeSegment } from '../blocks/sleeve';
import { edgeFacing, pocketBag, stripPiece, tiePiece, type StripSegment } from '../parts';
import { STAGE, ZIP_END_ALLOWANCE_CM } from '../seams';
import { buildSilhouette, type Knot } from '../silhouette';
import { arc, cubicBezier, dedupe, lerp, pathLength, rotatePath, sub, normalize, add, scale } from '../../geometry';
import { ballGownGatherRatio, ballGownWaistTreatment, isFineShell, KNIT_BLOCK_STRETCH_PCT, SHORT_SLEEVE_UNDERSEAM_MIN, strideHemNeeded } from '../../fit/plan';
import { headCircumference } from '../../measurements';
import {
  addDartSeams,
  addHem,
  centreBackEdges,
  curvedHemAllowance,
  dartIntakeOn,
  edgeLen,
  hasEdge,
  makeG,
  pieceById,
  pocketSplit,
  zipLength,
  zipFor,
  zipPhrase,
  fitFolds,
  type DraftResult,
  type G,
} from './common';

const POCKET_OPENING = 16;
/** Gown structure notions (named once so the drafting notes and the bill of materials agree). */
export const GOWN_WAIST_STAY = '2.5 cm petersham ribbon';
export const GOWN_BONING = '1 cm spiral-steel or polyester (rigilene-type) boning';
export const GOWN_HORSEHAIR = '5 cm horsehair braid';
/** Tape that stabilises the bias wrap edge (wovens: stay tape; knits: clear elastic). */
export const WRAP_STAY_TAPE = '6 mm stay tape (clear elastic on knits)';
const WRAP_STAY_SHORTEN_CM = 1.5;
/** Gown side seams get a wide allowance so they can be let out at the fitting. */
const GOWN_SIDE_SA = 2.5;

// ---------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------

interface Ctx {
  g: G;
  bustF: number;
  waistF: number;
  hipF: number;
  hemF: number;
  belowWaist: number; // waist to hem at the side
  sleeveless: boolean;
  lined: boolean;
  pullOn: boolean;
  /** Stretch knit drafted on the dartless knit block. */
  knitBlock: boolean;
  /** Neckline finished with a binding instead of facings (knits; fine pull-on silks). */
  boundNeck: boolean;
  type: DraftContext['garment']['id'];
}

function makeCtx(ctx: DraftContext): Ctx {
  const g = makeG(ctx);
  const fit = g.fit;
  return {
    g,
    bustF: fit.finished.bust ?? g.r.bustCm + 8,
    waistF: fit.finished.waist ?? g.r.waistCm + 6,
    // Tops that end above the hip have no planned finished hip; their side seams
    // still head for the hip at the planned hip ease.
    hipF: fit.finished.hip ?? g.r.hipCm + fit.ease.hip,
    hemF: fit.finished.hem ?? (fit.finished.hip ?? g.r.hipCm + fit.ease.hip),
    belowWaist: g.L.waist - fit.hemHeightFromFloorCm,
    sleeveless: fit.options.sleeve === 'none',
    lined: fit.options.lining && !g.knit,
    pullOn: g.closure === 'none',
    knitBlock: g.knit && g.material.stretchPct >= KNIT_BLOCK_STRETCH_PCT,
    boundNeck: !(fit.options.lining && !g.knit) && (g.knit || isFineShell(ctx.garment, ctx.material)),
    type: ctx.garment.id,
  };
}

function frameFor(c: Ctx, lower: Omit<LowerInput, 'hipF' | 'highHipF' | 'hipDepth' | 'highHipDepth'> | undefined, waistDarts: boolean): BodiceFrame {
  const { g } = c;
  const r = g.r;
  const highHipF = r.highHipCm + (g.fit.ease.waist + g.fit.ease.hip) / 2;
  return bodiceFrame({
    r,
    bustF: c.bustF,
    waistF: c.waistF,
    fit: g.fit.fit,
    knit: g.knit,
    sleeveless: c.sleeveless,
    neckline: g.fit.options.neckline,
    // A woven bias binding is cut shorter than the edge (BIAS_BINDING_SHORTEN),
    // which draws a bound neck in by that much: draft the neck larger to suit.
    minNeckOpening: c.pullOn ? (headCircumference(r.heightCm) + (g.knit ? 0 : 4)) / (c.boundNeck && !g.knit ? 1 - BIAS_BINDING_SHORTEN : 1) : undefined,
    waistDarts,
    knitBlock: c.knitBlock,
    lower: lower
      ? {
          hipF: c.hipF,
          highHipF: Math.max(highHipF, c.waistF),
          hipDepth: r.waistToHipCm,
          highHipDepth: Math.min(10, r.waistToHipCm / 2),
          ...lower,
        }
      : undefined,
  });
}

function shoulderDir(f: BodiceFrame, front: boolean): Point {
  const t = front ? f.thetaF : f.thetaB;
  return { x: Math.cos(t), y: Math.sin(t) };
}

function capEaseFor(c: Ctx): number {
  const m = c.g.material;
  if (c.g.knit) return 0.3;
  const base = { fitted: 3.2, regular: 2.8, relaxed: 2.2 }[c.g.fit.fit];
  return Math.max(2, Math.min(4, base - 1.2 * m.stiffness + 0.4));
}

function sleeveHem(c: Ctx, upperArmF: number): number {
  const r = c.g.r;
  const knit = c.g.knit;
  const hand = 0.12 * r.heightCm + 2; // hand circumference around the knuckles, folded
  switch (c.g.fit.options.sleeve) {
    case 'cap':
    case 'short':
      return upperArmF - 2;
    case 'elbow':
      return Math.min(upperArmF - 1, r.elbowCm + (knit ? 4 : 9));
    case 'three-quarter':
      return Math.min(upperArmF - 2, Math.max((r.elbowCm + r.wristCm) / 2 + (knit ? 3 : 8), knit ? 0 : hand));
    default:
      return Math.min(upperArmF - 4, Math.max(r.wristCm + (knit ? 3 : 9), knit ? r.wristCm + 3 : hand));
  }
}

/** Sleeve draft + data for seams. */
function sleevePiece(c: Ctx, f: BodiceFrame, segments: ArmholeSegment[]): { draft: PieceDraft; sections: ReturnType<typeof draftSleeve>['capSections'] } {
  const { g } = c;
  const upperArmF = g.r.upperArmCm + (g.fit.ease.upperArm || 6);
  const elbowFromTop = 0.56 * g.r.armLengthCm;
  const sleeveInput = (length: number) => ({
    segments,
    upperArmF,
    capEase: capEaseFor(c),
    armholeDepth: f.chestY - (f.spF.y + f.spB.y) / 2,
    length,
    hemCirc: sleeveHem(c, upperArmF),
    elbowFromTop: g.fit.options.sleeve === 'long' || g.fit.options.sleeve === 'three-quarter' ? elbowFromTop : undefined,
    // knit block: low, wide cap (the knit stretches over the shoulder)
    maxCapHeightFrac: c.knitBlock ? 0.6 : undefined,
  });
  const planned = g.fit.finished.sleeveLength ?? 0.3 * g.r.armLengthCm;
  let s = draftSleeve(sleeveInput(planned));
  // The plan estimates the cap height; the drafted cap decides. A short sleeve
  // keeps an underarm seam long enough to hang down the arm.
  const under = pathLength(s.underarmFront);
  if (g.fit.options.sleeve === 'short' && under < SHORT_SLEEVE_UNDERSEAM_MIN) s = draftSleeve(sleeveInput(planned + SHORT_SLEEVE_UNDERSEAM_MIN - under));
  const edges: EdgeDraft[] = [
    ...s.capSections.map((x) => ({ id: x.id, kind: 'seam' as const, points: x.points })),
    { id: 'underarm-back', kind: 'seam', points: s.underarmBack },
    { id: 'hem', kind: 'hem', points: s.hem },
    { id: 'underarm-front', kind: 'seam', points: s.underarmFront },
  ];
  return {
    draft: {
      id: 'sleeve',
      role: 'sleeve',
      name: 'Sleeve',
      layer: 'self',
      cutCount: 2,
      cutOnFold: false,
      mirrorPair: true,
      edges,
      notches: s.notches,
      seamAllowanceCm: g.sa,
      hemAllowanceCm: Math.min(g.ha, 2.5),
    },
    sections: s.capSections,
  };
}

function addSleeveSeams(c: Ctx, sections: ReturnType<typeof draftSleeve>['capSections']): void {
  const B = c.g.book;
  B.join('sleeve-underarm', ['sleeve', 'underarm-front'], ['sleeve', 'underarm-back'], STAGE.sleeveSeam, { note: 'Fold the sleeve right sides together and stitch the underarm seam.' });
  for (const s of sections) {
    B.join(`set-${s.id}`, ['sleeve', s.id], [s.segment.pieceId, s.segment.edgeId], STAGE.setSleeve, {
      type: 'set-in-sleeve',
      ease: Math.max(0, s.ease),
      note:
        s.ease > 0.2
          ? `Ease ${s.ease.toFixed(1)} cm of fullness into this section: run two rows of long stitches between the notches and draw them up gently so the cap curves without tucks.`
          : 'Match notches; no easing needed here.',
    });
  }
  addHem(c.g, 'sleeve', 'hem', false, Math.min(c.g.ha, 2.5), STAGE.hems);
}

/** Seam allowance used on both sides of a binding join (the binding encloses it). */
function bindingAllowance(c: Ctx): number {
  return Math.min(c.g.sa, 1);
}

/**
 * Give garment edges that will be bound the binding's own seam allowance, so
 * the raw edges line up when the binding is sewn on. Must run on the drafts,
 * before the pieces are built.
 */
function useBindingAllowance(c: Ctx, drafts: PieceDraft[], refs: ReadonlyArray<{ pieceId: string; edgeId: string }>): void {
  const a = bindingAllowance(c);
  for (const d of drafts) {
    const ids = new Set(refs.filter((r) => r.pieceId === d.id).map((r) => r.edgeId));
    if (ids.size) d.edges = d.edges.map((e) => (ids.has(e.id) ? { ...e, allowance: a } : e));
  }
}

/**
 * How much shorter a woven bias binding is cut than the concave edge it
 * binds (armholes, necklines): stretched on, it pulls the edge in to lie
 * flat against the body instead of rolling and gaping.
 */
export const BIAS_BINDING_SHORTEN = 0.06;
/** Knit bindings are cut 10 % shorter and stretched on. */
const KNIT_BINDING_SHORTEN = 0.1;

function bindingShorten(c: Ctx): number {
  return c.g.knit ? KNIT_BINDING_SHORTEN : BIAS_BINDING_SHORTEN;
}

/** Binding strip with one segment per garment edge. */
function bindingPiece(c: Ctx, id: string, name: string, built: PatternPiece[], parts: Array<{ pieceId: string; edgeId: string; seg: string; label?: string }>, cutCount: number): PieceDraft {
  const knit = c.g.knit;
  const factor = 1 - bindingShorten(c);
  const segments: StripSegment[] = parts.map((p) => ({ edgeId: p.seg, length: edgeLen(built, p.pieceId, p.edgeId) * factor, notchLabel: p.label }));
  return stripPiece({
    id,
    role: 'neck-binding',
    name,
    layer: 'self',
    segments,
    width: 1,
    folded: true,
    grain: knit ? 'crosswise' : 'bias',
    seamAllowanceCm: bindingAllowance(c),
    cutCount,
    notes: [knit ? 'Cut across the grain (stretch runs along the strip)' : 'Bias strip: cut at 45° to the selvedge'],
  });
}

function addBindingSeams(c: Ctx, bindingId: string, parts: Array<{ pieceId: string; edgeId: string; seg: string }>, built: PatternPiece[], stage: number, loop: boolean, what: string): void {
  const B = c.g.book;
  for (const p of parts) {
    const garmentLen = edgeLen(built, p.pieceId, p.edgeId);
    const ease = garmentLen * bindingShorten(c);
    B.join(`${bindingId}-${p.seg}`, [p.pieceId, p.edgeId], [bindingId, p.seg], stage, {
      ease,
      note: `Stretch the binding slightly as you sew (it is ${ease.toFixed(1)} cm shorter than the edge) so the curved edge is drawn in and lies flat against the body instead of rolling outwards.`,
    });
  }
  if (loop) B.join(`${bindingId}-ends`, [bindingId, 'end-start'], [bindingId, 'end-end'], stage - 1, { note: `Join the ${what} binding into a ring before attaching.` });
  else {
    B.single(`${bindingId}-end-start`, [bindingId, 'end-start'], 'plain', stage + 1, 'Fold the binding end in by 1 cm at the opening before wrapping it to the inside.');
    B.single(`${bindingId}-end-end`, [bindingId, 'end-end'], 'plain', stage + 1, 'Fold this end in the same way so both ends finish neatly at the zip.');
  }
  B.single(`${bindingId}-finish`, [bindingId, 'inner'], 'topstitch', stage + 1, `Fold the binding to the inside, enclosing the seam allowance, and topstitch close to its edge${c.g.knit ? ' with a twin needle or narrow zigzag' : ''}.`);
}

/** Neck facing drafts (+ interfacing) for a front and back neck path. */
function neckFacings(c: Ctx, f: BodiceFrame, frontNeck: Path, backNeck: Path, backCentre: 'fold' | 'seam'): PieceDraft[] {
  const w = 6;
  const front = edgeFacing({
    id: 'front-facing',
    role: 'front-facing',
    name: 'Front neck facing',
    layer: 'self',
    path: frontNeck,
    pathEdgeId: 'neck',
    shoulderDir: shoulderDir(f, true),
    width: w,
    close: 'vertical',
    closeEdgeId: 'centre',
    closeKind: 'fold',
    cutCount: 1,
    cutOnFold: true,
    seamAllowanceCm: c.g.sa,
  });
  const back = edgeFacing({
    id: 'back-facing',
    role: 'back-facing',
    name: 'Back neck facing',
    layer: 'self',
    path: backNeck,
    pathEdgeId: 'neck',
    shoulderDir: shoulderDir(f, false),
    width: w,
    close: 'vertical',
    closeEdgeId: 'centre',
    closeKind: backCentre === 'fold' ? 'fold' : 'seam',
    cutCount: backCentre === 'fold' ? 1 : 2,
    cutOnFold: backCentre === 'fold',
    seamAllowanceCm: c.g.sa,
  });
  return [front, back, ...interfacingOf([front, back])];
}

function interfacingOf(drafts: PieceDraft[]): PieceDraft[] {
  return drafts.map((d) => ({ ...d, id: `${d.id}-interfacing`, name: `${d.name} interfacing`, layer: 'interfacing' as const, notes: ['Fuse to the wrong side of the matching piece'] }));
}

function addFacingSeams(c: Ctx, frontPiece: string, backPiece: string, backCentreSeam: boolean): void {
  const B = c.g.book;
  B.join('facing-shoulders', ['front-facing', 'shoulder'], ['back-facing', 'shoulder'], STAGE.facingPrep, { note: 'Join the front and back facings at the shoulders; press open.' });
  B.join('neck-front', ['front-facing', 'neck'], [frontPiece, 'neck'], STAGE.neckline, { finish: 'Trim to 0.6 cm, clip the curve every 1 cm, press towards the facing.' });
  B.join('neck-back', ['back-facing', 'neck'], [backPiece, 'neck'], STAGE.neckline, { finish: 'Trim to 0.6 cm, clip the curve every 1 cm, press towards the facing.' });
  B.single('understitch-neck', ['front-facing', 'neck'], 'understitch', STAGE.understitch, 'Understitch: stitch the facing to the seam allowances 3 mm from the seam so the facing rolls to the inside.');
  if (backCentreSeam) B.single('facing-centre-back', ['back-facing', 'centre'], 'plain', STAGE.understitch + 1, 'Fold the facing ends back over the zip tape and slip-stitch them in place.');
}

/** Lining-to-main seams for neck/armholes plus lining construction seams. */
function lineSeam(c: Ctx, liningId: string, selfId: string, edgeId: string, stage: number, type: SeamType = 'plain', note?: string): void {
  c.g.book.join(`${liningId}-${edgeId}-to-${selfId}`, [liningId, edgeId], [selfId, edgeId], stage, { type, note, finish: 'Trim, clip curves and understitch the lining.' });
}

// ---------------------------------------------------------------------------
// Shell top & shift dress: one-piece block
// ---------------------------------------------------------------------------

export function draftBlockDress(ctx: DraftContext): DraftResult {
  const c = makeCtx(ctx);
  const { g } = c;
  const { r, L, fit } = g;
  const isShell = c.type === 'shell-top';
  const role = isShell ? ({ front: 'front-bodice', back: 'back-bodice' } as const) : ({ front: 'front-dress', back: 'back-dress' } as const);
  const pockets = fit.options.pockets && !isShell;
  const buttons = g.closure === 'buttons';
  const fold = !g.zip && !buttons;
  const ha = isShell ? Math.min(g.ha, 2) : curvedHemAllowance(g, fit.options.flare);

  const buildHalves = (belowWaist: number) => {
    const f = frameFor(c, { belowWaist, hemF: c.hemF }, false);
    return { f, ...blockHalves(f) };
  };
  const main = buildHalves(c.belowWaist);
  const f = main.f;
  const cbLen = pathLength(main.back.center);
  // Opening the zip must give: if the body of the garment already slips over
  // the bust (skimming shells), only the head has to pass the neck, so a short
  // neck zip is enough; otherwise it runs past the waist.
  const passes = Math.min(c.waistF, c.hemF) >= r.bustCm + 2 && (c.hemF >= r.hipCm + 2 || L.hip < fit.hemHeightFromFloorCm);
  const headNeed = Math.max(16, (headCircumference(r.heightCm) + 4 - (r.neckCm + 4)) / 2 + 3);
  const zipNeed = isShell && passes ? headNeed : isShell ? f.backWaistY - f.neckB[0].y + 5 : Math.max(35, f.backWaistY - f.neckB[0].y + 18);
  const zipLen = g.zip ? zipLength(g, zipNeed, cbLen) : 0;

  const halfDrafts = (h: { front: BodiceHalf; back: BodiceHalf }, isLining: boolean): PieceDraft[] => {
    const sfx = isLining ? '-lining' : '';
    const layer = isLining ? ('lining' as const) : ('self' as const);
    const hemA = isLining ? 2 : ha;
    const waistArcBack = sAt(h.back.side, f.backWaistY);
    const usePockets = pockets && !isLining;
    const frontSide: EdgeDraft[] = usePockets
      ? pocketSplit(h.front.side, true, waistArcBack + f.bustDart + 3, POCKET_OPENING)
      : [{ id: 'side', kind: 'seam', points: h.front.side }];
    const backSide: EdgeDraft[] = usePockets ? pocketSplit(h.back.side, true, waistArcBack + 3, POCKET_OPENING) : [{ id: 'side', kind: 'seam', points: h.back.side }];
    let backBottom = h.back.bottom;
    let centre: EdgeDraft[];
    const extraLabels: PieceDraft['extraLabels'] = [];
    if (buttons && !isLining) {
      const ext = 2;
      const band = 5;
      const bot = h.back.center[0];
      const top = h.back.center[h.back.center.length - 1];
      backBottom = dedupe([...backBottom, { x: -(ext + band), y: bot.y }]);
      centre = [
        { id: 'band', kind: 'facing', points: [{ x: -(ext + band), y: bot.y }, { x: -(ext + band), y: top.y }], allowance: 0 },
        { id: 'band-top', kind: 'seam', points: [{ x: -(ext + band), y: top.y }, top] },
      ];
      extraLabels.push({ at: { x: -ext, y: (top.y + bot.y) / 2 }, text: 'fold line', sizePt: 8 });
      const n = Math.max(4, Math.round((bot.y - top.y) / 8));
      for (let i = 0; i < n; i++) {
        const y = top.y + 1.5 + ((bot.y - top.y - 6) * i) / (n - 1);
        extraLabels.push({ at: { x: 0, y }, text: '⊕ button / buttonhole', sizePt: 7 });
      }
    } else {
      centre = centreBackEdges(h.back.center, g, { fold, zipLen, lining: isLining });
    }
    const front: PieceDraft = {
      id: `front${sfx}`,
      role: role.front,
      name: `${isShell ? 'Front' : 'Front dress'}${isLining ? ' lining' : ''}`,
      layer,
      cutCount: 1,
      cutOnFold: true,
      mirrorPair: false,
      edges: [
        { id: 'neck', kind: 'seam', points: h.front.neck },
        { id: 'shoulder', kind: 'seam', points: h.front.shoulder },
        { id: 'armhole', kind: 'seam', points: h.front.armhole },
        ...frontSide,
        { id: 'hem', kind: 'hem', points: h.front.bottom, allowance: hemA },
        { id: 'cf', kind: 'fold', points: h.front.center },
      ],
      darts: h.front.darts,
      notches: [
        { edgeId: 'armhole', at: 0.35 * pathLength(h.front.armhole), fromEnd: true, count: 1 },
        ...(usePockets ? [] : [{ edgeId: 'side', at: waistArcBack + f.bustDart, count: 1 as const, label: 'waist' }]),
      ],
      seamAllowanceCm: g.sa,
      hemAllowanceCm: hemA,
    };
    const back: PieceDraft = {
      id: `back${sfx}`,
      role: role.back,
      name: `${isShell ? 'Back' : 'Back dress'}${isLining ? ' lining' : ''}`,
      layer,
      cutCount: fold ? 1 : 2,
      cutOnFold: fold,
      mirrorPair: !fold,
      edges: [
        { id: 'neck', kind: 'seam', points: h.back.neck },
        { id: 'shoulder', kind: 'seam', points: h.back.shoulder },
        { id: 'armhole', kind: 'seam', points: h.back.armhole },
        ...backSide,
        { id: 'hem', kind: 'hem', points: backBottom, allowance: hemA },
        ...centre,
      ],
      darts: h.back.darts,
      notches: [
        { edgeId: 'armhole', at: 0.35 * pathLength(h.back.armhole), fromEnd: true, count: 2 },
        ...(usePockets ? [] : [{ edgeId: 'side', at: waistArcBack, count: 1 as const, label: 'waist' }]),
      ],
      extraLabels,
      seamAllowanceCm: g.sa,
      hemAllowanceCm: hemA,
    };
    return [front, back];
  };

  const drafts: PieceDraft[] = halfDrafts(main, false);
  let lining: { front: BodiceHalf; back: BodiceHalf } | undefined;
  if (c.lined) {
    lining = buildHalves(c.belowWaist - 2.5);
    drafts.push(...halfDrafts(lining, true));
  } else {
    drafts.push(...neckFacings(c, f, main.front.neck, main.back.neck, fold ? 'fold' : 'seam'));
  }
  if (pockets) {
    const pe = drafts[0].edges.find((e) => e.id === 'side-pocket');
    if (pe) drafts.push(pocketBag({ id: 'pocket-bag', name: 'Pocket bag', layer: c.lined ? 'lining' : 'self', attach: pe.points, interiorRight: false, seamAllowanceCm: g.sa }));
  }
  if (c.sleeveless && !c.lined) useBindingAllowance(c, drafts, [{ pieceId: 'front', edgeId: 'armhole' }, { pieceId: 'back', edgeId: 'armhole' }]);
  if (c.boundNeck) useBindingAllowance(c, drafts, neckBindingParts());
  let built = fitFolds(g, drafts).map(buildPiece);
  let sleeveSections: ReturnType<typeof draftSleeve>['capSections'] = [];
  const more: PieceDraft[] = [];
  if (!c.sleeveless) {
    const sp = sleevePiece(c, f, [
      { capEdgeId: 'cap-front', pieceId: 'front', edgeId: 'armhole', length: edgeLen(built, 'front', 'armhole'), upper: true, side: 'front' },
      { capEdgeId: 'cap-back', pieceId: 'back', edgeId: 'armhole', length: edgeLen(built, 'back', 'armhole'), upper: true, side: 'back' },
    ]);
    more.push(sp.draft);
    sleeveSections = sp.sections;
  } else if (!c.lined) {
    more.push(
      bindingPiece(c, 'armhole-binding', 'Armhole binding', built, [
        { pieceId: 'front', edgeId: 'armhole', seg: 'join-front', label: 'shoulder' },
        { pieceId: 'back', edgeId: 'armhole', seg: 'join-back' },
      ], 2),
    );
  }
  const knitNeck = c.boundNeck;
  if (knitNeck) {
    // A binding instead of facings: knits, and fine silks where a facing and
    // its interfacing would shadow through and add bulk.
    built = built.filter((p) => !p.id.includes('facing'));
    more.push(
      bindingPiece(c, 'neck-binding', 'Neck binding', built, neckBindingParts(), 1),
    );
  }
  const pieces = [...built, ...more.map(buildPiece)];

  // seams
  const B = g.book;
  addDartSeams(g, pieces, STAGE.darts);
  B.join('shoulders', ['front', 'shoulder'], ['back', 'shoulder'], STAGE.shoulders, {
    ease: f.shoulderEase,
    note: f.shoulderEase > 0 ? `The back shoulder is ${f.shoulderEase} cm longer: ease it onto the front so it fits over the shoulder blade.` : undefined,
  });
  addCentreBackSeams(c, pieces, 'back', zipLen);
  addSideSeams(c, pieces, 'front', 'back', f.bustDart, pockets);
  if (!c.lined) {
    if (!knitNeck) addFacingSeams(c, 'front', 'back', !fold);
    else addBindingSeams(c, 'neck-binding', neckBindingParts(), pieces, STAGE.neckline, fold, 'neck');
    if (c.sleeveless) addBindingSeams(c, 'armhole-binding', [{ pieceId: 'front', edgeId: 'armhole', seg: 'join-front' }, { pieceId: 'back', edgeId: 'armhole', seg: 'join-back' }], pieces, STAGE.armholeFinish, true, 'armhole');
  } else {
    addLiningSeams(c, pieces, ['front', 'back'], f.bustDart, f.shoulderEase);
  }
  if (!c.sleeveless) addSleeveSeams(c, sleeveSections);
  if (buttons) {
    B.single('button-band-top', ['back', 'band-top'], 'plain', STAGE.neckline - 1, 'Fold the band right sides together along the fold line and stitch across the top in line with the neckline; trim, turn and press.');
    B.single('button-band', ['back', 'band'], 'topstitch', STAGE.openingFinish, 'Interface the band, fold it to the inside along the fold line, stitch across the top, turn and topstitch 2.5 cm from the edge. Make buttonholes on the right back and sew buttons on the left back at the marks.');
  }
  addHem(g, 'front', 'hem', fit.options.flare > 0.3, ha, STAGE.hems);
  addHem(g, 'back', 'hem', fit.options.flare > 0.3, ha, STAGE.hems);

  const silhouette = bodiceSilhouette(c, f, [
    { h: L.waist, c: c.waistF },
    { h: L.highHip, c: r.highHipCm + (fit.ease.waist + fit.ease.hip) / 2 },
    { h: L.hip, c: c.hipF },
    { h: fit.hemHeightFromFloorCm, c: c.hemF },
  ]);
  return { pieces, seams: B.seams, silhouette };
}

function neckBindingParts(): Array<{ pieceId: string; edgeId: string; seg: string; label?: string }> {
  return [
    { pieceId: 'back', edgeId: 'neck', seg: 'join-back-1', label: 'shoulder' },
    { pieceId: 'front', edgeId: 'neck', seg: 'join-front-1', label: 'CF' },
    { pieceId: 'front', edgeId: 'neck', seg: 'join-front-2', label: 'shoulder' },
    { pieceId: 'back', edgeId: 'neck', seg: 'join-back-2' },
  ];
}

function sAt(p: Path, y: number): number {
  let acc = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if ((a.y - y) * (b.y - y) <= 0 && a.y !== b.y) return acc + d * ((y - a.y) / (b.y - a.y));
    acc += d;
  }
  return acc;
}

function addCentreBackSeams(c: Ctx, pieces: PatternPiece[], backId: string, zipLen: number, extraNote?: string): void {
  const B = c.g.book;
  if (hasEdge(pieces, backId, 'cb-zip')) {
    B.join(`${backId}-cb-zip`, [backId, 'cb-zip'], [backId, 'cb-zip'], STAGE.zip, {
      type: c.g.zipType,
      note: `Use ${zipPhrase(c.g, zipLen)}; the top stop sits 1 cm below the neckline seam line.${extraNote ? ' ' + extraNote : ''}`,
      finish: 'Finish both centre-back edges before inserting the zip.',
    });
  }
  const cb = pieceById(pieces, backId).edges.find((e) => e.id === 'cb');
  if (cb && cb.kind !== 'fold') B.join(`${backId}-cb`, [backId, 'cb'], [backId, 'cb'], STAGE.centreSeam, { note: 'From the bottom of the zip down.' });
  if (hasEdge(pieces, backId, 'vent')) B.single(`${backId}-vent`, [backId, 'vent'], 'topstitch', STAGE.openingFinish, 'Press the vent extensions to the left back and stitch across the top at 45°.', 'Walking vent');
  if (hasEdge(pieces, backId, 'slit')) B.single(`${backId}-slit`, [backId, 'slit'], 'hem-blind', STAGE.openingFinish, 'Press the slit allowances back, mitre the corner at the hem and slip-stitch.', 'Walking slit: lets you stride in the long narrow skirt.');
}

function addSideSeams(c: Ctx, pieces: PatternPiece[], frontId: string, backId: string, bustDart: number, pockets: boolean): void {
  const B = c.g.book;
  const dartNote = bustDart > 0 ? `The front edge includes the ${bustDart.toFixed(1)} cm bust dart; sew the dart first and the edges match.` : undefined;
  if (pockets && hasEdge(pieces, frontId, 'side-pocket')) {
    B.join('side-upper', [frontId, 'side-upper'], [backId, 'side-upper'], STAGE.sideSeams, { ease: dartIntakeOn(pieceById(pieces, frontId), 'side-upper'), note: dartNote });
    B.join('pocket-front-attach', ['pocket-bag', 'attach'], [frontId, 'side-pocket'], STAGE.pocketAttach, { note: 'Stitch a pocket bag to each front side edge between the pocket notches; press outwards.' });
    B.join('pocket-back-attach', ['pocket-bag', 'attach'], [backId, 'side-pocket'], STAGE.pocketAttach, { note: 'Stitch a pocket bag to each back side edge.' });
    B.join('side', [frontId, 'side'], [backId, 'side'], STAGE.sideSeams, { note: 'Below the pocket; pivot around the pocket bag.' });
    B.join('pocket-bag', ['pocket-bag', 'bag'], ['pocket-bag', 'bag'], STAGE.pocketBag, { note: 'Stitch the bags together and finish the edges together.' });
  } else {
    B.join(`${frontId}-${backId}-side`, [frontId, 'side'], [backId, 'side'], STAGE.sideSeams, { ease: dartIntakeOn(pieceById(pieces, frontId), 'side'), note: dartNote });
  }
}

function addLiningSeams(c: Ctx, pieces: PatternPiece[], ids: string[], bustDart: number, shoulderEase: number): void {
  const B = c.g.book;
  const [fId, bId] = ids;
  const fl = `${fId}-lining`;
  const bl = `${bId}-lining`;
  B.join(`${fl}-shoulders`, [fl, 'shoulder'], [bl, 'shoulder'], STAGE.liningSeams, { ease: shoulderEase });
  B.join(`${fl}-side`, [fl, 'side'], [bl, 'side'], STAGE.liningSeams, { ease: dartIntakeOn(pieceById(pieces, fl), 'side'), note: bustDart > 0 ? 'Includes the bust dart intake.' : undefined });
  const cb = pieceById(pieces, bl).edges.find((e) => e.id === 'cb');
  if (cb && cb.kind !== 'fold') B.join(`${bl}-cb`, [bl, 'cb'], [bl, 'cb'], STAGE.liningSeams);
  if (hasEdge(pieces, bl, 'cb-zip')) B.single(`${bl}-cb-zip`, [bl, 'cb-zip'], 'plain', STAGE.liningAttach + 1, 'Turn the lining edges under and slip-stitch them to the zip tape.');
  lineSeam(c, fl, fId, 'neck', STAGE.liningAttach);
  lineSeam(c, bl, bId, 'neck', STAGE.liningAttach);
  if (c.sleeveless) {
    lineSeam(c, fl, fId, 'armhole', STAGE.liningAttach, 'plain', 'Sew the armholes by the "burrito" method: roll the dress inside the lining, stitch, and pull through the shoulder.');
    lineSeam(c, bl, bId, 'armhole', STAGE.liningAttach);
  } else {
    B.single(`${fl}-armhole`, [fl, 'armhole'], 'plain', STAGE.liningAttach + 2, 'Turn the lining armhole edge under and hand-stitch it over the sleeve seam allowance.');
    B.single(`${bl}-armhole`, [bl, 'armhole'], 'plain', STAGE.liningAttach + 2, 'Turn the lining armhole edge under and hand-stitch it over the sleeve seam allowance.');
  }
  addHem(c.g, fl, 'hem', false, 2, STAGE.liningHem, 'The lining hangs 2.5 cm shorter than the dress.');
  addHem(c.g, bl, 'hem', false, 2, STAGE.liningHem);
}

function bodiceSilhouette(c: Ctx, f: BodiceFrame, lowerKnots: Knot[], sleeveOverride?: number): ReturnType<typeof buildSilhouette> {
  const { g } = c;
  const { r, L, fit } = g;
  const topH = g.hps - Math.min(f.neckF[0].y, f.apex.y - 2);
  const knots: Knot[] = [
    { h: g.hps, c: r.neckCm + 4 },
    { h: L.shoulder, c: Math.max(0.92 * r.bustCm + 3, r.neckCm + 14) },
    { h: g.prof.chest, c: c.bustF - 1 },
    { h: L.bust, c: c.bustF },
    { h: L.underbust, c: Math.max(r.underbustCm + 2, c.bustF + (c.waistF - c.bustF) * ((L.bust - L.underbust) / Math.max(1, L.bust - L.waist))) },
    ...lowerKnots,
  ];
  const upperArmF = r.upperArmCm + (fit.ease.upperArm || 6);
  return buildSilhouette({
    r,
    L,
    knit: g.knit,
    topHeight: topH,
    hemHeight: fit.hemHeightFromFloorCm,
    knots,
    neckline: fit.options.neckline,
    sleeve: c.sleeveless
      ? undefined
      : {
          lengthCm: fit.finished.sleeveLength ?? 20,
          topCircumferenceCm: sleeveOverride ?? upperArmF,
          bottomCircumferenceCm: sleeveHem(c, upperArmF),
        },
  });
}

// ---------------------------------------------------------------------------
// Sheath dress & column gown: princess panels to the hem
// ---------------------------------------------------------------------------

export function draftPrincessDress(ctx: DraftContext): DraftResult {
  const c = makeCtx(ctx);
  const { g } = c;
  const { r, L, fit } = g;
  const isColumn = c.type === 'column-gown';
  const fold = !g.zip;
  const ha = isColumn ? Math.min(g.ha, 2) : g.ha;
  const lowerFlat = c.hipF; // hem without flare
  const princessFlare = isColumn ? Math.max(0, (c.hemF - lowerFlat) / 12) : 0;
  const hemForFrame = isColumn ? lowerFlat + 4 * princessFlare : c.hemF;
  const stride = strideHemNeeded(r, L, fit.hemHeightFromFloorCm);
  const slitTop = L.knee + 5;
  const needsSlit = isColumn && c.hemF < stride + 2;
  const slitH = needsSlit ? Math.max(0, slitTop - fit.hemHeightFromFloorCm) : 0;
  const ventH = !isColumn ? Math.min(20, Math.max(12, (c.belowWaist - r.waistToHipCm) * 0.35)) : 0;

  const make = (belowWaist: number) => {
    const f = frameFor(c, { belowWaist, hemF: hemForFrame, princessFlare }, true);
    // a centre-back seam (zip) is shaped 1.2 cm in at the waist for the sway of the back
    return { f, p: princessPanels(f, { cbShapingCm: fold ? 0 : 1.2 }) };
  };
  const main = make(c.belowWaist);
  const f = main.f;
  const cbPath = main.p.centreBack.edges.find((e) => e.id === 'cb')!.points;
  const cbLen = pathLength(cbPath);
  const zipLen = g.zip ? zipLength(g, Math.max(40, f.backWaistY - f.neckB[0].y + 18), cbLen - Math.max(slitH, ventH) - 2) : 0;
  const roles = isColumn ? ({ front: 'front-dress', back: 'back-dress' } as const) : ({ front: 'front-dress', back: 'back-dress' } as const);

  const panelDrafts = (p: ReturnType<typeof princessPanels>, isLining: boolean): PieceDraft[] => {
    const sfx = isLining ? '-lining' : '';
    const layer = isLining ? ('lining' as const) : ('self' as const);
    const hemA = isLining ? 2 : ha;
    const nm = (s: string) => s + (isLining ? ' lining' : '');
    const toEdges = (edges: Array<{ id: string; points: Path }>): EdgeDraft[] =>
      edges.map((e) => ({
        id: e.id,
        kind: e.id === 'hem' ? 'hem' : e.id === 'cf' ? 'fold' : 'seam',
        points: e.points,
        ...(e.id === 'hem' ? { allowance: hemA } : e.id === 'side' && isColumn ? { allowance: GOWN_SIDE_SA } : {}),
      }));
    const cbEdgesRaw = p.centreBack.edges;
    const cbPathL = cbEdgesRaw.find((e) => e.id === 'cb')!.points;
    const centre = centreBackEdges(cbPathL, g, {
      fold,
      zipLen,
      ventHeight: !isLining ? ventH : 0,
      ventExtension: 4,
      slitHeight: isLining ? Math.max(slitH, ventH > 0 ? ventH + 2 : 0) : slitH,
      lining: isLining,
    });
    const cbOther = toEdges(cbEdgesRaw.filter((e) => e.id !== 'cb'));
    if (!isLining && ventH > 0) {
      const hem = cbOther.find((e) => e.id === 'hem')!;
      hem.points = dedupe([...hem.points, { x: -4, y: hem.points[hem.points.length - 1].y }]);
    }
    const waistNotchCF = notchAtY(p.centreFront.edges.find((e) => e.id === 'princess')!.points, f.frontWaistY);
    const waistNotchSF = notchAtY(p.sideFront.edges.find((e) => e.id === 'princess')!.points, f.frontWaistY);
    const waistNotchCB = notchAtY(p.centreBack.edges.find((e) => e.id === 'princess')!.points, f.backWaistY);
    const waistNotchSB = notchAtY(p.sideBack.edges.find((e) => e.id === 'princess')!.points, f.backWaistY);
    return [
      {
        id: `front-centre${sfx}`,
        role: roles.front,
        name: nm('Centre front'),
        layer,
        cutCount: 1,
        cutOnFold: true,
        mirrorPair: false,
        edges: toEdges(p.centreFront.edges),
        notches: [{ edgeId: 'princess', at: waistNotchCF, count: 1, label: 'waist' }],
        seamAllowanceCm: g.sa,
        hemAllowanceCm: hemA,
      },
      {
        id: `front-side${sfx}`,
        role: roles.front,
        name: nm('Side front'),
        layer,
        cutCount: 2,
        cutOnFold: false,
        mirrorPair: true,
        edges: toEdges(p.sideFront.edges),
        notches: [{ edgeId: 'princess', at: waistNotchSF, count: 1, label: 'waist' }],
        seamAllowanceCm: g.sa,
        hemAllowanceCm: hemA,
      },
      {
        id: `back-centre${sfx}`,
        role: roles.back,
        name: nm('Centre back'),
        layer,
        cutCount: fold ? 1 : 2,
        cutOnFold: fold,
        mirrorPair: !fold,
        edges: [...cbOther, ...centre],
        notches: [{ edgeId: 'princess', at: waistNotchCB, count: 2, label: 'waist' }],
        seamAllowanceCm: g.sa,
        hemAllowanceCm: hemA,
      },
      {
        id: `back-side${sfx}`,
        role: roles.back,
        name: nm('Side back'),
        layer,
        cutCount: 2,
        cutOnFold: false,
        mirrorPair: true,
        edges: toEdges(p.sideBack.edges),
        notches: [{ edgeId: 'princess', at: waistNotchSB, count: 2, label: 'waist' }],
        seamAllowanceCm: g.sa,
        hemAllowanceCm: hemA,
      },
    ];
  };
  const drafts = panelDrafts(main.p, false);
  if (c.lined) drafts.push(...panelDrafts(make(c.belowWaist - 2.5).p, true));
  else drafts.push(...neckFacings(c, f, f.neckF, f.neckB, fold ? 'fold' : 'seam'));
  if (c.sleeveless && !c.lined) {
    useBindingAllowance(c, drafts, ['front-side', 'front-centre', 'back-centre', 'back-side'].map((pieceId) => ({ pieceId, edgeId: 'armhole' })));
  }
  if (g.knit && !c.lined) useBindingAllowance(c, drafts, [{ pieceId: 'front-centre', edgeId: 'neck' }, { pieceId: 'back-centre', edgeId: 'neck' }]);
  let built = fitFolds(g, drafts).map(buildPiece);
  const more: PieceDraft[] = [];
  let sections: ReturnType<typeof draftSleeve>['capSections'] = [];
  const armParts = [
    { pieceId: 'front-side', edgeId: 'armhole', seg: 'join-front-side', label: 'princess' },
    { pieceId: 'front-centre', edgeId: 'armhole', seg: 'join-front-centre', label: 'shoulder' },
    { pieceId: 'back-centre', edgeId: 'armhole', seg: 'join-back-centre', label: 'princess' },
    { pieceId: 'back-side', edgeId: 'armhole', seg: 'join-back-side' },
  ];
  if (!c.sleeveless) {
    const sp = sleevePiece(c, f, [
      { capEdgeId: 'cap-front-lower', pieceId: 'front-side', edgeId: 'armhole', length: edgeLen(built, 'front-side', 'armhole'), upper: false, side: 'front' },
      { capEdgeId: 'cap-front-upper', pieceId: 'front-centre', edgeId: 'armhole', length: edgeLen(built, 'front-centre', 'armhole'), upper: true, side: 'front' },
      { capEdgeId: 'cap-back-upper', pieceId: 'back-centre', edgeId: 'armhole', length: edgeLen(built, 'back-centre', 'armhole'), upper: true, side: 'back' },
      { capEdgeId: 'cap-back-lower', pieceId: 'back-side', edgeId: 'armhole', length: edgeLen(built, 'back-side', 'armhole'), upper: false, side: 'back' },
    ]);
    more.push(sp.draft);
    sections = sp.sections;
  } else if (!c.lined) {
    more.push(bindingPiece(c, 'armhole-binding', 'Armhole binding', built, armParts, 2));
  }
  const knitNeck = g.knit && !c.lined;
  if (knitNeck) {
    built = built.filter((p) => !p.id.includes('facing'));
    more.push(
      bindingPiece(c, 'neck-binding', 'Neck binding', built, [
        { pieceId: 'back-centre', edgeId: 'neck', seg: 'join-back-1', label: 'shoulder' },
        { pieceId: 'front-centre', edgeId: 'neck', seg: 'join-front-1', label: 'CF' },
        { pieceId: 'front-centre', edgeId: 'neck', seg: 'join-front-2', label: 'shoulder' },
        { pieceId: 'back-centre', edgeId: 'neck', seg: 'join-back-2' },
      ], 1),
    );
  }
  const pieces = [...built, ...more.map(buildPiece)];

  const B = g.book;
  const princessEaseF = Math.abs(edgeLen(pieces, 'front-centre', 'princess') - edgeLen(pieces, 'front-side', 'princess'));
  B.join('princess-front', ['front-centre', 'princess'], ['front-side', 'princess'], STAGE.princess, {
    ease: princessEaseF,
    note: 'Match the waist notches; ease the side front over the bust curve. Clip the centre-front allowance at the bust so it spreads.',
  });
  B.join('princess-back', ['back-centre', 'princess'], ['back-side', 'princess'], STAGE.princess, { note: 'Match the waist notches.' });
  B.join('shoulders', ['front-centre', 'shoulder'], ['back-centre', 'shoulder'], STAGE.shoulders, {
    ease: f.shoulderEase,
    note: f.shoulderEase > 0 ? `Ease the ${f.shoulderEase} cm extra back shoulder length onto the front.` : undefined,
  });
  addCentreBackSeams(c, pieces, 'back-centre', zipLen);
  B.join('side-seams', ['front-side', 'side'], ['back-side', 'side'], STAGE.sideSeams);
  if (!c.lined) {
    if (!knitNeck) addFacingSeams(c, 'front-centre', 'back-centre', !fold);
    else
      addBindingSeams(c, 'neck-binding', [
        { pieceId: 'back-centre', edgeId: 'neck', seg: 'join-back-1' },
        { pieceId: 'front-centre', edgeId: 'neck', seg: 'join-front-1' },
        { pieceId: 'front-centre', edgeId: 'neck', seg: 'join-front-2' },
        { pieceId: 'back-centre', edgeId: 'neck', seg: 'join-back-2' },
      ], pieces, STAGE.neckline, fold, 'neck');
    if (c.sleeveless) addBindingSeams(c, 'armhole-binding', armParts, pieces, STAGE.armholeFinish, true, 'armhole');
  } else {
    const ids = ['front-centre', 'front-side', 'back-centre', 'back-side'];
    const li = (s: string) => `${s}-lining`;
    B.join('lining-princess-front', [li('front-centre'), 'princess'], [li('front-side'), 'princess'], STAGE.liningSeams, {
      ease: Math.abs(edgeLen(pieces, li('front-centre'), 'princess') - edgeLen(pieces, li('front-side'), 'princess')),
    });
    B.join('lining-princess-back', [li('back-centre'), 'princess'], [li('back-side'), 'princess'], STAGE.liningSeams);
    B.join('lining-shoulders', [li('front-centre'), 'shoulder'], [li('back-centre'), 'shoulder'], STAGE.liningSeams, { ease: f.shoulderEase });
    B.join('lining-side', [li('front-side'), 'side'], [li('back-side'), 'side'], STAGE.liningSeams);
    const lcb = pieceById(pieces, li('back-centre')).edges.find((e) => e.id === 'cb');
    if (lcb && lcb.kind !== 'fold') B.join('lining-cb', [li('back-centre'), 'cb'], [li('back-centre'), 'cb'], STAGE.liningSeams);
    if (hasEdge(pieces, li('back-centre'), 'cb-zip')) B.single('lining-cb-zip', [li('back-centre'), 'cb-zip'], 'plain', STAGE.liningAttach + 1, 'Turn the lining edges under and slip-stitch them to the zip tape.');
    if (hasEdge(pieces, li('back-centre'), 'slit')) B.single('lining-slit', [li('back-centre'), 'slit'], 'hem-double-fold', STAGE.liningHem, 'Hem the lining slit edges; the slit sits over the dress vent or slit.');
    lineSeam(c, li('front-centre'), 'front-centre', 'neck', STAGE.liningAttach);
    lineSeam(c, li('back-centre'), 'back-centre', 'neck', STAGE.liningAttach);
    for (const id of ids) {
      if (c.sleeveless) lineSeam(c, li(id), id, 'armhole', STAGE.liningAttach);
      else B.single(`${li(id)}-armhole`, [li(id), 'armhole'], 'plain', STAGE.liningAttach + 2, 'Turn the lining armhole edge under and hand-stitch it over the sleeve seam allowance.');
      addHem(g, li(id), 'hem', false, 2, STAGE.liningHem);
    }
  }
  if (!c.sleeveless) addSleeveSeams(c, sections);
  for (const id of ['front-centre', 'front-side', 'back-centre', 'back-side']) addHem(g, id, 'hem', isColumn, ha, STAGE.hems, isColumn ? 'Hem wearing your evening shoes; the hem should just kiss the floor.' : undefined);

  const silhouette = bodiceSilhouette(c, f, [
    { h: L.waist, c: c.waistF },
    { h: L.highHip, c: r.highHipCm + (fit.ease.waist + fit.ease.hip) / 2 },
    { h: L.hip, c: c.hipF },
    { h: fit.hemHeightFromFloorCm, c: c.hemF },
  ]);
  return { pieces, seams: B.seams, silhouette };
}

function notchAtY(p: Path, y: number): number {
  let best = 0;
  let bd = Infinity;
  let acc = 0;
  for (let i = 0; i < p.length; i++) {
    if (i > 0) acc += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    const d = Math.abs(p[i].y - y);
    if (d < bd) {
      bd = d;
      best = acc;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Wrap dress
// ---------------------------------------------------------------------------

export function draftWrapDress(ctx: DraftContext): DraftResult {
  const c = makeCtx(ctx);
  const { g } = c;
  const { r, L, fit } = g;
  const f = frameFor(c, undefined, true);
  const halves = blockHalves(f);
  const A = f.apex;
  const yW = f.frontWaistY;
  const frontFinished = f.inp.bustF / 4 + f.dx / 2 - f.sideSuppression - f.dartFront;
  const backFinished = f.inp.bustF / 4 - f.dx / 2 - f.sideSuppression - f.dartBack;
  // Crossover at the waist: about a quarter of the waist (>= 18 cm), so the
  // wrap reaches towards the opposite side seam and stays closed when walking
  // or sitting (limited to the front width).
  const O = Math.max(8, Math.min(0.95 * frontFinished, Math.max(18, 0.25 * r.waistCm)));
  const hps = f.hpsF;
  // wrap edge: from (-O, yW) up to the (widened) HPS, slightly convex
  const start = { x: -O, y: yW };
  const dirUp = normalize(sub(hps, start));
  const bulge = { x: dirUp.y, y: -dirUp.x }; // left-hand normal (towards upper-left)
  const lenW = Math.hypot(hps.x - start.x, hps.y - start.y);
  const wrapEdge = cubicBezier(start, add(lerp(start, hps, 0.3), scale(bulge, 0.03 * lenW)), add(lerp(start, hps, 0.72), scale(bulge, 0.025 * lenW)), hps);
  const fBottom = dedupe([...halves.front.bottom, start]);
  const ha = curvedHemAllowance(g, fit.options.flare);

  // skirt
  const skirtLen = c.belowWaist;
  const block = draftSkirtBlock({
    waistFront: frontFinished,
    waistBack: backFinished,
    hipF: c.hipF,
    highHipF: r.highHipCm + (fit.ease.waist + fit.ease.hip) / 2,
    hipDepth: r.waistToHipCm,
    highHipDepth: Math.min(10, r.waistToHipCm / 2),
    length: skirtLen,
    frontDartX: A.x,
    cbDrop: 0,
    sideOnly: c.knitBlock,
  });
  const flared = flareToHem(block.front, block.back, c.hemF);
  const sf = flared.front;
  const sb = flared.back;
  const hemEnd = sf.hem[sf.hem.length - 1];
  // The front edge angles out towards the hem so the overlap grows with the
  // flare and the skirt does not open at the knee.
  const edgeOut = Math.min(6, 0.05 * skirtLen);
  const skirtWaist = dedupe([{ x: -O, y: 0 }, ...sf.waist]);
  const skirtHem = dedupe([...sf.hem, { x: -O - edgeOut, y: hemEnd.y }]);
  const frontEdge: Path = [{ x: -O - edgeOut, y: hemEnd.y }, { x: -O, y: 0 }];

  const drafts: PieceDraft[] = [
    {
      id: 'front-bodice',
      role: 'front-bodice',
      name: 'Front bodice',
      layer: 'self',
      cutCount: 2,
      cutOnFold: false,
      mirrorPair: true,
      edges: [
        { id: 'wrap-edge', kind: 'seam', points: wrapEdge },
        { id: 'shoulder', kind: 'seam', points: [hps, f.spF] },
        { id: 'armhole', kind: 'seam', points: halves.front.armhole },
        { id: 'side', kind: 'seam', points: halves.front.side },
        { id: 'waist', kind: 'seam', points: fBottom },
      ],
      darts: halves.front.darts,
      notches: [{ edgeId: 'waist', at: O, fromEnd: true, count: 1, label: 'CF' }],
      seamAllowanceCm: g.sa,
      hemAllowanceCm: g.ha,
    },
    {
      id: 'back-bodice',
      role: 'back-bodice',
      name: 'Back bodice',
      layer: 'self',
      cutCount: 1,
      cutOnFold: true,
      mirrorPair: false,
      edges: [
        { id: 'neck', kind: 'seam', points: halves.back.neck },
        { id: 'shoulder', kind: 'seam', points: halves.back.shoulder },
        { id: 'armhole', kind: 'seam', points: halves.back.armhole },
        { id: 'side', kind: 'seam', points: halves.back.side },
        { id: 'waist', kind: 'seam', points: halves.back.bottom },
        { id: 'cb', kind: 'fold', points: halves.back.center },
      ],
      darts: halves.back.darts,
      seamAllowanceCm: g.sa,
      hemAllowanceCm: g.ha,
    },
    {
      id: 'front-skirt',
      role: 'front-skirt',
      name: 'Front skirt',
      layer: 'self',
      cutCount: 2,
      cutOnFold: false,
      mirrorPair: true,
      edges: [
        { id: 'waist', kind: 'seam', points: skirtWaist },
        { id: 'side', kind: 'seam', points: sf.side },
        { id: 'hem', kind: 'hem', points: skirtHem, allowance: ha },
        { id: 'front-edge', kind: 'hem', points: frontEdge, allowance: 2.5 },
      ],
      darts: sf.darts,
      notches: [{ edgeId: 'waist', at: O, count: 1, label: 'CF' }],
      seamAllowanceCm: g.sa,
      hemAllowanceCm: ha,
    },
    {
      id: 'back-skirt',
      role: 'back-skirt',
      name: 'Back skirt',
      layer: 'self',
      cutCount: 1,
      cutOnFold: true,
      mirrorPair: false,
      edges: [
        { id: 'waist', kind: 'seam', points: sb.waist },
        { id: 'side', kind: 'seam', points: sb.side },
        { id: 'hem', kind: 'hem', points: sb.hem, allowance: ha },
        { id: 'cb', kind: 'fold', points: sb.center },
      ],
      darts: sb.darts,
      seamAllowanceCm: g.sa,
      hemAllowanceCm: ha,
    },
    tiePiece({ id: 'wrap-tie', name: 'Waist tie', length: Math.round(0.5 * r.waistCm + 55), width: 3.5, cutCount: 2, seamAllowanceCm: g.sa }),
  ];
  const facingW = 5;
  const frontFacing = edgeFacing({
    id: 'front-facing',
    role: 'front-facing',
    name: 'Front edge facing',
    layer: 'self',
    path: wrapEdge,
    pathEdgeId: 'wrap-edge',
    shoulderDir: shoulderDir(f, true),
    width: facingW,
    close: 'horizontal',
    closeEdgeId: 'waist',
    closeKind: 'seam',
    cutCount: 2,
    cutOnFold: false,
    seamAllowanceCm: g.sa,
  });
  const backFacing = edgeFacing({
    id: 'back-facing',
    role: 'back-facing',
    name: 'Back neck facing',
    layer: 'self',
    path: halves.back.neck,
    pathEdgeId: 'neck',
    shoulderDir: shoulderDir(f, false),
    width: facingW,
    close: 'vertical',
    closeEdgeId: 'centre',
    closeKind: 'fold',
    cutCount: 1,
    cutOnFold: true,
    seamAllowanceCm: g.sa,
  });
  drafts.push(frontFacing, backFacing, ...interfacingOf([frontFacing, backFacing]));
  if (c.sleeveless) useBindingAllowance(c, drafts, [{ pieceId: 'front-bodice', edgeId: 'armhole' }, { pieceId: 'back-bodice', edgeId: 'armhole' }]);
  const built = fitFolds(g, drafts).map(buildPiece);
  const more: PieceDraft[] = [];
  let sections: ReturnType<typeof draftSleeve>['capSections'] = [];
  if (!c.sleeveless) {
    const sp = sleevePiece(c, f, [
      { capEdgeId: 'cap-front', pieceId: 'front-bodice', edgeId: 'armhole', length: edgeLen(built, 'front-bodice', 'armhole'), upper: true, side: 'front' },
      { capEdgeId: 'cap-back', pieceId: 'back-bodice', edgeId: 'armhole', length: edgeLen(built, 'back-bodice', 'armhole'), upper: true, side: 'back' },
    ]);
    more.push(sp.draft);
    sections = sp.sections;
  } else {
    more.push(
      bindingPiece(c, 'armhole-binding', 'Armhole binding', built, [
        { pieceId: 'front-bodice', edgeId: 'armhole', seg: 'join-front', label: 'shoulder' },
        { pieceId: 'back-bodice', edgeId: 'armhole', seg: 'join-back' },
      ], 2),
    );
  }
  const pieces = [...built, ...more.map(buildPiece)];

  const B = g.book;
  addDartSeams(g, pieces, STAGE.darts);
  B.join('shoulders', ['front-bodice', 'shoulder'], ['back-bodice', 'shoulder'], STAGE.shoulders, { ease: f.shoulderEase, note: f.shoulderEase > 0 ? `Ease the extra ${f.shoulderEase} cm of back shoulder onto the front.` : undefined });
  B.join('bodice-side', ['front-bodice', 'side'], ['back-bodice', 'side'], STAGE.sideSeams, {
    ease: dartIntakeOn(pieceById(pieces, 'front-bodice'), 'side'),
    note: 'Includes the bust dart intake. On the LEFT side seam leave a 2.5 cm gap just above the waist for the inner tie to pass through.',
  });
  B.join('skirt-side', ['front-skirt', 'side'], ['back-skirt', 'side'], STAGE.sideSeams);
  B.join('waist-front', ['front-bodice', 'waist'], ['front-skirt', 'waist'], STAGE.waistSeam, {
    ease: Math.abs(dartIntakeOn(pieceById(pieces, 'front-bodice'), 'waist') - dartIntakeOn(pieceById(pieces, 'front-skirt'), 'waist')),
    note: 'Match side seams, darts and the CF notch; the difference is dart intake.',
  });
  B.join('waist-back', ['back-bodice', 'waist'], ['back-skirt', 'waist'], STAGE.waistSeam, {
    ease: Math.abs(dartIntakeOn(pieceById(pieces, 'back-bodice'), 'waist') - dartIntakeOn(pieceById(pieces, 'back-skirt'), 'waist')),
    note: 'Match side seams and darts.',
  });
  B.join('facing-shoulders', ['front-facing', 'shoulder'], ['back-facing', 'shoulder'], STAGE.facingPrep);
  B.join('wrap-edge-facing', ['front-facing', 'wrap-edge'], ['front-bodice', 'wrap-edge'], STAGE.neckline, { finish: 'Trim to 0.6 cm, press towards the facing.' });
  B.join('neck-back-facing', ['back-facing', 'neck'], ['back-bodice', 'neck'], STAGE.neckline, { finish: 'Trim, clip and press towards the facing.' });
  B.single(
    'wrap-edge-stay',
    ['front-bodice', 'wrap-edge'],
    'plain',
    STAGE.staystitch,
    `${WRAP_STAY_TAPE}: lay it on the wrong side along the wrap edge, just inside the seam line, cut ${WRAP_STAY_SHORTEN_CM} cm shorter than the edge. Pin the ends, ease the edge onto the tape and stitch through its centre. The tape stops the bias-cut crossover from stretching and gaping.`,
    'The wrap edge is cut partly on the bias: stay it before any other sewing.',
  );
  B.single('understitch-wrap', ['front-facing', 'wrap-edge'], 'understitch', STAGE.understitch, 'Understitch the facing so it rolls inside; this stops the crossover edge gaping.');
  B.single('facing-waist', ['front-facing', 'waist'], 'plain', STAGE.waistSeam - 1, 'Baste the facing lower edge to the bodice waist so it is caught in the waist seam.');
  B.join('tie-long', ['wrap-tie', 'long'], ['wrap-tie', 'long'], STAGE.ties, { note: 'Fold each tie lengthwise right sides together and stitch the long edge.' });
  B.single('tie-end', ['wrap-tie', 'end'], 'plain', STAGE.ties, 'Stitch the angled end, trim the point, turn right side out and press.');
  B.single('tie-attach', ['wrap-tie', 'attach'], 'plain', STAGE.waistSeam + 1, 'Baste the open end of one tie to each front skirt at the waist, at the front edge, so it is caught when the front edge is hemmed and the waist is sewn.');
  addHem(g, 'front-skirt', 'front-edge', false, 2.5, STAGE.hems - 1, 'Hem the front edges of the skirt before the bottom hem.');
  addHem(g, 'front-skirt', 'hem', fit.options.flare > 0.3, ha, STAGE.hems);
  addHem(g, 'back-skirt', 'hem', fit.options.flare > 0.3, ha, STAGE.hems);
  if (!c.sleeveless) addSleeveSeams(c, sections);
  else addBindingSeams(c, 'armhole-binding', [{ pieceId: 'front-bodice', edgeId: 'armhole', seg: 'join-front' }, { pieceId: 'back-bodice', edgeId: 'armhole', seg: 'join-back' }], pieces, STAGE.armholeFinish, true, 'armhole');

  const silhouette = bodiceSilhouette(c, f, [
    { h: L.waist, c: c.waistF },
    { h: L.highHip, c: r.highHipCm + (fit.ease.waist + fit.ease.hip) / 2 },
    { h: L.hip, c: c.hipF },
    { h: fit.hemHeightFromFloorCm, c: c.hemF },
  ]);
  return { pieces, seams: B.seams, silhouette };
}

// ---------------------------------------------------------------------------
// Ball gown
// ---------------------------------------------------------------------------

function sectorPanel(top: number, bottom: number, slant: number, half: boolean): { waist: Path; right: Path; hem: Path; left: Path } {
  // annulus sector with radial sides of length `slant`, inner arc `top`, outer arc `bottom`
  if (bottom - top < 0.5) {
    const w0 = half ? top / 2 : top;
    const w1 = half ? bottom / 2 : bottom;
    const x0 = half ? 0 : -w0 / 2;
    const waist: Path = [{ x: x0, y: 0 }, { x: x0 + w0, y: 0 }];
    const right: Path = [{ x: x0 + w0, y: 0 }, { x: (half ? 0 : -w1 / 2) + w1, y: slant }];
    const hem: Path = [right[1], { x: half ? 0 : -w1 / 2, y: slant }];
    const left: Path = [hem[1], waist[0]];
    return { waist, right, hem, left };
  }
  const Ri = (slant * top) / (bottom - top);
  const beta = (bottom - top) / slant; // full panel angle
  const a1 = Math.PI / 2 + (half ? 0 : beta / 2);
  const a0 = Math.PI / 2 - beta / 2;
  const c = { x: 0, y: -Ri };
  const waist = arc(c, Ri, a1, a0);
  const hem = arc(c, Ri + slant, a0, a1);
  return { waist, right: [waist[waist.length - 1], hem[0]], hem, left: [hem[hem.length - 1], waist[0]] };
}

export function draftBallGown(ctx: DraftContext): DraftResult {
  const c = makeCtx(ctx);
  const { g } = c;
  const { L, fit } = g;
  if (g.closure === 'buttons') {
    // couture finish: covered buttons and loops over a concealed zip
    g.zip = true;
    g.zipType = 'zip-invisible';
  }
  const f = frameFor(c, undefined, true);
  const p = princessPanels(f);
  const pockets = fit.options.pockets;
  const ha = curvedHemAllowance(g, 0.9);
  const cbLenBodice = pathLength(p.centreBack.edges.find((e) => e.id === 'cb')!.points);
  // One zip from the neckline through the waist seam into the skirt: the
  // drafted opening (bodice + skirt part) matches the standard zip exactly.
  const zipTotal = zipFor(g, cbLenBodice + 16);
  const skirtZip = Math.round((zipTotal - ZIP_END_ALLOWANCE_CM[g.zipType] - cbLenBodice) * 10) / 10;

  const bodiceDrafts = (layer: 'self' | 'lining' | 'interfacing'): PieceDraft[] => {
    const sfx = layer === 'self' ? '' : `-${layer}`;
    const label = layer === 'self' ? '' : layer === 'lining' ? ' lining' : ' underlining (cotton coutil or batiste)';
    const kindOf = (id: string): EdgeDraft['kind'] => (id === 'cf' ? 'fold' : 'seam');
    const mk = (id: string, name: string, role: 'front-bodice' | 'back-bodice', edges: Array<{ id: string; points: Path }>, cut: number, fold: boolean): PieceDraft => ({
      id: id + sfx,
      role,
      name: name + label,
      layer,
      cutCount: cut,
      cutOnFold: fold,
      mirrorPair: !fold,
      edges: edges.map((e) =>
        e.id === 'cb'
          ? { id: 'cb-zip', kind: layer === 'lining' ? ('opening' as const) : ('seam' as const), points: e.points }
          : { id: e.id, kind: kindOf(e.id), points: e.points, ...(e.id === 'side' ? { allowance: GOWN_SIDE_SA } : {}) },
      ),
      seamAllowanceCm: g.sa,
      hemAllowanceCm: g.sa,
      notes: layer === 'interfacing' ? ['Sew-in underlining (cotton coutil or batiste): baste to the wrong side of the matching panel; carries the boning channels'] : undefined,
    });
    return [
      mk('front-centre', 'Centre front bodice', 'front-bodice', p.centreFront.edges, 1, true),
      mk('front-side', 'Side front bodice', 'front-bodice', p.sideFront.edges, 2, false),
      mk('back-centre', 'Centre back bodice', 'back-bodice', p.centreBack.edges, 2, false),
      mk('back-side', 'Side back bodice', 'back-bodice', p.sideBack.edges, 2, false),
    ];
  };
  const drafts: PieceDraft[] = [...bodiceDrafts('self'), ...bodiceDrafts('lining'), ...bodiceDrafts('interfacing')];
  const builtBodice = fitFolds(g, drafts).map(buildPiece);

  // skirt panels gathered into each bodice panel's waist
  const gather = ballGownGatherRatio(fit.options.flare);
  const skirtLen = (L.waist - fit.hemHeightFromFloorCm) * (1 + 0.04 * fit.options.flare);
  const bw = (id: string) => edgeLen(builtBodice, id, 'waist');
  const tops = { cf: bw('front-centre') * gather * 2, sf: bw('front-side') * gather, sb: bw('back-side') * gather, cb: bw('back-centre') * gather };
  let bottomFull = (fit.finished.hem ?? 400) / 7;
  const maxW = g.material.widthCm - 2 * g.sa - 4;
  bottomFull = Math.min(bottomFull, maxW);
  const panelSpecs: Array<{ key: 'cf' | 'sf' | 'sb' | 'cb'; id: string; name: string; left: string; right: string; half: boolean }> = [
    { key: 'cf', id: 'skirt-cf', name: 'Skirt centre front panel', left: 'cf', right: 'seam-sf', half: true },
    { key: 'sf', id: 'skirt-sf', name: 'Skirt side front panel', left: 'seam-cf', right: 'side', half: false },
    { key: 'sb', id: 'skirt-sb', name: 'Skirt side back panel', left: 'side', right: 'seam-cb', half: false },
    { key: 'cb', id: 'skirt-cb', name: 'Skirt centre back panel', left: 'seam-sb', right: 'cb', half: false },
  ];
  const pleated = ballGownWaistTreatment(g.material) === 'pleats';
  const pleatPlan = new Map<string, { count: number; intake: number }>();
  const skirtDrafts: PieceDraft[] = panelSpecs.map((s) => {
    const top = Math.min(tops[s.key], bottomFull);
    let geo = sectorPanel(top, Math.max(bottomFull, top), skirtLen, s.half);
    if (s.key === 'cb') {
      // Grain parallel to the centre back: the zip goes into a straight-grain
      // edge, never a bias one. Rotate the gore so its CB edge is vertical.
      const [a, b] = geo.right;
      const ang = Math.atan2(1, 0) - Math.atan2(b.y - a.y, b.x - a.x);
      const rot = (q: Path) => rotatePath(q, ang, a);
      geo = { waist: rot(geo.waist), right: rot(geo.right), hem: rot(geo.hem), left: rot(geo.left) };
    }
    const bodiceWaist = s.key === 'cf' ? bw('front-centre') : s.key === 'sf' ? bw('front-side') : s.key === 'sb' ? bw('back-side') : bw('back-centre');
    const extra = pathLength(geo.waist) - bodiceWaist;
    const notches: PieceDraft['notches'] = [];
    if (pleated && extra > 2) {
      // Box pleats: each takes `intake` out of the waist; its two fold lines
      // are notched and meet at the centre notch.
      const count = Math.max(1, Math.round(extra / 8));
      const intake = extra / count;
      const wl = pathLength(geo.waist);
      const pitch = wl / count;
      for (let i = 0; i < count; i++) {
        const mid = pitch * (i + 0.5);
        notches.push({ edgeId: 'waist', at: mid - intake / 2, count: 1, label: 'pleat' });
        notches.push({ edgeId: 'waist', at: mid, count: 2, label: 'pleat centre' });
        notches.push({ edgeId: 'waist', at: mid + intake / 2, count: 1, label: 'pleat' });
      }
      pleatPlan.set(s.id, { count, intake });
    }
    const edges: EdgeDraft[] = [{ id: 'waist', kind: 'seam', points: geo.waist }];
    if (s.right === 'side' && pockets) edges.push(...pocketSplit(geo.right, true, 3, POCKET_OPENING, 'seam', 2.5));
    else if (s.right === 'cb') {
      const cbEdges = centreBackEdges([geo.right[1], geo.right[0]], g, { fold: false, zipLen: skirtZip, lining: false });
      edges.push(...cbEdges.reverse().map((e) => ({ ...e, points: [...e.points].reverse() })));
    } else edges.push({ id: s.right, kind: 'seam', points: geo.right, allowance: s.right === 'side' ? 2.5 : undefined });
    edges.push({ id: 'hem', kind: 'hem', points: geo.hem, allowance: ha });
    if (s.left === 'cf') edges.push({ id: 'cf', kind: 'fold', points: geo.left });
    else if (s.left === 'side' && pockets) edges.push(...pocketSplit(geo.left, false, 3, POCKET_OPENING, 'seam', 2.5));
    else edges.push({ id: s.left, kind: 'seam', points: geo.left, allowance: s.left === 'side' ? 2.5 : undefined });
    return {
      id: s.id,
      role: 'skirt-panel',
      name: s.name,
      layer: 'self',
      cutCount: s.half ? 1 : 2,
      cutOnFold: s.half,
      mirrorPair: !s.half,
      edges,
      notches,
      seamAllowanceCm: g.sa,
      hemAllowanceCm: ha,
    };
  });
  const extra: PieceDraft[] = [...skirtDrafts];
  if (pockets) {
    const pe = skirtDrafts[1].edges.find((e) => e.id === 'side-pocket');
    if (pe) extra.push(pocketBag({ id: 'pocket-bag', name: 'Pocket bag', layer: 'lining', attach: pe.points, interiorRight: false, seamAllowanceCm: g.sa }));
  }
  const builtSkirt = fitFolds(g, extra).map(buildPiece);
  let pieces = [...builtBodice, ...builtSkirt];
  let sections: ReturnType<typeof draftSleeve>['capSections'] = [];
  if (!c.sleeveless) {
    const sp = sleevePiece(c, f, [
      { capEdgeId: 'cap-front-lower', pieceId: 'front-side', edgeId: 'armhole', length: edgeLen(pieces, 'front-side', 'armhole'), upper: false, side: 'front' },
      { capEdgeId: 'cap-front-upper', pieceId: 'front-centre', edgeId: 'armhole', length: edgeLen(pieces, 'front-centre', 'armhole'), upper: true, side: 'front' },
      { capEdgeId: 'cap-back-upper', pieceId: 'back-centre', edgeId: 'armhole', length: edgeLen(pieces, 'back-centre', 'armhole'), upper: true, side: 'back' },
      { capEdgeId: 'cap-back-lower', pieceId: 'back-side', edgeId: 'armhole', length: edgeLen(pieces, 'back-side', 'armhole'), upper: false, side: 'back' },
    ]);
    pieces = [...pieces, buildPiece(sp.draft)];
    sections = sp.sections;
  }

  // seams
  const B = g.book;
  for (const id of ['front-centre', 'front-side', 'back-centre', 'back-side']) {
    B.single(`underline-${id}`, [`${id}-interfacing`, 'waist'], 'plain', STAGE.staystitch, `Lay the underlining on the wrong side of the ${id.replace('-', ' ')} panel and baste them together 1 cm from all edges; treat them as one layer from now on.`);
  }
  const bodiceSeams = (sfx: string, stage: number) => {
    B.join(`princess-front${sfx}`, [`front-centre${sfx}`, 'princess'], [`front-side${sfx}`, 'princess'], stage, {
      ease: Math.abs(edgeLen(pieces, `front-centre${sfx}`, 'princess') - edgeLen(pieces, `front-side${sfx}`, 'princess')),
      note: sfx ? undefined : 'Ease the side front over the bust; clip the centre-front allowance at the curve.',
    });
    B.join(`princess-back${sfx}`, [`back-centre${sfx}`, 'princess'], [`back-side${sfx}`, 'princess'], stage);
    B.join(`shoulders${sfx}`, [`front-centre${sfx}`, 'shoulder'], [`back-centre${sfx}`, 'shoulder'], stage + 1, { ease: f.shoulderEase });
    B.join(`side${sfx}`, [`front-side${sfx}`, 'side'], [`back-side${sfx}`, 'side'], stage + 2, { note: sfx ? undefined : 'Gown side seams have 2.5 cm allowances so they can be let out at the fitting.' });
  };
  bodiceSeams('', STAGE.princess);
  bodiceSeams('-lining', STAGE.liningSeams);
  B.join('bodice-cb-zip', ['back-centre', 'cb-zip'], ['back-centre', 'cb-zip'], STAGE.zip + 2, {
    type: g.zipType,
    note: `Use one ${zipTotal} cm ${g.closure === 'lapped-zip' ? 'regular' : 'invisible'} zip running from the neckline through the waist seam ${skirtZip} cm into the skirt.${g.closure === 'buttons' ? ' Sew covered buttons with rouleau loops along the centre back over the zip for a couture finish.' : ''}`,
  });
  B.single('bodice-lining-cb', ['back-centre-lining', 'cb-zip'], 'plain', STAGE.liningAttach + 1, 'Turn the lining edges under and slip-stitch them to the zip tape.');
  lineSeam(c, 'front-centre-lining', 'front-centre', 'neck', STAGE.liningAttach);
  lineSeam(c, 'back-centre-lining', 'back-centre', 'neck', STAGE.liningAttach);
  for (const id of ['front-centre', 'front-side', 'back-centre', 'back-side']) {
    if (c.sleeveless) lineSeam(c, `${id}-lining`, id, 'armhole', STAGE.liningAttach);
    else B.single(`${id}-lining-armhole`, [`${id}-lining`, 'armhole'], 'plain', STAGE.liningAttach + 2, 'Hand-stitch the lining armhole over the sleeve seam allowance.');
    B.single(`${id}-lining-waist`, [`${id}-lining`, 'waist'], 'plain', STAGE.waistbandFinish, 'Turn the lining waist edge under and slip-stitch it over the waist seam allowance.');
  }
  // skirt panels
  B.join('skirt-cf-sf', ['skirt-cf', 'seam-sf'], ['skirt-sf', 'seam-cf'], STAGE.sideSeams);
  if (pockets) {
    B.join('skirt-side-upper', ['skirt-sf', 'side-upper'], ['skirt-sb', 'side-upper'], STAGE.sideSeams);
    B.join('pocket-front-attach', ['pocket-bag', 'attach'], ['skirt-sf', 'side-pocket'], STAGE.pocketAttach, { note: 'Stitch a pocket bag to the side front panel between the notches.' });
    B.join('pocket-back-attach', ['pocket-bag', 'attach'], ['skirt-sb', 'side-pocket'], STAGE.pocketAttach, { note: 'Stitch a pocket bag to the side back panel.' });
    B.join('skirt-side', ['skirt-sf', 'side'], ['skirt-sb', 'side'], STAGE.sideSeams, { note: 'Below the pocket.' });
    B.join('pocket-bag', ['pocket-bag', 'bag'], ['pocket-bag', 'bag'], STAGE.pocketBag);
  } else {
    B.join('skirt-side', ['skirt-sf', 'side'], ['skirt-sb', 'side'], STAGE.sideSeams);
  }
  B.join('skirt-sb-cb', ['skirt-sb', 'seam-cb'], ['skirt-cb', 'seam-sb'], STAGE.sideSeams);
  B.join('skirt-cb', ['skirt-cb', 'cb'], ['skirt-cb', 'cb'], STAGE.centreSeam, { note: 'From the bottom of the zip to the hem.' });
  B.join('skirt-cb-zip', ['skirt-cb', 'cb-zip'], ['skirt-cb', 'cb-zip'], STAGE.zip + 2, { type: g.zipType, note: 'The lower part of the same zip continues into the skirt.' });
  const pairs: Array<[string, string]> = [
    ['front-centre', 'skirt-cf'],
    ['front-side', 'skirt-sf'],
    ['back-side', 'skirt-sb'],
    ['back-centre', 'skirt-cb'],
  ];
  for (const [bod, sk] of pairs) {
    const ease = edgeLen(pieces, sk, 'waist') - edgeLen(pieces, bod, 'waist');
    const pl = pleatPlan.get(sk);
    const bodLen = edgeLen(pieces, bod, 'waist').toFixed(1);
    B.join(`waist-${sk}`, [bod, 'waist'], [sk, 'waist'], STAGE.waistSeam, {
      type: pl || pleated || ease <= 1 ? 'plain' : 'gathered',
      ease: Math.max(0, ease),
      note: pl
        ? `Fold ${pl.count} box pleat${pl.count > 1 ? 's' : ''} (each takes in ${pl.intake.toFixed(1)} cm): bring the two single "pleat" notches of each pleat to its double "pleat centre" notch, pin and baste across the top, so the skirt edge measures ${bodLen} cm. Structured silk holds a crisp pleat far better than gathers.`
        : pleated && ease > 0.3
          ? `Ease the ${ease.toFixed(1)} cm of extra skirt length into this ${bodLen} cm section evenly between the seams (no pleat needed here).`
          : ease > 1
          ? `Gather ${ease.toFixed(0)} cm of extra skirt fullness into this ${bodLen} cm section: two rows of long stitches, pull up evenly, then stitch.`
          : undefined,
    });
  }
  // Structure: a petersham waist stay carries the weight of the skirt, boning
  // in the underlining keeps the bodice smooth and up.
  B.single(
    'waist-stay',
    ['front-centre', 'waist'],
    'plain',
    STAGE.waistbandFinish + 1,
    `Waist stay: cut ${GOWN_WAIST_STAY} to your waist plus 5 cm. Hook-and-eye one end, turn the other under, and hand-tack the stay to the waist seam allowance at the centre front, every princess seam and the side seams, ending 1 cm each side of the zip. Fasten it before closing the zip: it takes the skirt's weight off the zip and the bodice.`,
    'The waist stay keeps the waist seam on your waist even under the weight of the skirt.',
  );
  for (const [pid, edge] of [['front-centre-interfacing', 'princess'], ['back-centre-interfacing', 'princess'], ['front-side-interfacing', 'side']] as const) {
    B.single(
      `boning-${pid.replace('-interfacing', '')}-${edge}`,
      [pid, edge],
      'topstitch',
      STAGE.princess - 1,
      `Boning channel: after the ${edge === 'side' ? 'side' : 'princess'} seams are sewn, press the seam allowances open, lay a ${GOWN_BONING} channel over them on the underlining side and stitch along both edges. Slide in boning cut 2 cm shorter than the channel (from 1.5 cm below the armhole seam line to 1.5 cm above the waist seam line), with the cut ends filed smooth or capped.`,
      `Boning sits on the ${edge} seam of every panel pair, left and right.`,
    );
  }
  if (!c.sleeveless) addSleeveSeams(c, sections);
  for (const s of panelSpecs)
    addHem(
      g,
      s.id,
      'hem',
      true,
      ha,
      STAGE.hems,
      `Wear the gown over its petticoat and in your ${fit.shoeHeelCm ?? 7} cm heels, then level the hem. Sew ${GOWN_HORSEHAIR} to the hem allowance before turning it up: it makes the hem stand away from the body and swing.`,
    );

  // silhouette: fitted bodice, domed skirt
  const hemC = 2 * (bottomFull / 2) + 6 * bottomFull;
  const len = L.waist - fit.hemHeightFromFloorCm;
  const domes: Knot[] = [];
  for (let d = 2; d <= len; d += 4) {
    const t = d / len;
    domes.push({ h: L.waist - d, c: c.waistF + (hemC - c.waistF) * (1 - (1 - t) * (1 - t)) });
  }
  const silhouette = bodiceSilhouette(c, f, [{ h: L.waist, c: c.waistF }, ...domes, { h: fit.hemHeightFromFloorCm, c: hemC }]);
  return { pieces, seams: B.seams, silhouette };
}

