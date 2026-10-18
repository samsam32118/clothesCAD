import type { DesignPackage, DesignRequest, FabricLayer, QualityCheck } from './types';
import { resolveMeasurements, validateMeasurements } from './measurements';
import { analyzeBody } from './fit/analyze';
import { planFit } from './fit/plan';
import { draftGarment } from './drafting';
import { isOneWayFabric, layoutPieces } from './layout';
import { buildInstructions, buildBom } from './instructions';
import { interfacingWidthCm } from './instructions/shared';
import { getGarment, getMaterial, getStyle, suggestLining } from './presets';
import { runQualityChecks } from './quality';
import { hashString } from './geometry';

/**
 * The single entry point: measurements + choices in, complete make-it package out.
 * Pure and deterministic (same request -> same package), runs in browser and Node.
 */
export function design(request: DesignRequest): DesignPackage {
  const garment = getGarment(request.garment);
  const style = getStyle(request.styleId);
  const material = getMaterial(request.materialId);

  const measurementIssues = validateMeasurements(request.measurements);
  if (measurementIssues.some((i) => i.severity === 'error')) {
    const msg = measurementIssues
      .filter((i) => i.severity === 'error')
      .map((i) => `${i.key}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid measurements: ${msg}`);
  }

  const measurements = resolveMeasurements(request.measurements);
  const body = analyzeBody(measurements);
  const fit = planFit({ request, garment, style, material, measurements, body });

  const seamAllowanceCm =
    request.seamAllowanceCm ?? (material.construction === 'knit' ? 1 : 1.5);
  const hemAllowanceCm = request.hemAllowanceCm ?? (garment.category === 'gown' ? 2 : 3);

  const drafted = draftGarment({
    request,
    garment,
    style,
    material,
    measurements,
    body,
    fit,
    seamAllowanceCm,
    hemAllowanceCm,
  });

  // Each layer is laid out on the width of the cloth actually bought for it,
  // so the bill of materials can take its length straight from the layout.
  const layerWidth: Record<FabricLayer, number> = {
    self: material.widthCm,
    lining: suggestLining(material).widthCm,
    interfacing: interfacingWidthCm(material),
  };
  const layers = [...new Set(drafted.pieces.map((p) => p.layer))];
  const layouts = layers.map((layer) =>
    layoutPieces(
      drafted.pieces.filter((p) => p.layer === layer),
      layerWidth[layer],
      layer,
      { oneWay: layer === 'self' && isOneWayFabric(material) },
    ),
  );

  const ctx = {
    garment,
    style,
    material,
    measurements,
    body,
    fit,
    pieces: drafted.pieces,
    seams: drafted.seams,
    layouts,
  };
  const { instructions, glossary, effort } = buildInstructions(ctx);
  const bom = buildBom(ctx);

  const pkg: DesignPackage = {
    version: 1,
    id: hashString(JSON.stringify(request)),
    name: request.name ?? `${style.name} ${garment.name}`,
    request,
    garment,
    style,
    material,
    measurements,
    measurementIssues,
    body,
    fit,
    pieces: drafted.pieces,
    seams: drafted.seams,
    layouts,
    bom,
    instructions,
    glossary,
    silhouette: drafted.silhouette,
    effort,
    quality: [] as QualityCheck[],
  };
  pkg.quality = runQualityChecks(pkg);
  return pkg;
}
