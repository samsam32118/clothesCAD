/**
 * Parametric female figure (dress-form / mannequin) described as a set of
 * "tube parts": each part is a stack of elliptical cross-sections along an
 * axis, smoothly interpolated between anatomical landmark stations with a
 * monotone Catmull-Rom spline, and closed with elliptical domes.
 *
 * The same description is used to build the mesh (see body.ts) and to answer
 * geometric queries (cross-section hull at a height, point containment) so
 * that the garment builder and the validator agree with what is rendered.
 *
 * Units: centimetres. Axes: y up (floor at y = 0), the figure faces +z, x is
 * the figure's left. No three.js / DOM dependency.
 */
import type { BodyLandmarks, ResolvedMeasurements } from '../core/types';
import {
  SmoothCurve,
  TAU,
  clamp,
  convexHull,
  ellipseFromPerimeter,
  ellipseRadial,
  lerp,
  polygonPerimeter,
  wrapAngle,
  type Vec2,
} from './math';

export type Vec3 = [number, number, number];

export interface Section {
  /** Semi-axis along the frame's u axis. */
  a: number;
  /** Semi-axis along the frame's w axis. */
  b: number;
  /** Section centre offset from the axis along u / w. */
  ou: number;
  ow: number;
}

export interface Frame {
  origin: Vec3;
  /** Axis direction (s grows along d). */
  d: Vec3;
  /** Lateral axis (phi = π/2). */
  u: Vec3;
  /** Front axis (phi = 0). */
  w: Vec3;
}

export type PartKind = 'torso' | 'neck' | 'head' | 'leg' | 'foot' | 'arm';

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** A body part: cross-sections along an axis. */
export class TubePart {
  /** True when (u, w, d) is left-handed (mirrored part): mesh winding must flip. */
  readonly mirrored: boolean;

  constructor(
    readonly name: string,
    readonly kind: PartKind,
    readonly frame: Frame,
    readonly s0: number,
    readonly s1: number,
    private readonly sectionFn: (s: number) => Section,
    private readonly bumpFn: ((s: number, phi: number) => number) | null,
    /** Row positions along s used for meshing (ascending, spanning [s0, s1]). */
    readonly rows: number[],
    /** Mesh columns around the section. */
    readonly cols: number,
  ) {
    this.mirrored = dot(cross(frame.u, frame.w), frame.d) < 0;
  }

  get vertical(): boolean {
    return Math.abs(this.frame.d[1] + 1) < 1e-9;
  }

  section(s: number): Section {
    if (s < this.s0 || s > this.s1) return { a: 0, b: 0, ou: 0, ow: 0 };
    return this.sectionFn(s);
  }

  bump(s: number, phi: number): number {
    return this.bumpFn ? this.bumpFn(s, phi) : 0;
  }

  /** Radius of the section boundary from its centre in direction phi. */
  radial(s: number, phi: number): number {
    const sec = this.section(s);
    if (sec.a <= 0 || sec.b <= 0) return 0;
    return ellipseRadial(sec.a, sec.b, phi) + this.bump(s, phi);
  }

  /** Section centre in world space. */
  centre(s: number, sec: Section = this.section(s)): Vec3 {
    const { origin: o, d, u, w } = this.frame;
    return [
      o[0] + s * d[0] + sec.ou * u[0] + sec.ow * w[0],
      o[1] + s * d[1] + sec.ou * u[1] + sec.ow * w[1],
      o[2] + s * d[2] + sec.ou * u[2] + sec.ow * w[2],
    ];
  }

  /** World point at axis position s, angle phi, radius r from the section centre. */
  pointAt(s: number, phi: number, r: number, sec: Section = this.section(s)): Vec3 {
    const c = this.centre(s, sec);
    const { u, w } = this.frame;
    const su = Math.sin(phi) * r;
    const sw = Math.cos(phi) * r;
    return [c[0] + su * u[0] + sw * w[0], c[1] + su * u[1] + sw * w[1], c[2] + su * u[2] + sw * w[2]];
  }

