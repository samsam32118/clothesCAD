import type { InstructionStep, MaterialPreset, SeamSpec } from '../types';
import {
  allowanceAtEdge,
  capitalize,
  describeJoin,
  edgeFinish,
  edgeInstances,
  fmt,
  edgePhrase,
  humanEdge,
  isFoldedJoin,
  listJoin,
  materialTimeFactor,
  materialTraits,
  minutes,
  pieceName,
  seamLengthCm,
  seamRepeats,
  zipInfo,
  type InstructionContext,
  type MaterialTraits,
  type PieceIndex,
} from './shared';

/** A step before numbering and glossary detection. */
export type StepDraft = Omit<InstructionStep, 'n' | 'terms'>;

export interface TechniqueEnv {
  ctx: InstructionContext;
  idx: PieceIndex;
  main: MaterialPreset;
  lining: MaterialPreset;
}

interface SeamEnv {
  mat: MaterialPreset;
  t: MaterialTraits;
  sa: number;
  reps: number;
  lengthCm: number;
  aName: string;
  bName: string | null;
  factor: number;
}

function seamEnv(seam: SeamSpec, env: TechniqueEnv): SeamEnv {
  const pa = env.idx.get(seam.a.pieceId);
  const mat = pa?.layer === 'lining' ? env.lining : env.main;
  const fallbackSa = mat.construction === 'knit' ? 1 : 1.5;
  return {
    mat,
    t: materialTraits(mat),
    sa: pa?.seamAllowanceCm || fallbackSa,
    reps: seamRepeats(seam, env.idx),
    lengthCm: seamLengthCm(seam, env.idx),
    aName: pieceName(pa, seam.a.pieceId),
    bName: seam.b ? pieceName(env.idx.get(seam.b.pieceId), seam.b.pieceId) : null,
    factor: materialTimeFactor(mat),
  };
}

function seamPieceIds(seam: SeamSpec): string[] {
  return [...new Set([seam.a.pieceId, ...(seam.b ? [seam.b.pieceId] : [])])];
}

// ---------------------------------------------------------------------------
// Shared phrases
// ---------------------------------------------------------------------------

export function machineSetup(mat: MaterialPreset): string {
  const t = materialTraits(mat);
  const stitch = t.knit
    ? `a narrow zigzag (width about 1 mm, length ${fmt(mat.handling.stitchLengthMm)} mm) or your machine's stretch stitch`
    : `a straight stitch, stitch length ${fmt(mat.handling.stitchLengthMm)} mm`;
  return `Machine set-up for ${mat.name}: ${mat.handling.needle} needle, ${mat.handling.thread.toLowerCase()}, ${stitch}.`;
}

function pinLine(t: MaterialTraits): string {
  if (t.pinInAllowanceOnly)
    return 'Pin inside the seam allowance only, every 5 cm, because pins leave permanent holes in this fabric (or use sewing clips).';
  if (t.slippery || t.knit)
    return 'Pin every 4-5 cm with the pins at right angles to the edge; this fabric shifts easily, so do not skip pins.';
  return 'Pin every 8-10 cm with the pins at right angles to the edge, removing each pin just before the needle reaches it.';
}

function stitchLine(e: SeamEnv, distanceCm: number): string {
  const how = e.t.knit
    ? `using a narrow zigzag or stretch stitch so the seam can stretch with the fabric`
    : `with stitch length ${fmt(e.mat.handling.stitchLengthMm)} mm`;
  return `Sew exactly ${fmt(distanceCm)} cm from the raw edge (line the edge up with the ${fmt(distanceCm)} cm mark on your needle plate) ${how}. Backstitch 3-4 stitches at the start and end.`;
}

function finishLine(e: SeamEnv): string {
  if (e.t.noFray) return 'No edge finish is needed: this fabric does not fray.';
  // The fabric's own recommendation wins (it knows e.g. that overlocking shows
  // through duchesse satin); keep any pressing direction the pattern specifies.
  const recommended = edgeFinish(e.mat);
  return `Seam finish (each allowance on its own): ${capitalize(recommended.replace(/\.$/, ''))}.`;
}

function pressTip(mat: MaterialPreset): string {
  return `Pressing ${mat.name}: ${mat.handling.pressing}`;
}

function repeatLine(reps: number, what = 'side'): string | null {
  if (reps <= 1) return null;
  if (reps === 2) return `Repeat for the other ${what}.`;
  return `Repeat for all ${reps} ${what}s.`;
}

function isCurvedEdge(edgeId: string): boolean {
  return /neck|armhole|crotch|rise|cap|waist|curve/i.test(edgeId);
}

function step(phase: StepDraft['phase'], title: string, lines: Array<string | null | undefined>, extra: Partial<StepDraft> & { minutes: number }): StepDraft {
  return {
    phase,
    title,
    body: lines.filter((l): l is string => !!l).join('\n'),
    tips: extra.tips ?? [],
    warnings: extra.warnings ?? [],
    seamIds: extra.seamIds ?? [],
    pieceIds: extra.pieceIds ?? [],
    minutes: extra.minutes,
    ...(extra.checkpoint ? { checkpoint: extra.checkpoint } : {}),
  };
}

// ---------------------------------------------------------------------------
// Context-aware details
// ---------------------------------------------------------------------------

function involvesRole(seam: SeamSpec, env: TechniqueEnv, re: RegExp): boolean {
  const ids = seamPieceIds(seam);
  return ids.some((id) => re.test(env.idx.get(id)?.role ?? ''));
}

function allRoles(seam: SeamSpec, env: TechniqueEnv, re: RegExp): boolean {
  return seamPieceIds(seam).every((id) => re.test(env.idx.get(id)?.role ?? ''));
}

/**
 * Seam type as sewn. The drafter already resolved French vs plain seams with
 * the shared rules in drafting/seams.ts (`resolveSeamTypes`), so the package
 * data is authoritative; folded strips are re-checked defensively.
 */
export function effectiveSeamType(seam: SeamSpec, env: TechniqueEnv): SeamSpec['type'] {
  if (seam.type !== 'french') return seam.type;
  if (isLiningJoin(seam, env) || isFoldedJoin(seam, env.idx)) return 'plain';
  return 'french';
}

// ---------------------------------------------------------------------------
// Seam groups
// ---------------------------------------------------------------------------

const BAND_ROLE = /^(waistband|neck-binding)$/;

/** Piece id of the band (waistband/binding) in a seam, if any. */
function bandPiece(seam: SeamSpec, env: TechniqueEnv): string | undefined {
  return [seam.a.pieceId, seam.b?.pieceId].find((id): id is string => !!id && BAND_ROLE.test(env.idx.get(id)?.role ?? ''));
}

/** A waistband or binding strip sewn to a garment edge. */
function isBandAttach(seam: SeamSpec, env: TechniqueEnv): boolean {
  if (!seam.b) return false;
  const band = bandPiece(seam, env);
  if (!band) return false;
  const other = band === seam.a.pieceId ? seam.b.pieceId : seam.a.pieceId;
  return !BAND_ROLE.test(env.idx.get(other)?.role ?? '');
}

function layerOf(env: TechniqueEnv, pieceId: string): string {
  return env.idx.get(pieceId)?.layer ?? 'self';
}

/** Lining sewn to the main fabric (or the reverse). */
function isLiningJoin(seam: SeamSpec, env: TechniqueEnv): boolean {
  if (!seam.b) return false;
  const la = layerOf(env, seam.a.pieceId);
  const lb = layerOf(env, seam.b.pieceId);
  return la !== lb && (la === 'lining' || lb === 'lining');
}

/** Lining joined wrong sides together by basting within the allowance (caught by a later seam). */
function isLiningBaste(seam: SeamSpec, env: TechniqueEnv): boolean {
  return isLiningJoin(seam, env) && /wrong sides|\bbaste/i.test(`${seam.finish} ${seam.note ?? ''}`);
}

const GENERIC_SENTENCE = /^(overlock or zigzag each edge|zigzag|press (the seam )?open|press open|finish (the )?edges?)$/i;

/**
 * The drafting engine's own operation text (finish + note), split into
 * sentences, without generic finishing boilerplate and duplicates.
 */
