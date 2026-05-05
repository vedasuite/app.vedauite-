const CANONICAL_MODULE_KEYS = ["fraud", "competitor", "pricing", "profit"];

function normalizeBoolean(value) {
  return value === true;
}

export function resolveBackendEnabledModules(appState) {
  const readinessModules = appState?.storeReadiness?.billing?.enabledModules;
  if (readinessModules) {
    return {
      fraud: normalizeBoolean(readinessModules.fraud),
      competitor: normalizeBoolean(readinessModules.competitor),
      pricing: normalizeBoolean(readinessModules.pricing),
      profit: normalizeBoolean(readinessModules.profit),
      reports: normalizeBoolean(readinessModules.reports),
      settings: normalizeBoolean(readinessModules.settings),
    };
  }

  const entitlements = appState?.entitlements;
  return {
    fraud: normalizeBoolean(entitlements?.fraud ?? entitlements?.trustAbuse),
    competitor: normalizeBoolean(entitlements?.competitor),
    pricing: normalizeBoolean(entitlements?.pricing ?? entitlements?.pricingProfit),
    profit: normalizeBoolean(entitlements?.profit),
    reports: normalizeBoolean(entitlements?.reports),
    settings: normalizeBoolean(entitlements?.settings),
  };
}

export function resolveBackendLockedModules(appState) {
  const enabledModules = resolveBackendEnabledModules(appState);
  return CANONICAL_MODULE_KEYS.filter((moduleKey) => !enabledModules[moduleKey]);
}

export function isBackendModuleEnabled(appState, moduleKey) {
  return normalizeBoolean(resolveBackendEnabledModules(appState)[moduleKey]);
}

export function resolveBackendPlan(appState) {
  return appState?.storeReadiness?.billing?.plan ?? appState?.billing?.planName ?? "NONE";
}

export function resolveBackendStarterModule(appState) {
  return appState?.storeReadiness?.billing?.starterModule ?? null;
}
