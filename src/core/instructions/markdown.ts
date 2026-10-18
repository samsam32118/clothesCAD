import type { BomItem, DesignPackage, InstructionStep, MeasurementKey } from '../types';
import { fmt } from './shared';

const MEASUREMENT_LABELS: Array<[MeasurementKey, string]> = [
  ['heightCm', 'Height'],
  ['bustCm', 'Bust'],
  ['underbustCm', 'Underbust'],
  ['waistCm', 'Waist'],
  ['highHipCm', 'High hip'],
  ['hipCm', 'Hip'],
  ['neckCm', 'Neck'],
  ['shoulderWidthCm', 'Shoulder width'],
  ['shoulderLengthCm', 'Shoulder length'],
  ['backWaistLengthCm', 'Back waist length'],
  ['frontWaistLengthCm', 'Front waist length'],
  ['shoulderToBustPointCm', 'Shoulder to bust point'],
  ['bustPointDistanceCm', 'Bust point distance'],
  ['armLengthCm', 'Arm length'],
  ['upperArmCm', 'Upper arm'],
  ['elbowCm', 'Elbow'],
  ['wristCm', 'Wrist'],
  ['waistToHipCm', 'Waist to hip'],
  ['waistToKneeCm', 'Waist to knee'],
  ['waistToFloorCm', 'Waist to floor'],
  ['crotchDepthCm', 'Crotch depth'],
  ['inseamCm', 'Inseam'],
  ['thighCm', 'Thigh'],
  ['kneeCm', 'Knee'],
  ['calfCm', 'Calf'],
  ['ankleCm', 'Ankle'],
];

const PHASE_TITLES: Record<InstructionStep['phase'], string> = {
  prepare: 'Prepare',
  cut: 'Cut',
  mark: 'Mark',
  construct: 'Sew',
  fit: 'Fit',
  finish: 'Finish',
  press: 'Press',
};

/** Escape characters that would break a markdown table cell. */
function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function eur(n: number | undefined): string {
  return n === undefined ? '' : `€${n.toFixed(2)}`;
}

function stars(n: number, max = 5): string {
  return '★'.repeat(n) + '☆'.repeat(Math.max(0, max - n));
}

function hours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Convert a step body (newline-separated lines; "- " for bullets) into markdown. */
function bodyMarkdown(body: string): string {
  const out: string[] = [];
  let n = 0;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('- ')) {
      out.push(`   ${line}`);
    } else {
      n++;
      out.push(`${n}. ${line}`);
    }
  }
  return out.join('\n');
}

function bomTable(items: BomItem[]): string[] {
  const rows = ['| Item | Qty | Details | Est. cost |', '|---|---|---|---|'];
  for (const b of items) {
    const qty = `${b.unit === 'm' ? fmt(b.quantity, 1) : fmt(b.quantity, 0)} ${b.unit}`;
    rows.push(
      `| ${cell(b.name)}${b.essential ? '' : ' *(optional)*'} | ${qty} | ${cell(b.spec ?? '')} | ${eur(b.estCostEur)} |`,
    );
  }
  return rows;
}

