/** Shared presentation primitives. Import from here so a page never hand-rolls a surface again. */
export { Surface, type SurfaceLevel } from "./Surface";
export { PageHeader } from "./PageHeader";
export { Status, StatusDot, type StatusTone } from "./Status";
export { Metric } from "./Metric";
export { SkeletonLine, SkeletonBlock, SkeletonMetrics, SkeletonRows, LoadingRegion } from "./Skeleton";
export {
  Panel,
  FieldRow,
  FieldList,
  PanelEmpty,
  StatTile,
  Pill,
  Tag,
  PANEL_SURFACE,
  BTN_PRIMARY,
  BTN_SECONDARY,
  BTN_QUIET,
  INPUT,
  type PillTone,
} from "./Panel";
