// Item 5.2 — per-notice actions on a teaming notice.
//
//   PUT  /api/teaming/[id]   body: { disposition }
//        → set triage disposition (new | pursuing | outreach_drafted | passed | teamed)
//   POST /api/teaming/[id]   body: { senderName?, capabilities?, primeContactName? }
//        → generate a 1.6-sanitized "we'd like to team with you" outreach DRAFT,
//          save it on the notice, and flip new/pursuing → outreach_drafted.
//
// NOTHING is sent — the draft is saved for the operator to review and send by hand.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getTeamingNotice,
  setTeamingNoticeDisposition,
  setTeamingNoticeOutreachDraft,
} from "@/lib/db";
import { isTeamingDisposition, type TeamingNoticeType } from "@/lib/teaming-sources/types";
import { composeTeamingOutreach } from "@/lib/teaming-outreach";

export const runtime = "nodejs";

type PutBody = { disposition?: string };
type PostBody = {
  senderName?: string;
  capabilities?: string[];
  primeContactName?: string | null;
};

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const body: PutBody = await req.json().catch(() => ({}));
  if (!isTeamingDisposition(body.disposition)) {
    return Response.json({ error: "invalid_disposition" }, { status: 400 });
  }

  const updated = setTeamingNoticeDisposition(id, session.email, body.disposition);
  if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ notice: updated });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const notice = getTeamingNotice(id, session.email);
  if (!notice) return Response.json({ error: "not_found" }, { status: 404 });

  const body: PostBody = await req.json().catch(() => ({}));
  const composed = composeTeamingOutreach(
    {
      noticeId: notice.noticeId,
      title: notice.title,
      agency: notice.agency,
      prime: notice.prime,
      noticeType: notice.noticeType as TeamingNoticeType,
      naics: notice.naics,
      description: notice.description,
      postedDate: notice.postedDate,
      responseDeadline: notice.responseDeadline,
      setAside: notice.setAside,
      url: notice.url,
      source: notice.source,
    },
    {
      senderName: body.senderName,
      capabilities: body.capabilities,
      primeContactName: body.primeContactName ?? null,
    },
  );

  const updated = setTeamingNoticeOutreachDraft(id, session.email, composed.markdown);
  return Response.json({
    ok: true,
    sent: false, // explicit: nothing is sent — this is a DRAFT
    draft: composed.markdown,
    redactions: composed.redactions,
    safe: composed.safe,
    notice: updated,
  });
}
