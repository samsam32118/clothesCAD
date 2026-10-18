/**
 * Skirts: A-line (slash-and-spread from the darted block), pencil (tapered
 * block with walking vent) and circle (full / three-quarter / half circle
 * cut from the waist radius). All share the waistband, zip, pocket and lining
 * logic.
 */
import type { Path, PatternPiece } from '../../types';
import type { DraftContext } from '../context';
import { buildPiece, type EdgeDraft, type NotchDraft, type PieceDraft } from '../piece';
import { draftSkirtBlock, flareToHem, type SkirtHalf } from '../blocks/skirt';
import { stripPiece, pocketBag, type StripSegment } from '../parts';
import { STAGE } from '../seams';
import { buildSilhouette, type Knot } from '../silhouette';
import { arc, dedupe, pathLength } from '../../geometry';
import { circleFraction } from '../../fit/plan';
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
  zipPhrase,
  fitFolds,
  type DraftResult,
  type G,
} from './common';

const WAISTBAND_W = 3.5;
const POCKET_TOP = 3;
const POCKET_OPENING = 16;

interface SkirtPanel {
  id: string;
  name: string;
  role: 'front-skirt' | 'back-skirt';
  /** Edges in clockwise order. The waist edge must be 'waist'. */
  edges: EdgeDraft[];
  darts: SkirtHalf['darts'];
  cutOnFold: boolean;
  cutCount: number;
  grain: 'vertical';
  /** Distance along the side seam from the waist to the hip line (for the hip notch). */
  sideToHip?: number;
}

/** Waistband segments: CB-left round to CB-right over the given waist pieces (CF..CB order). */
function waistbandSegments(pieces: PatternPiece[], order: string[], finishedOf: (p: PatternPiece) => number): StripSegment[] {
  const segs: StripSegment[] = [];
  const rev = [...order].reverse();
  rev.forEach((id, i) => {
    const p = pieceById(pieces, id);
    segs.push({ edgeId: `join-${id}-1`, length: finishedOf(p), notchLabel: i === rev.length - 1 ? 'CF' : 'seam' });
  });
  order.forEach((id, i) => {
    const p = pieceById(pieces, id);
    segs.push({ edgeId: `join-${id}-2`, length: finishedOf(p), notchLabel: i === order.length - 1 ? undefined : 'seam' });
  });
  return segs;
}

function halfToEdges(h: SkirtHalf, centreEdges: EdgeDraft[], hemAllowance: number, pockets: boolean): EdgeDraft[] {
  const sideEdges: EdgeDraft[] = pockets ? pocketSplit(h.side, true, POCKET_TOP, POCKET_OPENING) : [{ id: 'side', kind: 'seam', points: h.side }];
  return [
    { id: 'waist', kind: 'seam', points: h.waist },
    ...sideEdges,
    { id: 'hem', kind: 'hem', points: h.hem, allowance: hemAllowance },
    ...centreEdges,
  ];
}

