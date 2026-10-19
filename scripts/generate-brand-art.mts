/**
 * N9 — Nano Banana brand-art pipeline. Generates the GovScout illustration set
 * (login hero, empty-state art, celebration art) with Gemini's image model and
 * drops them into public/assets/brand/.
 *
 * Run: node --import tsx --env-file=.env.local scripts/generate-brand-art.mts
 *
 * NOTE: image generation needs quota — the AI Studio FREE tier has none, so
 * enable billing on the key's Google account (~$0.04/image) or wait for a
 * daily reset. Text-model quota is unaffected. Re-run any time to refresh art.
 */

import { mkdirSync, writeFileSync } from "fs";

const KEY = process.env.GEMINI_API_KEY?.trim();
if (!KEY) {
  console.error("GEMINI_API_KEY not set in .env.local");
  process.exit(1);
}

const MODEL = "gemini-2.5-flash-image";
const OUT_DIR = "public/assets/brand";

// The brand: deep navy (#0f1b33-ish), brushed gold (#d4a853), modern-federal,
// confident but warm. Flat/minimal so the art never fights the data UI.
const STYLE =
  "Flat minimal vector-style illustration, deep navy background (#0F1B33), brushed gold accents (#D4A853), " +
  "subtle off-white linework, modern-federal aesthetic, generous negative space, no text, no watermark.";

const ASSETS: { file: string; prompt: string }[] = [
  {
    file: "login-hero.png",
    prompt: `${STYLE} A wide banner: an abstract radar sweep over a stylized map of New Jersey and Florida, small gold coins/grant documents appearing at blip points, one gold compass rose at center. Calm, premium, intelligence-agency-meets-philanthropy mood. 16:9.`,
  },
  {
    file: "empty-state.png",
    prompt: `${STYLE} A small square spot illustration: a friendly telescope on a tripod pointed at a night sky where one star is a gold dollar-sign glint. Conveys "nothing here yet — still scanning". 1:1.`,
  },
  {
    file: "victory.png",
    prompt: `${STYLE} A small square spot illustration: a gold laurel wreath around a rolled award document with a ribbon seal. Conveys "grant won". 1:1.`,
  },
];

mkdirSync(OUT_DIR, { recursive: true });
let okCount = 0;

for (const asset of ASSETS) {
  process.stdout.write(`generating ${asset.file}… `);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": KEY, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: asset.prompt }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
      },
    );
    const body = (await res.json()) as Record<string, unknown>;
    const err = body.error as { code?: number; message?: string } | undefined;
    if (err) {
      console.log(`FAILED (${err.code}): ${String(err.message).slice(0, 100)}`);
      continue;
    }
    const parts =
      ((body.candidates as Record<string, unknown>[] | undefined)?.[0]?.content as
        | { parts?: Record<string, unknown>[] }
        | undefined)?.parts ?? [];
    const img = parts.find((p) => p.inlineData) as
      | { inlineData: { data: string; mimeType?: string } }
      | undefined;
    if (!img) {
      console.log("no image in response");
      continue;
    }
    writeFileSync(`${OUT_DIR}/${asset.file}`, Buffer.from(img.inlineData.data, "base64"));
    console.log("ok");
    okCount++;
  } catch (e) {
    console.log("error:", e instanceof Error ? e.message.slice(0, 100) : e);
  }
}

console.log(`\n${okCount}/${ASSETS.length} assets written to ${OUT_DIR}/`);
if (okCount === 0) {
  console.log("All failed — if errors were 429, enable billing on the AI Studio account or retry after the daily quota reset.");
}
