const cache = new Map<string, unknown>();

export function readModuleCache<T>(key: string) {
  return cache.get(key) as T | undefined;
}

export function writeModuleCache<T>(key: string, value: T) {
  cache.set(key, value);
}
