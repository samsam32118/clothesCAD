import type { SVGProps } from 'react';
import type { GarmentCategory, GarmentType } from '../../core/types';
import type { TabId } from '../../console/types';

type IconProps = SVGProps<SVGSVGElement>;

function Svg(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    />
  );
}

export const TabIcons: Record<TabId, (p: IconProps) => React.JSX.Element> = {
  measure: (p) => (
    <Svg {...p}>
      <path d="M3 8.5c0-1.4 4-2.5 9-2.5s9 1.1 9 2.5v7c0 1.4-4 2.5-9 2.5s-9-1.1-9-2.5z" />
      <path d="M7 6.6v3M11 6v3.5M15 6.2v3M19 7v2.2" />
    </Svg>
  ),
  design: (p) => (
    <Svg {...p}>
      <path d="M9 3h6l-1 4 5 14H5l5-14z" />
      <path d="M10 7h4" />
    </Svg>
  ),
  pattern: (p) => (
    <Svg {...p}>
      <path d="M4 4h10l6 6v10H4z" />
      <path d="M14 4v6h6" />
      <path d="M8 13h8M8 17h5" strokeDasharray="2 2" />
    </Svg>
  ),
  make: (p) => (
    <Svg {...p}>
      <path d="M5 19 19 5" />
      <circle cx="17.5" cy="6.5" r="1.2" />
      <path d="M4 14c3 0 3 3 6 3s3-3 6-3 3 3 4 3" />
    </Svg>
  ),
  '3d': (p) => (
    <Svg {...p}>
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
    </Svg>
  ),
  console: (p) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M12 15h5" />
    </Svg>
  ),
};

/** Small line drawings of each garment silhouette. */
const GARMENT_PATHS: Record<GarmentType, string> = {
  'a-line-skirt': 'M8 5h8l4 15H4z M8 7.5h8',
  'pencil-skirt': 'M7.5 4h9l-.8 16H8.3z M7.6 6.5h8.8 M12 17v3',
  'circle-skirt': 'M9.5 4h5l7.5 14c-3 2-17 2-20 0z M9.4 6h5.2',
  'wide-leg-trousers': 'M7 3h10l2 18h-5.5L12 10l-1.5 11H5z M7 5.5h10',
  'tapered-trousers': 'M7 3h10l-1 18h-3.6L12 10l-.4 11H8z M7 5.5h10',
  'shell-top': 'M8 3l-4 3 1.5 3H7v11h10V9h1.5L20 6l-4-3c-1 2-7 2-8 0z',
  'shift-dress': 'M9 2.5l-3 2.5 1 2.5h1L7 21h10l-1-13.5h1L18 5l-3-2.5c-.5 1.6-5.5 1.6-6 0z',
  'sheath-dress': 'M9 2.5 7 5l1 3-.5 5 1 8h7l1-8-.5-5 1-3-2-2.5c-.6 1.6-5.4 1.6-6 0z M8.3 10h7.4',
  'wrap-dress': 'M9 2.5 6.5 5 8 9.5 5 21h14l-3-11.5L17.5 5 15 2.5 12 9z M8 10h8 M16 10l2 3',
  'column-gown': 'M10 2h4l1 6-.5 3 .8 11H8.7l.8-11-.5-3z M9.3 8h5.4',
  'ball-gown': 'M10 2h4l.8 6-.3 2 7.5 11H2l7.5-11-.3-2z M9.4 9.5h5.2',
};

export function GarmentIcon({ type, ...p }: IconProps & { type: GarmentType }) {
  return (
    <Svg {...p} className={`garment-icon ${p.className ?? ''}`} strokeWidth={1.3}>
      <path d={GARMENT_PATHS[type]} />
    </Svg>
  );
}

export const CATEGORY_LABEL: Record<GarmentCategory, string> = {
  skirt: 'Skirt',
  trousers: 'Trousers',
  top: 'Top',
  dress: 'Dress',
  gown: 'Gown',
};

export function Plus(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function Minus(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 12h14" />
    </Svg>
  );
}

export function Fit(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </Svg>
  );
}

export function Download(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" />
    </Svg>
  );
}

export function Check(p: IconProps) {
  return (
    <Svg {...p} strokeWidth={2.2}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Svg>
  );
}
