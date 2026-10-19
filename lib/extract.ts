import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { getClient, DEFAULT_MODEL } from "./anthropic";

export type ExtractedNofo = {
  agency?: string;
  program?: string;
  funding_floor?: string;
  funding_ceiling?: string;
  period_of_performance?: string;
  eligibility?: string;
  key_dates?: { loi?: string; full_proposal?: string; award?: string; other?: string };
  evaluation_criteria?: string;
  required_sections?: string[];
  page_limits?: string;
  summary?: string;
};

const SUPPORTED_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
]);

export function isSupportedType(mime: string, filename: string): boolean {
  if (SUPPORTED_TYPES.has(mime)) return true;
  const lower = filename.toLowerCase();
  return lower.endsWith(".pdf") || lower.endsWith(".docx") || lower.endsWith(".txt") || lower.endsWith(".md");
}

export async function extractText(
  buffer: Buffer,
  mime: string,
  filename: string,
): Promise<{ text: string; pages?: number; sourceType: string }> {
  const lower = filename.toLowerCase();
  const isPdf = mime === "application/pdf" || lower.endsWith(".pdf");
  const isDocx =
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || lower.endsWith(".docx");

  if (isPdf) {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    return { text: result.text ?? "", pages: result.total ?? undefined, sourceType: "pdf" };
  }
  if (isDocx) {
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value ?? "", sourceType: "docx" };
  }
  return { text: buffer.toString("utf8"), sourceType: "text" };
}

const EXTRACT_SYSTEM = `You are a federal-grant solicitation reader. You will be given the raw text of a NOFO/RFP/RFA. Extract the structured fields below as strict JSON. If a field is not present, use null. Do not guess.

Return ONLY a single JSON object matching this TypeScript shape — no prose, no code fences:

{
  "agency": string | null,
  "program": string | null,
  "funding_floor": string | null,
  "funding_ceiling": string | null,
  "period_of_performance": string | null,
  "eligibility": string | null,
  "key_dates": { "loi": string | null, "full_proposal": string | null, "award": string | null, "other": string | null } | null,
  "evaluation_criteria": string | null,
  "required_sections": string[] | null,
  "page_limits": string | null,
  "summary": string | null
}

Rules:
- "summary" is a 2–4 sentence plain-English description of what the funder is buying.
- "evaluation_criteria" should preserve any point weights when present (e.g., "Approach 40 pts; Past Performance 20 pts; Budget 15 pts; ...").
- "required_sections" is a list of titled sections the proposal must contain (e.g., "Project Narrative", "Budget Justification", "Letters of Support").
- Money fields are short strings ("$500,000", "$1.5M", "Up to $750,000 over 3 yrs"). Don't reformat — keep the funder's wording when possible.
- Date fields are short strings ("2026-06-15", "June 15, 2026", "Rolling"). Keep the funder's wording when possible.`;

const MAX_TEXT_CHARS = 80_000;

export async function extractStructured(rawText: string): Promise<ExtractedNofo> {
  const trimmed = rawText.length > MAX_TEXT_CHARS ? rawText.slice(0, MAX_TEXT_CHARS) : rawText;
  const client = getClient();
  const resp = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 2048,
    system: EXTRACT_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Extract the structured NOFO fields from this solicitation text.\n\n--- BEGIN SOLICITATION TEXT ---\n${trimmed}\n--- END SOLICITATION TEXT ---`,
      },
    ],
  });

  const textBlock = resp.content.find((c) => c.type === "text");
  const text = textBlock && "text" in textBlock ? textBlock.text : "";
  return parseJsonLoose(text);
}

function parseJsonLoose(s: string): ExtractedNofo {
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
    return normalizeExtracted(parsed);
  } catch {
    return { summary: s.slice(0, 800) };
  }
}

function nonNull<T>(v: T | null | undefined): T | undefined {
  return v == null ? undefined : v;
}

function normalizeExtracted(raw: unknown): ExtractedNofo {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const kd = r.key_dates && typeof r.key_dates === "object" ? (r.key_dates as Record<string, unknown>) : null;
  return {
    agency: nonNull(r.agency as string | null),
    program: nonNull(r.program as string | null),
    funding_floor: nonNull(r.funding_floor as string | null),
    funding_ceiling: nonNull(r.funding_ceiling as string | null),
    period_of_performance: nonNull(r.period_of_performance as string | null),
    eligibility: nonNull(r.eligibility as string | null),
    key_dates: kd
      ? {
          loi: nonNull(kd.loi as string | null),
          full_proposal: nonNull(kd.full_proposal as string | null),
          award: nonNull(kd.award as string | null),
          other: nonNull(kd.other as string | null),
        }
      : undefined,
    evaluation_criteria: nonNull(r.evaluation_criteria as string | null),
    required_sections: Array.isArray(r.required_sections)
      ? (r.required_sections as unknown[]).map((s) => String(s)).filter(Boolean)
      : undefined,
    page_limits: nonNull(r.page_limits as string | null),
    summary: nonNull(r.summary as string | null),
  };
}

export function nofoToOpportunityText(text: string, structured: ExtractedNofo): string {
  const parts: string[] = [];
  if (structured.agency) parts.push(`Agency: ${structured.agency}`);
  if (structured.program) parts.push(`Program: ${structured.program}`);
  if (structured.funding_floor || structured.funding_ceiling) {
    parts.push(`Funding: ${[structured.funding_floor, structured.funding_ceiling].filter(Boolean).join(" – ")}`);
  }
  if (structured.period_of_performance) parts.push(`Period of Performance: ${structured.period_of_performance}`);
  if (structured.eligibility) parts.push(`Eligibility: ${structured.eligibility}`);
  if (structured.key_dates) {
    const kd = structured.key_dates;
    const dateParts = [
      kd.loi && `LOI ${kd.loi}`,
      kd.full_proposal && `Full proposal ${kd.full_proposal}`,
      kd.award && `Award ${kd.award}`,
      kd.other && kd.other,
    ].filter(Boolean);
    if (dateParts.length) parts.push(`Key dates: ${dateParts.join("; ")}`);
  }
  if (structured.evaluation_criteria) parts.push(`Evaluation criteria: ${structured.evaluation_criteria}`);
  if (structured.required_sections?.length) parts.push(`Required sections: ${structured.required_sections.join(", ")}`);
  if (structured.page_limits) parts.push(`Page limits: ${structured.page_limits}`);
  if (structured.summary) parts.push(`\nSummary:\n${structured.summary}`);
  parts.push(`\n--- RAW SOLICITATION EXCERPT ---\n${text.slice(0, 12000)}`);
  return parts.join("\n");
}
