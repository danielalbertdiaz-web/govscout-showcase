import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { extractText, extractStructured, nofoToOpportunityText } from "@/lib/extract";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOW_HOST_SUFFIXES = [
  "grants.gov",
  "sam.gov",
  "hrsa.gov",
  "samhsa.gov",
  "cdc.gov",
  "hud.gov",
  "doleta.gov",
  "dol.gov",
  "nih.gov",
  "ed.gov",
  "epa.gov",
  "energy.gov",
  "usda.gov",
  "noaa.gov",
  "nsf.gov",
  "nj.gov",
];

function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ALLOW_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

function validateTarget(target: string): URL | null {
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (!isAllowedHost(parsed.hostname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { url?: string };
  const target = (body.url ?? "").trim();
  if (!target) return Response.json({ error: "url_missing" }, { status: 400 });

  const parsed = validateTarget(target);
  if (!parsed) {
    return Response.json(
      { error: "url_not_allowed", allowed: ALLOW_HOST_SUFFIXES },
      { status: 400 },
    );
  }

  let fetched: Response | null = null;
  let currentUrl = parsed;
  try {
    for (let redirects = 0; redirects < 4; redirects += 1) {
      fetched = await fetch(currentUrl, {
        headers: { "user-agent": "GovScout/5 (NOFO fetch; hello@govscout.ai)" },
        redirect: "manual",
      });
      if (fetched.status < 300 || fetched.status >= 400) break;
      const location = fetched.headers.get("location");
      if (!location) {
        return Response.json({ error: "redirect_missing_location" }, { status: 502 });
      }
      const nextUrl = validateTarget(new URL(location, currentUrl).toString());
      if (!nextUrl) {
        return Response.json({ error: "redirect_target_not_allowed" }, { status: 403 });
      }
      currentUrl = nextUrl;
    }
  } catch (err) {
    return Response.json(
      { error: "fetch_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  if (!fetched) {
    return Response.json({ error: "fetch_failed", message: "No response received" }, { status: 502 });
  }

  if (!fetched.ok) {
    return Response.json({ error: "fetch_status", status: fetched.status, statusText: fetched.statusText }, { status: 502 });
  }
  const ab = await fetched.arrayBuffer();
  if (ab.byteLength > MAX_BYTES) {
    return Response.json({ error: "file_too_large", size: ab.byteLength, max: MAX_BYTES }, { status: 413 });
  }
  const buf = Buffer.from(ab);
  const contentType = fetched.headers.get("content-type") ?? "";
  const filename = parsed.pathname.split("/").pop() || "nofo.pdf";

  let extracted;
  try {
    extracted = await extractText(buf, contentType, filename);
  } catch (err) {
    return Response.json(
      { error: "extract_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 422 },
    );
  }
  if (!extracted.text.trim()) {
    return Response.json({ error: "no_text_extracted" }, { status: 422 });
  }

  let structured;
  try {
    structured = await extractStructured(extracted.text);
  } catch (err) {
    return Response.json(
      { error: "structured_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const opportunity = nofoToOpportunityText(extracted.text, structured);
  return Response.json({
    url: target,
    filename,
    sourceType: extracted.sourceType,
    pages: extracted.pages,
    chars: extracted.text.length,
    structured,
    opportunity,
  });
}
