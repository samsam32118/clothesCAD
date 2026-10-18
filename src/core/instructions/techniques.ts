import type { InstructionStep, MaterialPreset, SeamSpec } from '../types';
import {
  allowanceAtEdge,
  capitalize,
  describeJoin,
  edgeFinish,
  edgeInstances,
  fmt,
  humanEdge,
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
  return `Machine set-up for ${mat.name.toLowerCase()}: ${mat.handling.needle} needle, ${mat.handling.thread.toLowerCase()}, ${stitch}.`;
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

function finishLine(seam: SeamSpec, e: SeamEnv): string {
  if (e.t.noFray) return 'No edge finish is needed: this fabric does not fray. Press the seam allowances open.';
  // The fabric's own recommendation wins (it knows e.g. that overlocking shows
  // through duchesse satin); keep any pressing direction the pattern specifies.
  const recommended = edgeFinish(e.mat);
  const pressNote = seam.finish?.match(/press[^,.;]*/i)?.[0];
  return `Seam finish: ${capitalize(recommended)}.${pressNote && !/press/i.test(recommended) ? ` Then ${pressNote.toLowerCase()}.` : ''}`;
}

function pressTip(mat: MaterialPreset): string {
  return `Pressing ${mat.name.toLowerCase()}: ${mat.handling.pressing}`;
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

/** Whether a plain seam shares an edge with a zip seam (then it must stay a plain seam). */
function touchesZip(seam: SeamSpec, env: TechniqueEnv): boolean {
  const zips = env.ctx.seams.filter((s) => s.type === 'zip-invisible' || s.type === 'zip-lapped');
  const ends = [seam.a, ...(seam.b ? [seam.b] : [])];
  return zips.some((z) =>
    [z.a, ...(z.b ? [z.b] : [])].some((ze) => ends.some((e) => e.pieceId === ze.pieceId && e.edgeId === ze.edgeId)),
  );
}

/** Plain seams on sheer wovens become French seams (unless they hold a zip). */
export function effectiveSeamType(seam: SeamSpec, env: TechniqueEnv): SeamSpec['type'] {
  if (seam.type !== 'plain' || !seam.b) return seam.type;
  const e = seamEnv(seam, env);
  const structural = !involvesRole(seam, env, /waistband|facing|binding|tie/);
  const straight = !isCurvedEdge(seam.a.edgeId) && !isCurvedEdge(seam.b.edgeId);
  if (e.t.sheer && structural && straight && !touchesZip(seam, env) && e.sa >= 1) return 'french';
  return 'plain';
}

// ---------------------------------------------------------------------------
// Seam techniques
// ---------------------------------------------------------------------------

function plainSeam(seam: SeamSpec, env: TechniqueEnv, title: string): StepDraft {
  const e = seamEnv(seam, env);
  const join = describeJoin(seam, env.idx);
  const tips: string[] = [];
  const warnings: string[] = [];
  const lines: Array<string | null> = [];

  if (!seam.b) {
    lines.push(
      `Working on a single layer, stitch along ${join}, ${fmt(e.sa)} cm from the raw edge, stitch length ${fmt(e.mat.handling.stitchLengthMm)} mm.`,
      finishLine(seam, e),
      repeatLine(e.reps, 'piece'),
    );
    return step('construct', title, lines, {
      seamIds: [seam.id],
      pieceIds: seamPieceIds(seam),
      tips: [pressTip(e.mat)],
      minutes: minutes((8 + (e.lengthCm / 100) * 6) * e.reps * e.factor),
    });
  }

  const waistband = involvesRole(seam, env, /waistband/);
  const facing = involvesRole(seam, env, /facing/) && !allRoles(seam, env, /facing/);
  const crotch = /crotch|rise/i.test(seam.a.edgeId);

  lines.push(
    `Lay ${join} with right sides together, matching the raw edges, the ends and every notch.`,
    pinLine(e.t),
  );
  if (seam.intendedEaseCm > 0.3) {
    lines.push(
      `The ${e.aName} edge is about ${fmt(seam.intendedEaseCm)} cm longer than the edge it joins. Pin the ends and notches first, then spread the extra length evenly between them so no tucks form; sew with the longer layer underneath, against the machine's feed dogs, which eases it in for you.`,
    );
  }
  lines.push(stitchLine(e, e.sa));
  if (crotch) {
    lines.push(
      'Sew the curved lower part of the crotch a second time, 2 mm inside the first line, for strength, then trim the allowance on that curve to 1 cm.',
    );
  }
  if (facing) {
    lines.push(
      `Trim the seam allowance to about ${fmt(e.sa / 2)} cm and grade it (cut the facing layer a little narrower). On curves, clip into the allowance every 1-1.5 cm, stopping 2 mm before the stitches.`,
      'Press the facing and the allowances away from the garment.',
    );
  } else if (waistband) {
    lines.push(
      'Press the seam allowances up into the waistband. Fold the waistband in half lengthwise along its fold line, right sides together, and sew across each short end at the seam allowance; trim the corners diagonally and turn the band right side out, pushing the corners out gently.',
      `Press under the free long edge by ${fmt(e.sa)} cm, pin it over the seam on the inside so it just covers the stitching, and slip stitch it by hand (or stitch in the groove of the seam from the right side).`,
    );
  } else {
    lines.push('Press the seam flat exactly as sewn to set the stitches, then press the seam allowances open.');
    lines.push(finishLine(seam, e));
  }
  if (isCurvedEdge(seam.a.edgeId)) tips.push('Sew curves slowly. Stop with the needle down, lift the presser foot and turn the fabric slightly, then continue.');
  if (e.t.slippery) tips.push('Put a strip of tissue paper under the seam if the fabric gets pulled into the needle plate; tear it away afterwards.');
  if (e.lengthCm > 0)
    tips.push(`This seam is about ${fmt(e.lengthCm)} cm long. If the two edges differ by more than 0.5 cm at the end, unpick from the last notch and re-pin.`);
  tips.push(pressTip(e.mat));
  if (seam.note) tips.push(seam.note);
  if (e.t.pinInAllowanceOnly) warnings.push('Never sew over pins: on this fabric a broken needle or a hole is likely.');
  const rep = repeatLine(e.reps);
  if (rep) lines.push(rep);

  const base = 8 + (e.lengthCm / 100) * 6 + (e.t.noFray ? 0 : (e.lengthCm / 100) * 6) + 3 + (waistband ? 20 : 0) + (facing ? 8 : 0);
  return step('construct', title, lines, {
    seamIds: [seam.id],
    pieceIds: seamPieceIds(seam),
    tips,
    warnings,
    minutes: minutes(base * e.reps * e.factor),
  });
}

function frenchSeam(seam: SeamSpec, env: TechniqueEnv, title: string, converted: boolean): StepDraft {
  const e = seamEnv(seam, env);
  const first = Math.max(0.4, Math.round(e.sa * 0.4 * 10) / 10);
  const second = Math.max(0.5, Math.round((e.sa - first) * 10) / 10);
  const join = describeJoin(seam, env.idx);
  const lines = [
    converted
      ? `Because this fabric is sheer, you will enclose the raw edges in a French seam: the inside will look as neat as the outside.`
      : 'This is a French seam: it is sewn twice so the raw edges end up completely enclosed.',
    `Lay ${join} with WRONG sides together (yes, the opposite of usual), matching the edges and notches. ${pinLine(e.t)}`,
    `First pass: sew ${fmt(first)} cm from the raw edge, stitch length ${fmt(e.mat.handling.stitchLengthMm)} mm, backstitching at both ends.`,
    `Trim the allowance to a scant 3 mm, cutting carefully and evenly. Press the seam flat, then press it to one side.`,
    `Fold the fabric along the seam so the RIGHT sides are now together and the first seam sits exactly on the fold; press the fold sharply.`,
    `Second pass: sew ${fmt(second)} cm from the fold. This encloses the trimmed edges; check that no frayed threads poke through on the right side.`,
    'Press the finished seam towards the back of the garment.',
    repeatLine(e.reps),
  ];
  return step('construct', title, lines, {
    seamIds: [seam.id],
    pieceIds: seamPieceIds(seam),
    tips: [
      'If whiskers of fabric peek through after the second pass, unpick that section, trim closer and re-sew.',
      pressTip(e.mat),
      ...(seam.note ? [seam.note] : []),
    ],
    warnings: e.t.pinInAllowanceOnly ? ['Pin only within the seam allowance: pins mark this fabric.'] : [],
    minutes: minutes((15 + (e.lengthCm / 100) * 12) * e.reps * e.factor),
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
    minutes: minutes(total * 7 * e.factor),
  });
}

function invisibleZip(seam: SeamSpec, env: TechniqueEnv, title: string): StepDraft {
  const e = seamEnv(seam, env);
  const zip = zipInfo(env.ctx, env.idx);
  const join = describeJoin(seam, env.idx);
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
    seamIds: [seam.id],
    pieceIds: seamPieceIds(seam),
    tips: [
      'Practise once on two scraps of your fabric first; it takes 10 minutes and makes the real one easy.',
      'Buy the zip 2-3 cm longer than the opening: the slider can never be sewn past, so a longer zip lets you stitch the full opening.',
      pressTip(e.mat),
    ],
    warnings: ['Never touch the zip coil with a hot iron: it can melt.'],
    minutes: minutes(45 * e.factor),
  });
}

