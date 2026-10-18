import type { MeasurementKey } from '../../core/types';

/**
 * A small front-view croquis showing where each measurement is taken.
 * The active measurement is drawn in the accent colour.
 */

type P = [number, number];

// Right half of the silhouette, top to bottom (x > 60); mirrored for the left.
const RIGHT: P[] = [
  [66, 40], [67, 49], [78, 52], [86, 56], [83, 68], [84, 84], [80, 96], [76, 110],
  [79, 122], [82, 138], [80, 152], [76, 176], [72, 208], [73.5, 228], [67, 272], [70, 288],
  [62, 288], [62, 272], [62.5, 228], [62, 208], [61, 170], [60, 154],
];

function silhouettePath(): string {
  const left = [...RIGHT].reverse().map(([x, y]) => [120 - x, y] as P);
  const pts = [...RIGHT, ...left];
  return `M${pts.map(([x, y]) => `${x} ${y}`).join('L')}Z`;
}

const BODY = silhouettePath();
const ARMS = 'M86 56 L91 80 L94 104 L98 150 M34 56 L29 80 L26 104 L22 150';

const ring = (cy: number, rx: number, cx = 60, ry = 3.6) => ({ kind: 'ring' as const, cx, cy, rx, ry });
const line = (d: string) => ({ kind: 'line' as const, d });

type Mark = ReturnType<typeof ring> | ReturnType<typeof line>;

const MARKS: Record<MeasurementKey, Mark> = {
  heightCm: line('M108 12 L108 288 M104 12 L112 12 M104 288 L112 288'),
  bustCm: ring(84, 25),
  underbustCm: ring(96, 21),
  waistCm: ring(110, 17),
  highHipCm: ring(122, 20),
  hipCm: ring(138, 23),
  neckCm: ring(46, 7, 60, 2.4),
  shoulderWidthCm: line('M34 54 L86 54'),
  shoulderLengthCm: line('M67 49 L86 55'),
  backWaistLengthCm: line('M60 44 L60 110'),
  frontWaistLengthCm: line('M66 49 L71 84 L68 110'),
  shoulderToBustPointCm: line('M66 49 L71 84'),
  bustPointDistanceCm: line('M49 85 L71 85'),
  armLengthCm: line('M87 56 L92 80 L95 104 L99 150'),
  upperArmCm: ring(78, 5, 91, 2.2),
  elbowCm: ring(104, 4.4, 94, 2),
  wristCm: ring(148, 3.6, 98, 1.6),
  waistToHipCm: line('M96 110 L96 138'),
  waistToKneeCm: line('M100 110 L100 208'),
  waistToFloorCm: line('M104 110 L104 288'),
  crotchDepthCm: line('M92 110 L92 152'),
  inseamCm: line('M59 156 L59 288'),
  thighCm: ring(162, 11, 70, 2.6),
  kneeCm: ring(208, 7, 67, 2.2),
  calfCm: ring(228, 6.5, 68, 2.2),
  ankleCm: ring(272, 4, 64.5, 1.6),
};

export function BodyDiagram({ active, label }: { active: MeasurementKey | null; label?: string }) {
  const mark = active ? MARKS[active] : null;
  return (
    <svg className="body-figure" viewBox="0 0 120 296" role="img" aria-label={label ?? 'Body measurement guide'}>
      <path d={BODY} fill="currentColor" fillOpacity={0.07} stroke="currentColor" strokeWidth={1} strokeLinejoin="round" />
      <path d={ARMS} fill="none" stroke="currentColor" strokeOpacity={0.55} strokeWidth={7} strokeLinecap="round" />
      <ellipse cx={60} cy={25} rx={11} ry={14} fill="currentColor" fillOpacity={0.07} stroke="currentColor" strokeWidth={1} />
      {/* faint guide lines for the four essentials */}
      <g className="dim" fill="none" stroke="currentColor" strokeWidth={0.6} strokeDasharray="2 2">
        <ellipse cx={60} cy={84} rx={25} ry={3.6} />
        <ellipse cx={60} cy={110} rx={17} ry={3.6} />
        <ellipse cx={60} cy={138} rx={23} ry={3.6} />
      </g>
      {mark ? (
        <g className="hl" fill="none" strokeLinecap="round">
          {mark.kind === 'ring' ? <ellipse cx={mark.cx} cy={mark.cy} rx={mark.rx} ry={mark.ry} /> : <path d={mark.d} />}
        </g>
      ) : null}
    </svg>
  );
}