  /** Surface point (radius = radial + offset). */
  surfacePoint(s: number, phi: number, offset = 0): Vec3 {
    const sec = this.section(s);
    const r = sec.a > 0 && sec.b > 0 ? ellipseRadial(sec.a, sec.b, phi) + this.bump(s, phi) : 0;
    return this.pointAt(s, phi, r + offset, sec);
  }

  /**
   * Signed penetration of a world point into this part inflated by `margin`:
   * > 0 means the point is inside (by that many cm, measured radially).
   */
  penetration(p: Vec3, margin: number): number {
    const { origin: o, d, u, w } = this.frame;
    const rel: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    const s = dot(rel, d);
    if (s < this.s0 || s > this.s1) return -Infinity;
    const sec = this.sectionFn(s);
    if (sec.a <= 0 || sec.b <= 0) return -Infinity;
    const pu = dot(rel, u) - sec.ou;
    const pw = dot(rel, w) - sec.ow;
    const dist = Math.hypot(pu, pw);
    const phi = Math.atan2(pu, pw);
    const r = ellipseRadial(sec.a, sec.b, phi) + this.bump(s, phi);
    return r + margin - dist;
  }

  /** Axis coordinate s for a world height (vertical parts only). */
  sAtHeight(h: number): number {
    return this.frame.origin[1] - h;
  }

  /** Boundary points (x, z) of the horizontal cross-section at height h (vertical parts only). */
  boundaryAt(h: number, samples = 72): Vec2[] {
    if (!this.vertical) return [];
    const s = this.sAtHeight(h);
    if (s < this.s0 || s > this.s1) return [];
    const sec = this.sectionFn(s);
    if (sec.a <= 0 || sec.b <= 0) return [];
    const pts: Vec2[] = [];
    for (let i = 0; i < samples; i++) {
      const phi = (i / samples) * TAU;
      const p = this.surfacePoint(s, phi);
      pts.push([p[0], p[2]]);
    }
    return pts;
  }
}

// ---------------------------------------------------------------------------
// Station helpers
// ---------------------------------------------------------------------------

interface Station {
  s: number;
  a: number;
  b: number;
  ou: number;
  ow: number;
}

/**
 * Interpolate stations (sorted by s) with monotone Catmull-Rom curves and close
 * both ends with elliptical domes of the given lengths.
 */
function stationSections(stations: Station[], domeStart: number, domeEnd: number) {
  const ss = stations.map((st) => st.s);
  const ca = new SmoothCurve(ss, stations.map((st) => st.a));
  const cb = new SmoothCurve(ss, stations.map((st) => st.b));
  const cu = new SmoothCurve(ss, stations.map((st) => st.ou));
  const cw = new SmoothCurve(ss, stations.map((st) => st.ow));
  const first = ss[0]!;
  const last = ss[ss.length - 1]!;
  const fn = (s: number): Section => {
    let scale = 1;
    if (s < first) scale = domeStart > 0 ? Math.sqrt(Math.max(0, 1 - ((first - s) / domeStart) ** 2)) : 0;
    else if (s > last) scale = domeEnd > 0 ? Math.sqrt(Math.max(0, 1 - ((s - last) / domeEnd) ** 2)) : 0;
    return { a: ca.at(s) * scale, b: cb.at(s) * scale, ou: cu.at(s), ow: cw.at(s) };
  };
  return { fn, s0: first - domeStart, s1: last + domeEnd, first, last };
}

/** Mesh rows: cosine-spaced in the domes, ~`step` cm in the body of the tube. */
function tubeRows(first: number, last: number, domeStart: number, domeEnd: number, step: number): number[] {
  const rows: number[] = [];
  const domeSteps = 7;
  for (let i = 0; i < domeSteps; i++) {
    const psi = (i / domeSteps) * (Math.PI / 2);
    rows.push(first - domeStart * Math.cos(psi));
  }
  const n = Math.max(2, Math.ceil((last - first) / step));
  for (let i = 0; i <= n; i++) rows.push(first + ((last - first) * i) / n);
  for (let i = 1; i <= domeSteps; i++) {
    const psi = (i / domeSteps) * (Math.PI / 2);
    rows.push(last + domeEnd * Math.sin(psi));
  }
  return rows;
}