function lappedZip(seam: SeamSpec, env: TechniqueEnv, title: string): StepDraft {
  const e = seamEnv(seam, env);
  const zip = zipInfo(env.ctx, env.idx);
  const join = describeJoin(seam, env.idx);
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
    seamIds: [seam.id],
    pieceIds: seamPieceIds(seam),
    tips: ['A strip of 1.2 cm wide masking tape on the right side makes a perfect topstitching guide.', pressTip(e.mat)],
    warnings: ['Stop and turn the hand wheel by hand when you cross the zip teeth near the bottom; hitting the stop breaks needles.'],
    minutes: minutes(55 * e.factor),
  });
}

function setInSleeve(seam: SeamSpec, env: TechniqueEnv, title: string): StepDraft {
  const e = seamEnv(seam, env);
  const sleeveFirst = /sleeve/.test(env.idx.get(seam.a.pieceId)?.role ?? '');
  const sleeveName = sleeveFirst ? e.aName : (e.bName ?? 'sleeve');
  const ease = seam.intendedEaseCm;
  const r1 = Math.max(0.4, e.sa - 0.3);
  const r2 = Math.max(0.2, e.sa - 0.8);
  const lines = [
    `Sew the underarm seam of the ${sleeveName} first if you have not already, and press it open.`,
    `On the sleeve cap, sew two rows of ease stitching between the front and back notches: stitch length 4 mm, no backstitching, leaving 10 cm thread tails, at ${fmt(r1)} cm and ${fmt(r2)} cm from the raw edge.`,
    'Turn the garment wrong side out and the sleeve right side out. Slide the sleeve into the armhole so the right sides face each other.',
    'Pin the key points first: underarm seam to side seam, the dot at the top of the cap to the shoulder seam, the single notch to the front armhole and the double notch to the back armhole.',
    ease > 0.2
      ? `The cap is about ${fmt(ease)} cm longer than the armhole; that extra is what gives your shoulder room. Gently pull the two bobbin threads together to draw up the cap until it fits, spreading the fullness evenly over the top of the cap. Pin every 2 cm. There must be no tucks or pleats.`
      : 'The cap and armhole are nearly the same length; pin every 2-3 cm, spreading any tiny difference evenly.',
    `Sew with the sleeve side down against the machine bed (the feed dogs help ease it in), ${fmt(e.sa)} cm from the edge, starting at the underarm and going all the way round, overlapping the start by 2 cm.`,
    'Turn to the right side and check the cap for little tucks. If you find one, unpick 3 cm around it, redistribute and re-sew.',
    'Between the notches at the underarm only, sew a second row 6 mm outside the first and trim that part of the allowance close to it. Finish the edges together.',
    "Press the allowances towards the sleeve, over a tailor's ham, touching only the allowance; never press the sleeve cap flat. Pull out any ease stitches that show on the right side.",
    repeatLine(e.reps, 'sleeve') ? 'Repeat for the second sleeve. Check the notches so the left sleeve goes into the left armhole: single notch = front.' : null,
  ];
  return step('construct', title, lines, {
    seamIds: [seam.id],
    pieceIds: seamPieceIds(seam),
    tips: [
      'Hand baste the sleeve in first if you are nervous: it is quick, and you can try it on before machine stitching.',
      pressTip(e.mat),
    ],
    warnings: e.t.knit ? [] : ['Do not stretch the armhole of the bodice while pinning; it is cut partly on the bias and grows easily.'],
    minutes: minutes(40 * e.reps * e.factor),
  });
}

