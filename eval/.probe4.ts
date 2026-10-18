import { bodiceFrame } from '../src/core/drafting/blocks/bodice';
import { resolveMeasurements } from '../src/core/measurements';
import { getProfile, PROFILES } from './profiles';
import { pathLength } from '../src/core/geometry';
for (const p of PROFILES) {
  const r = resolveMeasurements(p.measurements);
  const f = bodiceFrame({ r, bustF: r.bustCm + 8, waistF: r.waistCm + 6, fit: 'regular', knit: false, sleeveless: false, neckline: 'jewel', waistDarts: true });
  console.log(p.id, 'dx', f.dx.toFixed(2), 'F', pathLength(f.armF).toFixed(1), 'B', pathLength(f.armB).toFixed(1), 'spF', f.spF.x.toFixed(1), f.spF.y.toFixed(1), 'spB', f.spB.x.toFixed(1), f.spB.y.toFixed(1), 'chest', f.chestY.toFixed(1));
}
void getProfile;
