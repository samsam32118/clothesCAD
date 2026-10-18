/**
 * Shopping-list arithmetic shared by the Design summary and the Make tab, so
 * both agree with each other and with the markdown booklet: "materials" are
 * everything that goes into the garment (cloth, lining, interfacing, notions,
 * thread); "tools" are reusable equipment, which a beginner may already own.
 */
import type { BomItem, DesignPackage, FabricLayer } from '../core/types';

export interface IndexedBomItem {
  item: BomItem;
  /** Position in `pkg.bom` (the key used for the ticked-off progress). */
  index: number;
}

export interface BomGroups {
  materials: IndexedBomItem[];
  tools: IndexedBomItem[];
}

export function isTool(b: BomItem): boolean {
  return b.kind === 'tool';
}

export function groupBom(bom: readonly BomItem[]): BomGroups {
  const materials: IndexedBomItem[] = [];
  const tools: IndexedBomItem[] = [];
  bom.forEach((item, index) => (isTool(item) ? tools : materials).push({ item, index }));
  return { materials, tools };
}

const sumCost = (items: readonly BomItem[]): number => items.reduce((sum, b) => sum + (b.estCostEur ?? 0), 0);

export interface BomTotals {
  /** Everything that goes into the garment (same figure as "Materials total" in instructions.md). */
  materialsEur: number;
  /** Essential tools only: what a beginner with no kit would have to buy. */
  essentialToolsEur: number;
  /** Nice-to-have tools (tailor's ham, rotary cutter, ...). */
  optionalToolsEur: number;
}

export function bomTotals(bom: readonly BomItem[]): BomTotals {
  const materials = bom.filter((b) => !isTool(b));
  const tools = bom.filter(isTool);
  return {
    materialsEur: sumCost(materials),
    essentialToolsEur: sumCost(tools.filter((b) => b.essential)),
    optionalToolsEur: sumCost(tools.filter((b) => !b.essential)),
  };
}

export interface FabricToBuy {
  /** Metres to buy (the shopping-list quantity, with the shrinkage/mistake margin). */
  buyM: number;
  /** Metres the cutting layout actually uses. */
  layoutM: number | null;
}

const BOM_KIND_FOR_LAYER: Record<FabricLayer, BomItem['kind']> = { self: 'fabric', lining: 'lining', interfacing: 'interfacing' };

/**
 * How much of a layer's cloth to buy (the shopping-list quantity) next to what
 * its cutting layout uses, or null when the package has no such layer.
 */
export function fabricToBuy(pkg: DesignPackage, layer: FabricLayer = 'self'): FabricToBuy | null {
  const layout = pkg.layouts.find((l) => l.layer === layer);
  const item = pkg.bom.find((b) => b.kind === BOM_KIND_FOR_LAYER[layer] && b.unit === 'm');
  if (item) return { buyM: item.quantity, layoutM: layout ? layout.lengthCm / 100 : null };
  if (layout) return { buyM: layout.lengthCm / 100, layoutM: layout.lengthCm / 100 };
  return null;
}