function gatheredSeam(seam: SeamSpec, env: TechniqueEnv, title: string): StepDraft {
  const e = seamEnv(seam, env);
  const lenA = seamLengthCm(seam, env.idx);
  const lenB = seam.b ? (env.idx.edge(seam.b.pieceId, seam.b.edgeId)?.lengthCm ?? 0) : 0;
  const longer = lenA >= lenB ? e.aName : (e.bName ?? e.aName);
  const shorter = lenA >= lenB ? (e.bName ?? 'its partner') : e.aName;
  const target = Math.min(lenA, lenB || lenA);
  const r1 = Math.max(0.4, e.sa - 0.5);
  const r2 = Math.max(0.2, e.sa - 1);
  const lines = [
    `The ${longer} is gathered to fit the ${shorter}${seam.intendedEaseCm > 0 ? ` (about ${fmt(seam.intendedEaseCm)} cm of extra fabric is drawn up)` : ''}.`,
    `Set a long stitch (4-5 mm) and loosen the upper tension a little. On the ${longer}, sew two parallel rows within the seam allowance, at ${fmt(r1)} cm and ${fmt(r2)} cm from the raw edge, without backstitching. Leave 15 cm thread tails. On long edges, stop and restart at each seam or quarter mark so each section can be gathered separately.`,
    `Pin the ${longer} to the ${shorter} with right sides together at the ends, side seams, notches and quarter marks.`,
    `Hold both bobbin threads at one end and gently slide the fabric along them until the gathered edge measures ${target > 0 ? `${fmt(target)} cm (the length of the ${shorter} edge)` : 'the same as the edge it joins'}. Wrap the threads around a pin in a figure of eight to lock them.`,
    'Spread the gathers evenly with your fingers and pin every 2-3 cm.',
    `Reset normal stitch length and tension. Sew with the gathered side up at ${fmt(e.sa)} cm, just outside the gathering rows, holding gathers flat in front of the needle so none fold over.`,
    'Remove any gathering threads that show on the right side. Finish the edges together and press the allowances away from the gathers (towards the smoother piece); do not press the gathers flat.',
  ];
  return step('construct', title, lines, {
    seamIds: [seam.id],
    pieceIds: seamPieceIds(seam),
    tips: ['If a thread snaps while gathering, that is why there are two rows; tie off and gather with the remaining one.', pressTip(e.mat)],
    warnings: [],
    minutes: minutes((25 + (Math.max(lenA, lenB) / 100) * 15) * e.reps * e.factor),
  });
}

