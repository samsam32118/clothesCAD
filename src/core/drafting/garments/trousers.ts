/**
 * Wide-leg and tapered trousers from the trouser block: front and back legs
 * (mirror pairs), a continuous waistband with an underlap, optional in-seam
 * pockets.
 *
 * Closures
 * - 'lapped-zip' is a classic FLY FRONT: a cut-on fly extension on each front
 *   leg (the left one carries the zip under its fold, the right one the zip
 *   tape), a separate folded fly shield behind the zip, and a waistband that
 *   opens at the centre front with an underlap over the shield.
 * - 'invisible-zip' goes in the LEFT side seam (pockets are then left out).
 * - The centre-back seat seam is never interrupted by a zip: it is the seam a
 *   fitter lets out for a fuller seat, so it gets a wide let-out allowance.
 * - 'elastic' / 'none': a pull-on casing.
 */
import type { Path, PatternPiece, Point } from '../../types';
import type { DraftContext } from '../context';
import { buildPiece, type EdgeDraft, type PieceDraft } from '../piece';
import { draftTrousers, type Pleat } from '../blocks/trousers';
import { stripPiece, pocketBag, type StripSegment } from '../parts';
import { STAGE } from '../seams';
import { buildSilhouette } from '../silhouette';
import { add, cubicBezier, dedupe, normalize, pathLength, pointAtLength, scale, splitAtLength, sub } from '../../geometry';
import { addDartSeams, addHem, dartIntakeOn, edgeLen, fitFolds, hasEdge, makeG, pieceById, pocketSplit, zipLength, zipPhrase, type DraftResult } from './common';

const WAISTBAND_W = 3.5;
/** Width of the cut-on fly extension and of the finished fly shield (cm). */
const FLY_W = 4;
/** The fly stitching curves back to the centre front this far below the zip stop (cm). */
const FLY_TAIL = 2;
/** Waistband underlap beyond the opening, carrying the hook and bar (cm). */
const UNDERLAP = 3.5;
/** Seam allowance on the centre-back seat seam, so it can be let out (cm). */
export const SEAT_LET_OUT_ALLOWANCE = 2.5;

/** Hip minus waist from which a seat counts as prominent (cm). */
const PROMINENT_SEAT_DROP = 30;

/** Total pleat intake along a waist edge. */
function pleatIntake(pleats: Pleat[]): number {
  return pleats.reduce((a, p) => a + p.intakeCm, 0);
}

/**
 * Fly-front outline replacing the top of the front crotch: from the CF waist
 * out across the extension ('fly-top'), down parallel to the CF for the zip
 * length ('fly-facing'), then curving back to the CF line ('fly-curve').
 * Returns the edges and the remaining (lower) front crotch.
 */
function flyFront(crotch: Path, zipLen: number, sa: number): { edges: EdgeDraft[]; lower: Path; cfLine: [Point, Point] } {
  const top = crotch[0];
  const [, lower] = splitAtLength(crotch, zipLen + FLY_TAIL);
  const zipStop = pointAtLength(crotch, zipLen).point;
  const u = normalize(sub(zipStop, top));
  const n = { x: u.y, y: -u.x }; // away from the leg, beyond the centre front
  const outTop = add(top, scale(n, FLY_W));
  const outBottom = add(zipStop, scale(n, FLY_W));
  const tail = lower[0];
  const curve = cubicBezier(outBottom, add(outBottom, scale(u, 0.6 * FLY_TAIL + 1)), add(tail, scale(n, 0.55 * FLY_W)), tail);
  return {
    edges: [
      { id: 'fly-top', kind: 'facing', points: [top, outTop], allowance: sa },
      { id: 'fly-facing', kind: 'facing', points: [outTop, outBottom], allowance: sa },
      { id: 'fly-curve', kind: 'facing', points: dedupe(curve), allowance: sa },
    ],
    lower,
    cfLine: [top, zipStop],
  };
}

