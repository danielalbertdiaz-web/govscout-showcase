/**
 * S9 Track C — Drafts pane regression snapshot test.
 *
 * Catches the "raw HTML, no Tailwind, no layout" symptom the operator saw at
 * app.govscout.ai/drafts on 2026-06-04 09:49 EDT by asserting each
 * authenticated page.tsx (or its delegated client component) renders with
 * Tailwind utility classes AND a max-width container — i.e. it would not
 * render as bare unstyled HTML even if a hostile CSS chunk diff appeared.
 *
 * Heuristic: scan page.tsx plus every other .tsx in the same route folder
 * (covers view.tsx, workbench.tsx, library.tsx, detail.tsx, search-client.tsx,
 * etc. without hard-coding names) for:
 *   1. A Tailwind utility class (e.g. `text-sm`, `border-stone-200`).
 *   2. A `max-w-*` container.
 *
 * The drafts/[id] route delegates to ../../workbench.tsx — handled by
 * walking up one directory level when the local folder doesn't satisfy.
 *
 * Login and the root page are exempt; everything else must satisfy both.
 * This won't catch a Vercel-side CSS bundle drop (the prod CSS chunk could
 * still fail to load) — see data/runbooks/drafts-pane-regression-2026-06-04.md
 * for the runtime diagnosis path.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";

const APP_DIR = join(process.cwd(), "app");
const EXEMPT = new Set(["app/login/page.tsx"]);

const TAILWIND_TOKEN = /className=["'`][^"'`]*\b(?:text|bg|border|p[xytrbl]?|m[xytrbl]?|w|h|rounded|flex|grid|gap|shadow|ring|tracking|leading|font|min-h|max-w|gs)-[a-z0-9]+/i;
const MAX_WIDTH = /\bmax-w-[a-z0-9]+/;

type Finding = { route: string; issues: string[] };

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (entry === "page.tsx") acc.push(p);
  }
  return acc;
}

function readSiblings(dir: string): string {
  let bundle = "";
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (!statSync(p).isFile()) continue;
    if (!entry.endsWith(".tsx") && !entry.endsWith(".ts")) continue;
    try {
      bundle += readFileSync(p, "utf8");
    } catch {
      // ignore unreadable
    }
  }
  return bundle;
}

function rel(p: string): string {
  return p.replace(process.cwd() + "/", "");
}

function checkPage(pagePath: string): Finding {
  const relPath = rel(pagePath);
  if (EXEMPT.has(relPath)) return { route: relPath, issues: [] };
  const issues: string[] = [];

  const localDir = dirname(pagePath);
  const localBundle = readSiblings(localDir);

  // Walk up to two dirs if needed (covers drafts/[id] -> workbench.tsx at app/workbench.tsx).
  const parentDir = dirname(localDir);
  const grandDir = dirname(parentDir);
  const ancestorBundle = readSiblings(parentDir) + readSiblings(grandDir);

  const combined = localBundle + "\n" + ancestorBundle;

  if (!TAILWIND_TOKEN.test(combined)) {
    issues.push("no Tailwind utility classes detected anywhere in the route or its ancestors");
  }
  if (!MAX_WIDTH.test(combined)) {
    issues.push("no max-w-* container — page may render full-bleed and look unstyled");
  }

  return { route: relPath, issues };
}

function main(): void {
  const pages = walk(APP_DIR);
  const findings = pages.map(checkPage);
  const failed = findings.filter((f) => f.issues.length > 0);
  const passed = findings.length - failed.length;

  process.stdout.write(`=== page-structure smoke (S9 Track C) ===\n`);
  process.stdout.write(`pages scanned: ${findings.length}\n`);
  process.stdout.write(`passed:        ${passed}\n`);
  process.stdout.write(`failed:        ${failed.length}\n`);

  for (const f of failed) {
    process.stdout.write(`\n❌ ${f.route}\n`);
    for (const issue of f.issues) process.stdout.write(`   - ${issue}\n`);
  }

  if (failed.length > 0) {
    process.stdout.write(
      `\nIf this fires on a previously-passing page, that page likely lost ` +
        `its layout chrome — the S9 Track C regression symptom.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`\n✅ all pages carry Tailwind utilities + max-w container\n`);
}

main();