export function draftSkirt(ctx: DraftContext): DraftResult {
  const g = makeG(ctx);
  const { r, L, fit } = g;
  const kind = ctx.garment.id;
  const opts = fit.options;
  const elastic = g.closure === 'elastic' || g.closure === 'none';
  const waistF = fit.finished.waist ?? r.waistCm + 2;
  const hipF = fit.finished.hip ?? r.hipCm + 4;
  const hemF = fit.finished.hem ?? hipF;
  const length = L.waist - fit.hemHeightFromFloorCm;
  const highHipF = r.highHipCm + (fit.ease.waist + fit.ease.hip) / 2;
  const fabricWaist = elastic ? Math.max(hipF + 4, waistF) : waistF;
  const lined = opts.lining;
  const pockets = opts.pockets;
  const ha = kind === 'circle-skirt' ? curvedHemAllowance(g, 1) : kind === 'a-line-skirt' ? curvedHemAllowance(g, opts.flare) : g.ha;
  const zipLen = g.zip ? zipLength(g, Math.max(18, r.waistToHipCm - 1), length) : 0;

  // ------------------------------------------------------------------ shape
  type Shape = { front: SkirtPanel[]; back: SkirtPanel[]; knots: Knot[] };
  const makeShape = (len: number, isLining: boolean): Shape => {
    const suffix = isLining ? '-lining' : '';
    const nameSfx = isLining ? ' lining' : '';
    const hemA = isLining ? 2 : ha;
    if (kind === 'circle-skirt') return circleShape(g, len, fabricWaist, suffix, nameSfx, hemA, pockets && !isLining, elastic, zipLen);
    const block = draftSkirtBlock({
      waistFront: fabricWaist / 4 + 0.5,
      waistBack: fabricWaist / 4 - 0.5,
      hipF,
      highHipF,
      hipDepth: r.waistToHipCm,
      highHipDepth: Math.min(10, r.waistToHipCm / 2),
      length: len,
      hemF: kind === 'pencil-skirt' ? hemF : undefined,
      frontDartX: r.bustPointDistanceCm / 2,
      cbDrop: 1,
      noDarts: elastic,
    });
    let front = block.front;
    let back = block.back;
    if (kind === 'a-line-skirt') {
      // flare scaled to this length so lining and shell keep the same angle
      const target = hipF + (hemF - hipF) * Math.max(0, len - r.waistToHipCm) / Math.max(1, length - r.waistToHipCm);
      const f = flareToHem(front, back, target);
      front = f.front;
      back = f.back;
    }
    const ventH = kind === 'pencil-skirt' && !isLining ? Math.min(22, Math.max(12, (len - r.waistToHipCm) * 0.4)) : 0;
    const slitH = kind === 'pencil-skirt' && isLining ? Math.min(22, Math.max(12, (len - r.waistToHipCm) * 0.4)) + 2 : 0;
    const frontEdges = halfToEdges(front, [{ id: 'cf', kind: 'fold', points: front.center }], hemA, pockets && !isLining);
    const backCentre = centreBackEdges(back.center, g, {
      fold: !g.zip,
      zipLen,
      ventHeight: ventH,
      ventExtension: 4,
      slitHeight: slitH,
      lining: isLining,
    });
    let backHem = back.hem;
    if (ventH > 0) backHem = dedupe([...backHem, { x: -4, y: backHem[backHem.length - 1].y }]);
    const backEdges = halfToEdges({ ...back, hem: backHem }, backCentre, hemA, pockets && !isLining);
    const knots: Knot[] = [
      { h: L.waist + WAISTBAND_W, c: waistF },
      { h: L.waist, c: waistF },
      { h: L.highHip, c: highHipF },
      { h: L.hip, c: hipF },
      { h: L.waist - length, c: hemF },
    ];
    return {
      front: [
        {
          id: `front-skirt${suffix}`,
          name: `Front skirt${nameSfx}`,
          role: 'front-skirt',
          edges: frontEdges,
          darts: front.darts,
          cutOnFold: true,
          cutCount: 1,
          grain: 'vertical',
          sideToHip: front.sideToHip,
        },
      ],
      back: [
        {
          id: `back-skirt${suffix}`,
          name: `Back skirt${nameSfx}`,
          role: 'back-skirt',
          edges: backEdges,
          darts: back.darts,
          cutOnFold: !g.zip,
          cutCount: g.zip ? 2 : 1,
          grain: 'vertical',
          sideToHip: back.sideToHip,
        },
      ],
      knots,
    };
  };

  const main = makeShape(length, false);
  const drafts: PieceDraft[] = [];
  const toDraft = (p: SkirtPanel, layer: 'self' | 'lining'): PieceDraft => ({
    id: p.id,
    role: p.role,
    name: p.name,
    layer,
    cutCount: p.cutCount,
    cutOnFold: p.cutOnFold,
    mirrorPair: !p.cutOnFold && p.cutCount % 2 === 0,
    edges: p.edges,
    darts: p.darts,
    notches: notchesFor(p),
    grain: p.grain,
    seamAllowanceCm: g.sa,
    hemAllowanceCm: layer === 'lining' ? 2 : ha,
  });
  for (const p of [...main.front, ...main.back]) drafts.push(toDraft(p, 'self'));
  let liningShape: ReturnType<typeof makeShape> | undefined;
  if (lined) {
    liningShape = makeShape(length - 2.5, true);
    for (const p of [...liningShape.front, ...liningShape.back]) drafts.push(toDraft(p, 'lining'));
  }

  // pockets
  if (pockets) {
    const fp = main.front[main.front.length - 1];
    const pe = fp.edges.find((e) => e.id === 'side-pocket');
    if (pe) {
      drafts.push(pocketBag({ id: 'pocket-bag', name: 'Pocket bag', layer: lined ? 'lining' : 'self', attach: pe.points, interiorRight: false, seamAllowanceCm: g.sa }));
    }
  }

  const panelsOrder = [...main.front, ...main.back].map((p) => p.id);
  // build skirt pieces first (waistband needs their finished waist lengths)
  const built = fitFolds(g, drafts).map(buildPiece);
  const finishedWaist = (p: PatternPiece) => edgeLen(built, p.id, 'waist') - dartIntakeOn(p, 'waist');
  const segs = waistbandSegments(built, panelsOrder, finishedWaist);
  const wbExt = g.closure === 'lapped-zip' ? 3 : 0;
  const waistband = stripPiece({
    id: 'waistband',
    role: 'waistband',
    name: elastic ? 'Waistband casing' : 'Waistband',
    layer: 'self',
    segments: segs,
    width: WAISTBAND_W,
    folded: true,
    extensionEnd: wbExt,
    grain: 'lengthwise',
    seamAllowanceCm: g.sa,
    notes: elastic ? [`Elastic ${Math.round(r.waistCm * 0.92)} cm × 3 cm`] : undefined,
  });
  const extra: PieceDraft[] = [waistband];
  if (!elastic) {
    extra.push({ ...waistband, id: 'waistband-interfacing', name: 'Waistband interfacing', layer: 'interfacing', notes: ['Fuse to the outer half of the waistband'] });
  }
  const pieces = [...built, ...fitFolds(g, extra).map(buildPiece)];

  // ------------------------------------------------------------------ seams
  const B = g.book;
  addDartSeams(g, pieces, STAGE.darts);
  const frontIds = main.front.map((p) => p.id);
  const backIds = main.back.map((p) => p.id);
  const allPanels = [...frontIds, ...backIds];
  // panel seams in order CF -> CB (circle gores), the side seam, and pockets
  for (let i = 0; i < allPanels.length - 1; i++) {
    const a = allPanels[i];
    const b = allPanels[i + 1];
    const pa = pieceById(pieces, a);
    const sharedIds = pa.edges.map((e) => e.id).filter((id) => id.startsWith('side') || id.startsWith('seam'));
    for (const eid of sharedIds) {
      if (!hasEdge(pieces, b, eid)) continue;
      if (eid === 'side-pocket') continue;
      B.join(`${a}-${b}-${eid}`, [a, eid], [b, eid], STAGE.sideSeams, {
        note: eid === 'side-upper' ? 'Above the pocket opening.' : eid === 'side' && pockets ? 'Below the pocket opening; pivot around the pocket bag.' : undefined,
      });
    }
  }
  if (pockets && hasEdge(pieces, frontIds[frontIds.length - 1], 'side-pocket')) {
    const f = frontIds[frontIds.length - 1];
    const b = backIds[0];
    B.join('pocket-front-attach', ['pocket-bag', 'attach'], [f, 'side-pocket'], STAGE.pocketAttach, { note: 'Stitch one pocket bag to the front side edge between the pocket notches, 1 cm from the edge; press the bag outwards.' });
    B.join('pocket-back-attach', ['pocket-bag', 'attach'], [b, 'side-pocket'], STAGE.pocketAttach, { note: 'Stitch the second pocket bag to the back side edge the same way.' });
    B.join('pocket-bag', ['pocket-bag', 'bag'], ['pocket-bag', 'bag'], STAGE.pocketBag, { note: 'Stitch the front and back bags together around the curve; finish the edges together.' });
  }
  const cbPiece = backIds[backIds.length - 1];
  const zipNote = `Use ${zipPhrase(g, zipLen)}; the top stop sits 0.5 cm below the waistband seam line.`;
  if (hasEdge(pieces, cbPiece, 'cb-zip')) B.join('cb-zip', [cbPiece, 'cb-zip'], [cbPiece, 'cb-zip'], STAGE.zip, { type: g.zipType, note: zipNote, finish: 'Finish both centre-back edges before inserting the zip.' });
  if (hasEdge(pieces, cbPiece, 'cb') && pieceById(pieces, cbPiece).edges.find((e) => e.id === 'cb')?.kind !== 'fold') {
    B.join('cb', [cbPiece, 'cb'], [cbPiece, 'cb'], STAGE.centreSeam, { note: g.zip ? 'From the bottom of the zip to the hem (or vent).' : undefined });
  }
  if (frontIds.length && hasEdge(pieces, frontIds[0], 'cf') && pieceById(pieces, frontIds[0]).edges.find((e) => e.id === 'cf')?.kind !== 'fold') {
    B.join('cf', [frontIds[0], 'cf'], [frontIds[0], 'cf'], STAGE.centreSeam, { note: 'Centre-front seam (the panel is too wide to cut on the fold).' });
  }
  if (hasEdge(pieces, cbPiece, 'vent')) {
    B.single('vent', [cbPiece, 'vent'], 'topstitch', STAGE.openingFinish, 'Press the vent extensions to the left back; stitch across the top of the vent at 45° through all layers.', 'Walking vent: lets you stride in a narrow skirt.');
  }
  // lining
  if (lined && liningShape) {
    const lf = liningShape.front.map((p) => p.id);
    const lb = liningShape.back.map((p) => p.id);
    const all = [...lf, ...lb];
    for (let i = 0; i < all.length - 1; i++) {
      const a = all[i];
      const b = all[i + 1];
      for (const e of pieceById(pieces, a).edges) {
        if ((e.id.startsWith('side') || e.id.startsWith('seam')) && hasEdge(pieces, b, e.id)) {
          B.join(`${a}-${b}-${e.id}`, [a, e.id], [b, e.id], STAGE.liningSeams);
        }
      }
    }
    const lcb = lb[lb.length - 1];
    if (hasEdge(pieces, lcb, 'cb') && pieceById(pieces, lcb).edges.find((e) => e.id === 'cb')?.kind !== 'fold') B.join(`${lcb}-cb`, [lcb, 'cb'], [lcb, 'cb'], STAGE.liningSeams);
    if (hasEdge(pieces, lcb, 'cb-zip')) B.single(`${lcb}-cb-zip`, [lcb, 'cb-zip'], 'plain', STAGE.liningAttach, 'Turn the lining edges under and slip-stitch them to the zip tape, clear of the teeth.');
    if (hasEdge(pieces, lcb, 'slit')) B.single(`${lcb}-slit`, [lcb, 'slit'], 'hem-double-fold', STAGE.liningHem, 'Press the slit edges under twice and stitch; the slit sits over the vent.');
    for (let i = 0; i < all.length; i++) {
      const self = allPanels[i];
      if (!self) continue;
      B.join(`${all[i]}-waist`, [all[i], 'waist'], [self, 'waist'], STAGE.liningAttach, { note: 'Baste lining to skirt at the waist, wrong sides together, before adding the waistband.', finish: 'Baste within the seam allowance.' });
    }
    for (const id of all) addHem(g, id, 'hem', false, 2, STAGE.liningHem, 'The lining hem ends 2.5 cm above the skirt hem.');
  }
  // waistband
  for (const s of segs) {
    const m = /^join-(.+)-([12])$/.exec(s.edgeId);
    if (!m) continue;
    const pid = m[1];
    const p = pieceById(pieces, pid);
    const ease = dartIntakeOn(p, 'waist');
    B.join(`waistband-${pid}-${m[2]}`, [pid, 'waist'], ['waistband', s.edgeId], STAGE.waistband, {
      ease,
      note: ease > 0 ? `The flat skirt edge includes ${ease.toFixed(1)} cm of dart; with the darts sewn the edges match.` : elastic ? 'Casing joined flat; the elastic gathers it later.' : undefined,
    });
  }
  if (elastic) {
    B.join('waistband-loop', ['waistband', 'end-start'], ['waistband', 'end-end'], STAGE.waistband - 1, { note: 'Join the casing into a ring before attaching; leave a 3 cm gap in the seam to thread the elastic.' });
    B.single('waistband-inner', ['waistband', 'inner'], 'topstitch', STAGE.waistbandFinish, 'Fold the casing over, stitch in the ditch from the outside, thread the elastic, overlap its ends 2 cm and zigzag; close the gap.');
  } else {
    B.single('waistband-ends', ['waistband', 'end-start'], 'plain', STAGE.waistbandFinish, 'Fold the waistband right sides together and stitch across both ends; trim, turn and press.');
    B.single('waistband-ends-2', ['waistband', 'end-end'], 'plain', STAGE.waistbandFinish, 'Stitch across the other end the same way.');
    if (hasEdge(pieces, 'waistband', 'ext-end')) B.single('waistband-underlap', ['waistband', 'ext-end'], 'plain', STAGE.waistbandFinish, 'The 3 cm extension is the underlap behind the zip: stitch its lower edge closed when you stitch the end, then sew the hook or button on it.');
    B.single('waistband-inner', ['waistband', 'inner'], 'topstitch', STAGE.waistbandFinish, 'Turn the inner edge under and stitch in the ditch from the right side, catching it underneath.');
  }
  for (const id of allPanels) addHem(g, id, 'hem', kind !== 'pencil-skirt', ha, STAGE.hems, kind === 'circle-skirt' ? 'Hang the skirt for 24 hours before hemming so the bias sections can drop; then level the hem.' : undefined);

  // ------------------------------------------------------------- silhouette
  const silhouette = buildSilhouette({
    r,
    L,
    knit: g.knit,
    topHeight: L.waist + WAISTBAND_W,
    hemHeight: fit.hemHeightFromFloorCm,
    knots: main.knots,
    neckline: null,
  });
  return { pieces, seams: B.seams, silhouette };
}

