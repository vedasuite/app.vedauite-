// THE canonical module-state model.
//
// PURE. No database, no network.
//
// WHY THIS EXISTS
// ---------------
// Staging showed a store with 75 orders and ZERO products reporting:
//
//   Store Overview  "Store analysis completed" / "Everything looks healthy"
//   Action Center   "All checks ran with the data available"
//   Pricing         "No products synced yet"
//   Reconciliation  "Your Shopify products have no SKUs yet"
//
// All four were computed independently, and the first two were wrong. The
// mechanism was `deriveSyncStatus`, which reduces the store to
// `products + orders + customers > 0`. Seventy-five orders therefore satisfied
// it on their own, and the complete absence of products — which makes Pricing,
// Product Profit and Inventory Reconciliation unrunnable — was invisible to
// every surface that asked "is this store ready?".
//
// Summing dimensions that mean different things is the bug. A store is not
// "ready"; each MODULE is ready, or is not, for a reason, and the global
// verdict is an aggregate of those — never a substitute for them.
//
// THE RULE THIS FILE ENFORCES
// ---------------------------
//   NO FINDINGS  !=  CHECK COULD NOT RUN.
//
// "Everything looks healthy" is permitted only when every entitled module
// actually ran, with sufficient evidence, and found nothing. One module that
// could not run makes the global verdict PARTIAL, and the reason is named.

/** The one vocabulary every surface uses. Ordered worst-to-best for ranking. */
export const MODULE_STATES = [
  "AUTH_FAILED",
  "SYNC_FAILED",
  "PARTIAL_DATA",
  "INSUFFICIENT_DATA",
  "PERMISSION_LIMITED",
  "NOT_RUN",
  "FEATURE_NOT_INCLUDED",
  "READY_NO_FINDINGS",
  "READY_WITH_FINDINGS",
] as const;

export type ModuleState = (typeof MODULE_STATES)[number];

/** Modules the global verdict is computed over. */
export const STATE_MODULES = [
  "customerLoss",
  "pricing",
  "productProfit",
  "marketSignals",
  "reconciliation",
] as const;

export type StateModule = (typeof STATE_MODULES)[number];

export const MODULE_LABEL: Record<StateModule, string> = {
  customerLoss: "Customer Loss",
  pricing: "Pricing recommendations",
  productProfit: "Product Profit",
  marketSignals: "Market Signals",
  reconciliation: "Reconciliation",
};

/**
 * Whether the check actually RAN and produced an answer.
 *
 * PARTIAL_DATA counts. A module that analysed an incomplete dataset still
 * produced a result the merchant can act on, and calling that "could not run"
 * is the mirror image of the bug this file exists to fix — under-claiming
 * instead of over-claiming. The caveat is carried by the STATE, and the global
 * verdict refuses to say HEALTHY while any module holds it.
 */
export function didRun(state: ModuleState): boolean {
  return (
    state === "READY_NO_FINDINGS" ||
    state === "READY_WITH_FINDINGS" ||
    state === "PARTIAL_DATA"
  );
}

/** Whether a state is a FAILURE the merchant should act on, not a limitation. */
export function isFailure(state: ModuleState): boolean {
  return state === "AUTH_FAILED" || state === "SYNC_FAILED";
}

/**
 * Whether a state is a deliberate, correct exclusion rather than a problem.
 *
 * A Starter merchant not having Reconciliation is not a fault, and must not
 * make the store look broken.
 */
export function isExpectedExclusion(state: ModuleState): boolean {
  return state === "FEATURE_NOT_INCLUDED";
}

export interface ModuleStateResult {
  module: StateModule;
  state: ModuleState;
  /** One sentence a merchant can act on. Never a bare status word. */
  reason: string;
  /** What is missing, when something is. Empty when the check ran. */
  missing: string[];
  findingCount: number;
}

/**
 * The evidence one module needs, and what the store actually has.
 *
 * Deliberately explicit per module: this is the table that stopped orders
 * standing in for products.
 */
export interface StoreEvidence {
  /** Connection-level failure. Outranks everything below it. */
  authFailed: boolean;
  /** The most recent sync job failed outright. */
  syncFailed: boolean;
  /** A sync ran but did not deliver everything it should have. */
  syncPartial: boolean;
  /** Nothing has ever synced. */
  neverSynced: boolean;

  products: number;
  variantsWithSku: number;
  orders: number;
  eligibleOrders: number;
  customers: number;
  competitorRowsFresh: number;
  competitorDomainsConfigured: number;
  priceRows: number;
  profitRowsWithObservedCost: number;
  reconciliationRuns: number;
}