export function seamInstruction(seam: SeamSpec): string[] {
  const raw = `${seam.finish ?? ''}. ${seam.note ?? ''}`;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/(?<=[.;!?])\s+|;\s*/)) {
    const s = part.replace(/^[\s.;]+|[\s.;]+$/g, '');
    if (s.length < 3 || GENERIC_SENTENCE.test(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${capitalize(s)}.`);
  }
  return out;
}

function edgeBase(edgeId: string): string {
  return edgeId.split('-')[0] ?? edgeId;
}

/** Short noun for a set of pieces: "lining", "skirt", "bodice" or their names. */
function groupNoun(pieceIds: string[], env: TechniqueEnv): string {
  const pieces = [...new Set(pieceIds)].map((id) => env.idx.get(id));
  if (pieces.length && pieces.every((p) => p?.layer === 'lining')) return 'lining';
  if (pieces.length && pieces.every((p) => p?.layer === 'interfacing')) return 'interfacing';
  if (pieces.length > 1 && pieces.every((p) => p && /skirt/.test(p.role))) return 'skirt';
  if (pieces.length > 1 && pieces.every((p) => p && /bodice/.test(p.role))) return 'bodice';
  if (pieces.length > 1 && pieces.every((p) => p && /dress/.test(p.role))) return 'dress';
  if (pieces.length > 1 && pieces.every((p) => p && /leg/.test(p.role))) return env.ctx.garment.category === 'trousers' ? 'trouser legs' : 'legs';
  return listJoin([...new Set(pieceIds)].map((id) => pieceName(env.idx.get(id), id)));
}

/**
 * One line per joined garment edge. A cut-on-fold piece joins a band in two
 * segments (left and right of the fold): those are one edge to the sewer, so
 * they are listed once with the whole length.
 */
function joinList(group: SeamSpec[], env: TechniqueEnv): string[] {
  const band = (s: SeamSpec) => bandPiece(s, env);
  const lines: string[] = [];
  const merged = new Map<string, { s: SeamSpec; len: number; count: number }>();
  for (const s of group) {
    const b = band(s);
    const garmentEnd = b && s.b ? (s.a.pieceId === b ? s.b : s.a) : s.a;
    const key = b ? `${garmentEnd.pieceId}.${garmentEnd.edgeId}` : s.id;
    const cur = merged.get(key);
    const len = b ? (env.idx.edge(garmentEnd.pieceId, garmentEnd.edgeId)?.lengthCm ?? 0) : seamLengthCm(s, env.idx);
    if (cur) cur.count++;
    else merged.set(key, { s, len, count: 1 });
  }
  for (const { s, len, count } of merged.values()) {
    const b = band(s);
    if (b && count > 1 && s.b) {
      const garmentEnd = s.a.pieceId === b ? s.b : s.a;
      const piece = env.idx.get(garmentEnd.pieceId);
      lines.push(`- the whole ${humanEdge(garmentEnd.edgeId)} edge of the ${pieceName(piece, garmentEnd.pieceId)}${piece?.cutOnFold ? ' (one piece cut on the fold)' : ''}, about ${fmt(len * count)} cm`);
    } else {
      lines.push(`- ${describeJoin(s, env.idx)}${len > 0 ? ` (about ${fmt(len)} cm)` : ''}`);
    }
  }
  return lines;
}

function groupReps(group: SeamSpec[], env: TechniqueEnv): number {
  return group.reduce((a, s) => a + seamRepeats(s, env.idx), 0);
}

/** Total length actually sewn (cm), counting left/right repeats. */
function groupLength(group: SeamSpec[], env: TechniqueEnv): number {
  return group.reduce((a, s) => a + seamLengthCm(s, env.idx) * seamRepeats(s, env.idx), 0);
}

/** Distinct notes; notes differing only in their numbers count once (the first is kept). */
function uniqueNotes(group: SeamSpec[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of group) {
    const n = s.note?.trim();
    if (!n) continue;
    const key = n.replace(/\d+(?:\.\d+)?/g, '#').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Seam techniques
// ---------------------------------------------------------------------------

function plainSeam(seam: SeamSpec, env: TechniqueEnv, title: string, group: SeamSpec[] = [seam]): StepDraft {
  if (!seam.b) return singleOperation(group, env, title);
  const e = seamEnv(seam, env);
  const multi = group.length > 1;
  const join = multi ? 'each pair of edges' : describeJoin(seam, env.idx);
  const tips: string[] = [];
  const warnings: string[] = [];
  const lines: Array<string | null> = [];
  const reps = groupReps(group, env);
  const totalLen = groupLength(group, env);

  // Waistbands and bindings are "bands": sewn to the garment edge, then folded over and closed later.
  const waistband = isBandAttach(seam, env);
  const bandId = [seam.a.pieceId, seam.b.pieceId].find((id) => BAND_ROLE.test(env.idx.get(id)?.role ?? ''));
  const bandName = bandId ? pieceName(env.idx.get(bandId), bandId) : 'waistband';
  const bandIsWaist = /waistband/.test(env.idx.get(bandId ?? '')?.role ?? '');
  const liningJoin = isLiningJoin(seam, env);
  const liningBaste = isLiningBaste(seam, env);
  const facing = (involvesRole(seam, env, /facing/) && !allRoles(seam, env, /facing/)) || (liningJoin && !liningBaste);
  const folded = isFoldedJoin(seam, env.idx);
  const crotch = /crotch|rise/i.test(seam.a.edgeId);
  const notes = uniqueNotes(group);
  const dartExplained = notes.some((n) => /dart/i.test(n));

  if (multi && waistband) {
    const parts = joinList(group, env);
    lines.push(
      `The ${bandName} joins the ${bandIsWaist ? 'waist' : 'edge'} in ${parts.length} sections. Pin them all first, matching the notches and seams, then sew them as one continuous seam from one end of the ${bandName} to the other:`,
      ...parts,
    );
    if (bandIsWaist) {
      const zipSeam = env.ctx.seams.find((z) => z.type === 'zip-invisible' || z.type === 'zip-lapped');
      lines.push(
        `Only the notched long edge of the ${bandName} is sewn now; it folds in half lengthwise along its marked fold line later.`,
        zipSeam
          ? `At the zip, let each end of the ${bandName} stick out ${fmt(e.sa)} cm beyond the zip edge: that is the allowance you fold in when you close the ends.`
          : null,
      );
    }
  } else if (multi) {
    lines.push(`This step covers ${group.length} seams. Sew them one after another in exactly the same way:`, ...joinList(group, env));
  }

  if (liningBaste) {
    const [lin, main] = layerOf(env, seam.a.pieceId) === 'lining' ? [e.aName, e.bName ?? 'garment'] : [e.bName ?? 'lining', e.aName];
    lines.push(
      multi
        ? 'Slip the lining inside the garment with WRONG sides together (the seam allowances of both face each other), matching the raw edges, side seams and notches.'
        : `Slip the ${lin} inside the ${main} with WRONG sides together (the seam allowances of both face each other), matching the raw edges, side seams and notches.`,
      pinLine(e.t),
      `Baste the layers together ${fmt(Math.max(0.5, e.sa - 0.5))} cm from the raw edge with the longest machine stitch (5 mm). This line sits inside the seam allowance, so the next seam hides it. From now on treat the two layers as one.`,
    );
    tips.push('If the lining looks a little larger than the garment, that is normal: it needs room to move. Spread it evenly; do not trim it.');
    return step('construct', title, lines, {
      seamIds: group.map((s) => s.id),
      pieceIds: [...new Set(group.flatMap(seamPieceIds))],
      tips: [...tips, ...notes],
      warnings,
      minutes: minutes((6 + (totalLen / 100) * 5) * e.factor),
    });
  }

  if (folded) {
    lines.push(
      `Fold ${multi ? 'each strip' : `each ${e.aName}`} in half lengthwise with right sides together so its long raw edges meet, and pin.`,
    );
  } else {
    lines.push(`Lay ${join} with right sides together, matching the raw edges, the ends and every notch.`);
  }
  lines.push(pinLine(e.t));
  const maxEase = Math.max(...group.map((s) => s.intendedEaseCm));
  if (waistband && !bandIsWaist && maxEase > 0.3) {
    lines.push(
      `The ${bandName} is cut slightly shorter than the edge it binds (by up to ${fmt(maxEase)} cm) so it hugs the body. Pin the ends and notches first, then stretch the ${bandName} gently between the pins until it lies flat along the edge; never stretch the garment edge itself.`,
    );
  } else if (seam.intendedEaseCm > 0.3 && !dartExplained) {
    lines.push(
      `${multi ? 'Where one edge is longer than its partner (by up to' : `The ${e.aName} edge is about`} ${fmt(Math.max(...group.map((s) => s.intendedEaseCm)))} cm${multi ? ')' : ' longer than the edge it joins'}, pin the ends and notches first, then spread the extra length evenly between them so no tucks form; sew with the longer layer underneath, against the machine's feed dogs, which eases it in for you.`,
    );
  }
  lines.push(
    multi && waistband
      ? stitchLine(e, e.sa).replace('Backstitch 3-4 stitches at the start and end.', `Backstitch only at the two ends of the ${bandName}, not between the sections.`)
      : stitchLine(e, e.sa),
  );
  if (crotch) {
    lines.push(
      'Sew the curved lower part of the crotch a second time, 2 mm inside the first line, for strength, then trim the allowance on that curve to 1 cm.',
    );
  }
  if (facing) {
    const inner = liningJoin ? 'lining' : 'facing';
    lines.push(
      `Trim the seam allowance to about ${fmt(e.sa / 2)} cm and grade it (cut the ${inner} layer a little narrower). On curves, clip into the allowance every 1-1.5 cm, stopping 2 mm before the stitches.`,
      `Press the ${inner} and the allowances away from the garment. Understitch: from the right side of the ${inner}, sew 3 mm from the seam through the ${inner} and both allowances (not the garment), then turn the ${inner} to the inside and press so it rolls 1 mm out of sight.`,
    );
  } else if (waistband) {
    const pieceIdsOnBand = new Set(group.flatMap(seamPieceIds));
    const bandIds = [...pieceIdsOnBand].filter((id) => BAND_ROLE.test(env.idx.get(id)?.role ?? ''));
    const separateFinish = env.ctx.seams.some(
      (s) => s.stage > seam.stage && bandIds.includes(s.a.pieceId) && (!s.b || s.b.pieceId === s.a.pieceId),
    );
    lines.push(`Trim the seam allowance to ${fmt(Math.max(0.6, e.sa / 2))} cm${bandIsWaist ? '' : ' and clip curves every 1-1.5 cm'}, then press the seam allowances towards the ${bandName}.`);
    if (!separateFinish) {
      lines.push(
        `Fold the ${bandName} in half lengthwise along its fold line, right sides together, and sew across each short end at the seam allowance; trim the corners diagonally and turn the band right side out, pushing the corners out gently.`,
        `Press under the free long edge by ${fmt(e.sa)} cm, pin it over the seam on the inside so it just covers the stitching, and slip stitch it by hand (or stitch in the groove of the seam from the right side).`,
      );
    } else {
      lines.push(`Leave the inner edge of the ${bandName} free for now; you will close its ends and stitch it down in the next steps.`);
    }
  } else if (folded) {
    lines.push('Press the seam flat to set the stitches. Do not turn the strip yet if one end still has to be closed.');
  } else {
    lines.push('Press the seam flat exactly as sewn to set the stitches.');
    lines.push(finishLine(e));
    lines.push(/towards|to the (back|front|side)|downwards/i.test(seam.finish) ? `Then ${seam.finish.match(/press[^.;]*/i)?.[0]?.toLowerCase() ?? 'press the seam allowances open'}.` : 'Then press the seam allowances open over a seam roll.');
  }
  if (isCurvedEdge(seam.a.edgeId)) tips.push('Sew curves slowly. Stop with the needle down, lift the presser foot and turn the fabric slightly, then continue.');
  if (e.t.slippery) tips.push('Put a strip of tissue paper under the seam if the fabric gets pulled into the needle plate; tear it away afterwards.');
  if (!multi && e.lengthCm > 0)
    tips.push(`This seam is about ${fmt(e.lengthCm)} cm long. If the two edges differ by more than 0.5 cm at the end, unpick from the last notch and re-pin.`);
  tips.push(pressTip(e.mat));
  tips.push(...notes);
  if (e.t.pinInAllowanceOnly) warnings.push('Never sew over pins: on this fabric a broken needle or a hole is likely.');
  if (!multi) {
    const rep = repeatLine(e.reps, folded ? 'strip' : 'side');
    if (rep) lines.push(rep);
  }

  const perMetre = 6 + (e.t.noFray || facing || waistband ? 0 : 6) + (facing ? 8 : 0);
  const base = 6 * reps + (totalLen / 100) * perMetre + 3 * group.length + (waistband ? 20 : 0) + (facing ? 6 * group.length : 0);
  return step('construct', title, lines, {
    seamIds: group.map((s) => s.id),
    pieceIds: [...new Set(group.flatMap(seamPieceIds))],
    tips,
    warnings,
    minutes: minutes(base * e.factor),
  });
}

