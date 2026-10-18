import type { BomItem, CuttingLayout, FabricLayer, MaterialPreset, PatternPiece, SeamType } from '../types';
import { suggestLining } from '../presets';
import {
  buttonCount,
  ceilTo,
  elasticLengthCm,
  fmt,
  indexPieces,
  materialTraits,
  seamLengthCm,
  seamRepeats,
  sewInInterfacing,
  zipInfo,
  type InstructionContext,
} from './shared';

/** Shrinkage + cutting-mistake margin applied to every fabric length. */
export const FABRIC_MARGIN = 0.1;
/** Extra margin when the cloth needs matching (checks, large prints). */
export const MATCHING_MARGIN = 0.1;

const LAYOUT_WIDTH_FALLBACK: Record<FabricLayer, number> = { self: 150, lining: 140, interfacing: 90 };

function midPrice(m: MaterialPreset): number {
  return (m.pricePerMeterEur[0] + m.pricePerMeterEur[1]) / 2;
}

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Metres to buy for one layer: layout length (or an area-based estimate if no
 * layout was produced), scaled when the real cloth is narrower than the
 * layout width, plus margin, rounded up to 0.1 m.
 */
export function metresForLayer(
  layer: FabricLayer,
  layouts: CuttingLayout[],
  pieces: PatternPiece[],
  actualWidthCm: number,
  margin: number,
): number {
  const layout = layouts.find((l) => l.layer === layer);
  let lengthCm: number;
  if (layout && layout.lengthCm > 0) {
    lengthCm = layout.lengthCm * Math.max(1, layout.fabricWidthCm / actualWidthCm);
  } else {
    const layerPieces = pieces.filter((p) => p.layer === layer);
    if (!layerPieces.length) return 0;
    const area = layerPieces.reduce((acc, p) => {
      const w = p.bounds.maxX - p.bounds.minX;
      const h = p.bounds.maxY - p.bounds.minY;
      return acc + w * h * Math.max(1, p.cutCount) * (p.cutOnFold ? 2 : 1);
    }, 0);
    const longest = Math.max(...layerPieces.map((p) => p.bounds.maxY - p.bounds.minY));
    lengthCm = Math.max(longest, (area / actualWidthCm) * 1.25); // ~80 % packing efficiency
  }
  return Math.round(ceilTo((lengthCm / 100) * (1 + margin), 0.1) * 10) / 10;
}

function lengthMarginFor(m: MaterialPreset): number {
  return FABRIC_MARGIN + (materialTraits(m).needsMatching ? MATCHING_MARGIN : 0);
}

/** Thread consumption factor (thread metres per cm of seam) by technique. */
const THREAD_PER_CM: Record<SeamType, number> = {
  plain: 0.13, // two threads x ~2.5 for stitching + zigzag finishing both edges
  french: 0.08,
  dart: 0.03,
  'zip-invisible': 0.06,
  'zip-lapped': 0.08,
  'set-in-sleeve': 0.14,
  'hem-blind': 0.04,
  'hem-double-fold': 0.03,
  'hem-rolled': 0.08,
  understitch: 0.03,
  gathered: 0.12,
  topstitch: 0.04,
};

