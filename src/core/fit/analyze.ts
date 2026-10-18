/**
 * Body shape analysis.
 *
 * Shape classification follows the circumference-difference rules used in
 * apparel-industry body-shape research (FFIT-style), converted to centimetres:
 *   hourglass family : |bust - hip| small (bust-hip <= 2.5, hip-bust < 9.1) and
 *                      bust-waist >= 22.9 or hip-waist >= 25.4; also "top" and
 *                      "bottom" hourglass where one difference is larger but the
 *                      waist is still clearly defined (>= 22.9 cm).
 *   pear (triangle / spoon): hip - bust >= 9.1 cm without a strongly defined waist.
 *   inverted triangle : bust - hip >= 9.1 cm and bust - waist < 22.9 cm.
 *   rectangle         : bust and hip within 9.1 cm, waist difference small.
 *   round             : waist close to or larger than bust and hip.
 */
import type { BodyAnalysis, BodyShape, ResolvedMeasurements } from '../types';
import { computeLandmarks } from '../measurements';

/** Inch thresholds of the FFIT rules converted to cm. */
export const SHAPE_RULES = {
  smallDiff: 2.54, // 1"
  sideDiff: 9.14, // 3.6"
  bustWaistDefined: 22.86, // 9"
  hipWaistDefined: 25.4, // 10"
  curvyLimit: 15, // beyond this bust/hip difference the larger side dominates the shape
  roundWaistToHip: 0.95,
  roundWaistToBust: 0.92,
} as const;

export function classifyShape(bust: number, waist: number, hip: number): BodyShape {
  const R = SHAPE_RULES;
  const bh = bust - hip;
  const hb = hip - bust;
  const bw = bust - waist;
  const hw = hip - waist;
  if (waist / hip >= R.roundWaistToHip && waist / bust >= R.roundWaistToBust) return 'round';
  if (waist >= bust && waist >= hip - R.smallDiff) return 'round';
  // Hourglass (balanced)
  if (bh <= R.smallDiff && hb < R.sideDiff && (bw >= R.bustWaistDefined || hw >= R.hipWaistDefined)) return 'hourglass';
  // Bottom hourglass: hips fuller but waist well defined
  if (hb >= R.sideDiff && hb < R.curvyLimit && hw >= R.hipWaistDefined && bw >= 0.75 * R.bustWaistDefined) return 'hourglass';
  // Top hourglass: bust fuller but waist well defined
  if (bh > R.smallDiff && bh < R.curvyLimit && bw >= R.bustWaistDefined && hw >= 0.75 * R.bustWaistDefined) return 'hourglass';
  if (hb >= R.sideDiff) return 'pear';
  if (bh >= R.sideDiff) return 'inverted-triangle';
  // Bust and hip within 9 cm: decide by waist definition
  if (bw >= R.bustWaistDefined || hw >= R.hipWaistDefined) return 'hourglass';
  // slight pear / slight inverted with little waist -> rectangle
  return 'rectangle';
}

