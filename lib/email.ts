// Item N2 / PENDING #1 — thin email notifier (Resend REST, no SDK).
//
// OPERATOR NOTIFICATIONS ONLY. This module emails the logged-in operator about
// their own queue (new decisions). It is NOT an outreach channel: partner-facing
// email stays draft-only per the standing "nothing auto-sends" guardrail.
//
// Double-gated and silent by design:
//   - RESEND_API_KEY unset            → no-op
//   - EMAIL_NOTIFICATIONS not "1"/"true" → no-op (explicit opt-in)
// Failures never throw — a dead mail provider must never break decision
// creation. Every attempt is visible in the activity log.

import { tryLogActivity } from "./activity";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export function emailConfigured(): boolean {
  const key = process.env.RESEND_API_KEY?.trim();
  const optIn = (process.env.EMAIL_NOTIFICATIONS ?? "").trim().toLowerCase();
  return Boolean(key) && (optIn === "1" || optIn === "true");
}

function fromAddress(): string {
  return process.env.EMAIL_FROM?.trim() || "GovScout <onboarding@resend.dev>";
}

/**
 * Where operator notifications land. The app's login identity
 * (hello@govscout.ai) is not necessarily a real mailbox — EMAIL_NOTIFY_TO
 * overrides the recipient with the operator's actual inbox. Also required by
 * Resend's test sender, which only delivers to the account owner's address.
 */
function notifyAddress(fallback: string): string {
  return process.env.EMAIL_NOTIFY_TO?.trim() || fallback;
}

function appBaseUrl(): string {
  return (process.env.APP_BASE_URL?.trim() || "http://localhost:3000").replace(/\/$/, "");
}

export type SendEmailInput = { to: string; subject: string; html: string };

export async function sendEmail(input: SendEmailInput): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  if (!emailConfigured()) return { ok: true, skipped: true };
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: fromAddress(), to: [input.to], subject: input.subject, html: input.html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 160)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fire-and-forget notification when a decision lands in the operator's queue.
 * Safe to call from sync code (`void notifyDecisionCreated(...)`).
 */
export async function notifyDecisionCreated(input: {
  userEmail: string;
  decisionId: string;
  question: string;
  recommendedOption?: string | null;
}): Promise<void> {
  if (!emailConfigured()) return;
  const link = `${appBaseUrl()}/decisions`;
  const result = await sendEmail({
    to: notifyAddress(input.userEmail),
    subject: `GovScout — decision waiting: ${input.question.slice(0, 80)}`,
    html: [
      `<p><strong>A decision is waiting in your queue.</strong></p>`,
      `<p>${escapeHtml(input.question)}</p>`,
      input.recommendedOption ? `<p>Recommended: <strong>${escapeHtml(input.recommendedOption)}</strong></p>` : "",
      `<p><a href="${link}">Open the decision queue →</a></p>`,
    ].join("\n"),
  });
  tryLogActivity({
    actor: "system",
    actionType: "email_notification",
    targetType: "decision",
    targetId: input.decisionId,
    summary: result.skipped
      ? "Decision email skipped (notifications not configured)"
      : result.ok
        ? `Decision email sent to ${input.userEmail}`
        : `Decision email FAILED: ${result.error}`,
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