/**
 * Operations on a single piece edge (no partner): lining hand-finishing,
 * basting an underlining, closing waistband ends, turning facing ends under.
 * The drafting engine describes the operation; we add the beginner technique.
 */
function singleOperation(group: SeamSpec[], env: TechniqueEnv, title: string): StepDraft {
  const seam = group[0]!;
  const e = seamEnv(seam, env);
  const instr = seamInstruction(seam);
  const text = instr.join(' ');
  const kind = singleKind(seam);
  const multi = group.length > 1;
  const pieceIds = [...new Set(group.map((s) => s.a.pieceId))];
  const totalLen = groupLength(group, env);
  const reps = groupReps(group, env);
  const lines: Array<string | null> = [];
  const tips: string[] = [];

  if (multi) {
    lines.push(
      'Do this on each of these edges:',
      ...group.map((s) => `- the ${humanEdge(s.a.edgeId)} of the ${pieceName(env.idx.get(s.a.pieceId), s.a.pieceId)}`),
    );
  }
  if (instr.length) lines.push(...instr);
  else lines.push(`Working on a single layer, stitch along the ${humanEdge(seam.a.edgeId)} edge of the ${e.aName}, ${fmt(e.sa)} cm from the raw edge.`);

  let perInstance: number;
  let perMetre: number;
  if (kind === 'hand') {
    lines.push(
      `Thread a hand needle with a single strand of thread matching the ${layerOf(env, seam.a.pieceId) === 'lining' ? 'lining' : 'fabric'} and knot the end. Turn the raw edge under by about ${fmt(e.sa)} cm as you go and pin it in place first.`,
      'Work small slip stitches about 5 mm apart: slide the needle 5 mm inside the fold, then pick up one or two threads of the layer underneath, and repeat. Keep the thread relaxed so nothing puckers or shows on the outside.',
    );
    tips.push('Pin the whole edge first and check from the outside that the garment hangs smoothly before stitching.');
    perInstance = 8;
    perMetre = 25;
  } else if (kind === 'baste') {
    lines.push(
      `Baste with the longest machine stitch (5 mm) or large hand stitches ${fmt(Math.max(0.5, e.sa - 0.5))} cm from the raw edges, inside the seam allowance, so the stitching never shows.`,
    );
    perInstance = 5;
    perMetre = 6;
  } else {
    lines.push(
      e.t.knit
        ? `Use a narrow zigzag or stretch stitch (length ${fmt(e.mat.handling.stitchLengthMm)} mm) and backstitch at both ends.`
        : `Use stitch length ${fmt(e.mat.handling.stitchLengthMm)} mm and backstitch at both ends.`,
    );
    if (/\bturn\b/i.test(text))
      lines.push('Before turning, trim the seam allowance to 5 mm and cut corners diagonally 2 mm from the stitches, so the corners turn out sharp. Push them out gently with a point turner.');
    if (!instr.length) lines.push(finishLine(e));
    perInstance = 7;
    perMetre = 8;
  }
  if (!multi) {
    const rep = repeatLine(e.reps, 'piece');
    if (rep) lines.push(rep);
  }
  tips.push(pressTip(e.mat));
  return step('construct', title, lines, {
    seamIds: group.map((s) => s.id),
    pieceIds,
    tips,
    warnings: [],
    minutes: minutes((perInstance * reps + (totalLen / 100) * perMetre) * e.factor),
  });
}

type SingleKind = 'hand' | 'baste' | 'machine';

function singleKind(seam: SeamSpec): SingleKind {
  const text = seamInstruction(seam).join(' ');
  if (/slip-?stitch|hand-?stitch|by hand|hand-?tack/i.test(text)) return 'hand';
  if (/\bbaste/i.test(text)) return 'baste';
  return 'machine';
}


