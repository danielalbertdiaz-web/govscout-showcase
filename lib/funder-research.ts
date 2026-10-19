// N6 — Perplexity Sonar funder-research adapter (dark seam).
//
// Answers funder/grant questions with LIVE, CITED web research ("who runs
// SAMHSA TI grants in NJ?", "what does the Quantum Foundation fund?"). Runs on
// the operator's Perplexity Pro included API credits. Like every other seam:
// no key → `available` is false and the UI hides the pane; failures return a
// clean error, never throw.

const SONAR_ENDPOINT = "https://api.perplexity.ai/chat/completions";
const SONAR_MODEL = "sonar";

const SYSTEM_PROMPT =
  "You are a grant-funding research assistant for a behavioral-health consultancy. " +
  "Answer concisely and factually with citations. Focus on: what a funder funds, typical award sizes, " +
  "application mechanics, named program officers/contacts when public, and recent grants. " +
  "If you cannot verify something, say so — never invent funders, programs, or dollar amounts.";

export function funderResearchConfigured(): boolean {
  return Boolean(process.env.PERPLEXITY_API_KEY?.trim());
}

export type FunderResearchResult = {
  ok: boolean;
  answer: string | null;
  citations: string[];
  error: string | null;
};

type SonarResponse = {
  choices?: { message?: { content?: string } }[];
  citations?: string[];
  search_results?: { url?: string }[];
  error?: { message?: string } | string;
};

/** Pure: pull answer + citation URLs out of a Sonar response body. */
export function parseSonarResponse(body: unknown): { answer: string | null; citations: string[] } {
  if (!body || typeof body !== "object") return { answer: null, citations: [] };
  const d = body as SonarResponse;
  const answer = d.choices?.[0]?.message?.content?.trim() || null;
  const fromCitations = Array.isArray(d.citations) ? d.citations.filter((c) => typeof c === "string") : [];
  const fromSearch = Array.isArray(d.search_results)
    ? d.search_results.map((r) => r?.url).filter((u): u is string => typeof u === "string")
    : [];
  const citations = Array.from(new Set([...fromCitations, ...fromSearch])).slice(0, 10);
  return { answer, citations };
}

export async function researchFunder(question: string): Promise<FunderResearchResult> {
  const key = process.env.PERPLEXITY_API_KEY?.trim();
  if (!key) return { ok: false, answer: null, citations: [], error: "not_configured" };
  const q = question.trim();
  if (!q) return { ok: false, answer: null, citations: [], error: "empty_question" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const res = await fetch(SONAR_ENDPOINT, {
      method: "POST",
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: SONAR_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: q.slice(0, 2_000) },
        ],
        max_tokens: 700,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, answer: null, citations: [], error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
    }
    const { answer, citations } = parseSonarResponse(await res.json());
    if (!answer) return { ok: false, answer: null, citations, error: "empty_answer" };
    return { ok: true, answer, citations, error: null };
  } catch (err) {
    return {
      ok: false,
      answer: null,
      citations: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
