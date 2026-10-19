// Partner ingestion — turn a URL, pasted prospectus text, or an uploaded
// document into a draft Partner record (+ markdown reference profile) for the
// user to review before saving. The model does the structured extraction; we
// only fetch/parse the source and shape the JSON.

import { getClient, defaultModelFor } from "./anthropic";
import { extractText, isSupportedType } from "./extract";
import type { UpsertPartnerInput } from "./partners";

export type PartnerDraft = {
  name: string;
  type: string;
  description: string;
  capabilities: string[];
  commission_structure: string;
  integration_notes: string;
  contact: string;
  status: string;
  body: string; // markdown reference profile
};

const MAX_TEXT_CHARS = 60_000;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 4;

// Block obvious internal/loopback targets so a URL ingest can't be aimed at the
// host's own metadata/services (basic SSRF hardening for a local tool).
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) return true;
  if (h === "0.0.0.0" || h === "::1" || h === "[::1]") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

export async function fetchUrlText(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http(s) URLs are supported");
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error("URL host is not allowed");
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    // Follow redirects MANUALLY so every hop is re-checked against the same
    // host policy. With redirect:"follow" an allowed URL could 302 the server
    // to an internal/metadata address (SSRF); manual following closes that.
    let current = url;
    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECTS) throw new Error("too many redirects");
      res = await fetch(current, {
        signal: ctrl.signal,
        redirect: "manual",
        headers: { "user-agent": "GovScout-PartnerIngest/1.0" },
      });
      if (res.status < 300 || res.status >= 400) break;
      const location = res.headers.get("location");
      if (!location) break; // 3xx without Location → treat as terminal
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error("invalid redirect target");
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new Error("redirect to unsupported protocol");
      }
      if (isBlockedHost(next.hostname)) {
        throw new Error("redirect host is not allowed");
      }
      current = next;
    }
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const html = await res.text();
  return htmlToText(html);
}

// Strip scripts/styles/tags to a plain-text approximation. Good enough to feed
// the model; we don't need a full DOM.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fileToText(
  buffer: Buffer,
  mime: string,
  filename: string,
): Promise<string> {
  if (!isSupportedType(mime, filename)) {
    throw new Error("unsupported file type (use PDF, DOCX, TXT, or MD)");
  }
  const { text } = await extractText(buffer, mime, filename);
  return text;
}

const PARTNER_TYPES = [
  "referral_partner",
  "tech_specialist",
  "community_partner",
  "healthcare_partner",
  "prime",
  "subcontractor",
] as const;

const INGEST_SYSTEM = `You read an organization's website, capability statement, or prospectus and extract a structured "consortium partner" profile for a federal-grant proposal shop.

Return ONLY a single JSON object (no prose, no code fences) matching:

{
  "name": string,                       // organization name
  "type": string,                       // one of: ${PARTNER_TYPES.join(", ")} — best fit, else "referral_partner"
  "description": string,                // one-sentence summary of what they do
  "capabilities": string[],             // 3–10 short snake_case capability tags, e.g. "grant_writing", "workforce_development", "data_evaluation"
  "commission_structure": string,       // referral/commission/teaming terms if stated, else ""
  "integration_notes": string,          // how they'd plug into a proposal (1 sentence), else ""
  "contact": string,                    // email/phone/website if present, else ""
  "status": "active",
  "body": string                        // a markdown reference profile (2–5 short paragraphs) usable as source-of-truth prose in proposals
}

Rules:
- Do NOT invent certifications, EINs, contract numbers, or past performance not present in the source. If unknown, omit from the body.
- capabilities are lowercase snake_case noun phrases.
- Keep "description" to one sentence.`;

export async function extractPartnerDraft(
  rawText: string,
  sourceHint?: string,
): Promise<PartnerDraft> {
  const trimmed = rawText.length > MAX_TEXT_CHARS ? rawText.slice(0, MAX_TEXT_CHARS) : rawText;
  if (!trimmed.trim()) throw new Error("no text to ingest");

  const client = getClient();
  const resp = await client.messages.create({
    model: defaultModelFor("extract"),
    max_tokens: 2048,
    system: INGEST_SYSTEM,
    messages: [
      {
        role: "user",
        content: `${sourceHint ? `Source: ${sourceHint}\n\n` : ""}Extract the partner profile from this content.\n\n--- BEGIN CONTENT ---\n${trimmed}\n--- END CONTENT ---`,
      },
    ],
  });

  const textBlock = resp.content.find((c) => c.type === "text");
  const text = textBlock && "text" in textBlock ? textBlock.text : "";
  return normalizeDraft(parseJsonLoose(text), trimmed);
}

function parseJsonLoose(s: string): Record<string, unknown> {
  if (!s) return {};
  let body = s.trim();
  if (body.startsWith("```")) {
    body = body.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  }
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) body = body.slice(start, end + 1);
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normalizeDraft(raw: Record<string, unknown>, fallbackText: string): PartnerDraft {
  const str = (v: unknown): string => (v == null ? "" : String(v)).trim();
  const caps = Array.isArray(raw.capabilities)
    ? raw.capabilities
        .map((c) => String(c).trim().toLowerCase().replace(/\s+/g, "_"))
        .filter(Boolean)
        .slice(0, 12)
    : [];
  const name = str(raw.name);
  if (!name) throw new Error("could not determine an organization name from the source");
  return {
    name,
    type: str(raw.type) || "referral_partner",
    description: str(raw.description),
    capabilities: caps,
    commission_structure: str(raw.commission_structure),
    integration_notes: str(raw.integration_notes),
    contact: str(raw.contact),
    status: str(raw.status) || "active",
    body: str(raw.body) || fallbackText.slice(0, 2000),
  };
}

export function draftToUpsert(draft: PartnerDraft): UpsertPartnerInput {
  return {
    name: draft.name,
    type: draft.type,
    description: draft.description,
    capabilities: draft.capabilities,
    commission_structure: draft.commission_structure,
    integration_notes: draft.integration_notes,
    contact: draft.contact,
    status: draft.status,
    body: draft.body,
  };
}
