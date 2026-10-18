/**
 * Self-checks run on every design package. Each check reports ok / not ok
 * with a plain-language message; `severity` says how serious a failure is
 * (for passing checks it is 'info').
 */
import type { DesignPackage, PatternPiece, QualityCheck } from './types';
import {
  dist,
  distToPolygon,
  isSimplePolygon,
  pathBounds,
  pathLength,
  pointInPolygon,
  polygonArea,
  polygonsOverlap,
  selfIntersections,
  slicePath,
} from './geometry';
import { placePath } from './layout';
import { headCircumference, heelInstepCircumference } from './measurements';
import { SHORT_SLEEVE_UNDERSEAM_MIN, strideHemNeeded } from './fit/plan';
import { frenchSeamBlocker, ZIP_END_ALLOWANCE_CM, zipForOpening } from './drafting/seams';

const SEAM_TOL = 0.3;

function check(id: string, ok: boolean, failSeverity: QualityCheck['severity'], okMsg: string, failMsg: string): QualityCheck {
  return { id, ok, severity: ok ? 'info' : failSeverity, message: ok ? okMsg : failMsg };
}

/** How many physical copies of an edge exist in the finished garment per drafted edge (fold pieces count twice). */
function multiplicity(p: PatternPiece): number {
  return p.cutOnFold ? 2 * p.cutCount : p.cutCount;
}