/** Bill of materials with EUR estimates, derived from layouts, pieces, seams and options. */
export function buildBom(ctx: InstructionContext): BomItem[] {
  const idx = indexPieces(ctx.pieces);
  const m = ctx.material;
  const t = materialTraits(m);
  const items: BomItem[] = [];
  const hasLayer = (layer: FabricLayer) => ctx.pieces.some((p) => p.layer === layer);
  const closure = ctx.fit.options.closure;

  // ---- fabrics ------------------------------------------------------------
  const selfMargin = lengthMarginFor(m);
  const selfM = metresForLayer('self', ctx.layouts, ctx.pieces, m.widthCm, selfMargin);
  if (selfM > 0) {
    items.push({
      kind: 'fabric',
      name: m.name,
      quantity: selfM,
      unit: 'm',
      spec: `${m.widthCm} cm wide, ${m.weightGsm} g/m²; includes ${Math.round(selfMargin * 100)} % for shrinkage and mistakes${
        t.needsMatching ? ' and pattern matching' : ''
      }. Pick a colour from the ${ctx.style.name} palette, e.g. ${ctx.style.palette
        .slice(0, 3)
        .map((c) => c.name.toLowerCase())
        .join(', ')}.`,
      estCostEur: money(selfM * midPrice(m)),
      essential: true,
    });
  }

  if (hasLayer('lining')) {
    const lining = suggestLining(m);
    const liningM = metresForLayer('lining', ctx.layouts, ctx.pieces, lining.widthCm, FABRIC_MARGIN);
    items.push({
      kind: 'lining',
      name: lining.name,
      quantity: liningM,
      unit: 'm',
      spec: `${lining.widthCm} cm wide, colour-matched or a tone lighter than the main fabric; ${lining.description.split('.')[0]}.`,
      estCostEur: money(liningM * midPrice(lining)),
      essential: true,
    });
  }

  const organzaInterfacing = sewInInterfacing(m);
  if (hasLayer('interfacing')) {
    const width = organzaInterfacing ? 114 : LAYOUT_WIDTH_FALLBACK.interfacing;
    const ifM = metresForLayer('interfacing', ctx.layouts, ctx.pieces, width, FABRIC_MARGIN);
    items.push({
      kind: 'interfacing',
      name: organzaInterfacing ? 'Silk organza (sew-in interfacing)' : 'Fusible interfacing',
      quantity: Math.max(0.3, ifM),
      unit: 'm',
      spec: m.handling.interfacing,
      estCostEur: money(Math.max(0.3, ifM) * (organzaInterfacing ? 40 : 8)),
      essential: true,
    });
  }

  // ---- notions ------------------------------------------------------------
  const zip = zipInfo(ctx, idx);
  if (zip) {
    items.push({
      kind: 'notion',
      name: zip.kind === 'invisible' ? 'Invisible zip' : 'Regular dress/skirt zip',
      quantity: 1,
      unit: 'pcs',
      spec: `${zip.zipLengthCm} cm ${zip.kind === 'invisible' ? 'invisible' : 'nylon-coil'} zip for a ${fmt(zip.openingCm)} cm opening, colour-matched`,
      estCostEur: zip.kind === 'invisible' ? 3 : 2.5,
      essential: true,
    });
    if (!hasLayer('interfacing') && (t.knit || t.slippery || m.stiffness < 0.4)) {
      items.push({
        kind: 'interfacing',
        name: 'Fusible stay tape or lightweight fusible interfacing',
        quantity: 0.3,
        unit: 'm',
        spec: 'Cut into 2 cm strips to stabilise the zip opening',
        estCostEur: 3,
        essential: false,
      });
    }
    items.push({
      kind: 'notion',
      name: 'Hook and eye',
      quantity: 1,
      unit: 'pack',
      spec: 'Small (size 1-2), to close the top of the zip neatly',
      estCostEur: 2,
      essential: false,
    });
  }

  if (closure === 'buttons') {
    const n = buttonCount(ctx);
    const gown = ctx.garment.category === 'gown';
    items.push({
      kind: 'notion',
      name: gown ? 'Self-cover buttons' : 'Buttons',
      quantity: n,
      unit: 'pcs',
      spec: gown ? '11 mm self-cover buttons covered in the main fabric, with fabric loops' : '12-15 mm flat sew-through buttons',
      estCostEur: money(n * (gown ? 0.9 : 0.6)),
      essential: true,
    });
  }

  if (closure === 'elastic') {
    const len = elasticLengthCm(ctx.measurements.waistCm);
    items.push({
      kind: 'notion',
      name: 'Waistband elastic',
      quantity: len,
      unit: 'cm',
      spec: `3 cm wide soft woven elastic, cut to ${len} cm (about 92 % of your ${fmt(ctx.measurements.waistCm)} cm waist plus 2.5 cm overlap)`,
      estCostEur: money((len / 100) * 1.8),
      essential: true,
    });
  }

  if (closure === 'wrap-tie') {
    items.push({
      kind: 'notion',
      name: 'Sew-on snap',
      quantity: 1,
      unit: 'pcs',
      spec: '10 mm snap to hold the inner wrap edge at the waist',
      estCostEur: 1,
      essential: false,
    });
  }

  // ---- thread -------------------------------------------------------------
  let threadM = 0;
  for (const s of ctx.seams) {
    const len = seamLengthCm(s, idx);
    threadM += len * seamRepeats(s, idx) * (THREAD_PER_CM[s.type] ?? 0.1);
  }
  threadM *= 1.3; // bobbin winding, test seams, basting
  const silkThread = /silk thread/i.test(m.handling.thread) && m.fiber === 'silk';
  const spools = Math.max(1, Math.ceil(threadM / 100));
  items.push({
    kind: 'thread',
    name: 'Sewing thread',
    quantity: spools,
    unit: 'spool',
    spec: `100 m spools; ${m.handling.thread}. Estimated use about ${Math.ceil(threadM)} m.`,
    estCostEur: money(spools * (silkThread ? 6 : 3)),
    essential: true,
  });
  items.push({
    kind: 'thread',
    name: 'Basting thread',
    quantity: 1,
    unit: 'spool',
    spec: 'Any cheap cotton thread in a contrasting colour, for basting and tailor tacks',
    estCostEur: 2,
    essential: false,
  });

  // ---- tools --------------------------------------------------------------
  const hasDarts = ctx.seams.some((s) => s.type === 'dart') || ctx.pieces.some((p) => p.darts.length > 0);
  const hasSleeves = ctx.seams.some((s) => s.type === 'set-in-sleeve');
  const hasFacings = ctx.pieces.some((p) => /facing|wrap-tie|waistband/.test(p.role));
  const tool = (name: string, spec: string, cost: number, essential = true): BomItem => ({
    kind: 'tool',
    name,
    quantity: 1,
    unit: 'pcs',
    spec,
    estCostEur: cost,
    essential,
  });

  items.push(
    tool('Fabric shears', '20-25 cm dressmaking shears, used only on fabric', 25),
    tool('Paper scissors', 'For cutting out the printed pattern (paper blunts fabric shears)', 5),
    tool(
      t.pinInAllowanceOnly || m.fiber === 'silk' ? 'Fine silk pins' : 'Glass-head pins',
      t.pinInAllowanceOnly || m.fiber === 'silk' ? '0.5 mm extra-fine pins that will not snag fine cloth' : 'Heat-proof glass heads so they survive the iron',
      5,
    ),
    tool('Tape measure', 'Flexible 150 cm tape measure', 3),
    tool(
      'Marking tools',
      m.fiber === 'wool'
        ? "Tailor's chalk (wax-free) and a contrasting basting thread for tailor's tacks"
        : t.tailorTacks || m.fiber === 'silk'
          ? "Silk thread for tailor's tacks plus a chalk pencil for the wrong side (test first)"
          : 'Water-soluble marking pen or chalk pencil (test on a scrap)',
      4,
    ),
    tool('Seam ripper', 'For unpicking mistakes and opening buttonholes', 3),
    tool('Iron and ironing board', 'A steam iron with adjustable temperature', 30),
    tool(
      'Press cloth',
      m.fiber === 'silk' || m.fiber === 'wool' ? 'Silk organza press cloth (see-through, heat-resistant)' : 'Plain cotton press cloth (a clean tea towel works)',
      m.fiber === 'silk' || m.fiber === 'wool' ? 8 : 3,
    ),
    tool('Machine needles', `${m.handling.needle} (pack of 5); start with a fresh needle`, 5),
    tool('Hand-sewing needles', 'Assorted sharps for hems, tacks and buttons', 3),
    tool('Clear tape and a long ruler', 'To assemble tiled pattern pages and check the test square', 6),
  );
  if (zip?.kind === 'invisible') items.push(tool('Invisible zip foot', 'Snap-on foot to fit your machine', 8));
  if (zip) items.push(tool('Zipper foot', 'Usually supplied with the machine', 6));
  if (hasDarts || hasSleeves) items.push(tool("Tailor's ham", 'For pressing darts and sleeve caps into rounded shapes', 18, false));
  if (m.fiber === 'wool' || m.weightGsm >= 250) items.push(tool('Clapper', 'Hardwood block for flat, crisp seams on wool and linen', 15, false));
  if (closure === 'elastic') items.push(tool('Bodkin or large safety pin', 'To thread elastic through the casing', 2));
  if (closure === 'buttons') items.push(tool('Buttonhole foot', 'Usually supplied with the machine', 8, false));
  if (t.slippery || t.knit || t.thick) items.push(tool('Rotary cutter, mat and pattern weights', 'Cuts slippery, stretchy or thick fabric without lifting it', 35, false));
  if (hasFacings) items.push(tool('Point turner', 'Pushes out corners of ties, waistbands and facings', 3, false));

  return items;
}
