// Node runtime preflight (runs via `pretest`).
//
// better-sqlite3 in node_modules is compiled for the pinned runtime (node@24,
// the same one launchd and scripts/deploy.sh use). Under any other Node the
// suite dies mid-run with ERR_DLOPEN_FAILED / NODE_MODULE_VERSION mismatch —
// a stack trace that looks like a broken database, not a runtime problem.
// This fails fast, legibly, before anything native loads.
//
// Deliberately dependency-free: node builtins only, plain .mjs.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const range = JSON.parse(readFileSync(pkgPath, "utf8")).engines?.node ?? "";
const running = process.versions.node;
const major = Number(running.split(".")[0]);

// Minimal evaluator for the simple space-separated comparator ranges we use
// (e.g. ">=24 <25"). Compares majors only — that is the granularity the
// native-module ABI (NODE_MODULE_VERSION) actually varies on.
const satisfied = range
  .split(/\s+/)
  .filter(Boolean)
  .every((comparator) => {
    const m = /^(>=|<=|>|<|=)?(\d+)/.exec(comparator);
    if (!m) return true; // unrecognized comparator: don't block on it
    const n = Number(m[2]);
    switch (m[1] ?? "=") {
      case ">=": return major >= n;
      case "<=": return major <= n;
      case ">": return major > n;
      case "<": return major < n;
      default: return major === n;
    }
  });

if (satisfied) process.exit(0);

console.error(
  [
    `govscout-v5 requires Node ${range} (package.json "engines"); you are running v${running}.`,
    `better-sqlite3 is compiled for the pinned runtime — other versions fail with a`,
    `cryptic ERR_DLOPEN_FAILED / NODE_MODULE_VERSION mismatch. Do not rebuild it; switch Node:`,
    ``,
    `  export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`,
  ].join("\n"),
);
process.exit(1);