function frenchSeam(seam: SeamSpec, env: TechniqueEnv, title: string, converted: boolean, group: SeamSpec[] = [seam]): StepDraft {
  const e = seamEnv(seam, env);
  const multi = group.length > 1;
  const first = Math.max(0.4, Math.round(e.sa * 0.4 * 10) / 10);
  const second = Math.max(0.5, Math.round((e.sa - first) * 10) / 10);
  const join = multi ? 'each pair of edges' : describeJoin(seam, env.idx);
  const lines = [
    converted
      ? `Because this fabric is sheer, you will enclose the raw edges in a French seam: the inside will look as neat as the outside.`
      : 'This is a French seam: it is sewn twice so the raw edges end up completely enclosed.',
    ...(multi ? [`This step covers ${group.length} seams, all sewn the same way:`, ...joinList(group, env)] : []),
    `Lay ${join} with WRONG sides together (yes, the opposite of usual), matching the edges and notches. ${pinLine(e.t)}`,
    `First pass: sew ${fmt(first)} cm from the raw edge, stitch length ${fmt(e.mat.handling.stitchLengthMm)} mm, backstitching at both ends.`,
    `Trim the allowance to a scant 3 mm, cutting carefully and evenly. Press the seam flat, then press it to one side.`,
    `Fold the fabric along the seam so the RIGHT sides are now together and the first seam sits exactly on the fold; press the fold sharply.`,
    `Second pass: sew ${fmt(second)} cm from the fold. This encloses the trimmed edges; check that no frayed threads poke through on the right side.`,
    'Press the finished seam towards the back of the garment.',
    multi ? null : repeatLine(e.reps),
  ];
  return step('construct', title, lines, {
    seamIds: group.map((s) => s.id),
    pieceIds: [...new Set(group.flatMap(seamPieceIds))],
    tips: [
      'If whiskers of fabric peek through after the second pass, unpick that section, trim closer and re-sew.',
      pressTip(e.mat),
      ...uniqueNotes(group),
    ],
    warnings: e.t.pinInAllowanceOnly ? ['Pin only within the seam allowance: pins mark this fabric.'] : [],
    minutes: minutes((10 * groupReps(group, env) + (groupLength(group, env) / 100) * 12) * e.factor),
  });
}

/** One step covering a group of dart seams at the same stage. */
export function dartStep(seams: SeamSpec[], env: TechniqueEnv): StepDraft {
  const first = seams[0]!;
  const e = seamEnv(first, env);
  let total = 0;
  let vertical = 0;
  let horizontal = 0;
  let deep = false;
  let maxLen = 0;
  const pieceLabels: string[] = [];
  for (const s of seams) {
    const p = env.idx.get(s.a.pieceId);
    const reps = seamRepeats(s, env.idx);
    total += reps;
    const specific = p?.darts.filter((d) => d.id === s.a.edgeId) ?? [];
    const darts = specific.length ? specific : (p?.darts ?? []);
    for (const d of darts) {
      const mid = { x: (d.legs[0].x + d.legs[1].x) / 2, y: (d.legs[0].y + d.legs[1].y) / 2 };
      if (Math.abs(d.apex.y - mid.y) >= Math.abs(d.apex.x - mid.x)) vertical += reps;
      else horizontal += reps;
      if (d.intakeCm > 3 && e.mat.weightGsm >= 230) deep = true;
      maxLen = Math.max(maxLen, d.lengthCm);
    }
    pieceLabels.push(pieceName(p, s.a.pieceId));
  }
  const uniqLabels = [...new Set(pieceLabels)];
  const pressDir: string[] = [];
  if (vertical) pressDir.push('press vertical darts (the long up-and-down ones) towards the centre front or centre back');
  if (horizontal) pressDir.push('press horizontal bust darts downwards');
  const lines = [
    `You will sew ${total} dart${total === 1 ? '' : 's'} on the ${listJoin(uniqLabels)}.`,
    'On the wrong side, fold the fabric through the middle of the dart, right sides together, so the two marked dart legs (the stitching lines) lie exactly on top of each other. Push a pin through both legs to check, then pin along the leg.',
    `Start at the wide end at the raw edge with a backstitch and sew in a perfectly straight line towards the point${maxLen ? ` (the longest dart is about ${fmt(maxLen)} cm)` : ''}. For the last 1-2 cm, sew right along the folded edge so the dart tapers to nothing.`,
    'Do not backstitch at the point (it makes a pucker). Sew off the fold, leave 10 cm thread tails and tie them together in a double knot; trim to 1 cm.',
    `Press the dart flat as sewn, then over a tailor's ham: ${pressDir.length ? listJoin(pressDir) : 'press towards the centre'}. Press only up to the point so it stays rounded.`,
    deep ? 'These darts are deep in a heavy cloth: slit the fold open to within 2 cm of the point and press the dart open to avoid a bulky ridge.' : null,
  ];
  return step('construct', total > 1 ? 'Sew the darts' : 'Sew the dart', lines, {
    seamIds: seams.map((s) => s.id),
    pieceIds: [...new Set(seams.map((s) => s.a.pieceId))],
    tips: [
      'Mark the dart with chalk on the wrong side, or lay a strip of paper tape from the wide end to the point and sew beside it for a dead-straight line.',
      pressTip(e.mat),
    ],
    warnings: ['A dart that curves or bubbles at the point looks home-made: unpick the last 3 cm and re-sew in a straight line.'],
    minutes: minutes(total * 5 * e.factor),
  });
}

function invisibleZip(seam: SeamSpec, env: TechniqueEnv, title: string, group: SeamSpec[] = [seam]): StepDraft {
  const e = seamEnv(seam, env);
  const zip = zipInfo(env.ctx, env.idx);
  const join =
    group.length > 1
      ? `${listJoin(group.map((s) => describeJoin(s, env.idx)))} (one zip runs continuously through all of them)`
      : describeJoin(seam, env.idx);
  const stabilise = e.t.knit || e.t.slippery || e.mat.stiffness < 0.4;
  const zipLen = zip?.zipLengthCm ?? 22;
  const opening = zip?.openingCm ?? zipLen - 2;
  const lines = [
    `This step puts an invisible zip into ${join}. You need a ${zipLen} cm invisible zip; the opening is about ${fmt(opening)} cm.`,
    e.t.noFray ? null : `Finish the raw edges of both seam allowances along the whole seam before you start (${edgeFinish(e.mat)}).`,
    stabilise
      ? `Fuse a 2 cm wide strip of lightweight interfacing to the wrong side along each opening edge so the fabric cannot stretch or ripple behind the zip.`
      : null,
    'Open the zip and, from the back, press the coils flat with a cool iron (synthetic setting) so the teeth uncurl; this lets you stitch closer.',
    `Lay the open zip face down on the right side of the first opening edge, with the coil sitting exactly on the stitching line (${fmt(e.sa)} cm in from the raw edge) and the top stop 3 mm below the top stitching line. Pin or hand baste it.`,
    "Fit the invisible zip foot. Sew the tape down with the coil in the foot's groove, from the top until the foot touches the zip slider. Backstitch.",
    'Close the zip and mark the top edge and any seams that cross the opening on the other tape with chalk, so both sides will line up. Open the zip again.',
    'Pin the second tape face down to the right side of the other opening edge, matching your marks, and sew it the same way with the coil in the other groove.',
    'Close the zip and check from the right side: the zip should vanish into the seam and the top edges and cross seams should be level. If not, unpick that side and re-sew.',
    `Now close the seam below the zip. Switch to the regular zipper foot, pull the zip tail out of the way, and sew from 1 cm above the end of the zip stitching (2 mm to the outside of it) down to the end of the seam at ${fmt(e.sa)} cm. Backstitch.`,
    'Press the seam below the zip open. Stitch the bottom ends of the zip tape to the seam allowances only, so the zip cannot flap inside.',
  ];
  return step('construct', title, lines, {
    seamIds: group.map((s) => s.id),
    pieceIds: [...new Set(group.flatMap(seamPieceIds))],
    tips: [
      'Practise once on two scraps of your fabric first; it takes 10 minutes and makes the real one easy.',
      'Buy the zip 2-3 cm longer than the opening: the slider can never be sewn past, so a longer zip lets you stitch the full opening.',
      pressTip(e.mat),
    ],
    warnings: ['Never touch the zip coil with a hot iron: it can melt.'],
    minutes: minutes(45 * e.factor),
  });
}

