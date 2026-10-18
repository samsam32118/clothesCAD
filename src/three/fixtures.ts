/**
 * Hand-crafted design inputs for exercising the 3D module without the
 * drafting engine (tests, demos). Each fixture is a plausible silhouette for a
 * garment family on a given body; it is not a substitute for `design()`.
 */
import type { BodyLandmarks, MaterialPreset, Neckline, ResolvedMeasurements, Silhouette, SilhouetteRing } from '../core/types';
import type { FigureSource } from './garment';

/** Reference body (168 cm, 88/70/94) with all measurements resolved. */
export const REFERENCE_MEASUREMENTS: ResolvedMeasurements = {
  heightCm: 168,
  bustCm: 88,
  waistCm: 70,
  hipCm: 94,
  underbustCm: 75.7,
  highHipCm: 84.4,
  neckCm: 36.9,
  shoulderWidthCm: 39.1,
  shoulderLengthCm: 12.3,
  backWaistLengthCm: 41.2,
  frontWaistLengthCm: 46.3,
  shoulderToBustPointCm: 25.6,
  bustPointDistanceCm: 18.1,
  armLengthCm: 58.8,
  upperArmCm: 27.8,
  elbowCm: 23.9,
  wristCm: 15.4,
  waistToHipCm: 20.7,
  waistToFloorCm: 104.2,
  waistToKneeCm: 58.8,
  crotchDepthCm: 28.2,
  inseamCm: 76,
  thighCm: 56.4,
  kneeCm: 36.9,
  calfCm: 34.9,
  ankleCm: 22.6,
  estimated: [],
};

export const REFERENCE_LANDMARKS: BodyLandmarks = {
  head: 168,
  nape: 145.4,
  shoulder: 143.384,
  bust: 121.965,
  underbust: 112.89,
  waist: 104.2,
  highHip: 94.2,
  hip: 83.5,
  crotch: 76,
  knee: 45.4,
  calf: 34.48,
  ankle: 7.56,
  elbow: 110.456,
  wrist: 84.584,
};

export type FixtureKind =
  | 'pencil-skirt'
  | 'a-line-skirt'
  | 'circle-skirt'
  | 'wide-leg-trousers'
  | 'tapered-trousers'
  | 'shell-top'
  | 'sheath-dress'
  | 'column-gown'
  | 'ball-gown';

export const FIXTURE_KINDS: FixtureKind[] = [
  'pencil-skirt',
  'a-line-skirt',
  'circle-skirt',
  'wide-leg-trousers',
  'tapered-trousers',
  'shell-top',
  'sheath-dress',
  'column-gown',
  'ball-gown',
];

type Render = Pick<MaterialPreset, 'render' | 'stiffness' | 'weightGsm' | 'sheen'> &
  Partial<Pick<MaterialPreset, 'id' | 'name' | 'fiber' | 'construction' | 'stretchPct'>>;

export const FIXTURE_MATERIALS: Record<'wool' | 'linen' | 'silk' | 'taffeta', Render> = {
  wool: {
    id: 'fixture-wool-crepe',
    name: 'Wool crepe',
    fiber: 'wool',
    construction: 'woven',
    stiffness: 0.45,
    weightGsm: 260,
    sheen: 'matte',
    render: { baseColor: '#3b4a5a', roughness: 0.9, sheen: 0.2 },
  },
  linen: {
    id: 'fixture-linen',
    name: 'Mid-weight linen',
    fiber: 'linen',
    construction: 'woven',
    stiffness: 0.55,
    weightGsm: 200,
    sheen: 'matte',
    render: { baseColor: '#d9cbb3', roughness: 0.85, sheen: 0.1 },
  },
  silk: {
    id: 'fixture-silk-charmeuse',
    name: 'Silk charmeuse',
    fiber: 'silk',
    construction: 'woven',
    stiffness: 0.1,
    weightGsm: 90,
    sheen: 'lustrous',
    render: { baseColor: '#8c1c3a', roughness: 0.35, sheen: 0.9 },
  },
  taffeta: {
    id: 'fixture-silk-taffeta',
    name: 'Silk taffeta',
    fiber: 'silk',
    construction: 'woven',
    stiffness: 0.8,
    weightGsm: 120,
    sheen: 'high',
    render: { baseColor: '#1f3b2d', roughness: 0.3, sheen: 0.8 },
  },
};

const ring = (heightCm: number, circumferenceCm: number, bodyCircumferenceCm: number, depthRatio: number): SilhouetteRing => ({
  heightCm,
  circumferenceCm,
  bodyCircumferenceCm,
  depthRatio,
});

