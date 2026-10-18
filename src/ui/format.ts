/** Human labels for enum values shown in the UI. */
import type { Closure, FitPreference, LengthPreset, Neckline, Occasion, SleeveType } from '../core/types';

export const OCCASION_LABEL: Record<Occasion, string> = {
  everyday: 'Everyday',
  work: 'Work',
  evening: 'Evening',
  runway: 'Runway',
};

export const LENGTH_LABEL: Record<LengthPreset, string> = {
  mini: 'Mini',
  'above-knee': 'Above knee',
  knee: 'Knee',
  midi: 'Midi',
  ankle: 'Ankle',
  floor: 'Floor',
};

export const SLEEVE_LABEL: Record<SleeveType, string> = {
  none: 'Sleeveless',
  cap: 'Cap',
  short: 'Short',
  elbow: 'Elbow',
  'three-quarter': '¾',
  long: 'Long',
};

export const NECKLINE_LABEL: Record<Neckline, string> = {
  jewel: 'Jewel',
  scoop: 'Scoop',
  v: 'V-neck',
  boat: 'Boat',
  square: 'Square',
  sweetheart: 'Sweetheart',
};

export const CLOSURE_LABEL: Record<Closure, string> = {
  'invisible-zip': 'Invisible zip',
  'lapped-zip': 'Lapped zip',
  buttons: 'Buttons',
  'wrap-tie': 'Wrap tie',
  elastic: 'Elastic',
  none: 'Pull-on',
};

export const FIT_LABEL: Record<FitPreference, string> = {
  fitted: 'Fitted',
  regular: 'Regular',
  relaxed: 'Relaxed',
};

export const SHAPE_LABEL: Record<string, string> = {
  hourglass: 'Hourglass',
  pear: 'Pear',
  'inverted-triangle': 'Inverted triangle',
  rectangle: 'Rectangle',
  round: 'Round',
};

export function formatMoney(eur: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(eur);
}
