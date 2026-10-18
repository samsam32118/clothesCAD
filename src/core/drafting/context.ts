import type {
  BodyAnalysis,
  DesignRequest,
  FitPlan,
  GarmentDefinition,
  MaterialPreset,
  ResolvedMeasurements,
  StylePreset,
} from '../types';

export interface DraftContext {
  request: DesignRequest;
  garment: GarmentDefinition;
  style: StylePreset;
  material: MaterialPreset;
  measurements: ResolvedMeasurements;
  body: BodyAnalysis;
  fit: FitPlan;
  seamAllowanceCm: number;
  hemAllowanceCm: number;
}
