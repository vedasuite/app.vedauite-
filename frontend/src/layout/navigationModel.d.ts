/**
 * Types for navigationModel.js.
 *
 * The implementation is plain ESM JavaScript so the backend test runner can
 * import and execute the exact shipped module (see
 * backend/tests/navigationRuntime.test.cjs). This file gives AppFrame.tsx full
 * type checking over it.
 */

export type NavModuleStatus =
  | {
      fraud?: boolean;
      competitor?: boolean;
      pricing?: boolean;
    }
  | null
  | undefined;

export type NavEntry = {
  path: string;
  label: string;
  /** Only ever "Upgrade" — a hint, never a gate. */
  badge?: string;
};

/** Every route reachable from the authenticated shell, in display order. */
export const NAV_PATHS: string[];

/** Entries that must never carry a badge or any gating whatsoever. */
export const UNGATED_PATHS: string[];

/**
 * Builds the navigation entries. Total: null, undefined and partial status all
 * return the complete list. Module status may only set a badge, never remove
 * an entry.
 */
export function buildNavigationModel(moduleStatus: NavModuleStatus): NavEntry[];