function lappedZip(seam: SeamSpec, env: TechniqueEnv, title: string, group: SeamSpec[] = [seam]): StepDraft {
  const e = seamEnv(seam, env);
  const zip = zipInfo(env.ctx, env.idx);
  const join =
    group.length > 1
      ? `${listJoin(group.map((s) => describeJoin(s, env.idx)))} (one zip runs continuously through all of them)`
      : describeJoin(seam, env.idx);
  const zipLen = zip?.zipLengthCm ?? 20;
  const opening = zip?.openingCm ?? zipLen;
  const lines = [
    `This step sews a lapped zip into ${join}: a fold of fabric (the lap) hides the zip. You need a ${zipLen} cm regular zip; the opening is about ${fmt(opening)} cm.`,
    e.t.noFray ? null : `Finish the raw edges of both seam allowances first (${edgeFinish(e.mat)}).`,
    `Sew the seam at ${fmt(e.sa)} cm from the bottom up to the bottom of the opening (${fmt(opening)} cm below the top stitching line) with normal stitches and a strong backstitch. Then baste the opening closed with a long 5 mm stitch on the same line. Press the whole seam open.`,
    'Lay the garment wrong side up. Open the zip and place it face down on the right-hand seam allowance only (the underlap), with the coil against the basted seam line and the top stop 3 mm below the top stitching line. Using the zipper foot, stitch the tape to that allowance.',
    'Turn the zip face up. This folds the allowance into a narrow pleat about 3 mm from the basting; edgestitch along that fold through the allowance and the tape only.',
    'Close the zip and spread the garment flat, right side up. Mark a line 1.2 cm from the basted seam on the other side (the lap) with chalk or tape.',
    'Topstitch from the right side along that line from the top down, then pivot and sew across the bottom of the zip to the seam. Feel for the zip stop so you never sew over metal.',
    'Unpick the basting: the lap now covers the zip neatly.',
  ];
  return step('construct', title, lines, {
    seamIds: group.map((s) => s.id),
    pieceIds: [...new Set(group.flatMap(seamPieceIds))],
    tips: ['A strip of 1.2 cm wide masking tape on the right side makes a perfect topstitching guide.', pressTip(e.mat)],
    warnings: ['Stop and turn the hand wheel by hand when you cross the zip teeth near the bottom; hitting the stop breaks needles.'],
    minutes: minutes(55 * e.factor),
  });
}

function setInSleeve(seam: SeamSpec, env: TechniqueEnv, title: string, group: SeamSpec[] = [seam]): StepDraft {
  const e = seamEnv(seam, env);
  const isSleeve = (id: string) => /sleeve/.test(env.idx.get(id)?.role ?? '');
  const sleeveId = [seam.a.pieceId, seam.b?.pieceId].find((id): id is string => !!id && isSleeve(id));
  const sleevePiece = sleeveId ? env.idx.get(sleeveId) : undefined;
  const sleeveName = sleeveId ? pieceName(sleevePiece, sleeveId) : 'sleeve';
  const sleeves = Math.max(1, edgeInstances(sleevePiece));
  // Cap ease per sleeve = sum over the cap sections of one sleeve.
  const ease = group.reduce((a, s) => a + Math.max(0, s.intendedEaseCm), 0);
  const sections = group.length > 1;
  const r1 = Math.max(0.4, e.sa - 0.3);
  const r2 = Math.max(0.2, e.sa - 0.8);
  const underarmSewn = env.ctx.seams.some(
    (s) => s.stage < seam.stage && !!sleeveId && s.a.pieceId === sleeveId && s.b?.pieceId === sleeveId,
  );
  const lines = [
    underarmSewn
      ? `Check that the underarm seam of each ${sleeveName} is sewn and pressed open.`
      : `Sew the underarm seam of the ${sleeveName} first, right sides together, and press it open.`,
    `On the sleeve cap, sew two rows of ease stitching between the front and back notches: stitch length 4 mm, no backstitching, leaving 10 cm thread tails, at ${fmt(r1)} cm and ${fmt(r2)} cm from the raw edge.`,
    'Turn the garment wrong side out and the sleeve right side out. Slide the sleeve into the armhole so the right sides face each other.',
    'Pin the key points first: underarm seam to side seam, the dot at the top of the cap to the shoulder seam, the single notch to the front armhole and the double notch to the back armhole.',
    sections
      ? `The armhole is made of ${group.length} sections (${listJoin(group.map((s) => humanEdge(s.a.pieceId === sleeveId ? s.a.edgeId : (s.b?.edgeId ?? s.a.edgeId))))}); match each section of the cap to its own armhole section between the notches.`
      : null,
    ease > 0.2
      ? `The cap is about ${fmt(ease)} cm longer than the armhole; that extra is what gives your shoulder room. Gently pull the two bobbin threads together to draw up the cap until it fits, spreading the fullness evenly over the top of the cap. Pin every 2 cm. There must be no tucks or pleats.`
      : 'The cap and armhole are nearly the same length; pin every 2-3 cm, spreading any tiny difference evenly.',
    `Sew with the sleeve side down against the machine bed (the feed dogs help ease it in), ${fmt(e.sa)} cm from the edge, starting at the underarm and going all the way round, overlapping the start by 2 cm.`,
    'Turn to the right side and check the cap for little tucks. If you find one, unpick 3 cm around it, redistribute and re-sew.',
    'Between the notches at the underarm only, sew a second row 6 mm outside the first and trim that part of the allowance close to it. Finish the edges together.',
    "Press the allowances towards the sleeve, over a tailor's ham, touching only the allowance; never press the sleeve cap flat. Pull out any ease stitches that show on the right side.",
    sleeves > 1 ? 'Repeat for the second sleeve. Check the notches so the left sleeve goes into the left armhole: single notch = front.' : null,
  ];
  return step('construct', title, lines, {
    seamIds: group.map((s) => s.id),
    pieceIds: [...new Set(group.flatMap(seamPieceIds))],
    tips: [
      'Hand baste the sleeve in first if you are nervous: it is quick, and you can try it on before machine stitching.',
      pressTip(e.mat),
    ],
    warnings: e.t.knit ? [] : ['Do not stretch the armhole of the bodice while pinning; it is cut partly on the bias and grows easily.'],
    minutes: minutes(35 * sleeves * e.factor),
  });
}

/** A skirt edge box-pleated into a shorter edge (structured silks). */
export function isPleatedSeam(seam: SeamSpec): boolean {
  return !!seam.b && seam.intendedEaseCm > 1 && /box pleat/i.test(seam.note ?? '');
}

function pleatedSeam(seam: SeamSpec, env: TechniqueEnv, title: string, group: SeamSpec[] = [seam]): StepDraft {
  const e = seamEnv(seam, env);
  const shortOf = (s: SeamSpec) => {
    const la = env.idx.edge(s.a.pieceId, s.a.edgeId)?.lengthCm ?? 0;
    const lb = s.b ? (env.idx.edge(s.b.pieceId, s.b.edgeId)?.lengthCm ?? 0) : 0;
    return la <= lb ? { short: s.a.pieceId, long: s.b?.pieceId ?? s.a.pieceId, target: la } : { short: s.b!.pieceId, long: s.a.pieceId, target: lb };
  };
  const parts = group.map((s) => ({ s, ...shortOf(s) }));
  const lines = [
    'The skirt is box-pleated into the bodice: crisp fabric holds a pleat far better than gathers and keeps the waist flat. Each pleat is marked on the skirt waist by two single "pleat" notches and a double "pleat centre" notch.',
    'Working on the right side of each skirt panel, fold the fabric at each single notch and bring both folds to meet exactly at the double notch between them. Pin the folds and baste across the top 1 cm from the raw edge.',
    'Check each pleated panel against the bodice edge it joins before sewing:',
    ...parts.map((p) => `- ${pieceName(env.idx.get(p.long), p.long)}: pleated to ${fmt(p.target)} cm (to fit the ${pieceName(env.idx.get(p.short), p.short)})`),
    'If a panel is a little long or short, let each pleat out or take it in by the same small amount rather than changing just one.',
    `Pin the skirt to the bodice right sides together, matching the seams and the centre front, and sew at ${fmt(e.sa)} cm with the pleated skirt on top so the presser foot cannot push the pleats out of line.`,
    'Press the seam allowances up towards the bodice; press the pleats only lightly from the inside so they stay crisp but are not flattened.',
  ];
  return step('construct', title, lines, {
    seamIds: group.map((s) => s.id),
    pieceIds: [...new Set(group.flatMap(seamPieceIds))],
    tips: ['Baste the pleats and try the bodice and skirt on together before the final seam: pleats are easy to adjust at this stage.', pressTip(e.mat)],
    warnings: [],
    minutes: minutes((15 + 6 * group.length) * e.factor),
  });
}