function verticalFrame(top: number, mirrored = false): Frame {
  return { origin: [0, top, 0], d: [0, -1, 0], u: [mirrored ? -1 : 1, 0, 0], w: [0, 0, 1] };
}

// ---------------------------------------------------------------------------
// Body model
// ---------------------------------------------------------------------------

export interface BodyModelOptions {
  /** Arm abduction from vertical, degrees (each arm swings out by this angle). */
  armAbductionDeg?: number;
}

export const DEFAULT_ARM_ABDUCTION_DEG = 10;

export interface ArmSpec {
  /** Shoulder joint (axis origin) of the right (+x) arm. */
  joint: Vec3;
  length: number; // shoulder point to wrist
  handLength: number;
  topRadius: number;
}

export class BodyModel {
  readonly torso: TubePart;
  readonly neck: TubePart;
  readonly head: TubePart;
  readonly legs: [TubePart, TubePart];
  readonly feet: [TubePart, TubePart];
  readonly arms: [TubePart, TubePart];
  readonly armSpec: ArmSpec;
  readonly armAbductionDeg: number;
  /** Height of the closed bottom of the torso (just above the crotch). */
  readonly torsoBottom: number;
  readonly underarmHeight: number;
  /** Height of the shoulder ring (shoulder point level). */
  readonly shoulderHeight: number;
  readonly hps: number;
  readonly heightCm: number;
  /** Achieved horizontal circumferences at the measured stations (for diagnostics). */
  readonly fittedCircumferences: Record<string, { target: number; achieved: number; height: number }>;
  private readonly centreZ: SmoothCurve;
  private readonly torsoTop: number;

