const cache = new Map<string, unknown>();
const STORAGE_PREFIX = "vedasuite:cache:";

function canUseStorage() {
  return typeof window !== "undefined" && !!window.sessionStorage;
}

export function readModuleCache<T>(key: string) {
  if (cache.has(key)) {
    return cache.get(key) as T | undefined;
  }

  if (!canUseStorage()) {
    return undefined;
  }

  const stored = window.sessionStorage.getItem(`${STORAGE_PREFIX}${key}`);
  if (!stored) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(stored) as T;
    cache.set(key, parsed);
    return parsed;
  } catch {
    window.sessionStorage.removeItem(`${STORAGE_PREFIX}${key}`);
    return undefined;
  }
}

export function writeModuleCache<T>(key: string, value: T) {
  cache.set(key, value);

  if (!canUseStorage()) {
    return;
  }

  window.sessionStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(value));
}

export function clearModuleCache(key: string) {
  cache.delete(key);

  if (!canUseStorage()) {
    return;
  }

  window.sessionStorage.removeItem(`${STORAGE_PREFIX}${key}`);
}