function gatheredSeam(seam: SeamSpec, env: TechniqueEnv, title: string, group: SeamSpec[] = [seam]): StepDraft {
  const e = seamEnv(seam, env);
  const parts = group.map((s) => {
    const lenA = seamLengthCm(s, env.idx);
    const lenB = s.b ? (env.idx.edge(s.b.pieceId, s.b.edgeId)?.lengthCm ?? 0) : 0;
    const aLonger = lenA >= lenB;
    const longId = aLonger ? s.a.pieceId : (s.b?.pieceId ?? s.a.pieceId);
    const shortId = aLonger ? (s.b?.pieceId ?? s.a.pieceId) : s.a.pieceId;
    return { s, longId, shortId, long: Math.max(lenA, lenB), target: Math.min(lenA, lenB || lenA) };
  });
  const longer = groupNoun(parts.map((p) => p.longId), env);
  const shorter = groupNoun(parts.map((p) => p.shortId), env);
  const extra = group.reduce((a, s) => a + Math.max(0, s.intendedEaseCm), 0);
  const r1 = Math.max(0.4, e.sa - 0.5);
  const r2 = Math.max(0.2, e.sa - 1);
  const lines = [
    `The ${longer} is gathered to fit the ${shorter}${extra > 0 ? ` (about ${fmt(extra)} cm of extra fabric is drawn up in total)` : ''}.`,
    `Set a long stitch (4-5 mm) and loosen the upper tension a little. On the ${longer}, sew two parallel rows within the seam allowance, at ${fmt(r1)} cm and ${fmt(r2)} cm from the raw edge, without backstitching. Leave 15 cm thread tails. Stop and restart at every seam so each section can be gathered separately.`,
    `Pin the ${longer} to the ${shorter} with right sides together at the ends, seams and notches.`,
    parts.length > 1
      ? 'Gather each section to the exact length of the edge it joins, then lock the threads by winding them round a pin in a figure of eight:'
      : `Hold both bobbin threads at one end and gently slide the fabric along them until the gathered edge measures ${parts[0]!.target > 0 ? `${fmt(parts[0]!.target)} cm (the length of the ${pieceName(env.idx.get(parts[0]!.shortId), parts[0]!.shortId)} edge)` : 'the same as the edge it joins'}. Wrap the threads around a pin in a figure of eight to lock them.`,
    ...(parts.length > 1
      ? parts.map(
          (p) =>
            `- ${pieceName(env.idx.get(p.longId), p.longId)}: from ${fmt(p.long)} cm down to ${fmt(p.target)} cm (to fit the ${pieceName(env.idx.get(p.shortId), p.shortId)})`,
        )
      : []),
    'Spread the gathers evenly with your fingers and pin every 2-3 cm.',
    `Reset normal stitch length and tension. Sew with the gathered side up at ${fmt(e.sa)} cm, just outside the gathering rows, holding gathers flat in front of the needle so none fold over.`,
    'Remove any gathering threads that show on the right side. Finish the edges together and press the allowances away from the gathers (towards the smoother piece); do not press the gathers flat.',
  ];
  const totalLong = parts.reduce((a, p) => a + p.long * seamRepeats(p.s, env.idx), 0);
  return step('construct', title, lines, {
    seamIds: group.map((s) => s.id),
    pieceIds: [...new Set(group.flatMap(seamPieceIds))],
    tips: [
      'If a thread snaps while gathering, that is why there are two rows; tie off and gather with the remaining one.',
      pressTip(e.mat),
      ...uniqueNotes(group).slice(0, 2),
    ],
    warnings: [],
    minutes: minutes((20 + 6 * group.length + (totalLong / 100) * 15) * e.factor),
  });
}

function understitch(seam: SeamSpec, env: TechniqueEnv, title: string, group: SeamSpec[] = [seam]): StepDraft {
  const e = seamEnv(seam, env);
  const facingFirst = /facing/.test(env.idx.get(seam.a.pieceId)?.role ?? '');
  const facingName = facingFirst ? e.aName : (e.bName ?? 'facing');
  const garmentName = facingFirst ? (e.bName ?? 'garment') : e.aName;
  const edge = listJoin([...new Set(group.map((s) => humanEdge(s.a.edgeId)))]);
  const alreadyJoined = group.every((g) =>
    env.ctx.seams.some(
      (s) =>
        s !== g &&
        s.stage <= g.stage &&
        s.type === 'plain' &&
        [s.a, ...(s.b ? [s.b] : [])].some((x) => x.pieceId === g.a.pieceId && x.edgeId === g.a.edgeId),
    ),
  );
  const lines = [
    alreadyJoined
      ? null
      : `Pin the ${facingName} to the ${garmentName} along the ${edge} edge with right sides together, matching notches and seams, and sew at ${fmt(e.sa)} cm.`,
    `Trim the seam allowance to about ${fmt(e.sa / 2)} cm and grade it so the facing layer is narrower. On curves, clip into the allowance every 1 cm, stopping 2 mm before the stitches.`,
    `Press the ${facingName} and both seam allowances away from the ${garmentName}.`,
    `From the right side of the ${facingName}, sew 2-3 mm from the seam line along the ${edge} through the facing and the allowances underneath (not the garment). Keep the allowances flat underneath and turn the work slowly on curves.`,
    `Turn the facing to the inside. The understitching makes the seam roll 1 mm towards the inside so the facing never peeks out. Press.`,
    'Hand-tack the facing to the seam allowances at the shoulder and side seams with a few small stitches so it stays inside.',
  ];
  return step('construct', title, lines, {
    seamIds: group.map((s) => s.id),
    pieceIds: [...new Set(group.flatMap(seamPieceIds))],
    tips: ['Understitching is what separates a professional neckline from a home-made one; take it slowly.', pressTip(e.mat), ...uniqueNotes(group)],
    warnings: ['When clipping, never cut through the stitches: stop 2 mm short.'],
    minutes: minutes((12 + (groupLength(group, env) / 100) * 10 + (alreadyJoined ? 0 : 10)) * e.factor),
  });
}

