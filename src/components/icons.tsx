import type { SVGProps } from "react";

/**
 * JobHunt's line icons.
 *
 * WHY THESE ARE HAND-DRAWN. The rail was text-only for a reason that has now changed: the project
 * had no icon set, and pulling a library in to letter six navigation items would have cost more
 * than the labels were worth. It still would — so this is the set the product actually uses and
 * nothing more. Every glyph below is on a screen today.
 *
 * ONE GRID, ONE WEIGHT. 24x24, 1.75 stroke, round caps and joins, no fills. That consistency is the
 * whole point of an icon system; a set assembled from different grids reads as clip-art however
 * good each individual mark is.
 *
 * They inherit `currentColor` and size from the `size` prop, so a glyph is coloured by the text it
 * sits with rather than carrying its own palette. Decorative by default — every icon here is
 * `aria-hidden`, because in every use the adjacent text already names the thing. An icon that ever
 * stands alone must be labelled by its control, not by the glyph.
 */

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  size?: number;
}

function Icon({ size = 18, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconHome = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 10.2 12 3.8l8.5 6.4V19a1.5 1.5 0 0 1-1.5 1.5h-3.4v-6H8.4v6H5A1.5 1.5 0 0 1 3.5 19z" />
  </Icon>
);

export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-3.6-3.6" />
  </Icon>
);

export const IconBriefcase = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="7.5" width="18" height="12.5" rx="2" />
    <path d="M8.5 7.5V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5" />
    <path d="M3 12.5h18" />
  </Icon>
);

export const IconDocument = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6M9 17h4" />
  </Icon>
);

export const IconUser = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="10" r="3" />
    <path d="M6.4 19a6 6 0 0 1 11.2 0" />
  </Icon>
);

export const IconSettings = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7h-.3a2 2 0 1 1 0-4h.2A1.6 1.6 0 0 0 4.5 7.3l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1v-.3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.3 1z" />
  </Icon>
);

export const IconBell = (p: IconProps) => (
  <Icon {...p}>
    <path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5" />
    <path d="M13.7 19a2 2 0 0 1-3.4 0" />
  </Icon>
);

export const IconSparkle = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5 13.9 9l5.6 2-5.6 2-1.9 5.5L10.1 13 4.5 11l5.6-2z" />
  </Icon>
);

export const IconChevronRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
  </Icon>
);

export const IconStar = (p: IconProps) => (
  <Icon {...p}>
    <path d="m12 3.8 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 10l5.9-.9z" />
  </Icon>
);

export const IconTrend = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 16.5 9.5 11l3.5 3.5L20 7.5" />
    <path d="M15.5 7.5H20v4.5" />
  </Icon>
);

export const IconInbox = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 13h4l1.5 2.5h6L16.5 13h4" />
    <path d="M5.6 5.5h12.8l2.1 7.5V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18v-5z" />
  </Icon>
);

export const IconCheckCircle = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12.2 2.4 2.4 4.6-4.8" />
  </Icon>
);

export const IconCircle = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
  </Icon>
);

export const IconPin = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 21s6.5-6.1 6.5-10.5a6.5 6.5 0 0 0-13 0C5.5 14.9 12 21 12 21z" />
    <circle cx="12" cy="10.5" r="2.4" />
  </Icon>
);

export const IconArrowUpRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7.5 16.5 16.5 7.5" />
    <path d="M9 7.5h7.5V15" />
  </Icon>
);

export const IconShield = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.2 19 6v6c0 4.2-2.9 7.4-7 8.8-4.1-1.4-7-4.6-7-8.8V6z" />
    <path d="m9.2 12.2 2 2 3.6-3.8" />
  </Icon>
);

export const IconDashboard = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="4.5" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="10.5" width="7" height="10" rx="1.5" />
  </Icon>
);

export const IconBuilding = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 21V5.5A1.5 1.5 0 0 1 5.5 4h8A1.5 1.5 0 0 1 15 5.5V21" />
    <path d="M15 9h3.5a1.5 1.5 0 0 1 1.5 1.5V21M2.5 21h19M7 8h1m3 0h1M7 12h1m3 0h1M7 16h1m3 0h1" />
  </Icon>
);

export const IconScanner = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
    <path d="M7 12h10M9 9.5v5M12 8v8M15 10v4" />
  </Icon>
);

export const IconPenTool = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4 20 4.2-1 10.6-10.6a2.1 2.1 0 0 0-3-3L5.2 16z" />
    <path d="m13.8 7.4 3 3M4 20l1.2-4 3 3z" />
  </Icon>
);

export const IconServer = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="4" width="17" height="6" rx="2" />
    <rect x="3.5" y="14" width="17" height="6" rx="2" />
    <path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" />
  </Icon>
);

export const IconActivity = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 12h4l2-6 4 12 2-6h6" />
  </Icon>
);