/** Hip-line notch on the side seam (front single, back double), matched on both pieces. */
function notchesFor(p: SkirtPanel): NotchDraft[] {
  if (p.sideToHip === undefined) return [];
  const count = p.role === 'front-skirt' ? 1 : 2;
  const side = p.edges.find((e) => e.id === 'side');
  if (!side) return [];
  const above = p.edges.filter((e) => e.id === 'side-upper' || e.id === 'side-pocket').reduce((a, e) => a + pathLength(e.points), 0);
  const at = p.sideToHip - above;
  if (at <= 0.5 || at >= pathLength(side.points) - 0.5) return [];
  return [{ edgeId: 'side', at, count, label: 'hip' }];
}

/** Circle skirt panels (wedges). */
function circleShape(
  g: G,
  len: number,
  fabricWaist: number,
  suffix: string,
  nameSfx: string,
  hemA: number,
  pockets: boolean,
  elastic: boolean,
  zipLen: number,
): { front: SkirtPanel[]; back: SkirtPanel[]; knots: Knot[] } {
  const { fit, L, r } = g;
  const f = circleFraction(fit.options.flare);
  const rw = fabricWaist / (2 * Math.PI * f);
  const R = rw + len;
  const W = g.material.widthCm;
  const total = 2 * Math.PI * f; // total angle of the skirt
  // wedges per half body: 2 (front + back), 4, 6... until each fits the fabric
  let n = 2;
  for (; n <= 8; n += 2) {
    const alpha = total / (2 * n);
    const width = alpha >= Math.PI / 2 ? R : R * Math.sin(alpha);
    const widthBisector = 2 * R * Math.sin(Math.min(Math.PI / 2, alpha / 2));
    if (Math.min(width, widthBisector) + 2 * g.sa + 2 <= W) break;
  }
  n = Math.min(n, 8);
  const alpha = total / (2 * n);
  const frontFold = (alpha >= Math.PI / 2 ? R : R * Math.sin(alpha)) + g.sa + 1 <= W / 2;
  const half = n / 2;
  const front: SkirtPanel[] = [];
  const back: SkirtPanel[] = [];
  for (let i = 0; i < n; i++) {
    const isFront = i < half;
    const leftId = i === 0 ? 'cf' : i === half ? 'side' : `seam-${i}`;
    const rightId = i === n - 1 ? 'cb' : i + 1 === half ? 'side' : `seam-${i + 1}`;
    // orientation: grain along the CF edge for the first panel, along CB for the last, bisector otherwise
    const a1 = i === 0 ? Math.PI / 2 : i === n - 1 ? Math.PI / 2 + alpha : Math.PI / 2 + alpha / 2;
    const a0 = a1 - alpha;
    const waist = arc({ x: 0, y: 0 }, rw, a1, a0);
    const hem = arc({ x: 0, y: 0 }, R, a0, a1);
    const right: Path = [waist[waist.length - 1], hem[0]];
    const left: Path = [hem[hem.length - 1], waist[0]];
    const edges: EdgeDraft[] = [{ id: 'waist', kind: 'seam', points: waist }];
    if (rightId === 'side' && pockets) edges.push(...pocketSplit(right, true, POCKET_TOP, POCKET_OPENING));
    else edges.push({ id: rightId, kind: 'seam', points: right });
    edges.push({ id: 'hem', kind: 'hem', points: hem, allowance: hemA });
    if (leftId === 'cf') {
      edges.push({ id: 'cf', kind: frontFold ? 'fold' : 'seam', points: left });
    } else if (leftId === 'side' && pockets) {
      edges.push(...pocketSplit(left, false, POCKET_TOP, POCKET_OPENING));
    } else {
      edges.push({ id: leftId, kind: 'seam', points: left });
    }
    if (rightId === 'cb') {
      // replace the CB edge with zip-split edges (path runs inner -> outer; centreBackEdges wants bottom -> top)
      const idx = edges.findIndex((e) => e.id === 'cb');
      const cbPath: Path = [hem[0], waist[waist.length - 1]];
      const cbEdges = centreBackEdges(cbPath, g, { fold: false, zipLen: elastic ? 0 : zipLen, lining: false });
      // the CB edge on this panel runs waist -> hem (clockwise), so reverse the split edges
      const rev = cbEdges.reverse().map((e) => ({ ...e, points: [...e.points].reverse() }));
      edges.splice(idx, 1, ...rev);
    }
    const panel: SkirtPanel = {
      id: (isFront ? 'front-skirt' : 'back-skirt') + (isFront ? (i === 0 ? '' : `-${i + 1}`) : i === n - 1 ? '' : `-${n - i}`) + suffix,
      name: (isFront ? 'Front skirt' : 'Back skirt') + (n > 2 ? ` panel ${isFront ? i + 1 : n - i}` : '') + nameSfx,
      role: isFront ? 'front-skirt' : 'back-skirt',
      edges,
      darts: [],
      cutOnFold: i === 0 && frontFold,
      cutCount: i === 0 && frontFold ? 1 : 2,
      grain: 'vertical',
    };
    (isFront ? front : back).push(panel);
  }
  const hemCirc = 2 * Math.PI * f * R;
  const waistF = fit.finished.waist ?? r.waistCm;
  const knots: Knot[] = [{ h: L.waist + WAISTBAND_W, c: waistF }];
  for (let d = 0; d <= len; d += 5) knots.push({ h: L.waist - d, c: waistF + (hemCirc - waistF) * Math.pow(d / len, 0.9) });
  knots.push({ h: L.waist - len, c: hemCirc });
  return { front, back, knots };
}
