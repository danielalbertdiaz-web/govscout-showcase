/**
 * Track L P1 — capture an authenticated screenshot of the /track-l pane.
 * Run: APP_BASE_URL=http://localhost:3005 node --import tsx --env-file=.env.local scripts/capture-track-l.mts
 *
 * Same drive-installed-Chrome approach as capture-bid-board.mts.
 */

import { chromium } from "playwright-core";
import { createSessionToken } from "../lib/auth";

const BASE = process.env.APP_BASE_URL?.trim() || "http://localhost:3000";
const OUT = process.env.OUT_PATH?.trim() || "docs/track-l.png";
const host = new URL(BASE).hostname;

const token = await createSessionToken({
  sub: "hello@govscout.ai",
  email: "hello@govscout.ai",
  name: "the operator",
});

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.addCookies([{ name: "gs_session", value: token, domain: host, path: "/" }]);
const page = await context.newPage();
await page.goto(`${BASE}/track-l`, { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.waitForSelector("table tbody tr", { timeout: 60_000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: OUT, fullPage: false });
console.log("captured", OUT);
await browser.close();
