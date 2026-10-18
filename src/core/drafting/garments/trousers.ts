/**
 * Wide-leg and tapered trousers from the trouser block: front and back legs
 * (mirror pairs), waistband, centre-back zip, optional in-seam pockets.
 */
import type { PatternPiece } from '../../types';
import type { DraftContext } from '../context';
import { buildPiece, type EdgeDraft, type PieceDraft } from '../piece';
import { draftTrousers } from '../blocks/trousers';
import { stripPiece, pocketBag, type StripSegment } from '../parts';
import { STAGE } from '../seams';
import { buildSilhouette } from '../silhouette';
import { pathLength, splitAtLength } from '../../geometry';
import { addDartSeams, addHem, dartIntakeOn, edgeLen, fitFolds, hasEdge, makeG, pieceById, pocketSplit, zipLength, type DraftResult } from './common';

const WAISTBAND_W = 3.5;

export function draftTrouserGarment(ctx: DraftContext): DraftResult {
  const g = makeG(ctx);
  const { r, L, fit } = g;
  const opts = fit.options;
  const elastic = g.closure === 'elastic' || g.closure === 'none';
  const wide = ctx.garment.id === 'wide-leg-trousers';
  const waistF = fit.finished.waist ?? r.waistCm + 2.5;
  const hipF = fit.finished.hip ?? r.hipCm + 7;
  const hemLeg = fit.finished.hem ?? 40;
  const thighF = r.thighCm + fit.ease.thigh;
  const riseEase = { fitted: 1, regular: 1.5, relaxed: 2.5 }[fit.fit];
  const rise = r.crotchDepthCm + riseEase;
  const inseam = Math.max(10, L.waist - rise - fit.hemHeightFromFloorCm);
  const kneeEase = { fitted: 8, regular: 11, relaxed: 15 }[fit.fit];
  const kneeLeg = wide ? Math.max(hemLeg, thighF * 0.92) : Math.max(r.kneeCm + kneeEase, (thighF + hemLeg) / 2 - 2);
  const fabricWaist = elastic ? Math.max(hipF + 2, waistF) : waistF;
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
  });
  const ha = g.ha;
  const pockets = opts.pockets;
  const crotchTotalBack = pathLength(block.back.crotch);
  const zipLen = g.zip ? zipLength(18, Math.min(22, crotchTotalBack - 6)) : 0;

  // front edges (clockwise): waist, crotch, inseam, hem, side (hem -> waist)
  const frontSide: EdgeDraft[] = pockets
    ? pocketSplit(block.front.side, false, 4, 16)
    : [{ id: 'side', kind: 'seam', points: block.front.side }];
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
      { id: 'crotch', kind: 'seam', points: block.front.crotch },
      { id: 'inseam', kind: 'seam', points: block.front.inseam },
      { id: 'hem', kind: 'hem', points: block.front.hem },
      ...frontSide,
    ],
    darts: block.front.darts,
    notches: [
      { edgeId: 'inseam', at: Math.min(10, pathLength(block.front.inseam) * 0.2), count: 1, label: 'inseam' },
      { edgeId: 'crotch', at: pathLength(block.front.crotch) * 0.45, count: 1 },
    ],
    seamAllowanceCm: g.sa,
    hemAllowanceCm: ha,
  };
  // back edges (clockwise): waist, side, hem, inseam, crotch (crotch point -> CB waist, split for zip)
  const backSide: EdgeDraft[] = pockets ? pocketSplit(block.back.side, true, 4, 16) : [{ id: 'side', kind: 'seam', points: block.back.side }];
  const crotchEdges: EdgeDraft[] = [];
  if (zipLen > 0) {
    const [lower, upper] = splitAtLength(block.back.crotch, crotchTotalBack - zipLen);
    crotchEdges.push({ id: 'crotch', kind: 'seam', points: lower });
    crotchEdges.push({ id: 'cb-zip', kind: 'seam', points: upper, allowance: g.closure === 'lapped-zip' ? Math.max(2, g.sa) : g.sa });
  } else {
    crotchEdges.push({ id: 'crotch', kind: 'seam', points: block.back.crotch });
  }
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
      ...crotchEdges,
    ],
    darts: block.back.darts,
    notches: [
      { edgeId: 'inseam', at: Math.min(10, pathLength(block.back.inseam) * 0.2), fromEnd: true, count: 2, label: 'inseam' },
      { edgeId: 'crotch', at: pathLength(block.back.crotch) * 0.3, count: 2 },
    ],
    seamAllowanceCm: g.sa,
    hemAllowanceCm: ha,
  };
  const drafts: PieceDraft[] = [frontDraft, backDraft];
  if (pockets) {
    const pe = frontSide.find((e) => e.id === 'side-pocket');
    if (pe) drafts.push(pocketBag({ id: 'pocket-bag', name: 'Pocket bag', layer: 'self', attach: pe.points, interiorRight: true, seamAllowanceCm: g.sa }));
  }
  const built = fitFolds(g, drafts).map(buildPiece);
  const fin = (id: string) => edgeLen(built, id, 'waist') - dartIntakeOn(pieceById(built, id), 'waist');
  // waistband: from CB-left: back, front, front, back
  const segs: StripSegment[] = [
    { edgeId: 'join-back-leg-1', length: fin('back-leg'), notchLabel: 'side' },
    { edgeId: 'join-front-leg-1', length: fin('front-leg'), notchLabel: 'CF' },
    { edgeId: 'join-front-leg-2', length: fin('front-leg'), notchLabel: 'side' },
    { edgeId: 'join-back-leg-2', length: fin('back-leg') },
  ];
  const waistband = stripPiece({
    id: 'waistband',
    role: 'waistband',
    name: elastic ? 'Waistband casing' : 'Waistband',
    layer: 'self',
    segments: segs,
    width: WAISTBAND_W,
    folded: true,
    extensionEnd: g.closure === 'lapped-zip' ? 3 : 0,
    grain: 'lengthwise',
    seamAllowanceCm: g.sa,
    notes: elastic ? [`Elastic ${Math.round(r.waistCm * 0.92)} cm × 3 cm`] : undefined,
  });
  const extras: PieceDraft[] = [waistband];
  if (!elastic) extras.push({ ...waistband, id: 'waistband-interfacing', name: 'Waistband interfacing', layer: 'interfacing', notes: ['Fuse to the outer half of the waistband'] });
  const pieces: PatternPiece[] = [...built, ...extras.map(buildPiece)];

  // seams
  const B = g.book;
  addDartSeams(g, pieces, STAGE.darts);
  if (pockets) {
    B.join('pocket-front-attach', ['pocket-bag', 'attach'], ['front-leg', 'side-pocket'], STAGE.pocketAttach, { note: 'Stitch a pocket bag to each front leg between the pocket notches; press outwards.' });
    B.join('pocket-back-attach', ['pocket-bag', 'attach'], ['back-leg', 'side-pocket'], STAGE.pocketAttach, { note: 'Stitch a pocket bag to each back leg the same way.' });
  }
  for (const e of ['side-upper', 'side']) {
    if (hasEdge(pieces, 'front-leg', e)) {
      B.join(`side-${e}`, ['front-leg', e], ['back-leg', e], STAGE.sideSeams, { note: e === 'side-upper' ? 'Above the pocket opening.' : pockets ? 'Below the pocket opening; pivot around the bag.' : undefined });
    }
  }
  if (pockets) B.join('pocket-bag', ['pocket-bag', 'bag'], ['pocket-bag', 'bag'], STAGE.pocketBag, { note: 'Stitch the bags together around the curve and finish the edges together.' });
  B.join('inseam', ['front-leg', 'inseam'], ['back-leg', 'inseam'], STAGE.inseam, { note: 'Match the crotch points first, then the hems.' });
  B.join('front-crotch', ['front-leg', 'crotch'], ['front-leg', 'crotch'], STAGE.crotch, { note: 'Join the two front legs at the centre front. Stitch the curve twice for strength; clip the curve.' });
  B.join('back-crotch', ['back-leg', 'crotch'], ['back-leg', 'crotch'], STAGE.crotch + 1, { note: 'Turn one leg right side out and slip it inside the other; stitch the crotch from the zip to the front, matching the inseams.' });
  if (zipLen > 0) B.join('cb-zip', ['back-leg', 'cb-zip'], ['back-leg', 'cb-zip'], STAGE.zip, { type: g.zipType, note: `Use a ${zipLen} cm ${g.closure === 'lapped-zip' ? 'regular' : 'invisible'} zip in the centre-back seam.` });
  for (const s of segs) {
    const m = /^join-(.+)-([12])$/.exec(s.edgeId);
    if (!m) continue;
    const ease = dartIntakeOn(pieceById(pieces, m[1]), 'waist');
    B.join(`waistband-${m[1]}-${m[2]}`, [m[1], 'waist'], ['waistband', s.edgeId], STAGE.waistband, {
      ease,
      note: ease > 0 ? `Includes ${ease.toFixed(1)} cm of dart intake; sew the darts first.` : undefined,
    });
  }
  if (elastic) {
    B.join('waistband-loop', ['waistband', 'end-start'], ['waistband', 'end-end'], STAGE.waistband - 1, { note: 'Join the casing into a ring, leaving a 3 cm gap to thread the elastic.' });
    B.single('waistband-inner', ['waistband', 'inner'], 'topstitch', STAGE.waistbandFinish, 'Fold the casing over, stitch in the ditch, thread the elastic and close the gap.');
  } else {
    B.single('waistband-ends', ['waistband', 'end-start'], 'plain', STAGE.waistbandFinish, 'Stitch across both ends of the folded waistband, trim and turn.');
    B.single('waistband-ends-2', ['waistband', 'end-end'], 'plain', STAGE.waistbandFinish, 'Stitch across the other end the same way.');
    if (hasEdge(pieces, 'waistband', 'ext-end')) B.single('waistband-underlap', ['waistband', 'ext-end'], 'plain', STAGE.waistbandFinish, 'The 3 cm extension is the underlap behind the zip: stitch its lower edge closed when you stitch the end, then sew the hook or button on it.');
    B.single('waistband-inner', ['waistband', 'inner'], 'topstitch', STAGE.waistbandFinish, 'Turn the inner edge under and stitch in the ditch from the right side. Add a hook and bar (or button) at the top of the zip.');
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