  constructor(
    readonly measurements: ResolvedMeasurements,
    readonly landmarks: BodyLandmarks,
    options: BodyModelOptions = {},
  ) {
    const m = measurements;
    const L = landmarks;
    const H = m.heightCm;
    this.heightCm = H;
    this.armAbductionDeg = clamp(options.armAbductionDeg ?? DEFAULT_ARM_ABDUCTION_DEG, 0, 80);

    // ---- Torso ------------------------------------------------------------
    const hps = L.nape + 2;
    this.hps = hps;
    const shoulderH = Math.min(L.shoulder, hps - 2.5);
    const cup = Math.max(2, m.bustCm - m.underbustCm);
    const underarm = Math.max(L.bust + 3.5, shoulderH - Math.max(14, 0.1 * H + 0.15 * cup));
    this.underarmHeight = underarm;
    this.shoulderHeight = shoulderH;
    const crotch = L.crotch;
    const shoulderHalf = m.shoulderWidthCm / 2;

    const neckE = ellipseFromPerimeter(m.neckCm, 0.86);
    const upperChestTarget = m.bustCm - 0.3 * cup;
    // Fuller figures have rounder cross-sections (depth grows faster than width).
    const chestK = 0.62 + clamp((m.bustCm - 90) / 100, 0, 0.14);
    const hipK = 0.69 + clamp((m.hipCm - 100) / 120, 0, 0.12);
    const ucE = ellipseFromPerimeter(upperChestTarget, chestK);
    const waistK = clamp(0.7 + 0.5 * (m.waistCm / m.hipCm - 0.72), 0.68, 0.92);

    interface TorsoStation {
      key: string;
      h: number;
      a: number;
      b: number;
      cz: number;
      target?: number;
    }
    const st = (key: string, h: number, circ: number, k: number, cz: number, target?: number): TorsoStation => {
      const e = ellipseFromPerimeter(circ, k);
      return { key, h, a: e.a, b: e.b, cz, target };
    };
    const torsoBottomRing = crotch + 3;
    const thighE = ellipseFromPerimeter(m.thighCm, 0.9);
    const seatCirc = 0.97 * m.hipCm;
    const bottomCirc = Math.min(0.93 * m.hipCm, 2 * Math.PI * thighE.a + 4 * (thighE.a + 1.3) + 2);
    const stations: TorsoStation[] = [
      { key: 'hps', h: hps, a: neckE.a * 1.03, b: neckE.b * 1.03, cz: -1.4 },
      {
        key: 'slope',
        h: hps - 0.35 * (hps - shoulderH),
        a: lerp(neckE.a, shoulderHalf - 1.2, 0.55),
        b: lerp(neckE.b, ucE.b * 0.74, 0.6),
        cz: -1.3,
      },
      { key: 'shoulder', h: shoulderH, a: shoulderHalf - 1.2, b: ucE.b * 0.76, cz: -1.1 },
      { key: 'armTop', h: shoulderH - 0.3 * (shoulderH - underarm), a: shoulderHalf - 2.2, b: ucE.b * 0.9, cz: -0.6 },
      st('underarm', underarm, upperChestTarget, chestK, -0.1, upperChestTarget),
      st('bust', L.bust, m.bustCm * 0.95, chestK + 0.02, 0.2, m.bustCm),
      st('underbust', L.underbust, m.underbustCm, 0.72, 0.2, m.underbustCm),
      st('waist', L.waist, m.waistCm, waistK, 0, m.waistCm),
      st('highHip', L.highHip, m.highHipCm, hipK + 0.02, -0.6, m.highHipCm),
      st('hip', L.hip, m.hipCm, hipK, -1.2, m.hipCm),
      st('seat', (L.hip + torsoBottomRing) / 2, seatCirc, 0.7, -1.0),
      st('bottom', torsoBottomRing, bottomCirc, 0.74, -0.6),
    ];
    // Enforce strictly descending heights (robust to unusual landmark sets).
    for (let i = 1; i < stations.length; i++) {
      const prev = stations[i - 1]!;
      const cur = stations[i]!;
      if (cur.h > prev.h - 1) cur.h = prev.h - 1;
    }

    const torsoTop = hps + 1.2; // top of the closing dome
    this.torsoTop = torsoTop;
    const domeTop = 1.2;
    const domeBottom = 2.4;
    const bustS = torsoTop - L.bust;
    const bustE = ellipseFromPerimeter(m.bustCm, chestK + 0.02);
    const apexAngle = Math.asin(clamp(m.bustPointDistanceCm / 2 / Math.max(bustE.a, 1), 0.2, 0.85));
    const bumpAmp = clamp(0.2 * cup, 0.8, 6.5);
    const sigmaAbove = 6.5 + 0.25 * cup; // upper pole slopes gently from the upper chest
    const sigmaBelow = 3.2 + 0.2 * cup; // lower pole rounds back to the underbust
    const sigmaPhi = 0.42;
    const bump = (s: number, phi: number): number => {
      const dh = s - bustS; // > 0 below the apex
      const sig = dh > 0 ? sigmaBelow : sigmaAbove;
      const gv = Math.exp(-((dh / sig) ** 2));
      if (gv < 1e-4) return 0;
      const p = wrapAngle(phi);
      const g1 = Math.exp(-(((p - apexAngle) / sigmaPhi) ** 2));
      const g2 = Math.exp(-(((p + apexAngle) / sigmaPhi) ** 2));
      return bumpAmp * gv * (g1 + g2);
    };

    const makeTorso = (list: TorsoStation[]) => {
      const sorted = list
        .map((x) => ({ s: torsoTop - x.h, a: x.a, b: x.b, ou: 0, ow: x.cz }))
        .sort((p, q) => p.s - q.s);
      // Station 'hps' sits at s = domeTop, so the closing dome starts at s = 0.
      return stationSections(sorted, domeTop, domeBottom);
    };
    const hullPerimeterAt = (fn: (s: number) => Section, s: number): number => {
      const sec = fn(s);
      const pts: Vec2[] = [];
      for (let i = 0; i < 128; i++) {
        const phi = (i / 128) * TAU;
        const r = ellipseRadial(sec.a, sec.b, phi) + bump(s, phi);
        pts.push([Math.sin(phi) * r, Math.cos(phi) * r]);
      }
      return polygonPerimeter(convexHull(pts));
    };
    // Fit the measured stations so the convex-hull girth (what a tape measures)
    // equals the measurement, accounting for bust shaping and spline blending.
    let sections = makeTorso(stations);
    for (let iter = 0; iter < 6; iter++) {
      let maxErr = 0;
      for (const station of stations) {
        if (station.target === undefined) continue;
        const p = hullPerimeterAt(sections.fn, torsoTop - station.h);
        const ratio = station.target / p;
        maxErr = Math.max(maxErr, Math.abs(1 - ratio));
        station.a *= ratio;
        station.b *= ratio;
      }
      sections = makeTorso(stations);
      if (maxErr < 1e-4) break;
    }
    this.fittedCircumferences = {};
    for (const station of stations) {
      if (station.target === undefined) continue;
      this.fittedCircumferences[station.key] = {
        target: station.target,
        achieved: hullPerimeterAt(sections.fn, torsoTop - station.h),
        height: station.h,
      };
    }
    this.torsoBottom = torsoBottomRing - domeBottom;
    this.torso = new TubePart(
      'torso',
      'torso',
      verticalFrame(torsoTop),
      sections.s0,
      sections.s1,
      sections.fn,
      bump,
      tubeRows(sections.first, sections.last, sections.first - sections.s0, domeBottom, 0.8),
      96,
    );

    // ---- Neck & head ------------------------------------------------------
    const headCirc = 0.13 * H + 34.5;
    const headRy = H / 15.2;
    const headCentreY = H - headRy;
    const headE = ellipseFromPerimeter(headCirc * 0.97, 1.22);
    const neckTop = headCentreY - headRy * 0.35;
    const neckBottom = hps - 3.5;
    const neckSt = stationSections(
      [
        { s: 0, a: neckE.a * 0.86, b: neckE.b * 0.9, ou: 0, ow: 0.2 },
        { s: (neckTop - neckBottom) * 0.6, a: neckE.a * 0.9, b: neckE.b * 0.93, ou: 0, ow: -0.6 },
        { s: neckTop - neckBottom, a: neckE.a * 1.02, b: neckE.b * 1.02, ou: 0, ow: -1.3 },
      ],
      0,
      0,
    );
    this.neck = new TubePart(
      'neck',
      'neck',
      verticalFrame(neckTop),
      neckSt.s0,
      neckSt.s1,
      neckSt.fn,
      null,
      tubeRows(neckSt.first, neckSt.last, 0, 0, 0.8).filter((v, i, arr) => i === 0 || v !== arr[i - 1]),
      48,
    );
    const headTop = H;
    this.head = new TubePart(
      'head',
      'head',
      verticalFrame(headTop),
      0,
      2 * headRy,
      (s) => {
        const t = clamp((s - headRy) / headRy, -1, 1);
        const f = Math.sqrt(Math.max(0, 1 - t * t));
        // Slightly narrower jaw: taper the lower half.
        const jaw = t > 0 ? 1 - 0.12 * t : 1;
        return { a: headE.a * f * jaw, b: headE.b * f, ou: 0, ow: 1.0 + 0.6 * Math.max(0, t) };
      },
      null,
      Array.from({ length: 33 }, (_, i) => headRy * (1 - Math.cos((i / 32) * Math.PI))),
      48,
    );

    // ---- Legs & feet --------------------------------------------------------
    const ankleE = ellipseFromPerimeter(m.ankleCm, 0.8);
    const legTop = crotch + 5;
    const footHeight = 0.043 * H;
    const legBottom = footHeight * 0.75;
    const legStation = (h: number, circ: number, k: number, gap: number, cz: number): Station & { h: number } => {
      const e = ellipseFromPerimeter(circ, k);
      return { h, s: 0, a: e.a, b: e.b, ou: e.a + gap, ow: cz };
    };
    const midThighCirc = m.thighCm - 0.45 * (m.thighCm - m.kneeCm);
    const legStations = [
      // Top of the thigh is buried inside the seat; the legs separate just above the crotch.
      { ...legStation(legTop, m.thighCm * 0.98, 0.92, 0, -0.9), ou: 0.8 * thighE.a },
      legStation(crotch + 0.5, m.thighCm * 1.01, 1.3, 0.85, -0.7),
      legStation(crotch - 2, m.thighCm, 1.22, 0.9, -0.6),
      legStation(lerp(crotch, L.knee, 0.5), midThighCirc, 1.05, 1.3, -0.3),
      legStation(L.knee + 6, m.kneeCm * 1.04, 0.9, 1.7, 0),
      legStation(L.knee, m.kneeCm, 0.92, 1.9, 0.1),
      legStation(L.calf, m.calfCm, 0.9, 1.7, -0.9),
      legStation(lerp(L.calf, L.ankle, 0.55), m.ankleCm + 0.45 * (m.calfCm - m.ankleCm), 0.88, 2.4, -0.5),
      legStation(L.ankle, m.ankleCm, 0.8, 3.2, -0.5),
      legStation(legBottom + 0.6, m.ankleCm * 1.02, 0.85, 3.4, -0.2),
    ];
    for (let i = 1; i < legStations.length; i++) {
      if (legStations[i]!.h > legStations[i - 1]!.h - 0.8) legStations[i]!.h = legStations[i - 1]!.h - 0.8;
    }
    const legSt = stationSections(
      legStations.map((x) => ({ ...x, s: legTop - x.h })),
      2,
      0.6,
    );
    const legTopS = legTop + 2; // origin above the top dome
    const legFn = (s: number) => legSt.fn(s - 2);
    const legRows = tubeRows(legSt.first, legSt.last, 2, 0.6, 0.9).map((s) => s + 2);
    const makeLeg = (mirror: boolean) =>
      new TubePart(
        mirror ? 'leg-right' : 'leg-left',
        'leg',
        verticalFrame(legTopS, mirror),
        legSt.s0 + 2,
        legSt.s1 + 2,
        legFn,
        null,
        legRows,
        64,
      );
    // +x is the figure's left side.
    this.legs = [makeLeg(false), makeLeg(true)];

    const footLen = 0.15 * H;
    const footHalfW = 0.026 * H + 0.03 * m.ankleCm;
    const footRy = footHeight / 2;
    const ankleGap = ankleE.a + 3.4;
    const makeFoot = (mirror: boolean) =>
      new TubePart(
        mirror ? 'foot-right' : 'foot-left',
        'foot',
        verticalFrame(footHeight, mirror),
        0,
        footHeight,
        (s) => {
          const t = clamp((s - footRy) / footRy, -1, 1);
          // Super-ellipsoid profile: flatter sole, rounded instep.
          const f = Math.pow(Math.max(0, 1 - Math.abs(t) ** 2.6), 1 / 2.6);
          // Wedge profile: full length at the sole, short and set back at the instep.
          const up = (1 - t) / 2; // 1 at the top, 0 at the sole
          return {
            a: footHalfW * f * (1 - 0.25 * up),
            b: (footLen / 2) * f * (1 - 0.45 * up),
            ou: ankleGap + 0.6,
            ow: 0.23 * footLen - 0.2 * footLen * up,
          };
        },
        null,
        Array.from({ length: 17 }, (_, i) => footRy * (1 - Math.cos((i / 16) * Math.PI))),
        40,
      );
    this.feet = [makeFoot(false), makeFoot(true)];

    // ---- Arms ---------------------------------------------------------------
    const armLen = m.armLengthCm;
    const handLen = 0.108 * H;
    const deltoidCirc = m.upperArmCm * 1.14;
    const topR = deltoidCirc / TAU;
    const jointY = shoulderH - 0.5 * topR;
    // The upper arm rests against the side of the chest at the armpit: on fuller
    // figures that, not the bony shoulder width, decides where the arm hangs.
    const upperArmR = m.upperArmCm / TAU;
    const restTan = Math.tan((DEFAULT_ARM_ABDUCTION_DEG * Math.PI) / 180);
    const jointX = Math.max(shoulderHalf - 0.75 * topR, ucE.a + 0.35 * upperArmR - (jointY - underarm) * restTan);
    const joint: Vec3 = [jointX, jointY, -1.0];
    this.armSpec = { joint, length: armLen, handLength: handLen, topRadius: topR };
    const armStation = (s: number, circ: number, ratio: number): Station => {
      const e = ellipseFromPerimeter(circ, ratio);
      return { s, a: e.a, b: e.b, ou: 0, ow: 0 };
    };
    const armSt = stationSections(
      [
        armStation(0, deltoidCirc, 1.0),
        armStation(0.25 * armLen, m.upperArmCm, 1.0),
        armStation(0.56 * armLen, m.elbowCm, 1.05),
        armStation(0.68 * armLen, m.elbowCm * 1.04, 1.15),
        armStation(armLen, m.wristCm, 1 / 0.68),
        armStation(armLen + 0.18 * handLen, m.wristCm * 1.12, 1 / 0.5),
        armStation(armLen + 0.5 * handLen, m.wristCm * 1.3, 1 / 0.36),
        armStation(armLen + 0.85 * handLen, m.wristCm * 1.05, 1 / 0.42),
      ],
      topR,
      0.15 * handLen,
    );
    const alpha = (this.armAbductionDeg * Math.PI) / 180;
    const beta = (3 * Math.PI) / 180;
    const makeArm = (mirror: boolean) => {
      const sx = mirror ? -1 : 1;
      const d = norm([sx * Math.sin(alpha) * Math.cos(beta), -Math.cos(alpha) * Math.cos(beta), Math.sin(beta)]);
      const w0: Vec3 = [0, 0, 1];
      const wd = dot(w0, d);
      const w = norm([w0[0] - wd * d[0], w0[1] - wd * d[1], w0[2] - wd * d[2]]);
      let u = cross(w, d); // right-handed (u × w = d)
      if (mirror) u = [-u[0], -u[1], -u[2]];
      const origin: Vec3 = [sx * joint[0], joint[1], joint[2]];
      return new TubePart(
        mirror ? 'arm-right' : 'arm-left',
        'arm',
        { origin, d, u, w },
        armSt.s0,
        armSt.s1,
        armSt.fn,
        null,
        tubeRows(armSt.first, armSt.last, topR, 0.15 * handLen, 0.9),
        36,
      );
    };
    this.arms = [makeArm(false), makeArm(true)];

    // ---- Body centre line (for garment centring) ----------------------------
    const czH: number[] = [];
    const czV: number[] = [];
    for (const s of stations) {
      czH.push(s.h);
      czV.push(s.cz);
    }
    for (const ls of legStations) {
      if (ls.h < torsoBottomRing - 4) {
        czH.push(ls.h);
        czV.push(ls.ow);
      }
    }
    czH.push(0);
    czV.push(legStations[legStations.length - 1]!.ow);
    this.centreZ = new SmoothCurve(czH, czV);
  }