function understitch(seam: SeamSpec, env: TechniqueEnv, title: string): StepDraft {
  const e = seamEnv(seam, env);
  const facingFirst = /facing/.test(env.idx.get(seam.a.pieceId)?.role ?? '');
  const facingName = facingFirst ? e.aName : (e.bName ?? 'facing');
  const garmentName = facingFirst ? (e.bName ?? 'garment') : e.aName;
  const edge = humanEdge(seam.a.edgeId);
  const alreadyJoined = env.ctx.seams.some(
    (s) =>
      s !== seam &&
      s.stage <= seam.stage &&
      s.type === 'plain' &&
      [s.a, ...(s.b ? [s.b] : [])].some((x) => x.pieceId === seam.a.pieceId && x.edgeId === seam.a.edgeId),
  );
  const lines = [
    alreadyJoined
      ? null
      : `Pin the ${facingName} to the ${garmentName} along the ${edge} edge with right sides together, matching notches and seams, and sew at ${fmt(e.sa)} cm.`,
    `Trim the seam allowance to about ${fmt(e.sa / 2)} cm and grade it so the facing layer is narrower. On curves, clip into the allowance every 1 cm, stopping 2 mm before the stitches.`,
    `Press the ${facingName} and both seam allowances away from the ${garmentName}.`,
    `From the right side of the ${facingName}, sew 2-3 mm from the seam line through the facing and the allowances underneath (not the garment). Keep the allowances flat underneath and turn the work slowly on curves.`,
    `Turn the facing to the inside. The understitching makes the seam roll 1 mm towards the inside so the facing never peeks out. Press.`,
    'Hand-tack the facing to the seam allowances at the shoulder and side seams with a few small stitches so it stays inside.',
  ];
  return step('construct', title, lines, {
    seamIds: [seam.id],
    pieceIds: seamPieceIds(seam),
    tips: ['Understitching is what separates a professional neckline from a home-made one; take it slowly.', pressTip(e.mat)],
    warnings: ['When clipping, never cut through the stitches: stop 2 mm short.'],
    minutes: minutes((15 + (e.lengthCm / 100) * 8 + (alreadyJoined ? 0 : 10)) * e.factor),
  });
}