function hemSeam(seam: SeamSpec, env: TechniqueEnv, title: string, group: SeamSpec[] = [seam]): StepDraft {
  const e = seamEnv(seam, env);
  const p = env.idx.get(seam.a.pieceId);
  const H = allowanceAtEdge(p, seam.a.edgeId, seam.type === 'hem-rolled' ? 1 : 3);
  const pieceIds = [...new Set(group.map((s) => s.a.pieceId))];
  const totalLen = group.reduce((a, s) => a + seamLengthCm(s, env.idx) * edgeInstances(env.idx.get(s.a.pieceId)), 0);
  const isBottomHem = group.every((s) => edgeBase(s.a.edgeId) === 'hem');
  const edges = isBottomHem ? 'lower' : listJoin([...new Set(group.map((s) => humanEdge(s.a.edgeId)))]);
  const where = `the ${edges} edge${group.length > 1 || pieceIds.some((id) => edgeInstances(env.idx.get(id)) > 1) ? 's' : ''} of the ${groupNoun(pieceIds, env)}`;
  const isSleeveHem = pieceIds.every((id) => /sleeve/.test(env.idx.get(id)?.role ?? ''));
  const curved =
    !isSleeveHem && (env.ctx.garment.id === 'circle-skirt' || env.ctx.fit.options.flare >= 0.6 || env.ctx.garment.id === 'ball-gown');
  const selfLayer = pieceIds.every((id) => layerOf(env, id) === 'self');
  const liningNeedsHemNote =
    selfLayer &&
    !isSleeveHem &&
    env.ctx.pieces.some((x) => x.layer === 'lining') &&
    !env.ctx.seams.some((s) => s.type.startsWith('hem') && layerOf(env, s.a.pieceId) === 'lining');
  const tips: string[] = [];
  const warnings: string[] = [];
  let lines: Array<string | null>;
  let mins: number;

  if (seam.type === 'hem-rolled') {
    const Hr = Math.min(H, 1);
    lines = [
      `This is a rolled hem on ${where}: a tiny, delicate hem about 3 mm wide.`,
      H > 1.2 ? `Once the length is confirmed, trim the hem allowance evenly down to ${fmt(Hr)} cm; a rolled hem needs very little fabric.` : null,
      `Machine stitch ${isBottomHem ? 'all round ' : ''}${fmt(Math.max(0.5, Hr - 0.3))} cm from the raw edge (stitch length ${fmt(e.mat.handling.stitchLengthMm)} mm). This line guides the fold and stops the edge stretching.`,
      'Fold the edge to the wrong side exactly along that stitching and press. Sew again 2 mm from the fold.',
      'With small sharp scissors, trim the excess fabric right next to the second stitching line.',
      'Fold again along the stitching line, enclosing the trimmed edge, and stitch on top of the previous line. Press gently.',
    ];
    tips.push('Slow down and pull the fabric very slightly from behind the foot to keep a thin, even roll.');
    mins = 10 + (totalLen / 100) * 18;
  } else if (seam.type === 'hem-double-fold') {
    const firstFold = H >= 2 ? 1 : Math.max(0.5, Math.round((H / 3) * 10) / 10);
    const secondFold = Math.max(0.5, Math.round((H - firstFold) * 10) / 10);
    lines = [
      `Hem ${where} with a double-fold hem (the hem allowance is ${fmt(H)} cm).`,
      `Press ${fmt(firstFold)} cm to the wrong side all the way along.`,
      `Fold up again by ${fmt(secondFold)} cm so the raw edge is hidden inside, matching seams, and press. Pin every 5-8 cm.`,
      `From the wrong side, stitch 2 mm from the inner fold with stitch length ${fmt(e.mat.handling.stitchLengthMm + 0.3)} mm${isBottomHem ? ', starting at a seam and overlapping the start by 2 cm' : ', backstitching at both ends'}.`,
      'Press the hem from the wrong side.',
    ];
    if (curved) tips.push('On a curved hem the folded edge is longer than where it lands; first sew a row of long stitches along the first fold and pull it slightly so the hem lies flat without tucks.');
    mins = 8 + (totalLen / 100) * 8;
  } else {
    const hand = e.t.thick || e.t.knit ? 'catch stitch' : 'slip stitch';
    lines = [
      `Hem ${where} with a blind hem: almost nothing will show on the outside. The hem allowance is ${fmt(H)} cm.`,
      e.t.noFray
        ? 'This fabric does not fray, so the raw edge can stay as it is.'
        : e.t.sheer
          ? 'Turn under 6 mm along the raw edge and press; this fine fabric shows a zigzag through.'
          : `Finish the raw edge (${edgeFinish(e.mat)}).`,
      `Fold the hem up by ${fmt(H)} cm to the wrong side along the hem line, matching seams, and pin every 5 cm. Press lightly with the iron, without pressing over the pins.`,
      `Thread a hand needle with one strand of matching thread. Work a ${hand}: pick up just 1-2 threads of the garment, then take a 1 cm stitch inside the hem edge, and repeat. Do not pull tight; the stitches should be invisible from the right side.`,
      'Press the hem from the wrong side, using the press cloth.',
      liningNeedsHemNote ? 'Hem the lining separately with a double-fold hem so it ends 2-3 cm above the finished hem of the garment.' : null,
    ];
    tips.push('A machine blind-hem foot does the same job faster once you have practised on a scrap.');
    mins = 10 + (totalLen / 100) * 22;
  }
  if (curved) warnings.push('Let the garment hang on a hanger for 24 hours before hemming: the bias parts of the hem drop and would otherwise make the hem wavy.');
  tips.push(pressTip(e.mat));
  tips.push(...uniqueNotes(group));
  return step('construct', title, lines, {
    seamIds: group.map((s) => s.id),
    pieceIds,
    tips,
    warnings,
    minutes: minutes(mins * e.factor),
  });
}

function topstitch(seam: SeamSpec, env: TechniqueEnv, title: string, group: SeamSpec[] = [seam]): StepDraft {
  const e = seamEnv(seam, env);
  const instr = seamInstruction(seam);
  const ditch = /ditch|groove/i.test(instr.join(' '));
  const verb = ditch ? 'Stitch in the ditch' : 'Topstitch';
  const lines = [
    group.length > 1
      ? `${verb} from the right side of the garment along: ${listJoin(group.map((s) => describeJoin(s, env.idx)))}.`
      : `${verb} along ${describeJoin(seam, env.idx)} from the right side of the garment.`,
    ...instr,
    `Lengthen the stitch to ${fmt(Math.max(3, e.mat.handling.stitchLengthMm + 0.5))} mm. ${
      /ditch|groove/i.test(instr.join(' '))
        ? 'To stitch in the ditch, sew exactly in the groove of the seam so the stitches sink out of sight, catching the folded edge underneath.'
        : /close to|edgestitch/i.test(instr.join(' '))
          ? 'Edgestitch 2 mm from the folded edge, watching the edge against a mark on the presser foot rather than the needle.'
          : 'Sew 6 mm from the seam or edge, using the edge of the presser foot or a strip of masking tape as a guide.'
    }`,
    'Do not backstitch on visible stitching: leave long tails, pull them through to the wrong side with a hand needle and knot them.',
    group.length > 1 ? null : repeatLine(e.reps),
  ];
  return step('construct', title, lines, {
    seamIds: group.map((s) => s.id),
    pieceIds: [...new Set(group.flatMap(seamPieceIds))],
    tips: ['Test the stitch length and distance on a folded scrap first.', pressTip(e.mat)],
    warnings: [],
    minutes: minutes((8 * groupReps(group, env) + (groupLength(group, env) / 100) * 8) * e.factor),
  });
}

/** Grouping key: seams at the same stage with the same family become one step. */
export function seamFamily(seam: SeamSpec, env: TechniqueEnv): string {
  const type = effectiveSeamType(seam, env);
  const la = layerOf(env, seam.a.pieceId);
  switch (type) {
    case 'dart':
      return `dart|${la}`;
    case 'set-in-sleeve':
      return 'sleeve';
    case 'gathered':
      return 'gathered';
    case 'zip-invisible':
    case 'zip-lapped':
      return `zip|${type}`;
    case 'hem-blind':
    case 'hem-double-fold':
    case 'hem-rolled':
      return `hem|${type}|${la}|${/sleeve/.test(env.idx.get(seam.a.pieceId)?.role ?? '') ? 'sleeve' : 'body'}`;
    case 'understitch':
    case 'topstitch':
      return `${type}|${la}|${edgeBase(seam.a.edgeId)}`;
    case 'plain':
    case 'french': {
      if (!seam.b) {
        return `single|${la}|${singleKind(seam)}|${edgeBase(seam.a.edgeId)}`;
      }
      const lb = layerOf(env, seam.b.pieceId);
      if (isPleatedSeam(seam)) return 'pleated';
      if (isBandAttach(seam, env)) return `band-attach|${type}|${bandPiece(seam, env) ?? ''}`;
      if (involvesRole(seam, env, /facing/) && !allRoles(seam, env, /facing/)) return `facing-attach|${type}|${edgeBase(seam.a.edgeId)}`;
      if (isLiningJoin(seam, env)) return `lining-attach|${isLiningBaste(seam, env)}|${edgeBase(seam.a.edgeId)}`;
      if (la === 'lining' && lb === 'lining') return `lining-assembly|${type}`;
      return `own|${seam.id}`;
    }
  }
}

