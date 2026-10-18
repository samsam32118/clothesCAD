/**
 * Compact, JSON-serialisable views of catalogue entries, packages and app
 * state. Used by console output, the agent API and the CLI so all three
 * speak the same shapes.
 */
import type {
  DesignPackage,
  GarmentDefinition,
  GarmentOptions,
  MaterialPreset,
  StylePreset,
} from '../core/types';
import { buildRequest, isDesignStale, type AppData } from './store';

export function garmentSummary(g: GarmentDefinition) {
  return {
    id: g.id,
    name: g.name,
    category: g.category,
    difficulty: g.difficulty,
    occasions: g.occasions,
    fabricTypes: g.fabricTypes,
    description: g.description,
    defaults: g.defaults,
    allowed: g.allowed,
  };
}

export function materialSummary(m: MaterialPreset) {
  return {
    id: m.id,
    name: m.name,
    fiber: m.fiber,
    construction: m.construction,
    weightGsm: m.weightGsm,
    widthCm: m.widthCm,
    stretchPct: m.stretchPct,
    stiffness: m.stiffness,
    sheen: m.sheen,
    beginnerFriendliness: m.beginnerFriendliness,
    regions: m.regions,
    origin: m.origin,
    occasions: m.occasions,
    suitableFor: m.suitableFor,
    color: m.render.baseColor,
    pricePerMeterEur: m.pricePerMeterEur,
    description: m.description,
  };
}

export function styleSummary(s: StylePreset) {
  return {
    id: s.id,
    name: s.name,
    region: s.region,
    subregion: s.subregion,
    description: s.description,
    keywords: s.keywords,
    palette: s.palette,
    occasions: s.occasions,
    recommendedGarments: s.recommendedGarments,
    recommendedMaterials: s.recommendedMaterials,
    defaultFit: s.silhouette.defaultFit,
  };
}

export function fitSummary(pkg: DesignPackage) {
  return {
    bodyShape: pkg.body.shape,
    bodyNotes: pkg.body.notes,
    fit: pkg.fit.fit,
    options: pkg.fit.options,
    easeCm: pkg.fit.ease,
    finishedCm: pkg.fit.finished,
    hemHeightFromFloorCm: pkg.fit.hemHeightFromFloorCm,
    rationale: pkg.fit.rationale,
    estimatedMeasurements: pkg.measurements.estimated,
    measurementIssues: pkg.measurementIssues,
  };
}

export function piecesSummary(pkg: DesignPackage) {
  return pkg.pieces.map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    layer: p.layer,
    cutCount: p.cutCount,
    cutOnFold: p.cutOnFold,
    mirrorPair: p.mirrorPair,
    seamAllowanceCm: p.seamAllowanceCm,
    sizeCm: {
      width: Math.round((p.bounds.maxX - p.bounds.minX) * 10) / 10,
      height: Math.round((p.bounds.maxY - p.bounds.minY) * 10) / 10,
    },
    darts: p.darts.length,
    notches: p.notches.length,
  }));
}

export function stepsSummary(pkg: DesignPackage) {
  return pkg.instructions.map((s) => ({
    n: s.n,
    phase: s.phase,
    title: s.title,
    minutes: s.minutes,
    ...(s.checkpoint ? { checkpoint: s.checkpoint } : {}),
  }));
}

export function layoutsSummary(pkg: DesignPackage) {
  return pkg.layouts.map((l) => ({
    layer: l.layer,
    fabricWidthCm: l.fabricWidthCm,
    fold: l.fold,
    lengthCm: Math.round(l.lengthCm * 10) / 10,
    efficiencyPct: Math.round(l.efficiency * 1000) / 10,
    placements: l.placements.length,
  }));
}

export function qualitySummary(pkg: DesignPackage) {
  const failed = pkg.quality.filter((q) => !q.ok);
  return {
    passed: pkg.quality.length - failed.length,
    total: pkg.quality.length,
    errors: failed.filter((q) => q.severity === 'error').map((q) => ({ id: q.id, message: q.message })),
    warnings: failed.filter((q) => q.severity === 'warning').map((q) => ({ id: q.id, message: q.message })),
    info: failed.filter((q) => q.severity === 'info').map((q) => ({ id: q.id, message: q.message })),
  };
}

