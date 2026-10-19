// P5 — CSV lead upload (pure core). Parses an exported lead list (LinkedIn,
// Apollo, spreadsheet — anything with a header row) into CreateContactInput
// rows. Tolerant header matching: "First Name"+"Last Name" or "Name",
// "Company"/"Organization"/"Agency", "Email"/"Email Address", etc.

import { parseCsvLine } from "./foundation-sources/irs-bmf";

export type CsvLead = {
  name: string;
  title: string | null;
  agency: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  notes: string | null;
};

const HEADER_ALIASES: Record<keyof Omit<CsvLead, "name">, string[]> = {
  title: ["title", "job title", "position", "role"],
  agency: ["company", "organization", "organisation", "agency", "org", "employer", "company name"],
  email: ["email", "email address", "e-mail", "work email"],
  phone: ["phone", "phone number", "mobile", "telephone"],
  linkedinUrl: ["linkedin", "linkedin url", "profile url", "url", "linkedin profile"],
  notes: ["notes", "note", "comments", "description"],
};

function findCol(headers: string[], aliases: string[]): number {
  return headers.findIndex((h) => aliases.includes(h));
}

export type CsvParseResult = {
  leads: CsvLead[];
  skippedRows: number;
  headersSeen: string[];
};

export function parseContactsCsv(text: string): CsvParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { leads: [], skippedRows: 0, headersSeen: [] };

  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const iName = findCol(headers, ["name", "full name", "contact name", "contact"]);
  const iFirst = findCol(headers, ["first name", "firstname", "first"]);
  const iLast = findCol(headers, ["last name", "lastname", "last", "surname"]);
  const cols = Object.fromEntries(
    (Object.keys(HEADER_ALIASES) as (keyof typeof HEADER_ALIASES)[]).map((k) => [
      k,
      findCol(headers, HEADER_ALIASES[k]),
    ]),
  ) as Record<keyof typeof HEADER_ALIASES, number>;

  const get = (row: string[], i: number): string | null => {
    if (i < 0) return null;
    const v = (row[i] ?? "").trim();
    return v.length ? v : null;
  };

  const leads: CsvLead[] = [];
  let skippedRows = 0;
  for (let r = 1; r < lines.length; r++) {
    const row = parseCsvLine(lines[r]);
    const name =
      get(row, iName) ?? [get(row, iFirst), get(row, iLast)].filter(Boolean).join(" ").trim();
    if (!name) {
      skippedRows++;
      continue;
    }
    leads.push({
      name,
      title: get(row, cols.title),
      agency: get(row, cols.agency),
      email: get(row, cols.email)?.toLowerCase() ?? null,
      phone: get(row, cols.phone),
      linkedinUrl: get(row, cols.linkedinUrl),
      notes: get(row, cols.notes),
    });
  }
  return { leads, skippedRows, headersSeen: headers };
}