export interface EntitlementFlags {
  customerLoss: boolean;
  pricing: boolean;
  productProfit: boolean;
  marketSignals: boolean;
  reconciliation: boolean;
}

/**
 * Minimum evidence per module, named so a merchant knows what to do.
 *
 * These are DESCRIPTIONS of thresholds enforced elsewhere, not a second copy
 * of them: `minStoreOrders` comes from the Customer Loss detector itself.
 */
export interface StateThresholds {
  /** CUSTOMER_LOSS.minStoreOrders — passed in, never duplicated here. */
  customerLossMinOrders: number;
}

/**
 * Derives every module's state from one evidence snapshot.
 *
 * ORDER OF PRECEDENCE, worst first: a store whose connection is broken is not
 * "insufficient data", and a module the merchant does not pay for is not
 * "not run".
 */
export function deriveModuleStates(input: {
  evidence: StoreEvidence;
  entitlements: EntitlementFlags;
  thresholds: StateThresholds;
  findingCounts: Partial<Record<StateModule, number>>;
}): ModuleStateResult[] {
  const { evidence, entitlements, thresholds } = input;
  const findings = (module: StateModule) => input.findingCounts[module] ?? 0;

  const base = (module: StateModule): ModuleState | null => {
    if (!entitlements[module]) return "FEATURE_NOT_INCLUDED";
    if (evidence.authFailed) return "AUTH_FAILED";
    if (evidence.syncFailed) return "SYNC_FAILED";
    if (evidence.neverSynced) return "NOT_RUN";
    return null;
  };

  const resolve = (
    module: StateModule,
    requirements: Array<{ met: boolean; missing: string }>
  ): ModuleStateResult => {
    const blocking = base(module);
    if (blocking) {
      return {
        module,
        state: blocking,
        reason: REASONS[blocking](MODULE_LABEL[module]),
        missing: [],
        findingCount: 0,
      };
    }

    const missing = requirements.filter((r) => !r.met).map((r) => r.missing);
    if (missing.length > 0) {
      return {
        module,
        state: "INSUFFICIENT_DATA",
        reason: `${MODULE_LABEL[module]} could not be evaluated: ${missing.join(", ")}.`,
        missing,
        findingCount: 0,
      };
    }

    // The check could run. Whether the SYNC was complete still matters: a
    // module analysing a partial dataset produced a partial answer.
    if (evidence.syncPartial) {
      return {
        module,
        state: "PARTIAL_DATA",
        reason: `${MODULE_LABEL[module]} ran, but the last sync did not deliver all of your Shopify data, so this result may be incomplete.`,
        missing: [],
        findingCount: findings(module),
      };
    }

    const count = findings(module);
    return {
      module,
      state: count > 0 ? "READY_WITH_FINDINGS" : "READY_NO_FINDINGS",
      reason:
        count > 0
          ? `${MODULE_LABEL[module]} found ${count} ${count === 1 ? "item" : "items"} to review.`
          : `${MODULE_LABEL[module]} ran and found nothing that needs attention.`,
      missing: [],
      findingCount: count,
    };
  };

  return [
    resolve("customerLoss", [
      {
        met: evidence.eligibleOrders >= thresholds.customerLossMinOrders,
        missing: `at least ${thresholds.customerLossMinOrders} synced orders (${evidence.eligibleOrders} so far)`,
      },
    ]),
    resolve("pricing", [
      {
        met: evidence.products > 0,
        missing: "no products have synced from Shopify",
      },
      {
        met: evidence.priceRows > 0,
        missing: "no pricing records have been calculated yet",
      },
    ]),
    resolve("productProfit", [
      {
        met: evidence.products > 0,
        missing: "no products have synced from Shopify",
      },
      {
        met: evidence.profitRowsWithObservedCost > 0,
        missing: "no product cost has been recorded, so margin cannot be calculated",
      },
    ]),
    resolve("marketSignals", [
      {
        met: evidence.competitorDomainsConfigured > 0,
        missing: "no competitor websites have been added",
      },
      {
        met: evidence.competitorRowsFresh > 0,
        missing: "no competitor domain has been refreshed successfully",
      },
    ]),
    resolve("reconciliation", [
      {
        met: evidence.reconciliationRuns > 0,
        missing: "no reconciliation has been run yet",
      },
    ]),
  ];
}