export interface OptionSubstitution {
  option: keyof GarmentOptions;
  requested: GarmentOptions[keyof GarmentOptions];
  used: GarmentOptions[keyof GarmentOptions];
  /** Values this garment offers for the option. */
  allowed: Array<string | boolean> | string;
}

/**
 * Options the request asked for that the pipeline replaced (because the
 * garment does not offer them, or a number was clamped). Agents should treat
 * a non-empty list as "you did not get exactly what you asked for".
 */
export function optionSubstitutions(pkg: DesignPackage): OptionSubstitution[] {
  const requested = pkg.request.options ?? {};
  const used = pkg.fit.options;
  const a = pkg.garment.allowed;
  const allowedFor = (k: keyof GarmentOptions): OptionSubstitution['allowed'] => {
    switch (k) {
      case 'length':
        return [...a.length];
      case 'sleeve':
        return [...a.sleeve];
      case 'neckline':
        return [...a.neckline];
      case 'closure':
        return [...a.closure];
      case 'lining':
        return a.lining ? [true, false] : [false];
      case 'pockets':
        return a.pockets ? [true, false] : [false];
      case 'fit':
        return ['fitted', 'regular', 'relaxed'];
      case 'flare':
        return '0..1';
    }
  };
  const out: OptionSubstitution[] = [];
  for (const k of Object.keys(requested) as Array<keyof GarmentOptions>) {
    const want = requested[k];
    if (want === undefined) continue;
    const got = used[k];
    const same = typeof want === 'number' && typeof got === 'number' ? Math.abs(want - got) < 1e-6 : want === got;
    if (!same) out.push({ option: k, requested: want, used: got, allowed: allowedFor(k) });
  }
  return out;
}

/** Plain-language warnings an agent or user should read before trusting the result. */
export function designWarnings(pkg: DesignPackage): string[] {
  const out: string[] = [];
  for (const s of optionSubstitutions(pkg)) {
    out.push(
      `Option ${s.option}=${String(s.requested)} is not available for a ${pkg.garment.name.toLowerCase()}; ${String(s.used)} was used instead (allowed: ${Array.isArray(s.allowed) ? s.allowed.join(', ') : s.allowed}).`,
    );
  }
  for (const i of pkg.measurementIssues.filter((x) => x.severity === 'warning')) out.push(`Measurement ${i.key}: ${i.message}`);
  for (const q of pkg.quality.filter((x) => !x.ok && x.severity === 'error')) out.push(`Quality check failed: ${q.message}`);
  return out;
}

export function designSummary(pkg: DesignPackage) {
  return {
    id: pkg.id,
    name: pkg.name,
    garment: pkg.garment.id,
    style: pkg.style.id,
    material: pkg.material.id,
    effort: pkg.effort,
    fit: fitSummary(pkg),
    pieces: piecesSummary(pkg),
    layouts: layoutsSummary(pkg),
    bom: pkg.bom,
    steps: pkg.instructions.length,
    quality: qualitySummary(pkg),
    /** Requested options that were replaced; empty when you got exactly what you asked for. */
    substitutions: optionSubstitutions(pkg),
    warnings: designWarnings(pkg),
    request: pkg.request,
  };
}

export function stateSnapshot(s: AppData) {
  const req = buildRequest(s);
  return {
    measurementsCm: s.measurements,
    measurementsAreSample: s.measurementsAreSample,
    displayUnit: s.unit,
    selection: s.selection,
    tab: s.tab,
    request: req.ok ? req.request : null,
    requestError: req.ok ? null : req.error,
    design: s.pkg ? { id: s.pkg.id, name: s.pkg.name, stale: isDesignStale(s) } : null,
    designError: s.designError,
  };
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}