function hemSeam(seam: SeamSpec, env: TechniqueEnv, title: string): StepDraft {
  const e = seamEnv(seam, env);
  const p = env.idx.get(seam.a.pieceId);
  const H = allowanceAtEdge(p, seam.a.edgeId, seam.type === 'hem-rolled' ? 1 : 3);
  const pieceList = [e.aName, ...(e.bName && e.bName !== e.aName ? [e.bName] : [])];
  const totalLen = e.lengthCm * edgeInstances(p);
  const where = `the ${humanEdge(seam.a.edgeId)} edge of the ${listJoin(pieceList)}`;
  const curved = env.ctx.garment.id === 'circle-skirt' || env.ctx.fit.options.flare >= 0.6 || env.ctx.garment.id === 'ball-gown';
  const tips: string[] = [];
  const warnings: string[] = [];
  let lines: Array<string | null>;
  let mins: number;

  if (seam.type === 'hem-rolled') {
    lines = [
      `This is a rolled hem on ${where}: a tiny, delicate hem about 3 mm wide.`,
      `Machine stitch all round ${fmt(Math.max(0.5, H - 0.3))} cm from the raw edge (stitch length ${fmt(e.mat.handling.stitchLengthMm)} mm). This line guides the fold and stops the edge stretching.`,
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
      `Press ${fmt(firstFold)} cm to the wrong side all the way round.`,
      `Fold up again by ${fmt(secondFold)} cm so the raw edge is hidden inside, matching side seams, and press. Pin every 5-8 cm.`,
      `From the wrong side, stitch 2 mm from the inner fold with stitch length ${fmt(e.mat.handling.stitchLengthMm + 0.3)} mm, starting at a side seam and overlapping the start by 2 cm.`,
      'Press the hem from the wrong side.',
    ];
    if (curved) tips.push('On a curved hem the folded edge is longer than where it lands; first sew a row of long stitches along the first fold and pull it slightly so the hem lies flat without tucks.');
    mins = 10 + (totalLen / 100) * 8;
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
      env.ctx.pieces.some((x) => x.layer === 'lining')
        ? 'Hem the lining separately with a double-fold hem so it ends 2-3 cm above the finished hem of the garment.'
        : null,
    ];
    tips.push('A machine blind-hem foot does the same job faster once you have practised on a scrap.');
    mins = 10 + (totalLen / 100) * 25;
  }
  if (curved && !/sleeve/.test(p?.role ?? '')) warnings.push('Let the garment hang on a hanger for 24 hours before hemming: the bias parts of the hem drop and would otherwise make the hem wavy.');
  tips.push(pressTip(e.mat));
  if (seam.note) tips.push(seam.note);
  return step('construct', title, lines, {
    seamIds: [seam.id],
    pieceIds: seamPieceIds(seam),
    tips,
    warnings,
    minutes: minutes(mins * e.factor),
  });
}