export function draftTrouserGarment(ctx: DraftContext): DraftResult {
  const g = makeG(ctx);
  const { r, L, fit } = g;
  const opts = fit.options;
  const elastic = g.closure === 'elastic' || g.closure === 'none';
  const fly = g.closure === 'lapped-zip';
  const sideZip = g.closure === 'invisible-zip';
  const wide = ctx.garment.id === 'wide-leg-trousers';
  const waistF = fit.finished.waist ?? r.waistCm + 2;
  const hipF = fit.finished.hip ?? r.hipCm + 7;
  const hemLeg = fit.finished.hem ?? 40;
  const thighF = r.thighCm + fit.ease.thigh;
  const riseEase = { fitted: 1, regular: 1.5, relaxed: 2.5 }[fit.fit];
  const rise = r.crotchDepthCm + riseEase;
  const inseam = Math.max(10, L.waist - rise - fit.hemHeightFromFloorCm);
  const kneeEase = { fitted: 8, regular: 11, relaxed: 15 }[fit.fit];
  const kneeLeg = wide ? Math.max(hemLeg, thighF * 0.92) : Math.max(r.kneeCm + kneeEase, (thighF + hemLeg) / 2 - 2);
  const fabricWaist = elastic ? Math.max(hipF + 2, waistF) : waistF;
  // Classic wide legs (and the avant-garde cut) take their front waist intake
  // in two soft pleats; fitted tapered trousers in darts. Knits never pleat.
  const pleated = !elastic && !g.knit && (wide || /antwerp|avant/i.test(ctx.style.id));
  const block = draftTrousers({
    waistF: fabricWaist,
    hipF,
    thighF,
    kneeLeg,
    hemLeg,
    rise,
    hipDepth: r.waistToHipCm,
    waistToKnee: r.waistToKneeCm,
    inseam,
    fit: fit.fit,
    noDarts: elastic,
    frontPleats: pleated,
    prominentSeat: ctx.body.shape === 'pear' || r.hipCm - r.waistCm > PROMINENT_SEAT_DROP,
  });
  const ha = g.ha;
  const pockets = opts.pockets && !sideZip;
  const frontCrotchLen = pathLength(block.front.crotch);
  const zipLen = fly
    ? zipLength(g, 18, Math.min(20.5, frontCrotchLen - FLY_TAIL - 4))
    : sideZip
      ? zipLength(g, 18, Math.min(23.5, r.waistToHipCm + 3.5))
      : 0;

  // --------------------------------------------------------------- front
  // front edges (clockwise): waist, [fly], crotch, inseam, hem, side (hem -> waist)
  let frontSide: EdgeDraft[];
  if (pockets) frontSide = pocketSplit(block.front.side, false, 4, 16);
  else if (sideZip) {
    const [lowerSide, upperSide] = splitAtLength(block.front.side, pathLength(block.front.side) - zipLen);
    frontSide = [
      { id: 'side', kind: 'seam', points: lowerSide },
      { id: 'side-zip', kind: 'seam', points: upperSide },
    ];
  } else frontSide = [{ id: 'side', kind: 'seam', points: block.front.side }];
  const flyParts = fly ? flyFront(block.front.crotch, zipLen, g.sa) : null;
  const pleats = block.front.pleats;
  const frontDraft: PieceDraft = {
    id: 'front-leg',
    role: 'front-leg',
    name: 'Front trouser leg',
    layer: 'self',
    cutCount: 2,
    cutOnFold: false,
    mirrorPair: true,
    edges: [
      { id: 'waist', kind: 'seam', points: block.front.waist },
      ...(flyParts ? flyParts.edges : []),
      { id: 'crotch', kind: 'seam', points: flyParts ? flyParts.lower : block.front.crotch },
      { id: 'inseam', kind: 'seam', points: block.front.inseam },
      { id: 'hem', kind: 'hem', points: block.front.hem },
      ...frontSide,
    ],
    darts: block.front.darts,
    notches: [
      { edgeId: 'inseam', at: Math.min(10, pathLength(block.front.inseam) * 0.2), count: 1, label: 'inseam' },
      { edgeId: 'crotch', at: pathLength(flyParts ? flyParts.lower : block.front.crotch) * 0.4, count: 1 },
      ...(flyParts ? [{ edgeId: 'crotch', at: 0, count: 1 as const, label: 'fly end' }] : []),
      ...pleats.flatMap((p) => [
        { edgeId: 'waist', at: p.at - p.intakeCm / 2, count: 1 as const, label: 'pleat' },
        { edgeId: 'waist', at: p.at + p.intakeCm / 2, count: 1 as const, label: 'pleat' },
      ]),
    ],
    extraLabels: [
      ...pleats.map((p) => {
        const at = pointAtLength(block.front.waist, p.at).point;
        return { at: { x: at.x, y: at.y + 4 }, text: `pleat ${p.intakeCm.toFixed(1)} cm → fold towards CF`, sizePt: 7 };
      }),
      ...(flyParts
        ? [{ at: { x: (flyParts.cfLine[0].x + flyParts.cfLine[1].x) / 2 - 1, y: (flyParts.cfLine[0].y + flyParts.cfLine[1].y) / 2 }, text: 'CF · fly fold line', sizePt: 7 }]
        : []),
    ],
    seamAllowanceCm: g.sa,
    hemAllowanceCm: ha,
  };

  // ---------------------------------------------------------------- back
  // back edges (clockwise): waist, side, hem, inseam, crotch (crotch point -> hip line), seat (-> CB waist)
  let backSide: EdgeDraft[];
  if (pockets) backSide = pocketSplit(block.back.side, true, 4, 16);
  else if (sideZip) {
    const [upperSide, lowerSide] = splitAtLength(block.back.side, zipLen);
    backSide = [
      { id: 'side-zip', kind: 'seam', points: upperSide },
      { id: 'side', kind: 'seam', points: lowerSide },
    ];
  } else backSide = [{ id: 'side', kind: 'seam', points: block.back.side }];
  const seat = block.back.seat ?? [];
  const backDraft: PieceDraft = {
    id: 'back-leg',
    role: 'back-leg',
    name: 'Back trouser leg',
    layer: 'self',
    cutCount: 2,
    cutOnFold: false,
    mirrorPair: true,
    edges: [
      { id: 'waist', kind: 'seam', points: block.back.waist },
      ...backSide,
      { id: 'hem', kind: 'hem', points: block.back.hem },
      { id: 'inseam', kind: 'seam', points: block.back.inseam },
      { id: 'crotch', kind: 'seam', points: block.back.crotch },
      ...(seat.length ? [{ id: 'seat', kind: 'seam' as const, points: seat, allowance: Math.max(g.sa, SEAT_LET_OUT_ALLOWANCE) }] : []),
    ],
    darts: block.back.darts,
    notches: [
      { edgeId: 'inseam', at: Math.min(10, pathLength(block.back.inseam) * 0.2), fromEnd: true, count: 2, label: 'inseam' },
      { edgeId: 'crotch', at: pathLength(block.back.crotch) * 0.45, count: 2 },
    ],
    notes: seat.length ? [`Centre-back seat seam has a ${Math.max(g.sa, SEAT_LET_OUT_ALLOWANCE)} cm allowance so it can be let out`] : undefined,
    seamAllowanceCm: g.sa,
    hemAllowanceCm: ha,
  };
  const drafts: PieceDraft[] = [frontDraft, backDraft];
  if (pockets) {
    const pe = frontSide.find((e) => e.id === 'side-pocket');
    if (pe) drafts.push(pocketBag({ id: 'pocket-bag', name: 'Pocket bag', layer: 'self', attach: pe.points, interiorRight: true, seamAllowanceCm: g.sa }));
  }
  const built = fitFolds(g, drafts).map(buildPiece);
  // Waist edge as it is sewn: darts closed, pleats folded.
  const fin = (id: string) => edgeLen(built, id, 'waist') - dartIntakeOn(pieceById(built, id), 'waist') - (id === 'front-leg' ? pleatIntake(pleats) : 0);

  // ----------------------------------------------------------- waistband
  // A continuous band (no seam at the CB) opening where the trousers open,
  // with an underlap for the hook and bar.
  let segs: StripSegment[];
  if (fly) {
    // From the CF on the fly (left) side round the back to the CF on the underlap side.
    segs = [
      { edgeId: 'join-front-leg-1', length: fin('front-leg'), notchLabel: 'side' },
      { edgeId: 'join-back-leg-1', length: fin('back-leg'), notchLabel: 'CB' },
      { edgeId: 'join-back-leg-2', length: fin('back-leg'), notchLabel: 'side' },
      { edgeId: 'join-front-leg-2', length: fin('front-leg') },
    ];
  } else if (sideZip) {
    // From the left side seam round the front and back back to the left side.
    segs = [
      { edgeId: 'join-front-leg-1', length: fin('front-leg'), notchLabel: 'CF' },
      { edgeId: 'join-front-leg-2', length: fin('front-leg'), notchLabel: 'side' },
      { edgeId: 'join-back-leg-2', length: fin('back-leg'), notchLabel: 'CB' },
      { edgeId: 'join-back-leg-1', length: fin('back-leg') },
    ];
  } else {
    segs = [
      { edgeId: 'join-back-leg-1', length: fin('back-leg'), notchLabel: 'side' },
      { edgeId: 'join-front-leg-1', length: fin('front-leg'), notchLabel: 'CF' },
      { edgeId: 'join-front-leg-2', length: fin('front-leg'), notchLabel: 'side' },
      { edgeId: 'join-back-leg-2', length: fin('back-leg') },
    ];
  }
  const waistband = stripPiece({
    id: 'waistband',
    role: 'waistband',
    name: elastic ? 'Waistband casing' : 'Waistband',
    layer: 'self',
    segments: segs,
    width: WAISTBAND_W,
    folded: true,
    extensionEnd: elastic ? 0 : UNDERLAP,
    grain: 'lengthwise',
    seamAllowanceCm: g.sa,
    notes: elastic ? [`Elastic ${Math.round(r.waistCm * 0.92)} cm × 3 cm`] : [`${UNDERLAP} cm underlap at the end for the hook and bar`],
  });
  const extras: PieceDraft[] = [waistband];
  if (!elastic) extras.push({ ...waistband, id: 'waistband-interfacing', name: 'Waistband interfacing', layer: 'interfacing', notes: ['Fuse to the outer half of the waistband'] });
  if (fly) {
    const shield = stripPiece({
      id: 'fly-shield',
      role: 'front-facing',
      name: 'Fly shield',
      layer: 'self',
      segments: [{ edgeId: 'attach', length: zipLen }],
      width: FLY_W,
      folded: true,
      grain: 'lengthwise',
      seamAllowanceCm: g.sa,
      notes: ['Fold in half lengthwise; it sits behind the zip so the teeth never touch you'],
    });
    extras.push(shield, { ...shield, id: 'fly-shield-interfacing', name: 'Fly shield interfacing', layer: 'interfacing', notes: ['Fuse to one half of the fly shield'] });
  }
  const pieces: PatternPiece[] = [...built, ...extras.map(buildPiece)];

  // ---------------------------------------------------------------- seams
  const B = g.book;
  addDartSeams(g, pieces, STAGE.darts);
  if (pleats.length) {
    B.single('front-pleats', ['front-leg', 'waist'], 'plain', STAGE.darts, `Fold the ${pleats.length} pleat${pleats.length > 1 ? 's' : ''} on each front leg along the notches, towards the centre front, and machine-baste across the top 1 cm from the waist edge.`);
  }
  if (pockets) {
    B.join('pocket-front-attach', ['pocket-bag', 'attach'], ['front-leg', 'side-pocket'], STAGE.pocketAttach, { note: 'Stitch a pocket bag to each front leg between the pocket notches; press outwards.' });
    B.join('pocket-back-attach', ['pocket-bag', 'attach'], ['back-leg', 'side-pocket'], STAGE.pocketAttach, { note: 'Stitch a pocket bag to each back leg the same way.' });
  }
  if (fly) {
    B.join('front-crotch', ['front-leg', 'crotch'], ['front-leg', 'crotch'], STAGE.zip - 1, {
      note: 'Join the two front legs at the centre front from the inseam up to the "fly end" notch. Stitch the curve twice for strength; clip the curve.',
    });
    B.join('fly-zip', ['front-leg', 'fly-facing'], ['front-leg', 'fly-facing'], STAGE.zip, {
      type: 'zip-lapped',
      note: `Fly front with ${zipPhrase(g, zipLen)}: stitch the zip tape to the right fly extension, fold the left extension under on the CF fold line so it laps over the zip, and topstitch the J-shaped fly line from the waist to the fly end, ${FLY_W - 0.5} cm from the fold.`,
    });
    B.single('fly-curve-finish', ['front-leg', 'fly-curve'], 'plain', STAGE.zip, 'Neaten the curved lower edge of each fly extension with zigzag before the zip goes in.');
    B.single('fly-top', ['front-leg', 'fly-top'], 'plain', STAGE.waistband, 'Keep the top of the fly extensions folded inside; they are caught in the waistband seam.');
    B.join('fly-shield-attach', ['fly-shield', 'attach'], ['front-leg', 'fly-facing'], STAGE.zip + 1, {
      note: 'Fold the fly shield in half, neaten its long raw edges together and stitch it behind the zip to the right fly extension.',
    });
    B.single('fly-shield-end', ['fly-shield', 'end-start'], 'plain', STAGE.zip + 1, 'Stitch across the lower end of the folded shield 1 cm from the raw edge, trim the corners, turn and press.');
    B.single('fly-shield-top', ['fly-shield', 'end-end'], 'plain', STAGE.waistband, 'The top of the shield is caught in the waistband seam.');
  }
  if (sideZip) {
    B.join('side-zip', ['front-leg', 'side-zip'], ['back-leg', 'side-zip'], STAGE.zip, {
      type: g.zipType,
      note: `Left side seam: insert ${zipPhrase(g, zipLen)} here. On the right leg, sew this section as part of the side seam.`,
    });
  }
  for (const e of ['side-upper', 'side']) {
    if (hasEdge(pieces, 'front-leg', e)) {
      B.join(`side-${e}`, ['front-leg', e], ['back-leg', e], STAGE.sideSeams, {
        note: e === 'side-upper' ? 'Above the pocket opening.' : pockets ? 'Below the pocket opening; pivot around the bag.' : sideZip ? 'On the left leg start at the bottom of the zip.' : undefined,
      });
    }
  }
  if (pockets) B.join('pocket-bag', ['pocket-bag', 'bag'], ['pocket-bag', 'bag'], STAGE.pocketBag, { note: 'Stitch the bags together around the curve and finish the edges together.' });
  B.join('inseam', ['front-leg', 'inseam'], ['back-leg', 'inseam'], STAGE.inseam, { note: 'Match the crotch points first, then the hems.' });
  if (!fly) {
    B.join('front-crotch', ['front-leg', 'crotch'], ['front-leg', 'crotch'], STAGE.crotch, { note: 'Join the two front legs at the centre front. Stitch the curve twice for strength; clip the curve.' });
  }
  B.join('back-crotch', ['back-leg', 'crotch'], ['back-leg', 'crotch'], STAGE.inseam + 1, {
    note: 'Turn one leg right side out and slip it inside the other; stitch the crotch from the back hip line, through the inseams, to the front. Stitch the curve twice.',
  });
  if (seat.length) {
    B.join('back-seat', ['back-leg', 'seat'], ['back-leg', 'seat'], STAGE.inseam + 1, {
      note: `Continue the seam up the centre back to the waist. Press this ${Math.max(g.sa, SEAT_LET_OUT_ALLOWANCE)} cm allowance open and do not trim it: it is there to let out for a fuller seat.`,
    });
  }
  for (const s of segs) {
    const m = /^join-(.+)-([12])$/.exec(s.edgeId);
    if (!m) continue;
    const folds = dartIntakeOn(pieceById(pieces, m[1]), 'waist') + (m[1] === 'front-leg' ? pleatIntake(pleats) : 0);
    B.join(`waistband-${m[1]}-${m[2]}`, [m[1], 'waist'], ['waistband', s.edgeId], STAGE.waistband, {
      ease: folds,
      note: folds > 0 ? `The flat edge includes ${folds.toFixed(1)} cm of ${pleats.length && m[1] === 'front-leg' ? 'pleats' : 'darts'}; with them sewn or folded the edges match.` : undefined,
    });
  }
  if (elastic) {
    B.join('waistband-loop', ['waistband', 'end-start'], ['waistband', 'end-end'], STAGE.waistband - 1, { note: 'Join the casing into a ring, leaving a 3 cm gap to thread the elastic.' });
    B.single('waistband-inner', ['waistband', 'inner'], 'topstitch', STAGE.waistbandFinish, 'Fold the casing over, stitch in the ditch, thread the elastic and close the gap.');
  } else {
    B.single('waistband-ends', ['waistband', 'end-start'], 'plain', STAGE.waistbandFinish, `Fold the band right sides together and stitch across this end ${g.sa} cm from the raw edge, level with the edge of the opening; trim the corner, then turn and press.`);
    B.single('waistband-ends-2', ['waistband', 'end-end'], 'plain', STAGE.waistbandFinish, `Stitch across the underlap end the same way, ${g.sa} cm from the raw edge.`);
    B.single('waistband-underlap', ['waistband', 'ext-end'], 'plain', STAGE.waistbandFinish, `The ${UNDERLAP} cm extension is the underlap: stitch its lower edge closed as you stitch the end, then sew the hook on the overlapping end and the bar on the underlap.`);
    B.single('waistband-inner', ['waistband', 'inner'], 'topstitch', STAGE.waistbandFinish, `Press the inner long edge under ${g.sa} cm, pin it just over the seam line and stitch in the ditch from the right side.`);
  }
  addHem(g, 'front-leg', 'hem', false, ha, STAGE.hems, 'Hem both legs at the same time; try on with your shoes first.');
  addHem(g, 'back-leg', 'hem', false, ha, STAGE.hems);

  // silhouette (y in the block is measured down from the waist)
  const silhouette = buildSilhouette({
    r,
    L,
    knit: g.knit,
    topHeight: L.waist + WAISTBAND_W,
    hemHeight: fit.hemHeightFromFloorCm,
    knots: [
      { h: L.waist + WAISTBAND_W, c: waistF },
      { h: L.waist, c: waistF },
      { h: L.highHip, c: r.highHipCm + (fit.ease.waist + fit.ease.hip) / 2 },
      { h: L.hip, c: hipF },
      { h: L.waist - rise, c: hipF },
    ],
    neckline: null,
    leg: {
      top: L.waist - rise,
      bottom: fit.hemHeightFromFloorCm,
      at: (h: number) => block.legCircAt(L.waist - h),
    },
  });
  return { pieces, seams: B.seams, silhouette };
}
