import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  extractPartnerDraft,
  fetchUrlText,
  fileToText,
} from "@/lib/partner-ingest";

export const runtime = "nodejs";

// Turn a URL, pasted text, or an uploaded document into a draft partner the
// user can review and edit before saving. Does NOT persist — the caller POSTs
// the (possibly edited) result to /api/partners to save.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const contentType = req.headers.get("content-type") ?? "";

  try {
    let text = "";
    let sourceHint: string | undefined;

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "no file provided" }, { status: 400 });
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      text = await fileToText(buffer, file.type, file.name);
      sourceHint = file.name;
    } else {
      const body = (await req.json().catch(() => ({}))) as { url?: string; text?: string };
      if (body.url && body.url.trim()) {
        text = await fetchUrlText(body.url.trim());
        sourceHint = body.url.trim();
      } else if (body.text && body.text.trim()) {
        text = body.text;
        sourceHint = "pasted text";
      } else {
        return NextResponse.json({ error: "provide a url, text, or file" }, { status: 400 });
      }
    }

    const draft = await extractPartnerDraft(text, sourceHint);
    return NextResponse.json({ draft });
  } catch (err) {
    const message = err instanceof Error ? err.message : "ingestion failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
