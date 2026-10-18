/**
 * Drafting engine entry point: one drafter per garment type, built on shared
 * blocks (skirt block, bodice block / princess panels, trouser block, sleeve
 * block).
 */
import type { PatternPiece, SeamSpec, Silhouette } from '../types';
import type { DraftContext } from './context';
import { draftSkirt } from './garments/skirts';
import { draftTrouserGarment } from './garments/trousers';
import { draftBallGown, draftBlockDress, draftPrincessDress, draftWrapDress } from './garments/bodiced';

export type { DraftContext } from './context';
export { buildPiece, edgePoints, edgeLength, cutInstruction } from './piece';
export { STAGE } from './seams';
import { STAGE, resolveSeamTypes } from './seams';

export function draftGarment(ctx: DraftContext): { pieces: PatternPiece[]; seams: SeamSpec[]; silhouette: Silhouette } {
  const out = draftByType(ctx);
  const seams = withCentreSeams(out.pieces, out.seams);
  return { ...out, seams: resolveSeamTypes(out.pieces, seams, ctx.material) };
}

/**
 * Pieces whose centre edge became a seam (too wide to cut on the fold) need a
 * centre seam joining the two mirrored halves.
 */
function withCentreSeams(pieces: PatternPiece[], seams: SeamSpec[]): SeamSpec[] {
  const used = new Set<string>();
  for (const s of seams) {
    used.add(`${s.a.pieceId}.${s.a.edgeId}`);
    if (s.b) used.add(`${s.b.pieceId}.${s.b.edgeId}`);
  }
  const extra: SeamSpec[] = [];
  for (const p of pieces) {
    for (const e of p.edges) {
      if (e.kind !== 'seam' || !['cf', 'cb', 'centre'].includes(e.id) || used.has(`${p.id}.${e.id}`)) continue;
      extra.push({
        id: `${p.id}-${e.id}-seam`,
        type: 'plain',
        a: { pieceId: p.id, edgeId: e.id },
        b: { pieceId: p.id, edgeId: e.id },
        intendedEaseCm: 0,
        stage: p.layer === 'lining' ? STAGE.liningSeams : p.role.includes('facing') ? STAGE.facingPrep : STAGE.centreSeam,
        finish: 'Stitch the two halves together along the centre line; finish and press open.',
        note: 'Centre seam (this piece is too wide to cut on the fold of your fabric).',
      });
    }
  }
  return [...seams, ...extra];
}

function draftByType(ctx: DraftContext): { pieces: PatternPiece[]; seams: SeamSpec[]; silhouette: Silhouette } {
  switch (ctx.garment.id) {
    case 'a-line-skirt':
    case 'pencil-skirt':
    case 'circle-skirt':
      return draftSkirt(ctx);
    case 'wide-leg-trousers':
    case 'tapered-trousers':
      return draftTrouserGarment(ctx);
    case 'shell-top':
    case 'shift-dress':
      return draftBlockDress(ctx);
    case 'sheath-dress':
    case 'column-gown':
      return draftPrincessDress(ctx);
    case 'wrap-dress':
      return draftWrapDress(ctx);
    case 'ball-gown':
      return draftBallGown(ctx);
  }
}
