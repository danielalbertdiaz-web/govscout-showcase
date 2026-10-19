import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { extractText, extractStructured, isSupportedType, nofoToOpportunityText } from "@/lib/extract";
import { saveNofo } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "invalid_form" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "file_missing" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: "file_too_large", maxBytes: MAX_BYTES }, { status: 413 });
  }
  if (!isSupportedType(file.type, file.name)) {
    return Response.json({ error: "unsupported_type", got: file.type || file.name }, { status: 415 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  let extracted;
  try {
    extracted = await extractText(buf, file.type, file.name);
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

  let nofoId: string | null = null;
  try {
    const saved = saveNofo({
      userEmail: session.email,
      structured,
      rawText: extracted.text,
      originalFilename: file.name,
    });
    nofoId = saved.id;
  } catch (err) {
    console.error("[nofo/upload] persist failed", err);
  }

  const opportunity = nofoToOpportunityText(extracted.text, structured);
  return Response.json({
    filename: file.name,
    sourceType: extracted.sourceType,
    pages: extracted.pages,
    chars: extracted.text.length,
    structured,
    opportunity,
    nofoId,
  });
}
