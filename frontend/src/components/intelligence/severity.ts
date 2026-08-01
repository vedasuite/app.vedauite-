// One severity vocabulary for the whole intelligence UI.
//
// Every level pairs an icon + text label with its colour, so priority is never
// communicated by colour alone (WCAG 1.4.1). Tones map onto Polaris values so
// the palette stays consistent with the rest of Shopify Admin.

import {
  AlertDiamondIcon,
  AlertTriangleIcon,
  CheckCircleIcon,
  InfoIcon,
  LightbulbIcon,
  StatusActiveIcon,
} from "@shopify/polaris-icons";
import type { Urgency } from "../../lib/insightsTypes";

export type SeverityLevel =
  | "critical"
  | "warning"
  | "opportunity"
  | "healthy"
  | "ready"
  | "info";

export type SeverityStyle = {
  level: SeverityLevel;
  /** Human label — always rendered next to the icon. */
  label: string;
  /** Polaris Badge tone. `undefined` renders the neutral badge. */
  badgeTone: "critical" | "warning" | "success" | "info" | "attention" | undefined;
  /** Polaris Icon tone. */
  iconTone: "critical" | "caution" | "success" | "info" | "subdued";
  icon: typeof InfoIcon;
  /** CSS modifier for the left severity rail. */
  rail: string;
  /** CSS modifier for meter fills. */
  meter: "critical" | "warning" | "success" | "info" | "neutral";
};

export const SEVERITY: Record<SeverityLevel, SeverityStyle> = {
  critical: {
    level: "critical",
    label: "Critical",
    badgeTone: "critical",
    iconTone: "critical",
    icon: AlertDiamondIcon,
    rail: "veda-rail--critical",
    meter: "critical",
  },
  warning: {
    level: "warning",
    label: "Needs attention",
    badgeTone: "warning",
    iconTone: "caution",
    icon: AlertTriangleIcon,
    rail: "veda-rail--warning",
    meter: "warning",
  },
  opportunity: {
    level: "opportunity",
    label: "Opportunity",
    badgeTone: "success",
    iconTone: "success",
    icon: LightbulbIcon,
    rail: "veda-rail--opportunity",
    meter: "success",
  },
  healthy: {
    level: "healthy",
    label: "Healthy",
    badgeTone: "success",
    iconTone: "success",
    icon: CheckCircleIcon,
    rail: "veda-rail--healthy",
    meter: "success",
  },
  ready: {
    level: "ready",
    label: "Ready",
    badgeTone: "info",
    iconTone: "info",
    icon: StatusActiveIcon,
    rail: "veda-rail--info",
    meter: "info",
  },
  info: {
    level: "info",
    label: "Information",
    badgeTone: undefined,
    iconTone: "subdued",
    icon: InfoIcon,
    rail: "veda-rail--neutral",
    meter: "neutral",
  },
};

/** Map the engine's urgency enum onto the shared severity vocabulary. */
export function severityForUrgency(urgency: Urgency): SeverityStyle {
  if (urgency === "critical") return SEVERITY.critical;
  if (urgency === "high") return SEVERITY.warning;
  if (urgency === "medium") return SEVERITY.opportunity;
  return SEVERITY.info;
}

/** Severity for a 0–100 pressure reading (module risk meters). */
export function severityForPressure(pressure: number): SeverityStyle {
  if (pressure >= 70) return SEVERITY.critical;
  if (pressure >= 40) return SEVERITY.warning;
  if (pressure > 0) return SEVERITY.opportunity;
  return SEVERITY.healthy;
}