function topstitch(seam: SeamSpec, env: TechniqueEnv, title: string): StepDraft {
  const e = seamEnv(seam, env);
  const lines = [
    `Topstitch along ${describeJoin(seam, env.idx)} from the right side of the garment.`,
    `Lengthen the stitch to ${fmt(Math.max(3, e.mat.handling.stitchLengthMm + 0.5))} mm. Sew 6 mm from the seam or edge, using the edge of the presser foot or a strip of masking tape as a guide.`,
    'Do not backstitch on visible stitching: leave long tails, pull them through to the wrong side with a hand needle and knot them.',
    repeatLine(e.reps),
  ];
  return step('construct', title, lines, {
    seamIds: [seam.id],
    pieceIds: seamPieceIds(seam),
    tips: ['Test the stitch length and distance on a folded scrap first.', pressTip(e.mat)],
    warnings: [],
    minutes: minutes((8 + (e.lengthCm / 100) * 6) * e.reps * e.factor),
  });
}

function seamTitle(seam: SeamSpec, env: TechniqueEnv, type: SeamSpec['type']): string {
  const a = pieceName(env.idx.get(seam.a.pieceId), seam.a.pieceId);
  const edge = humanEdge(seam.a.edgeId);
  switch (type) {
    case 'zip-invisible':
      return 'Insert the invisible zip';
    case 'zip-lapped':
      return 'Insert the lapped zip';
    case 'set-in-sleeve':
      return 'Set in the sleeves';
    case 'gathered':
      return `Gather and join the ${a}`;
    case 'understitch':
      return `Understitch the ${edge} facing`;
    case 'hem-blind':
    case 'hem-double-fold':
    case 'hem-rolled':
      return `Hem the ${a}`;
    case 'topstitch':
      return `Topstitch the ${edge}`;
    case 'french':
      return `French seam: ${edge} of the ${a}`;
    default:
      if (involvesRole(seam, env, /waistband/)) return 'Attach the waistband';
      if (allRoles(seam, env, /facing/)) return `Join the facing pieces at the ${edge}`;
      if (involvesRole(seam, env, /facing/)) return `Attach the ${edge} facing`;
      if (involvesRole(seam, env, /binding/)) return `Bind the ${edge}`;
      return `Sew the ${edge} seam${seam.b && seam.b.pieceId !== seam.a.pieceId ? ` (${a} to ${pieceName(env.idx.get(seam.b.pieceId), seam.b.pieceId)})` : ` (${a})`}`;
  }
}

/** Full technique step for one seam (darts are grouped separately). */
export function seamStep(seam: SeamSpec, env: TechniqueEnv): StepDraft {
  const type = effectiveSeamType(seam, env);
  const title = capitalize(seamTitle(seam, env, type));
  switch (type) {
    case 'plain':
      return plainSeam(seam, env, title);
    case 'french':
      return frenchSeam(seam, env, title, seam.type !== 'french');
    case 'dart':
      return dartStep([seam], env);
    case 'zip-invisible':
      return invisibleZip(seam, env, title);
    case 'zip-lapped':
      return lappedZip(seam, env, title);
    case 'set-in-sleeve':
      return setInSleeve(seam, env, title);
    case 'gathered':
      return gatheredSeam(seam, env, title);
    case 'understitch':
      return understitch(seam, env, title);
    case 'hem-blind':
    case 'hem-double-fold':
    case 'hem-rolled':
      return hemSeam(seam, env, title);
    case 'topstitch':
      return topstitch(seam, env, title);
  }
}

/** Temporary basting of the seams that decide fit, for a try-on. */
export function basteStep(seams: SeamSpec[], env: TechniqueEnv): StepDraft {
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
    `Before sewing for real, baste the seams that decide how the garment fits so you can try it on: ${listJoin(names)}${total > seams.length ? ' (both sides)' : ''}.`,
    `Pin with right sides together, matching notches. Set the stitch length to 5 mm (the longest) and sew exactly on the ${fmt(sa)} cm seam line. Do not backstitch; leave 5 cm thread tails so the stitches are easy to pull out.`,
    french
      ? 'These seams will become French seams later; basting right sides together now is only for the fitting, and you will pull this basting out afterwards.'
      : 'Do not finish the edges or trim anything yet; you may need the extra fabric.',
  ];
  return step('construct', 'Baste the main seams for a fitting', lines, {
    seamIds: seams.map((s) => s.id),
    pieceIds: [...new Set(seams.flatMap(seamPieceIds))],
    tips: ['Use a contrasting thread colour for basting so it is easy to see and remove.'],
    warnings: [],
    minutes: minutes(mins),
  });
}