/** A complete, printable markdown booklet for the design package. */
export function renderInstructionsMarkdown(pkg: DesignPackage): string {
  const L: string[] = [];
  const { garment, style, material, fit, measurements, body } = pkg;
  const pieceById = new Map(pkg.pieces.map((p) => [p.id, p] as const));

  // ---- title + overview -------------------------------------------------------
  L.push(`# ${pkg.name}`, '');
  L.push(`*${garment.name} · ${style.name} · ${material.name}*`, '');
  L.push(`> ${garment.description}`, '');
  L.push('## Overview', '');
  L.push('| | |', '|---|---|');
  L.push(`| Garment | ${cell(garment.name)} (${garment.category}) |`);
  L.push(`| Style | ${cell(style.name)} (${style.region === 'european' ? 'European' : 'Scandinavian'}) |`);
  L.push(`| Fabric | ${cell(material.name)}, ${material.weightGsm} g/m², ${material.widthCm} cm wide |`);
  L.push(`| Difficulty | ${stars(pkg.effort.difficulty)} (${pkg.effort.difficulty}/5) |`);
  L.push(`| Estimated sewing time | ${hours(pkg.effort.minutes)} (${pkg.instructions.length} steps) |`);
  const opts = fit.options;
  const optBits = [
    `${opts.fit} fit`,
    garment.allowed.length.length ? `${opts.length} length` : null,
    garment.allowed.neckline.length ? `${opts.neckline} neckline` : null,
    garment.allowed.sleeve.length > 1 ? `sleeve: ${opts.sleeve}` : null,
    `closure: ${opts.closure}`,
    opts.lining ? 'lined' : null,
    opts.pockets ? 'pockets' : null,
  ].filter((x): x is string => !!x);
  L.push(`| Options | ${cell(optBits.join(', '))} |`);
  const totalCost = pkg.bom.filter((b) => b.kind !== 'tool').reduce((a, b) => a + (b.estCostEur ?? 0), 0);
  L.push(`| Materials cost (est.) | ${eur(totalCost)} |`);
  L.push('');
  L.push(`**Style:** ${style.description}`, '');
  if (style.palette.length) {
    L.push(`**Suggested colours:** ${style.palette.map((c) => `${c.name} (\`${c.hex}\`)`).join(', ')}`, '');
  }
  L.push(`**Fabric:** ${material.description}`, '');

  // ---- fit rationale --------------------------------------------------------
  L.push('## Why this design suits you', '');
  L.push(`Body shape: **${body.shape}**.`, '');
  for (const r of fit.rationale) L.push(`- ${r}`);
  for (const n of body.notes) L.push(`- ${n}`);
  L.push('');

  // ---- measurements ---------------------------------------------------------
  L.push('## Your measurements', '');
  const estimated = new Set<MeasurementKey>(measurements.estimated);
  L.push('| Measurement | cm | Source |', '|---|---|---|');
  for (const [key, label] of MEASUREMENT_LABELS) {
    const v = measurements[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    L.push(`| ${label} | ${fmt(v)} | ${estimated.has(key) ? 'estimated ⚠' : 'measured'} |`);
  }
  L.push('');
  if (estimated.size) {
    L.push(
      `> ⚠ ${estimated.size} measurement${estimated.size === 1 ? ' was' : 's were'} estimated from your height, bust, waist and hip. Measuring them yourself gives a better fit.`,
      '',
    );
  }
  if (pkg.measurementIssues.length) {
    L.push('**Measurement notes:**', '');
    for (const i of pkg.measurementIssues) L.push(`- *${i.severity}* (${i.key}): ${i.message}`);
    L.push('');
  }

  L.push('### Finished garment', '');
  L.push('| Area | Finished (cm) | Body (cm) | Ease (cm) |', '|---|---|---|---|');
  const fin = fit.finished;
  const row = (label: string, f: number | undefined, b: number, e: number) => {
    if (f !== undefined && Number.isFinite(f)) L.push(`| ${label} | ${fmt(f)} | ${fmt(b)} | ${fmt(e)} |`);
  };
  row('Bust', fin.bust, measurements.bustCm, fit.ease.bust);
  row('Waist', fin.waist, measurements.waistCm, fit.ease.waist);
  row('Hip', fin.hip, measurements.hipCm, fit.ease.hip);
  if (fin.hem !== undefined) L.push(`| Hem circumference | ${fmt(fin.hem)} | | |`);
  if (fin.lengthFromWaist !== undefined) L.push(`| Length from waist | ${fmt(fin.lengthFromWaist)} | | |`);
  if (fin.lengthFromShoulder !== undefined) L.push(`| Length from shoulder | ${fmt(fin.lengthFromShoulder)} | | |`);
  if (fin.sleeveLength !== undefined && fin.sleeveLength > 0) L.push(`| Sleeve length | ${fmt(fin.sleeveLength)} | ${fmt(measurements.armLengthCm)} | |`);
  if (fin.inseam !== undefined) L.push(`| Inseam | ${fmt(fin.inseam)} | ${fmt(measurements.inseamCm)} | |`);
  L.push(`| Hem height from floor | ${fmt(fit.hemHeightFromFloorCm)} | | |`);
  L.push('');

  // ---- BOM ------------------------------------------------------------------
  L.push('## Shopping list', '');
  const materials = pkg.bom.filter((b) => b.kind !== 'tool');
  const tools = pkg.bom.filter((b) => b.kind === 'tool');
  L.push(...bomTable(materials), '');
  L.push(`**Materials total (est.): ${eur(totalCost)}**`, '');
  if (tools.length) {
    L.push('### Tools', '');
    L.push(...bomTable(tools), '');
  }

  // ---- cutting --------------------------------------------------------------
  L.push('## Pattern pieces and cutting', '');
  L.push('| Piece | Layer | Cut | On fold | Mirrored pair |', '|---|---|---|---|---|');
  for (const p of pkg.pieces) {
    L.push(`| ${cell(p.name)} | ${p.layer} | ${p.cutCount} | ${p.cutOnFold ? 'yes' : ''} | ${p.mirrorPair ? 'yes' : ''} |`);
  }
  L.push('');
  if (pkg.layouts.length) {
    L.push('| Layout | Fabric width | Fold | Length used | Efficiency |', '|---|---|---|---|---|');
    for (const l of pkg.layouts) {
      L.push(
        `| ${l.layer} | ${fmt(l.fabricWidthCm)} cm | ${l.fold} | ${fmt(l.lengthCm, 0)} cm | ${Math.round(l.efficiency * 100)} % |`,
      );
    }
    L.push('');
  }

  // ---- steps ----------------------------------------------------------------
  L.push('## Step by step', '');
  let phase: InstructionStep['phase'] | null = null;
  for (const s of pkg.instructions) {
    if (s.phase !== phase) {
      phase = s.phase;
      L.push(`### ${PHASE_TITLES[phase]}`, '');
    }
    L.push(`#### Step ${s.n}. ${s.title}`, '');
    L.push(`*About ${s.minutes} min*`, '');
    L.push(bodyMarkdown(s.body), '');
    if (s.warnings.length) {
      L.push(s.warnings.map((w) => `> ⚠ **Careful:** ${w}`).join('\n>\n'), '');
    }
    for (const t of s.tips) L.push(`- 💡 ${t}`);
    if (s.tips.length) L.push('');
    if (s.checkpoint) L.push(`> ✅ **Checkpoint:** ${s.checkpoint}`, '');
    const parts = s.pieceIds.map((id) => pieceById.get(id)?.name ?? id);
    const meta: string[] = [];
    if (parts.length) meta.push(`Pieces: ${parts.join(', ')}`);
    if (s.seamIds.length) meta.push(`Seams: ${s.seamIds.map((x) => `\`${x}\``).join(', ')}`);
    if (s.terms.length) meta.push(`Terms: ${s.terms.join(', ')}`);
    if (meta.length) L.push(`<sub>${meta.join(' · ')}</sub>`, '');
  }

  // ---- styling + glossary ---------------------------------------------------
  if (style.stylingNotes.length || style.details.length) {
    L.push('## Styling and finishing details', '');
    for (const d of style.details) L.push(`- ${d}`);
    for (const n of style.stylingNotes) L.push(`- ${n}`);
    L.push('');
  }

  L.push('## Glossary', '');
  for (const [term, def] of Object.entries(pkg.glossary).sort(([a], [b]) => a.localeCompare(b))) {
    L.push(`- **${term}**: ${def}`);
  }
  L.push('');

  const failed = pkg.quality.filter((q) => !q.ok);
  if (pkg.quality.length) {
    L.push('## Pattern self-checks', '');
    L.push(
      failed.length
        ? `${pkg.quality.length - failed.length} of ${pkg.quality.length} checks passed.`
        : `All ${pkg.quality.length} checks passed.`,
      '',
    );
    for (const q of failed) L.push(`- ${q.severity === 'error' ? '❌' : '⚠'} ${q.message}`);
    if (failed.length) L.push('');
  }

  L.push(`<sub>Design ${pkg.id} · generated by clothesCAD</sub>`, '');
  return L.join('\n');
}