const REASONS: Record<ModuleState, (label: string) => string> = {
  AUTH_FAILED: (label) =>
    `${label} could not run because VedaSuite's connection to Shopify needs to be repaired.`,
  SYNC_FAILED: (label) =>
    `${label} could not run because the last Shopify sync failed.`,
  PARTIAL_DATA: (label) =>
    `${label} ran on incomplete data because the last sync did not finish delivering it.`,
  INSUFFICIENT_DATA: (label) => `${label} does not have enough data to run yet.`,
  PERMISSION_LIMITED: (label) =>
    `${label} is limited because VedaSuite does not have all the Shopify permissions it needs.`,
  NOT_RUN: (label) => `${label} has not run yet.`,
  FEATURE_NOT_INCLUDED: (label) => `${label} is not included in your current plan.`,
  READY_NO_FINDINGS: (label) => `${label} ran and found nothing that needs attention.`,
  READY_WITH_FINDINGS: (label) => `${label} found items to review.`,
};

// ---------------------------------------------------------------------------
// The global verdict
// ---------------------------------------------------------------------------

export type GlobalHealth =
  | "HEALTHY"
  | "ATTENTION_REQUIRED"
  | "PARTIAL"
  | "BLOCKED"
  | "NOT_READY";

export interface GlobalHealthResult {
  health: GlobalHealth;
  /** The headline. Never says "healthy" unless every check truly ran. */
  headline: string;
  /** Named modules behind a non-healthy verdict. */
  detail: string[];
  /** Modules that genuinely ran. */
  ran: StateModule[];
  /** Modules that could NOT run, and are therefore unaccounted for. */
  couldNotRun: StateModule[];
}

/**
 * Aggregates module states into one honest verdict.
 *
 * THE ONE RULE. HEALTHY requires that every module which was EXPECTED to run
 * did run. A module the merchant is not entitled to is excluded from the
 * expectation, because its absence is a plan boundary rather than a problem.
 * Anything else that did not run makes the verdict PARTIAL and is named.
 */
export function deriveGlobalHealth(states: ModuleStateResult[]): GlobalHealthResult {
  const expected = states.filter((s) => !isExpectedExclusion(s.state));
  const ran = expected.filter((s) => didRun(s.state));
  const couldNotRun = expected.filter((s) => !didRun(s.state));
  const failed = expected.filter((s) => isFailure(s.state));
  const withFindings = expected.filter((s) => s.state === "READY_WITH_FINDINGS");
  const partial = expected.filter((s) => s.state === "PARTIAL_DATA");

  const names = (list: ModuleStateResult[]) =>
    list.map((s) => MODULE_LABEL[s.module]);

  if (failed.length > 0) {
    return {
      health: "BLOCKED",
      headline:
        failed.some((s) => s.state === "AUTH_FAILED")
          ? "VedaSuite cannot reach Shopify. Reconnect the app to resume analysis."
          : "The last Shopify sync failed, so your results are out of date.",
      detail: failed.map((s) => s.reason),
      ran: ran.map((s) => s.module),
      couldNotRun: couldNotRun.map((s) => s.module),
    };
  }

  if (ran.length === 0) {
    return {
      health: "NOT_READY",
      headline:
        "No checks have been able to run yet. VedaSuite needs more of your Shopify data first.",
      detail: couldNotRun.map((s) => s.reason),
      ran: [],
      couldNotRun: couldNotRun.map((s) => s.module),
    };
  }

  if (withFindings.length > 0) {
    const total = withFindings.reduce((sum, s) => sum + s.findingCount, 0);
    return {
      health: "ATTENTION_REQUIRED",
      headline: `${total} ${total === 1 ? "item needs" : "items need"} your attention across ${names(
        withFindings
      ).join(", ")}.`,
      detail: [
        ...withFindings.map((s) => s.reason),
        ...couldNotRun.map((s) => s.reason),
      ],
      ran: ran.map((s) => s.module),
      couldNotRun: couldNotRun.map((s) => s.module),
    };
  }

  if (couldNotRun.length > 0 || partial.length > 0) {
    // THE CASE THAT USED TO SAY "EVERYTHING LOOKS HEALTHY".
    return {
      health: "PARTIAL",
      headline: `${ran.length} of ${expected.length} checks ran and found nothing. ${names(
        couldNotRun
      ).join(", ")} could not be evaluated.`,
      detail: couldNotRun.map((s) => s.reason),
      ran: ran.map((s) => s.module),
      couldNotRun: couldNotRun.map((s) => s.module),
    };
  }

  return {
    health: "HEALTHY",
    headline: `All ${ran.length} checks ran successfully and found nothing that needs attention.`,
    detail: [],
    ran: ran.map((s) => s.module),
    couldNotRun: [],
  };
}
