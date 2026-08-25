// Open findings for one engine family, read from the Action Center.
//
// WHY THIS EXISTS
// ---------------
// The workspace pages used to draw their insight cards from
// /api/insights/dashboard, which recomputes on every read and knows nothing
// about IntelligenceFinding. That made them the last surface able to
// contradict the Action Center: a merchant could resolve a finding, watch it
// leave the Action Center and the Store Overview, then open the matching
// workspace and still see it there with a "Critical" badge and a monetary
// impact beside it.
//
// Phase F fixed the Store Overview by projecting the same open findings.
// This is that same fix applied to the workspaces, so every merchant-facing
// surface — Action Center, Store Overview, the three workspaces and the AI
// brief — reads one source with one lifecycle.
//
// Coverage ("how many rows were analysed") deliberately still comes from the
// insights endpoint. It makes no claim about problems, money, confidence or
// status, so it cannot contradict a finding.

import { useCallback, useEffect, useRef, useState } from "react";
import { embeddedShopRequest } from "../lib/embeddedShopRequest";

export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type FindingConfidence = "high" | "medium" | "low" | "insufficient_data";

export type ModuleFindingImpact =
  | {
      status: "quantified";
      min: number;
      max: number;
      currency: string;
      period: string;
      basis?: string;
    }
  | { status: "impact_not_quantifiable"; reason: string };

export interface ModuleFinding {
  id: string;
  findingType: string;
  module: string;
  status: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  title: string;
  whatHappened: string;
  whyItMatters: string;
  evidence: Array<{ label: string; value: string; source?: string }>;
  methodology: { summary: string; assumptions: string[]; caps: string[] } | null;
  dataComplete: boolean;
  degraded?: boolean;
  impact: ModuleFindingImpact;
  recommendedAction: string;
  route: string;
  lastSeenAt: string;
  isStale: boolean;
  rank: { score: number };
}

interface ActionCenterResponse {
  cards: ModuleFinding[];
  meta?: { enabledModules?: string[] };
}

/** The statuses that mean "still needs attention". Mirrors the server. */
const OPEN_STATUSES = new Set(["new", "seen", "in_review"]);

export interface ModuleFindingsState {
  /** Open findings for the requested modules, highest-ranked first. */
  findings: ModuleFinding[];
  loading: boolean;
  /**
   * True when findings could not be read at all. Distinct from an empty list:
   * "nothing is wrong" and "VedaSuite could not check" are different claims,
   * and the caller must not render the second as the first.
   */
  unavailable: boolean;
  authRequired: boolean;
  reload: () => void;
}

export function useModuleFindings(modules: string[]): ModuleFindingsState {
  const [findings, setFindings] = useState<ModuleFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const mounted = useRef(true);

  // Stable across renders so an inline array literal in the caller does not
  // retrigger the fetch on every render.
  const key = modules.join(",");

  const load = useCallback(async () => {
    setLoading(true);
    setUnavailable(false);
    setAuthRequired(false);
    try {
      // The whole feed for the store, filtered client-side: the server's
      // `module` filter takes a single value, while a family such as customer
      // loss spans fraud, trust and return_abuse. Entitlement filtering has
      // already happened server-side.
      const res = await embeddedShopRequest<ActionCenterResponse>(
        "/api/action-center",
        { timeoutMs: 25000, retries: 2 }
      );
      if (!mounted.current) return;
      const wanted = new Set(key.split(",").filter(Boolean));
      const open = (res.cards ?? [])
        .filter((card) => wanted.has(card.module) && OPEN_STATUSES.has(card.status))
        .sort((a, b) => {
          if (b.rank.score !== a.rank.score) return b.rank.score - a.rank.score;
          if (a.lastSeenAt !== b.lastSeenAt) return a.lastSeenAt < b.lastSeenAt ? 1 : -1;
          return a.id < b.id ? -1 : 1;
        });
      setFindings(open);
    } catch (err) {
      if (!mounted.current) return;
      const msg = err instanceof Error ? err.message : "";
      const hasReauth =
        err instanceof Error &&
        "reauthorizeUrl" in err &&
        !!(err as Error & { reauthorizeUrl?: string }).reauthorizeUrl;
      if (hasReauth || /session|reconnect|authoriz|MISSING_SHOP/i.test(msg)) {
        setAuthRequired(true);
      }
      // Never leaves a stale list behind: showing yesterday's findings after a
      // failed refresh would be its own quiet contradiction.
      setFindings([]);
      setUnavailable(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  return { findings, loading, unavailable, authRequired, reload: load };
}