  get parts(): TubePart[] {
    return [this.torso, this.neck, this.head, ...this.legs, ...this.feet, ...this.arms];
  }

  /** Vertical parts a garment wrapping the body (torso / skirt) must clear. */
  get trunkParts(): TubePart[] {
    return [this.torso, this.neck, ...this.legs, ...this.feet];
  }

  /** Front/back centre (z) of the figure at height h — garments are centred here. */
  centreZAt(h: number): number {
    return this.centreZ.at(h);
  }

  get topOfTorso(): number {
    return this.torsoTop;
  }

  /** Convex hull (x, z) of the given vertical parts' cross-sections at height h. */
  hullAt(h: number, parts: TubePart[] = this.trunkParts, samples = 72): Vec2[] {
    const pts: Vec2[] = [];
    for (const p of parts) for (const q of p.boundaryAt(h, samples)) pts.push(q);
    return pts.length >= 3 ? convexHull(pts) : [];
  }

  /** Largest penetration of p into any of the given parts (inflated by margin). */
  penetration(p: Vec3, margin: number, parts: TubePart[] = this.parts): { depth: number; part: string | null } {
    let depth = -Infinity;
    let part: string | null = null;
    for (const pt of parts) {
      const d = pt.penetration(p, margin);
      if (d > depth) {
        depth = d;
        part = pt.name;
      }
    }
    return { depth, part };
  }
}