function seamTitle(seam: SeamSpec, env: TechniqueEnv, type: SeamSpec['type'], group: SeamSpec[] = [seam]): string {
  const a = pieceName(env.idx.get(seam.a.pieceId), seam.a.pieceId);
  const pieceIds = [...new Set(group.flatMap(seamPieceIds))];
  const subject = groupNoun(group.map((s) => s.a.pieceId), env);
  const edge = humanEdge(seam.a.edgeId);
  const multi = group.length > 1;
  switch (type) {
    case 'zip-invisible':
      return 'Insert the invisible zip';
    case 'zip-lapped':
      return 'Insert the lapped zip';
    case 'set-in-sleeve':
      return 'Set in the sleeves';
    case 'gathered':
      return multi ? `Gather the ${groupNoun(group.map((s) => s.b?.pieceId ?? s.a.pieceId), env)} and join it to the ${groupNoun(group.map((s) => s.a.pieceId), env)}` : `Gather and join the ${a}`;
    case 'understitch':
      return `Understitch the ${edge} facing`;
    case 'hem-blind':
    case 'hem-double-fold':
    case 'hem-rolled':
      return edgeBase(seam.a.edgeId) === 'hem' ? `Hem the ${subject}` : `Hem the ${edge} edges of the ${subject}`;
    case 'topstitch':
      if (/ditch/i.test(seamInstruction(seam).join(' '))) return `Stitch the ${subject} facing down (stitch in the ditch)`;
      return `Topstitch the ${edgePhrase(seam.a.edgeId)} of the ${subject}`;
    case 'french':
      if (multi) return isLiningJoin(seam, env) || layerOf(env, seam.a.pieceId) === 'lining' ? 'Sew the lining pieces together with French seams' : `Sew the ${subject} seams with French seams`;
      return `${seamTitle(seam, env, 'plain', group)} with a French seam`;
    default: {
      if (!seam.b) {
        const kind = singleKind(seam);
        const text = seamInstruction(seam).join(' ');
        if (kind === 'baste' && /underlin/i.test(text)) return 'Baste the underlining to the main fabric';
        const edges = multi ? (group.every((s) => /^end/.test(s.a.edgeId)) ? 'ends' : `${edgeBase(seam.a.edgeId)} edges`) : edge;
        if (kind === 'hand') return `Hand-finish the ${edges} of the ${subject}`;
        if (kind === 'baste') return `Baste the ${edges} of the ${subject}`;
        return `Stitch the ${edges} of the ${subject}`;
      }
      if (isBandAttach(seam, env)) {
        return involvesRole(seam, env, /waistband/) ? 'Attach the waistband' : `Bind the ${humanEdge(seam.a.pieceId === bandPiece(seam, env) ? seam.b.edgeId : seam.a.edgeId)}`;
      }
      if (seam.a.pieceId === seam.b.pieceId && BAND_ROLE.test(env.idx.get(seam.a.pieceId)?.role ?? '') && seam.a.edgeId !== seam.b.edgeId)
        return `Join the ends of the ${a} into a ring`;
      if (seam.a.edgeId === 'attach' && seam.b.pieceId !== seam.a.pieceId)
        return `Attach the ${a} to the ${pieceName(env.idx.get(seam.b.pieceId), seam.b.pieceId)}`;
      if (isLiningBaste(seam, env)) return `Baste the lining to the garment at the ${edge}`;
      if (isLiningJoin(seam, env)) return `Sew the lining to the ${multi ? listJoin([...new Set(group.map((s) => humanEdge(s.a.edgeId)))]) : edge}`;
      if (multi && pieceIds.every((id) => layerOf(env, id) === 'lining')) return 'Sew the lining pieces together';
      if (isFoldedJoin(seam, env.idx)) return `Sew the ${a} strips`;
      if (allRoles(seam, env, /facing/)) return `Join the facing pieces at the ${edge}`;
      if (involvesRole(seam, env, /facing/)) return `Attach the ${edge} facing`;
      if (involvesRole(seam, env, /binding/)) return `Bind the ${edge}`;
      if (seam.b.pieceId === seam.a.pieceId && seam.a.edgeId !== seam.b.edgeId && edgeBase(seam.a.edgeId) === edgeBase(seam.b.edgeId)) {
        return `Sew the ${humanEdge(edgeBase(seam.a.edgeId))} seam of the ${a}`;
      }
      const seamWord = /seam$/.test(edge) ? edge : `${edge} seam`;
      return `Sew the ${seamWord}${seam.b.pieceId !== seam.a.pieceId ? ` (${a} to ${pieceName(env.idx.get(seam.b.pieceId), seam.b.pieceId)})` : ` (${a})`}`;
    }
  }
}

/** Full technique step for one seam (darts are grouped separately). */
export function seamStep(seam: SeamSpec, env: TechniqueEnv): StepDraft {
  return seamGroupStep([seam], env);
}

/** One step for a group of seams sharing a stage and family (see seamFamily). */
/**
 * A centre seam on a piece that also holds a zip: the zip steps already close
 * the seam below the zip, so this seam must not be sewn a second time.
 */
export function closedByZip(seam: SeamSpec, env: TechniqueEnv): SeamSpec | undefined {
  if (!seam.b || seam.a.pieceId !== seam.b.pieceId || seam.a.edgeId !== seam.b.edgeId) return undefined;
  if (!/^(cb|cf|centre)$/.test(seam.a.edgeId)) return undefined;
  return env.ctx.seams.find(
    (z) => (z.type === 'zip-invisible' || z.type === 'zip-lapped') && z.a.pieceId === seam.a.pieceId && z.stage <= seam.stage,
  );
}

function closedSeamStep(group: SeamSpec[], env: TechniqueEnv): StepDraft {
  const seam = group[0]!;
  const e = seamEnv(seam, env);
  const lines = [
    `You already sewed the ${humanEdge(seam.a.edgeId)} seam of the ${e.aName} below the zip when you put the zip in. Do not sew it again.`,
    'Check it from the right side: the seam should continue the zip line in one straight line, with no pucker where the zip stitching ends. If there is a pucker, unpick 3 cm below the zip and re-sew that bit.',
    e.t.noFray ? null : `If you have not yet done so, finish the two allowances below the zip (${edgeFinish(e.mat)}).`,
    'Press the seam allowances open below the zip, over a seam roll.',
  ];
  return step('press', `Check and press the ${humanEdge(seam.a.edgeId)} seam below the zip`, lines, {
    seamIds: group.map((s) => s.id),
    pieceIds: [...new Set(group.flatMap(seamPieceIds))],
    tips: [pressTip(e.mat)],
    warnings: [],
    minutes: minutes(5 * e.factor),
  });
}

export function seamGroupStep(group: SeamSpec[], env: TechniqueEnv): StepDraft {
  const seam = group[0]!;
  if (group.every((s) => closedByZip(s, env))) return closedSeamStep(group, env);
  const type = effectiveSeamType(seam, env);
  const title = capitalize(seamTitle(seam, env, type, group));
  switch (type) {
    case 'plain':
      if (isPleatedSeam(seam)) return pleatedSeam(seam, env, 'Pleat the skirt and join it to the bodice', group);
      return plainSeam(seam, env, title, group);
    case 'french':
      return frenchSeam(seam, env, title, seam.type !== 'french', group);
    case 'dart':
      return dartStep(group, env);
    case 'zip-invisible':
      return invisibleZip(seam, env, title, group);
    case 'zip-lapped':
      return lappedZip(seam, env, title, group);
    case 'set-in-sleeve':
      return setInSleeve(seam, env, title, group);
    case 'gathered':
      return gatheredSeam(seam, env, title, group);
    case 'understitch':
      return understitch(seam, env, title, group);
    case 'hem-blind':
    case 'hem-double-fold':
    case 'hem-rolled':
      return hemSeam(seam, env, title, group);
    case 'topstitch':
      return topstitch(seam, env, title, group);
  }
}

/** Split seams of one stage into ordered groups that share a family. */
export function groupSeams(seams: SeamSpec[], env: TechniqueEnv): SeamSpec[][] {
  const groups = new Map<string, SeamSpec[]>();
  for (const s of seams) {
    const key = seamFamily(s, env);
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }
  return [...groups.values()];
}

/** Temporary basting of the seams that decide fit, for a try-on. */
/**
 * Basting for the fitting. When the fit seams are interleaved with other
 * assembly stages, basting is split into several steps; `continued` marks the
 * later ones so their wording reads naturally.
 */
export function basteStep(seams: SeamSpec[], env: TechniqueEnv, continued = false): StepDraft {
  const names = seams.map((s) => describeJoin(s, env.idx));
  const sa = seamEnv(seams[0]!, env).sa;
  let total = 0;
  let mins = 0;
  for (const s of seams) {
    const e = seamEnv(s, env);
    total += e.reps;
    mins += (5 + (e.lengthCm / 100) * 4) * e.reps;
  }
  const french = seams.some((s) => effectiveSeamType(s, env) === 'french');
  const lines = [
    continued
      ? `Baste the next fitting seams the same way, so the garment can be tried on: ${listJoin(names)}${total > seams.length ? ' (both sides)' : ''}.`
      : `Before sewing for real, baste the seams that decide how the garment fits so you can try it on: ${listJoin(names)}${total > seams.length ? ' (both sides)' : ''}.`,
    `Pin with right sides together, matching notches. Set the stitch length to 5 mm (the longest) and sew exactly on the ${fmt(sa)} cm seam line. Do not backstitch; leave 5 cm thread tails so the stitches are easy to pull out.`,
    french
      ? 'These seams will become French seams later; basting right sides together now is only for the fitting, and you will pull this basting out afterwards.'
      : 'Do not finish the edges or trim anything yet; you may need the extra fabric.',
  ];
  return step('construct', continued ? 'Baste the remaining fitting seams' : 'Baste the main seams for a fitting', lines, {
    seamIds: seams.map((s) => s.id),
    pieceIds: [...new Set(seams.flatMap(seamPieceIds))],
    tips: ['Use a contrasting thread colour for basting so it is easy to see and remove.'],
    warnings: [],
    minutes: minutes(mins),
  });
}
