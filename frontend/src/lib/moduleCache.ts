import { getEmbeddedContext } from "./shopifyEmbeddedContext";

/**
 * Bump this whenever the shape of a cached value changes incompatibly — a
 * mismatch invalidates the entry instead of risking a stale/malformed object
 * being read back as if it were current.
 */
const CACHE_SCHEMA_VERSION = 2;

/**
 * Cached state is for initial paint only, never authoritative — a fresh
 * backend response always replaces it (see SubscriptionProvider /
 * AppStateProvider). This TTL just bounds how stale that initial paint can
 * be before it's discarded outright rather than shown at all.
 */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

const STORAGE_PREFIX = "vedasuite:cache:";

type CacheEnvelope<T> = {
  schemaVersion: number;
  shop: string;
  buildId: string;
  savedAt: number;
  value: T;
};

const memoryCache = new Map<string, CacheEnvelope<unknown>>();

function canUseStorage() {
  return typeof window !== "undefined" && !!window.sessionStorage;
}

/**
 * Ties a cache entry to the deployed frontend build, so a new deploy never
 * reads back state shaped by the previous one. Falls back to "dev" when the
 * build tooling hasn't injected an id (local development).
 */
function currentBuildId(): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string> })?.env;
    return typeof env?.VITE_BUILD_ID === "string" && env.VITE_BUILD_ID
      ? env.VITE_BUILD_ID
      : "dev";
  } catch {
    return "dev";
  }
}

/** Binds a cache entry to the current shop so switching shops (or a stale
 * multi-tab session) can never read another store's cached billing state. */
function currentShop(): string {
  try {
    return getEmbeddedContext().shop || "";
  } catch {
    return "";
  }
}

function isFresh(envelope: CacheEnvelope<unknown>, maxAgeMs: number): boolean {
  return (
    envelope.schemaVersion === CACHE_SCHEMA_VERSION &&
    envelope.buildId === currentBuildId() &&
    envelope.shop === currentShop() &&
    Date.now() - envelope.savedAt <= maxAgeMs
  );
}

export function readModuleCache<T>(
  key: string,
  options?: { maxAgeMs?: number }
): T | undefined {
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_TTL_MS;

  const cached = memoryCache.get(key) as CacheEnvelope<T> | undefined;
  if (cached) {
    return isFresh(cached, maxAgeMs) ? cached.value : undefined;
  }

  if (!canUseStorage()) {
    return undefined;
  }

  const stored = window.sessionStorage.getItem(`${STORAGE_PREFIX}${key}`);
  if (!stored) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(stored) as CacheEnvelope<T>;
    if (!isFresh(parsed, maxAgeMs)) {
      window.sessionStorage.removeItem(`${STORAGE_PREFIX}${key}`);
      return undefined;
    }
    memoryCache.set(key, parsed);
    return parsed.value;
  } catch {
    window.sessionStorage.removeItem(`${STORAGE_PREFIX}${key}`);
    return undefined;
  }
}

export function writeModuleCache<T>(key: string, value: T) {
  const envelope: CacheEnvelope<T> = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    shop: currentShop(),
    buildId: currentBuildId(),
    savedAt: Date.now(),
    value,
  };

  memoryCache.set(key, envelope);

  if (!canUseStorage()) {
    return;
  }

  window.sessionStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(envelope));
}

export function clearModuleCache(key: string) {
  memoryCache.delete(key);

  if (!canUseStorage()) {
    return;
  }

  window.sessionStorage.removeItem(`${STORAGE_PREFIX}${key}`);
}

/**
 * Clears every VedaSuite module cache entry. Call this after authentication
 * changes (reconnect, re-auth) or plan changes, where more than one cached
 * key could be affected — not just the one the current flow happens to know
 * about.
 */
export function clearAllModuleCaches() {
  memoryCache.clear();

  if (!canUseStorage()) {
    return;
  }

  const keysToRemove: string[] = [];
  for (let i = 0; i < window.sessionStorage.length; i += 1) {
    const storageKey = window.sessionStorage.key(i);
    if (storageKey && storageKey.startsWith(STORAGE_PREFIX)) {
      keysToRemove.push(storageKey);
    }
  }
  keysToRemove.forEach((storageKey) => window.sessionStorage.removeItem(storageKey));
}
