// Cost and abuse protection for the AI brief, plus the result cache.
//
// Pure and injectable: no timers, no I/O, clock passed in. In-process only —
// see the note on horizontal scaling below.

import { env } from "../../config/env";

export interface CachedBrief<T> {
  value: T;
  storedAt: number;
}

type StoreBudget = {
  /** Call timestamps inside the rolling window. */
  calls: number[];
  cache?: { key: string; entry: CachedBrief<unknown> };
};

/**
 * Per-store state.
 *
 * NOTE ON SCALING: this is per-process. With multiple Render instances the
 * effective ceiling is (instances x maxCallsPerStorePerHour). That is
 * acceptable because the ceiling is a cost guard, not a correctness or security
 * boundary, and the AI path is read-only. If VedaSuite later needs a hard
 * global cap, this map is the single place to swap for a shared store.
 */
const budgets = new Map<string, StoreBudget>();

/** Bounds memory if a very large number of stores are active in one process. */
const MAX_TRACKED_STORES = 5000;
const WINDOW_MS = 60 * 60 * 1000;

function budgetFor(storeId: string): StoreBudget {
  let budget = budgets.get(storeId);
  if (!budget) {
    if (budgets.size >= MAX_TRACKED_STORES) {
      // Drop the oldest insertion rather than grow without bound. Losing a
      // window only means a store may get its full allowance again.
      const oldest = budgets.keys().next().value;
      if (oldest !== undefined) {
        budgets.delete(oldest);
      }
    }
    budget = { calls: [] };
    budgets.set(storeId, budget);
  }
  return budget;
}

/**
 * A cache key that changes whenever the brief's meaning could change.
 *
 * Built from finding identity plus the fields the brief actually reflects, so a
 * status change or a new detection produces a fresh brief while repeated page
 * loads reuse one.
 */
export function buildBriefCacheKey(
  parts: Array<{ id: string; status: string; lastSeenAt: string; severity: string }>
): string {
  return parts
    .map((p) => `${p.id}:${p.status}:${p.severity}:${p.lastSeenAt}`)
    .join("|");
}

/** A cached brief for this exact key, or null. */
export function readCachedBrief<T>(
  storeId: string,
  key: string,
  now: number,
  ttlMs: number = env.ai.cacheTtlMs
): T | null {
  const cache = budgets.get(storeId)?.cache;
  if (!cache || cache.key !== key) {
    return null;
  }
  if (now - cache.entry.storedAt >= ttlMs) {
    return null;
  }
  return cache.entry.value as T;
}

export function writeCachedBrief<T>(
  storeId: string,
  key: string,
  value: T,
  now: number
): void {
  budgetFor(storeId).cache = { key, entry: { value, storedAt: now } };
}

/**
 * Is this store allowed another provider call right now?
 *
 * Read-only — call recordAiCall() when a call is actually made, so a cache hit
 * never consumes allowance.
 */
export function isWithinAiRateLimit(
  storeId: string,
  now: number,
  maxPerHour: number = env.ai.maxCallsPerStorePerHour
): boolean {
  if (maxPerHour <= 0) {
    return false;
  }
  const recent = (budgets.get(storeId)?.calls ?? []).filter(
    (at) => now - at < WINDOW_MS
  );
  return recent.length < maxPerHour;
}

/** Records one provider call against this store's hourly allowance. */
export function recordAiCall(storeId: string, now: number): void {
  const budget = budgetFor(storeId);
  budget.calls = budget.calls.filter((at) => now - at < WINDOW_MS);
  budget.calls.push(now);
}

/** Remaining calls in the current window — for observability and tests. */
export function remainingAiCalls(
  storeId: string,
  now: number,
  maxPerHour: number = env.ai.maxCallsPerStorePerHour
): number {
  const recent = (budgets.get(storeId)?.calls ?? []).filter(
    (at) => now - at < WINDOW_MS
  );
  return Math.max(0, maxPerHour - recent.length);
}

/** Test seam: clears all per-store state. */
export function resetAiBudgets(): void {
  budgets.clear();
}
