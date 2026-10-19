import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { listPartners, upsertPartner, type UpsertPartnerInput } from "@/lib/partners";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const partners = await listPartners();
  return NextResponse.json({ partners });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: Partial<UpsertPartnerInput>;
  try {
    body = (await req.json()) as Partial<UpsertPartnerInput>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.name || !body.name.trim()) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  try {
    const partner = await upsertPartner({
      id: body.id,
      name: body.name,
      type: body.type,
      description: body.description,
      capabilities: Array.isArray(body.capabilities) ? body.capabilities : undefined,
      commission_structure: body.commission_structure,
      integration_notes: body.integration_notes,
      contact: body.contact,
      status: body.status,
      body: body.body ?? null,
    });
    return NextResponse.json({ partner }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to save partner";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