const SHAPE_NOTES: Record<BodyShape, string[]> = {
  hourglass: [
    'Your bust and hip are balanced with a clearly defined waist, so garments that mark the waist (wrap fronts, waist seams, belts) follow your natural curve instead of hiding it.',
    'Fitted or semi-fitted shapes work better than boxy ones: straight, unshaped garments hang from bust to hip and lose the waist, making the figure look wider than it is.',
    'V, scoop and sweetheart necklines echo the curve of the bust and keep the upper body in proportion.',
  ],
  pear: [
    'Your hip is fuller than your bust, so the eye should be drawn upward and the hip skimmed rather than gripped: A-line and gently flared skirts glide over the hip.',
    'Boat, square and wide scoop necklines widen the shoulder line visually, balancing it with the hip.',
    'Hems that end at the high hip or below the fullest part of the thigh avoid drawing a horizontal line across the widest point.',
  ],
  'inverted-triangle': [
    'Your shoulders and bust are fuller than your hip, so adding gentle volume below the waist (A-line, circle or pleated skirts, wide-leg trousers) balances the silhouette.',
    'V and scoop necklines break up the width across the chest; avoid boat necks and wide shoulder details that add more width on top.',
    'Keep the bodice clean and fitted; place detail and fullness in the skirt or trouser leg.',
  ],
  rectangle: [
    'Your bust, waist and hip are close in size, giving a long, straight line that suits clean, architectural shapes such as shift dresses, column gowns and straight trousers.',
    'If you want more curve, a defined waist (wrap dress, waist seam, belt) plus a little hem flare creates the illusion of an hourglass.',
    'Square and sweetheart necklines add shape at the top; flared skirts add shape at the bottom.',
  ],
  round: [
    'Your waist is close to (or larger than) your bust and hip, so garments that skim the middle rather than cinch it look best: shift shapes, empire lines and fluid fabrics.',
    'A V neckline creates a long vertical line that lengthens the torso.',
    'Keep the waist ease generous and let the hem fall straight or with a gentle flare; avoid tight waistbands that cut across the middle.',
  ],
};

/** Shape analysis, ratios, landmark heights and plain-language styling notes with reasons. */
export function analyzeBody(r: ResolvedMeasurements): BodyAnalysis {
  const landmarks = computeLandmarks(r);
  const shape = classifyShape(r.bustCm, r.waistCm, r.hipCm);
  const ratios = {
    waistToHip: r.waistCm / r.hipCm,
    waistToBust: r.waistCm / r.bustCm,
    bustToHip: r.bustCm / r.hipCm,
    legToHeight: r.waistToFloorCm / r.heightCm,
    torsoToLeg: (r.heightCm - r.waistToFloorCm) / r.waistToFloorCm,
  };
  const notes = [...SHAPE_NOTES[shape]];

  if (r.heightCm < 160) {
    notes.push(
      `At ${Math.round(r.heightCm)} cm you are petite: knee-length or just-below-knee hems and unbroken vertical lines keep your proportions balanced, while very full or very long skirts can overwhelm the frame.`,
    );
  } else if (r.heightCm > 175) {
    notes.push(
      `At ${Math.round(r.heightCm)} cm you are tall: you carry midi, ankle and floor lengths and generous volume easily; every length in the pattern has been scaled to your height, so expect to need more fabric than standard.`,
    );
  }
  if (ratios.legToHeight >= 0.63) {
    notes.push('Your legs are long relative to your height: dropped or natural waistlines and longer tops balance a short torso.');
  } else if (ratios.legToHeight <= 0.58) {
    notes.push('Your legs are a little shorter relative to your height: high-waisted skirts and trousers and a defined natural waist lengthen the leg line.');
  }
  const cup = r.bustCm - r.underbustCm;
  if (cup >= 18) {
    notes.push(`Your bust is full relative to your ribcage (${Math.round(cup)} cm difference), so the bodice gets a larger bust dart; this stops the hem riding up at the front and keeps side seams vertical.`);
  } else if (cup <= 9) {
    notes.push('Your bust is small relative to your ribcage, so bust darts are kept small; boat and square necklines and soft draping add gentle shape.');
  }
  const shoulderBalance = r.shoulderWidthCm / (r.hipCm / Math.PI);
  if (shoulderBalance > 1.35) {
    notes.push('Your shoulders are broad compared with your hip: avoid extra width at the shoulder and keep sleeves set in neatly at the natural shoulder point.');
  } else if (shoulderBalance < 1.15) {
    notes.push('Your shoulders are narrow compared with your hip: boat necklines and cap or short sleeves extend the shoulder line for balance.');
  }
  if (r.calfCm > 0.42 * r.hipCm) {
    notes.push('Your calves are shapely: hems sitting just below the knee or just below the widest part of the calf are more flattering than a hem across the fullest point.');
  }
  return { shape, ratios, landmarks, notes };
}
