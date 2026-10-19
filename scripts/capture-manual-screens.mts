/**
 * N3 — capture authenticated screenshots for the training manual.
 * Run: node --import tsx --env-file=.env.local scripts/capture-manual-screens.mts
 *
 * Drives the installed Chrome via playwright-core (no browser download),
 * authenticates with a session cookie minted by the app's own auth code, and
 * writes PNGs to docs/manual-screens/. Re-run any time the UI changes, then
 * regenerate the manual PDF.
 */

import { chromium } from "playwright-core";
import { createSessionToken } from "../lib/auth";

const BASE = process.env.APP_BASE_URL?.trim() || "http://localhost:3000";
const OUT = "docs/manual-screens";

const PAGES: { file: string; path: string; waitFor?: string }[] = [
  { file: "01-home.png", path: "/" },
  { file: "02-search.png", path: "/search", waitFor: "text=result" },
  { file: "03-opportunities.png", path: "/opportunities" },
  { file: "04-scouts.png", path: "/scouts" },
  { file: "05-teaming.png", path: "/teaming" },
  { file: "06-pools.png", path: "/pools" },
  { file: "07-reference.png", path: "/reference" },
  { file: "08-workbench.png", path: "/workbench" },
  { file: "09-drafts.png", path: "/drafts" },
  { file: "11-partners.png", path: "/partners" },
  { file: "12-decisions.png", path: "/decisions" },
  { file: "13-boilerplate.png", path: "/boilerplate" },
];

const token = await createSessionToken({
  sub: "hello@govscout.ai",
  email: "hello@govscout.ai",
  name: "the operator",
});

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies([
  { name: "gs_session", value: token, domain: "localhost", path: "/" },
]);
const page = await context.newPage();

for (const p of PAGES) {
  await page.goto(`${BASE}${p.path}`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  if (p.waitFor) await page.waitForSelector(p.waitFor, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${p.file}` });
  console.log("captured", p.file);
}

// Element shots on the draft detail page: budget engine + council pane.
const draftLink = await page
  .goto(`${BASE}/drafts`, { waitUntil: "domcontentloaded" })
  .then(() => page.locator('a[href^="/drafts/"]').first().getAttribute("href"));
if (draftLink) {
  await page.goto(`${BASE}${draftLink}`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(800);
  const budget = page.locator("div.rounded-xl", { hasText: "Budget engine" }).last();
  if (await budget.count()) {
    await budget.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await budget.screenshot({ path: `${OUT}/10-budget-engine.png` });
    console.log("captured 10-budget-engine.png");
  }
  const council = page.locator("div,section").filter({ hasText: /Council/ }).filter({ has: page.locator("button") }).first();
  if (await council.count()) {
    await council.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await council.screenshot({ path: `${OUT}/14-council.png` }).catch(() => console.log("council shot skipped"));
    console.log("captured 14-council.png");
  }
}

await browser.close();
console.log("done.");
