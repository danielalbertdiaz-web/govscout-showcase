// Item 4.3 — LinkedIn lead importer (thin shell over the pure mapping core).
//
// Reads the version-controlled linkedin-connections index (via lib/connections),
// maps each connection to a contact, and inserts the ones not already present.
// Idempotent: re-running skips leads whose dedupe key already exists. De-dupes
// against the 4.1 partner roster is N/A here (partners != contacts), but we DO
// avoid duplicating the operator's existing contacts.
//
// NOTE ON VOLUME: the index reports metadata.total_connections (~1,881) but only
// `extracted_count` records are actually enriched in the file today. We import
// whatever is present and report both numbers so the gap is visible, never
// fabricating leads that don't exist.

import { loadConnections, readConnectionsMetadata } from "./connections";
import {
  createContact,
  existingContactDedupeKeys,
  type ContactRecord,
} from "./db";
import {
  linkedinConnectionToContactDraft,
  contactDedupeKey,
} from "./contact-outreach";

export type LinkedinImportResult = {
  /** Connections actually present (enriched) in the index. */
  available: number;
  /** metadata.total_connections — the *claimed* size of the network. */
  totalClaimed: number | null;
  imported: number;
  skipped: number;
  created: ContactRecord[];
};

export async function importLinkedinConnections(
  userEmail: string,
): Promise<LinkedinImportResult> {
  const connections = await loadConnections();
  const meta = await readConnectionsMetadata();

  const existing = existingContactDedupeKeys(userEmail, contactDedupeKey);
  const created: ContactRecord[] = [];
  let skipped = 0;

  for (const conn of connections) {
    const draft = linkedinConnectionToContactDraft(conn);
    const key = contactDedupeKey({
      linkedinUrl: draft.linkedinUrl,
      name: draft.name,
      agency: draft.agency,
    });
    if (existing.has(key)) {
      skipped += 1;
      continue;
    }
    existing.add(key); // guard against intra-batch dupes too
    const contact = createContact({
      userEmail,
      name: draft.name,
      title: draft.title,
      agency: draft.agency,
      linkedinUrl: draft.linkedinUrl,
      tags: draft.tags,
      notes: draft.notes,
      source: draft.source,
      raw: draft.raw,
    });
    created.push(contact);
  }

  return {
    available: connections.length,
    totalClaimed: typeof meta.total_connections === "number" ? meta.total_connections : null,
    imported: created.length,
    skipped,
    created,
  };
}
