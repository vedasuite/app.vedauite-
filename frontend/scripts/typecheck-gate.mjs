#!/usr/bin/env node
/**
 * Frontend TypeScript release gate.
 *
 * WHY THIS EXISTS: Vite builds with esbuild, which does not typecheck. A route
 * once shipped referencing a component that was never imported — the build
 * passed and the app threw ReferenceError at runtime. `tsc --noEmit` catches
 * that class of defect, but the codebase carries historical errors that would
 * make a plain hard failure unusable as a gate.
 *
 * So this gate is incremental: it fails on NEW errors only, measured against a
 * committed baseline. Nothing is suppressed — every pre-existing error stays
 * visible in the baseline file and in tsc output, and the count can only go
 * down (the gate tells you when to shrink it).
 *
 *   node scripts/typecheck-gate.mjs           check against the baseline
 *   node scripts/typecheck-gate.mjs --update  rewrite the baseline
 *
 * Errors are keyed by file + code + message WITHOUT line numbers, so simply
 * moving code does not read as a new error, while a genuinely new error — or a
 * second instance of an existing one in the same file — does.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(here, "..");
const baselinePath = path.join(frontendDir, "typecheck-baseline.json");
const update = process.argv.includes("--update");

/** `file(line,col): error TSxxxx: message` */
const ERROR_LINE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

function runTsc() {
  try {
    execFileSync("npx", ["tsc", "--noEmit"], {
      cwd: frontendDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    return "";
  } catch (error) {
    // tsc exits non-zero when there are errors; that is the normal path here.
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
}

/** Map of "file|code|message" -> occurrence count. */
function parseErrors(output) {
  const counts = {};
  for (const raw of output.split(/\r?\n/)) {
    const match = raw.match(ERROR_LINE);
    if (!match) continue;
    const [, file, , , code, message] = match;
    const key = `${file.replace(/\\/g, "/")}|${code}|${message.trim()}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

const output = runTsc();
const current = parseErrors(output);
const currentTotal = total(current);

if (update) {
  fs.writeFileSync(
    baselinePath,
    `${JSON.stringify({ total: currentTotal, errors: current }, null, 2)}\n`
  );
  console.log(`Baseline written: ${currentTotal} pre-existing error(s).`);
  process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
  console.error(
    `No baseline at ${baselinePath}. Create one with:\n  npm run typecheck:baseline`
  );
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const baselineErrors = baseline.errors ?? {};

const introduced = [];
for (const [key, count] of Object.entries(current)) {
  const allowed = baselineErrors[key] ?? 0;
  if (count > allowed) {
    introduced.push({ key, count, allowed });
  }
}

const fixed = [];
for (const [key, count] of Object.entries(baselineErrors)) {
  const now = current[key] ?? 0;
  if (now < count) {
    fixed.push({ key, was: count, now });
  }
}

const describe = ({ key }) => {
  const [file, code, message] = key.split("|");
  return `  ${file}: ${code}: ${message}`;
};

console.log(
  `TypeScript: ${currentTotal} error(s) now, ${baseline.total} in the baseline.`
);

if (introduced.length > 0) {
  console.error(
    `\nFAIL — this change introduces ${introduced.length} new TypeScript error(s):\n`
  );
  introduced.forEach((entry) => {
    console.error(describe(entry));
    if (entry.allowed > 0) {
      console.error(
        `    (${entry.allowed} allowed by the baseline, ${entry.count} found)`
      );
    }
  });
  console.error(
    "\nFix these before release. Do not run --update to silence them: the" +
      "\nbaseline exists only to hold PRE-EXISTING errors, and it must shrink," +
      "\nnever grow."
  );
  process.exit(1);
}

if (fixed.length > 0) {
  console.log(`\nImproved — ${fixed.length} baseline error(s) no longer occur:\n`);
  fixed.forEach((entry) => console.log(describe(entry)));
  console.log(
    "\nRun `npm run typecheck:baseline` to lock in the improvement so it" +
      "\ncannot regress."
  );
}

console.log("\nPASS — no new TypeScript errors.");
process.exit(0);
