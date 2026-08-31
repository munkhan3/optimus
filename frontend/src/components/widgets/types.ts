import type { ComponentType } from "react";
import type { Calibration, Flow, Portfolio, Roadmap, Throughput } from "../../lib/dashboard";

/**
 * The data a widget can read.
 *
 * Sources with no per-widget parameters are fetched once by the Dashboard and
 * shared: thirteen widgets each issuing their own /portfolio request would make
 * a page load thirteen times more expensive than the information warrants.
 * A widget that takes its own parameters (the commitment grid scopes to a goal
 * and a week count) fetches for itself.
 *
 * `undefined` means "still loading", `null` means "this failed". A widget must
 * distinguish them: one is a skeleton, the other is a message.
 */
export interface DashboardData {
  portfolio?: Portfolio | null;
  throughput?: Throughput | null;
  calibration?: Calibration | null;
  roadmap?: Roadmap | null;
  flow?: Flow | null;
}

export interface WidgetProps {
  data: DashboardData;
  config: Record<string, unknown>;
  setConfig: (next: Record<string, unknown>) => void;
  /** Navigate elsewhere in the app, e.g. the compact roadmap's click-through. */
  onNavigate?: (tab: "roadmap" | "tree" | "work" | "plan") => void;
}

export type Source = keyof DashboardData;

export interface WidgetSpec {
  kind: string;
  title: string;
  /** One line, shown in the picker. Says what question it answers. */
  blurb: string;
  /** Grid units. w is out of 12 columns; h is out of 40px rows. */
  defaultW: number;
  defaultH: number;
  minW: number;
  minH: number;
  sources: Source[];
  Component: ComponentType<WidgetProps>;
}
