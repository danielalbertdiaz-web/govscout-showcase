// POST /api/contacts/[id]/intro — Item 4.3
// Generate (and persist) a cold-intro DRAFT for a contact. Optionally anchored
// to a saved opportunity (body.opportunityId). The draft is sanitized (1.6) and
// stored on the contact for review. NOTHING IS SENT.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getContact, setContactIntroDraft, getSavedOpportunity } from "@/lib/db";
import { composeColdIntro } from "@/lib/contact-outreach";

export const runtime = "nodejs";

type Body = { opportunityId?: string; senderName?: string };

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const contact = getContact(id, session.email);
  if (!contact) return Response.json({ error: "not_found" }, { status: 404 });

  const body: Body = await req.json().catch(() => ({}));

  let opportunityTitle: string | null = null;
  let opportunitySummary: string | null = null;
  if (body.opportunityId) {
    const opp = getSavedOpportunity(body.opportunityId, session.email);
    if (opp) {
      opportunityTitle = opp.title;
      opportunitySummary = opp.summary;
    }
  }

  const intro = composeColdIntro(
    {
      name: contact.name,
      title: contact.title,
      agency: contact.agency,
      tags: contact.tags,
    },
    { opportunityTitle, opportunitySummary, senderName: body.senderName },
  );

  const updated = setContactIntroDraft(id, session.email, intro.markdown);
  return Response.json({
    saved: true,
    sent: false, // explicit: this system never auto-sends
    contact: updated,
    markdown: intro.markdown,
    redactions: intro.redactions,
    safe: intro.safe,
  });
}
