export type UnifiedSetupStatus = "complete" | "incomplete";
export type UnifiedSyncStatus = "idle" | "running" | "completed" | "failed";
export type UnifiedDataStatus =
  | "ready"
  | "partial"
  | "empty"
  | "stale"
  | "failed"
  | "processing";
export type UnifiedCoverage = "full" | "partial" | "none";
export type UnifiedDependencyStatus = "ready" | "missing";

export type UnifiedModuleState = {
  setupStatus: UnifiedSetupStatus;
  syncStatus: UnifiedSyncStatus;
  dataStatus: UnifiedDataStatus;
  lastSuccessfulSyncAt: string | null;
  lastAttemptAt: string | null;
  dataChanged: boolean;
  coverage: UnifiedCoverage;
  dependencies: {
    competitor: UnifiedDependencyStatus;
    pricing: UnifiedDependencyStatus;
    fraud: UnifiedDependencyStatus;
  };
  title: string;
  description: string;
  nextAction: string | null;
};

type CreateUnifiedModuleStateArgs = {
  setupStatus: UnifiedSetupStatus;
  syncStatus: UnifiedSyncStatus;
  dataStatus: UnifiedDataStatus;
  lastSuccessfulSyncAt?: string | null;
  lastAttemptAt?: string | null;
  dataChanged?: boolean;
  coverage: UnifiedCoverage;
  dependencies?: Partial<UnifiedModuleState["dependencies"]>;
  title: string;
  description: string;
  nextAction?: string | null;
};

export const STALE_DATA_THRESHOLD_HOURS = 24;

export function toIsoString(value?: Date | string | null) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.toISOString();
}

export function isStaleTimestamp(value?: Date | string | null, thresholdHours = STALE_DATA_THRESHOLD_HOURS) {
  if (!value) return false;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return false;
  return Date.now() - time > thresholdHours * 60 * 60 * 1000;
}

export function createUnifiedModuleState(
  args: CreateUnifiedModuleStateArgs
): UnifiedModuleState {
  return {
    setupStatus: args.setupStatus,
    syncStatus: args.syncStatus,
    dataStatus: args.dataStatus,
    lastSuccessfulSyncAt: args.lastSuccessfulSyncAt ?? null,
    lastAttemptAt: args.lastAttemptAt ?? null,
    dataChanged: args.dataChanged ?? false,
    coverage: args.coverage,
    dependencies: {
      competitor: args.dependencies?.competitor ?? "missing",
      pricing: args.dependencies?.pricing ?? "missing",
      fraud: args.dependencies?.fraud ?? "missing",
    },
    title: args.title,
    description: args.description,
    nextAction: args.nextAction ?? null,
  };
}