export function runQualityChecks(pkg: DesignPackage): QualityCheck[] {
  const out: QualityCheck[] = [];
  const pieces = pkg.pieces;
  const byId = new Map(pieces.map((p) => [p.id, p]));

  // 1. geometry: closed, simple, finite, cut line encloses seam line
  const badGeom: string[] = [];
  for (const p of pieces) {
    if (!isSimplePolygon(p.seamLine)) badGeom.push(`${p.name}: stitching line crosses itself ${JSON.stringify(selfIntersections(p.seamLine, 1)[0] ?? [])}`);
    if (!isSimplePolygon(p.cutLine)) badGeom.push(`${p.name}: cutting line crosses itself`);
    const outside = p.seamLine.filter((q) => !pointInPolygon(q, p.cutLine) && distToPolygon(q, p.cutLine) > 0.05).length;
    if (outside > 0) badGeom.push(`${p.name}: ${outside} stitching-line points lie outside the cutting line`);
    const lastEdge = p.edges[p.edges.length - 1];
    if (!lastEdge || lastEdge.to !== 0 || p.edges[0].from !== 0) badGeom.push(`${p.name}: edges do not close the outline`);
    for (const e of p.edges) {
      const L = pathLength(p.seamLine, e.from, e.to);
      if (Math.abs(L - e.lengthCm) > 0.05) badGeom.push(`${p.name}.${e.id}: stored length ${e.lengthCm} ≠ ${L.toFixed(2)}`);
    }
  }
  out.push(check('geometry-valid', badGeom.length === 0, 'error', `All ${pieces.length} pieces have closed, non-crossing stitching and cutting lines.`, badGeom.slice(0, 6).join('; ')));

  // 2. seams reference real pieces/edges
  const badRefs: string[] = [];
  for (const s of pkg.seams) {
    for (const side of [s.a, s.b]) {
      if (!side) continue;
      const p = byId.get(side.pieceId);
      if (!p || !p.edges.some((e) => e.id === side.edgeId)) badRefs.push(`${s.id} → ${side.pieceId}.${side.edgeId}`);
    }
  }
  out.push(check('seam-references', badRefs.length === 0, 'error', `All ${pkg.seams.length} seams refer to existing piece edges.`, `Seams refer to missing edges: ${badRefs.slice(0, 6).join(', ')}`));

  // 3. seam lengths match within intended ease
  const mism: string[] = [];
  let pairs = 0;
  for (const s of pkg.seams) {
    if (!s.b) continue;
    const ea = byId.get(s.a.pieceId)?.edges.find((e) => e.id === s.a.edgeId);
    const eb = byId.get(s.b.pieceId)?.edges.find((e) => e.id === s.b!.edgeId);
    if (!ea || !eb) continue;
    pairs++;
    const diff = Math.abs(ea.lengthCm - eb.lengthCm);
    if (Math.abs(diff - s.intendedEaseCm) > SEAM_TOL) mism.push(`${s.id}: ${ea.lengthCm} vs ${eb.lengthCm} cm (intended difference ${s.intendedEaseCm})`);
  }
  out.push(check('seam-lengths', mism.length === 0, 'error', `All ${pairs} seams match within ±${SEAM_TOL} cm of their intended ease.`, `Seam lengths do not match: ${mism.slice(0, 5).join('; ')}`));

  // 4. every edge (except folds and finished edges) is used by a seam
  const used = new Set<string>();
  for (const s of pkg.seams) {
    used.add(`${s.a.pieceId}.${s.a.edgeId}`);
    if (s.b) used.add(`${s.b.pieceId}.${s.b.edgeId}`);
  }
  const unused: string[] = [];
  for (const p of pieces) {
    if (p.layer === 'interfacing') continue;
    for (const e of p.edges) {
      if (e.kind === 'fold' || e.kind === 'facing') continue;
      if (!used.has(`${p.id}.${e.id}`)) unused.push(`${p.id}.${e.id}`);
    }
  }
  out.push(check('edges-joined', unused.length === 0, 'warning', 'Every cut edge is sewn, hemmed or finished by some step.', `Edges without any seam or finish: ${unused.slice(0, 8).join(', ')}`));

  // 5. darts sit on the seam line, apex inside
  const badDarts: string[] = [];
  for (const p of pieces) {
    for (const d of p.darts) {
      const onLine = d.legs.every((l) => p.seamLine.some((q) => dist(q, l) < 0.05));
      if (!onLine) badDarts.push(`${p.id}/${d.id} legs not on the stitching line`);
      if (!pointInPolygon(d.apex, p.seamLine)) badDarts.push(`${p.id}/${d.id} point outside the piece`);
      if (d.intakeCm <= 0 || d.intakeCm > 8) badDarts.push(`${p.id}/${d.id} intake ${d.intakeCm} cm`);
    }
  }
  out.push(check('darts-valid', badDarts.length === 0, 'error', 'All darts start on the stitching line and point inside the piece.', badDarts.slice(0, 5).join('; ')));

  // 6. grainlines and notches
  const badGrain: string[] = [];
  for (const p of pieces) {
    if (!p.grainline.every((g) => pointInPolygon(g, p.cutLine))) badGrain.push(`${p.id} grainline leaves the piece`);
    for (const n of p.notches) {
      const e = p.edges.find((x) => x.id === n.edgeId);
      if (!e) badGrain.push(`${p.id} notch on unknown edge ${n.edgeId}`);
      else if (!slicePath(p.seamLine, e.from, e.to).some((q) => dist(q, n.at) < 0.6)) badGrain.push(`${p.id} notch off its edge ${n.edgeId}`);
    }
  }
  out.push(check('markings', badGrain.length === 0, 'warning', 'Grainlines lie inside every piece and notches sit on their edges.', badGrain.slice(0, 5).join('; ')));

  // 7. ease within sensible ranges
  const r = pkg.measurements;
  const e = pkg.fit.ease;
  const knit = pkg.material.construction === 'knit';
  const cat = pkg.garment.category;
  const easeIssues: string[] = [];
  const lim = (name: string, v: number, lo: number, hi: number) => {
    if (v < lo || v > hi) easeIssues.push(`${name} ease ${v} cm outside ${lo}…${hi} cm`);
  };
  if (cat !== 'skirt' && cat !== 'trousers') lim('bust', e.bust, knit ? -0.12 * r.bustCm : 2, 40);
  lim('hip', e.hip, knit ? -0.12 * r.hipCm : 2, 60);
  const elasticWaist = pkg.fit.options.closure === 'elastic';
  if (!elasticWaist) lim('waist', e.waist, knit ? -0.12 * r.waistCm : 0.5, cat === 'skirt' || cat === 'trousers' ? 8 : 60);
  if (cat === 'trousers') lim('thigh', e.thigh, knit ? -0.12 * r.thighCm : 3, 40);
  out.push(check('ease-range', easeIssues.length === 0, 'warning', `Ease is within comfortable limits for a ${pkg.fit.fit} ${knit ? 'knit' : 'woven'} garment.`, easeIssues.join('; ')));

  // 8. wearability: can the garment be put on?
  const wear: string[] = [];
  const zip = pkg.seams.find((s) => s.type === 'zip-invisible' || s.type === 'zip-lapped');
  const zipLen = zipOpeningCm(pkg);
  const closure = pkg.fit.options.closure;
  const stretch = knit ? pkg.material.stretchPct / 100 : 0;
  if (closure === 'invisible-zip' || closure === 'lapped-zip' || (closure === 'buttons' && zip)) {
    let need = 14;
    if (cat !== 'skirt' && cat !== 'trousers') {
      // A bodice whose waist and hem already pass over bust and hips only needs
      // the zip to get the head through the neckline; otherwise it must open past the waist.
      const f = pkg.fit.finished;
      const L = pkg.body.landmarks;
      const pass = r.bustCm + 2;
      const passes =
        (f.waist ?? 0) * (1 + stretch) >= pass &&
        (f.hem ?? 0) * (1 + stretch) >= pass &&
        ((f.hem ?? 0) * (1 + stretch) >= r.hipCm + 2 || pkg.fit.hemHeightFromFloorCm > L.hip);
      const neck = pieces
        .filter((p) => p.layer === 'self')
        .flatMap((p) => p.edges.filter((x) => x.id === 'neck').map((x) => x.lengthCm * multiplicity(p)))
        .reduce((a, b) => a + b, 0);
      need = passes ? Math.max(12, (headCircumference(r.heightCm) + (knit ? 0 : 2) - neck) / 2) : 30;
    }
    if (zipLen < need) wear.push(`zip opening ${zipLen.toFixed(1)} cm is shorter than the ${need.toFixed(0)} cm needed to get the garment on`);
  }
  const neckEdges = pieces.filter((p) => p.layer === 'self').flatMap((p) => p.edges.filter((x) => x.id === 'neck').map((x) => x.lengthCm * multiplicity(p)));
  if (closure === 'none' && neckEdges.length) {
    const neck = neckEdges.reduce((a, b) => a + b, 0) * (1 + 0.8 * stretch);
    const head = headCircumference(r.heightCm) + (knit ? 0 : 2);
    if (neck < head) wear.push(`neck opening ${neck.toFixed(0)} cm is smaller than the head (${head.toFixed(0)} cm) and there is no fastening`);
  }
  if (closure === 'elastic') {
    const wb = byId.get('waistband');
    if (wb) {
      const L = wb.edges.filter((x) => x.id.startsWith('join-')).reduce((a, x) => a + x.lengthCm, 0);
      if (L * (1 + stretch) < r.hipCm + 2) wear.push(`elastic waist casing (${L.toFixed(0)} cm) cannot pass over the hips (${r.hipCm} cm)`);
    }
  }
  if (cat === 'trousers' && pkg.fit.finished.hem !== undefined) {
    const need = heelInstepCircumference(r);
    if (pkg.fit.finished.hem * (1 + stretch) < need) wear.push(`leg opening ${pkg.fit.finished.hem} cm is too small for the foot (${need.toFixed(0)} cm)`);
  }
  if (cat !== 'top' && pkg.fit.finished.hem !== undefined && cat !== 'trousers') {
    // walking: hem must clear the legs in stride, or there must be a vent / slit
    const hasOpening = pieces.some((p) => p.edges.some((x) => x.id === 'vent' || x.id === 'slit' || x.id === 'front-edge'));
    const stride = strideHemNeeded(r, pkg.body.landmarks, pkg.fit.hemHeightFromFloorCm);
    if (!hasOpening && pkg.fit.finished.hem * (1 + stretch) < stride) wear.push(`hem ${pkg.fit.finished.hem} cm is too narrow to walk in (needs ~${stride.toFixed(0)} cm or a vent)`);
  }
  out.push(check('wearable', wear.length === 0, 'error', 'The garment can be put on and walked in: openings, zip and hem width are sufficient.', wear.join('; ')));

  // 9. layouts: inside the fabric, no overlaps, all pieces placed
  const layoutIssues: string[] = [];
  for (const l of pkg.layouts) {
    const usable = l.fold === 'folded' ? l.fabricWidthCm / 2 : l.fabricWidthCm;
    const placed = l.placements.map((pl) => ({ pl, poly: byId.get(pl.pieceId) ? placePath(byId.get(pl.pieceId)!.cutLine, pl) : [] }));
    for (const { pl, poly } of placed) {
      const b = pathBounds(poly);
      if (b.minX < -0.01 || b.maxX > usable + 0.01 || b.minY < -0.01) layoutIssues.push(`${pl.pieceId} #${pl.copy} lies outside the ${l.layer} fabric (${b.minX.toFixed(1)}…${b.maxX.toFixed(1)} of ${usable} cm)`);
    }
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        if (polygonsOverlap(placed[i].poly, placed[j].poly)) layoutIssues.push(`${placed[i].pl.pieceId} overlaps ${placed[j].pl.pieceId} on the ${l.layer} layout`);
      }
    }
    for (const p of pieces.filter((x) => x.layer === l.layer)) {
      const n = l.placements.filter((x) => x.pieceId === p.id).length;
      const expected = l.fold === 'folded' ? (p.cutOnFold ? p.cutCount : Math.ceil(p.cutCount / 2)) : p.cutOnFold ? 2 * p.cutCount : p.cutCount;
      if (n !== expected) layoutIssues.push(`${p.id}: ${n} placements, expected ${expected}`);
    }
  }
  const layers = new Set(pieces.map((p) => p.layer));
  for (const layer of layers) if (!pkg.layouts.some((l) => l.layer === layer)) layoutIssues.push(`no cutting layout for ${layer}`);
  out.push(check('layout-valid', layoutIssues.length === 0, 'error', `Cutting layouts fit the fabric width with no overlaps (${pkg.layouts.map((l) => `${l.layer} ${(l.lengthCm / 100).toFixed(2)} m`).join(', ')}).`, layoutIssues.slice(0, 5).join('; ')));

  // 10. silhouette sanity for the 3D model
  const silIssues: string[] = [];
  const rings = [...pkg.silhouette.torso, ...(pkg.silhouette.leg ?? [])];
  for (const ring of rings) {
    if (![ring.heightCm, ring.circumferenceCm, ring.bodyCircumferenceCm, ring.depthRatio].every(Number.isFinite)) silIssues.push(`non-finite ring at ${ring.heightCm}`);
    else if (ring.circumferenceCm < ring.bodyCircumferenceCm) silIssues.push(`garment inside body at ${ring.heightCm} cm`);
  }
  const t = pkg.silhouette.torso;
  for (let i = 1; i < t.length; i++) if (t[i].heightCm >= t[i - 1].heightCm) silIssues.push('torso rings are not ordered top to bottom');
  if (t.length < 3) silIssues.push('too few silhouette rings');
  out.push(check('silhouette', silIssues.length === 0, 'error', `3D silhouette has ${rings.length} rings, all outside the body.`, silIssues.slice(0, 4).join('; ')));

  // 11. hem placement
  const hemH = pkg.fit.hemHeightFromFloorCm;
  const L = pkg.body.landmarks;
  const calfBand = hemH > L.calf - 3 && hemH < L.calf + 3 && cat !== 'trousers' && cat !== 'top';
  out.push(check('hem-placement', hemH + (pkg.fit.shoeHeelCm ?? 0) >= 0 && !calfBand, 'warning', `Hem sits ${hemH} cm from the floor, clear of the widest part of the calf.`, calfBand ? `Hem at ${hemH} cm cuts across the widest part of the calf (${L.calf.toFixed(0)} cm).` : `Hem height ${hemH} cm is invalid.`));

  // 12. fabric quantity in the bill of materials covers the layout
  const fabric = pkg.bom.find((b) => b.kind === 'fabric' && b.essential);
  const selfLayout = pkg.layouts.find((l) => l.layer === 'self');
  if (fabric && selfLayout) {
    const metres = fabric.unit === 'm' ? fabric.quantity : fabric.unit === 'cm' ? fabric.quantity / 100 : fabric.quantity;
    out.push(check('bom-fabric', metres * 100 >= selfLayout.lengthCm - 0.5, 'warning', `Bill of materials buys ${metres} m of fabric for a ${(selfLayout.lengthCm / 100).toFixed(2)} m layout.`, `Bill of materials lists ${metres} m but the cutting layout needs ${(selfLayout.lengthCm / 100).toFixed(2)} m.`));
  }

  // 13. instructions cover every seam and piece
  if (pkg.instructions.length) {
    const seamIds = new Set(pkg.instructions.flatMap((s) => s.seamIds));
    const pieceIds = new Set(pkg.instructions.filter((s) => s.phase === 'cut').flatMap((s) => s.pieceIds));
    const missingSeams = pkg.seams.filter((s) => !seamIds.has(s.id)).map((s) => s.id);
    const missingPieces = pieces.filter((p) => !pieceIds.has(p.id)).map((p) => p.id);
    out.push(
      check(
        'instructions-coverage',
        missingSeams.length === 0 && missingPieces.length === 0,
        'warning',
        `Instructions cover all ${pkg.seams.length} seams and all ${pieces.length} pieces.`,
        `Not covered by instructions: ${[...missingSeams.map((x) => `seam ${x}`), ...missingPieces.map((x) => `piece ${x}`)].slice(0, 6).join(', ')}`,
      ),
    );
  }

  // 15. seam types can actually be sewn (no French seam on a facing, binding, curve or zip)
  const badFrench = pkg.seams
    .filter((s) => s.type === 'french')
    .map((s) => ({ id: s.id, why: frenchSeamBlocker(s, pieces, pkg.seams) }))
    .filter((x) => x.why !== null);
  out.push(
    check(
      'seam-types',
      badFrench.length === 0,
      'warning',
      'Every seam type can be sewn as specified.',
      `French seam impossible on: ${badFrench.slice(0, 4).map((x) => `${x.id} (${x.why})`).join(', ')}`,
    ),
  );

  // 16. the drafted zip opening (all its edges together) matches a zip sold in shops
  const zipIssues: string[] = [];
  if (zip) {
    const type = zip.type as 'zip-invisible' | 'zip-lapped';
    const opening = zipOpeningCm(pkg);
    const z = zipForOpening(opening, type);
    const drafted = opening + ZIP_END_ALLOWANCE_CM[type];
    if (Math.abs(z - drafted) > 0.6) zipIssues.push(`${opening.toFixed(1)} cm opening needs a ${drafted.toFixed(1)} cm zip, not a standard length (nearest ${z} cm)`);
  }
  out.push(check('zip-length', zipIssues.length === 0, 'warning', 'The zip opening is drafted to a standard zip length.', zipIssues.join('; ')));

  // 17. armhole balance: the back armhole is at least as long as the front
  // (within 0.5 cm), else the sleeve pulls forward and the front armhole gapes.
  const armholeOf = (roles: ReadonlySet<string>) =>
    pieces
      .filter((p) => p.layer === 'self' && roles.has(p.role))
      .flatMap((p) => p.edges.filter((e) => e.id.startsWith('armhole')))
      .reduce((a, e) => a + e.lengthCm, 0);
  const frontAH = armholeOf(new Set(['front-bodice', 'front-dress']));
  const backAH = armholeOf(new Set(['back-bodice', 'back-dress']));
  if (frontAH > 0 && backAH > 0) {
    out.push(
      check(
        'armhole-balance',
        backAH >= frontAH - 0.5,
        'warning',
        `Back armhole ${backAH.toFixed(1)} cm ≥ front ${frontAH.toFixed(1)} cm: the sleeve hangs straight.`,
        `Front armhole ${frontAH.toFixed(1)} cm is longer than the back ${backAH.toFixed(1)} cm: the sleeve will pull forward and the front armhole gape.`,
      ),
    );
  }
  // 18. a short sleeve has an underarm seam long enough to hang and cover the armpit
  const sleeve = pieces.find((p) => p.role === 'sleeve' && p.layer === 'self');
  if (sleeve && pkg.fit.options.sleeve === 'short') {
    const under = sleeve.edges.find((e) => e.id === 'underarm-front')?.lengthCm ?? 0;
    out.push(
      check(
        'short-sleeve-underseam',
        under >= SHORT_SLEEVE_UNDERSEAM_MIN - 0.5,
        'warning',
        `Short sleeve underarm seam ${under.toFixed(1)} cm: it hangs down the arm.`,
        `Short sleeve underarm seam is only ${under.toFixed(1)} cm: it is really a cap sleeve and will flare off the arm.`,
      ),
    );
  }

  // 14. pieces have sensible size
  const tiny = pieces.filter((p) => polygonArea(p.seamLine) < 4).map((p) => p.id);
  out.push(check('piece-size', tiny.length === 0, 'warning', 'All pieces have a workable size.', `Very small pieces: ${tiny.join(', ')}`));
  return out;
}

/** Total drafted zip opening (cm): every distinct main-fabric zip edge (bodice + skirt on a gown). */
function zipOpeningCm(pkg: DesignPackage): number {
  const seen = new Set<string>();
  let total = 0;
  for (const s of pkg.seams) {
    if (s.type !== 'zip-invisible' && s.type !== 'zip-lapped') continue;
    const key = `${s.a.pieceId}.${s.a.edgeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += pkg.pieces.find((p) => p.id === s.a.pieceId)?.edges.find((x) => x.id === s.a.edgeId)?.lengthCm ?? 0;
  }
  return total;
}