/** Build a fixture silhouette for the given body. */
export function fixtureSilhouette(kind: FixtureKind, m: ResolvedMeasurements, L: BodyLandmarks): Silhouette {
  const W = L.waist;
  const shoulderRing = (ease: number) => ring(L.shoulder, m.bustCm + ease, m.bustCm, 0.62);
  const bodiceRings = (ease: { bust: number; waist: number; hip: number }) => [
    ring(L.bust, m.bustCm + ease.bust, m.bustCm, 0.66),
    ring(L.underbust, m.underbustCm + ease.waist + 1, m.underbustCm, 0.72),
    ring(W, m.waistCm + ease.waist, m.waistCm, 0.75),
    ring(L.highHip, m.highHipCm + ease.hip, m.highHipCm, 0.72),
    ring(L.hip, m.hipCm + ease.hip, m.hipCm, 0.7),
  ];
  const base = (torso: SilhouetteRing[], neckline: Neckline | null, topHeightCm: number): Silhouette => ({
    torso,
    neckline,
    topHeightCm,
    hemHeightCm: Math.min(...torso.map((r) => r.heightCm)),
  });
  switch (kind) {
    case 'pencil-skirt':
      return base(
        [
          ring(W, m.waistCm + 1.5, m.waistCm, 0.75),
          ring(L.highHip, m.highHipCm + 3, m.highHipCm, 0.72),
          ring(L.hip, m.hipCm + 4, m.hipCm, 0.7),
          ring(L.knee + 3, m.hipCm - 2, m.kneeCm * 2, 0.72),
        ],
        null,
        W,
      );
    case 'a-line-skirt':
      return base(
        [
          ring(W, m.waistCm + 1.5, m.waistCm, 0.75),
          ring(L.highHip, m.highHipCm + 4, m.highHipCm, 0.73),
          ring(L.hip, m.hipCm + 6, m.hipCm, 0.74),
          ring(L.knee, m.hipCm * 1.5, m.kneeCm * 2, 0.8),
        ],
        null,
        W,
      );
    case 'circle-skirt': {
      const rw = (m.waistCm + 1) / (2 * Math.PI);
      const hem = L.knee - 4;
      const at = (h: number) => 2 * Math.PI * (rw + (W - h));
      return base(
        [
          ring(W, m.waistCm + 1, m.waistCm, 0.8),
          ring(L.highHip, at(L.highHip), m.highHipCm, 0.85),
          ring(L.hip, at(L.hip), m.hipCm, 0.88),
          ring(hem, at(hem), m.kneeCm * 2, 0.92),
        ],
        null,
        W,
      );
    }
    case 'wide-leg-trousers':
    case 'tapered-trousers': {
      const wide = kind === 'wide-leg-trousers';
      const hem = wide ? 2.5 : L.ankle + 1;
      return {
        torso: [
          ring(W, m.waistCm + 1.5, m.waistCm, 0.75),
          ring(L.highHip, m.highHipCm + 4, m.highHipCm, 0.72),
          ring(L.hip, m.hipCm + 5, m.hipCm, 0.7),
          ring(L.crotch, m.hipCm + 6, m.hipCm, 0.72),
        ],
        leg: [
          ring(L.crotch, m.thighCm + (wide ? 12 : 7), m.thighCm, 0.92),
          ring(L.knee, wide ? m.thighCm + 10 : m.kneeCm + 7, m.kneeCm, 0.92),
          ring(hem, wide ? m.thighCm + 16 : m.ankleCm + 9, m.ankleCm, 0.92),
        ],
        neckline: null,
        topHeightCm: W,
        hemHeightCm: hem,
      };
    }
    case 'shell-top':
      return {
        ...base([shoulderRing(6), ...bodiceRings({ bust: 8, waist: 14, hip: 6 })], 'scoop', L.shoulder - 9),
        sleeve: { lengthCm: 16, topCircumferenceCm: m.upperArmCm + 7, bottomCircumferenceCm: m.upperArmCm + 6 },
      };
    case 'sheath-dress':
      return {
        ...base(
          [shoulderRing(4), ...bodiceRings({ bust: 5, waist: 4, hip: 4 }), ring(L.knee + 2, m.hipCm + 1, m.kneeCm * 2, 0.72)],
          'v',
          L.bust + 3,
        ),
        sleeve: { lengthCm: m.armLengthCm - 1, topCircumferenceCm: m.upperArmCm + 6, bottomCircumferenceCm: m.wristCm + 9 },
      };
    case 'column-gown':
      return base(
        [
          shoulderRing(3),
          ...bodiceRings({ bust: 4, waist: 3, hip: 4 }),
          ring(L.knee, m.hipCm + 8, m.kneeCm * 2, 0.75),
          ring(1.5, m.hipCm + 22, m.ankleCm * 2, 0.8),
        ],
        'boat',
        L.shoulder - 4,
      );
    case 'ball-gown':
      return base(
        [
          ring(L.bust + 8, m.bustCm - 2, m.bustCm - 3, 0.64),
          ring(L.bust, m.bustCm + 3, m.bustCm, 0.66),
          ring(W, m.waistCm + 2, m.waistCm, 0.75),
          ring(L.highHip, m.hipCm * 1.5, m.highHipCm, 0.85),
          ring(L.hip, m.hipCm * 2.0, m.hipCm, 0.9),
          ring(L.knee, m.hipCm * 3.0, m.kneeCm * 2, 0.95),
          ring(1.5, m.hipCm * 3.6, m.ankleCm * 2, 0.95),
        ],
        'sweetheart',
        L.bust + 3,
      );
  }
}

/** A FigureSource (DesignPackage-compatible subset) for tests and demos. */
export function fixtureSource(
  kind: FixtureKind,
  material: Render = FIXTURE_MATERIALS.wool,
  measurements: ResolvedMeasurements = REFERENCE_MEASUREMENTS,
  landmarks: BodyLandmarks = REFERENCE_LANDMARKS,
): FigureSource {
  return {
    id: `fixture-${kind}-${material.id ?? 'm'}`,
    name: `Fixture ${kind}`,
    measurements,
    body: { landmarks },
    silhouette: fixtureSilhouette(kind, measurements, landmarks),
    material,
  };
}
