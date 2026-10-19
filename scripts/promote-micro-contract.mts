// Promote micro_contracts staging rows onto the Bid Board by sol number —
// the human-authorised path out of a sweep kill (see lib/promote-micro-contract.ts
// for why this exists; born of the 2026-08 foreign-pop over-kill).
//
// All decision logic lives in the lib; this is argument parsing + reporting.
// Writes go through upsertFpOpportunity only. Tombstoned sols are REFUSED and
// exit nonzero — overriding a permanent delete is a deliberate human act, not
// an import side effect. Existing fp rows are reported and left alone.
//
// Usage:
//   node --import tsx scripts/promote-micro-contract.mts --sol <SOL> [--sol <SOL> ...]           # dry run (default)
//   node --import tsx scripts/promote-micro-contract.mts --sol <SOL> --dry-run                   # same, explicit
//   node --import tsx scripts/promote-micro-contract.mts --sol <SOL> --apply [--by <who>]        # write

import { promoteMicroContracts, type PromotionOutcome } from "../lib/promote-micro-contract";
import { deadlineText } from "../lib/deadline";

const USAGE =
  "usage: node --import tsx scripts/promote-micro-contract.mts --sol <SOL> [--sol <SOL> ...] [--dry-run | --apply] [--by <who>]";

const args = process.argv.slice(2);
const sols: string[] = [];
let apply = false;
let dryRunFlag = false;
let by = "operator";
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--sol") {
    const v = args[++i];
    if (!v || v.startsWith("--")) {
      console.error("--sol requires a value");
      console.error(USAGE);
      process.exit(1);
    }
    sols.push(v);
  } else if (a === "--by") {
    const v = args[++i];
    if (!v || v.startsWith("--")) {
      console.error("--by requires a value");
      console.error(USAGE);
      process.exit(1);
    }
    by = v;
  } else if (a === "--apply") apply = true;
  else if (a === "--dry-run") dryRunFlag = true;
  else {
    console.error(`unknown argument: ${a}`);
    console.error(USAGE);
    process.exit(1);
  }
}
if (apply && dryRunFlag) {
  console.error("--dry-run and --apply are mutually exclusive");
  process.exit(1);
}
if (sols.length === 0) {
  console.error("at least one --sol is required");
  console.error(USAGE);
  process.exit(1);
}

/** The owner rows are filed under. Single-tenant, so the one AUTH_USERS identity. */
function ownerEmail(): string {
  const explicit = process.env.GOVSCOUT_OWNER_EMAIL?.trim();
  if (explicit) return explicit;
  const raw = process.env.AUTH_USERS ?? "";
  const first = raw.split("|")[0]?.split(":")[0]?.trim().toLowerCase();
  if (first) return first;
  throw new Error("cannot determine owner: set GOVSCOUT_OWNER_EMAIL or AUTH_USERS");
}

const owner = ownerEmail();
const mode = apply ? "APPLY" : "DRY RUN (no writes)";
console.log(`micro-contract promoter — ${mode}`);
console.log(`  owner:     ${owner}`);
console.log(`  requested: ${sols.join(", ")}`);
console.log("");

const { outcomes, ok } = promoteMicroContracts(sols, {
  ownerEmail: owner,
  apply,
  authorisedBy: by,
  priority: "high",
});

function describe(o: PromotionOutcome): void {
  switch (o.kind) {
    case "missing":
      console.log(`  ${o.sol}  MISSING — no micro_contracts row matches this sol number.`);
      console.log("      Nothing was written for it. Check the sol number against the staging table.");
      break;
    case "tombstoned":
      console.log(`  ${o.sol}  REFUSED — TOMBSTONED (permanent delete, migration 036).`);
      console.log(
        `      Deleted ${new Date(o.tombstone.deletedAt).toISOString()} by ${o.tombstone.deletedBy}` +
          (o.tombstone.reason ? ` — reason: ${o.tombstone.reason}` : ""),
      );
      console.log(
        "      Nothing was written. Resurrection-by-import is disabled by design; if this",
      );
      console.log(
        "      promotion is really wanted, a human must explicitly clear the tombstone first.",
      );
      break;
    case "exists":
      console.log(`  ${o.sol}  EXISTS, SKIPPED — already on the Bid Board as "${o.existing.title.slice(0, 56)}"`);
      console.log(
        `      fp id ${o.existing.id}, status ${o.existing.status} — left alone (no field touched).`,
      );
      if (o.linkRepair) {
        console.log(
          `      micro->fp backlink was missing; ${apply ? "repaired" : "would repair"} (bookkeeping only).`,
        );
      }
      if (o.dispositionRepair) {
        console.log(
          `      staging row still carried the superseded sweep kill; ${apply ? "repaired" : "would repair"} ` +
            `disposition passed -> reviewing (clears the manufactured R-1 conflict; description untouched).`,
        );
      }
      break;
    case "promoted": {
      const verb = apply ? "PROMOTED" : "WOULD PROMOTE";
      console.log(`  ${o.sol}  ${verb} — "${o.micro.title.slice(0, 64)}"`);
      console.log(`      agency:    ${o.micro.agency ?? "(none)"}`);
      console.log(
        `      deadline:  ${o.micro.responseDeadline ?? "(none)"} (${deadlineText(o.micro.responseDeadline)})`,
      );
      console.log(
        `      status ${o.input.status}, tier ${o.input.tier}, source ${o.input.source}, ` +
          `set-aside ${o.micro.setAside ?? "(uncaptured -> unknown)"}`,
      );
      console.log(
        `      previously excluded: ${o.micro.description ?? "(no sweep verdict recorded)"} ` +
          `[disposition: ${o.micro.disposition}]`,
      );
      if (o.dispositionChange) {
        console.log(
          `      staging disposition: ${o.dispositionChange.from} -> ${o.dispositionChange.to} ` +
            `(sweep kill superseded by this promotion; description/audit trail untouched)`,
        );
      }
      if (o.deadlineMs != null && o.deadlineMs < Date.now()) {
        console.log("      WARNING: deadline is already past — promoting a dead solicitation?");
      }
      if (apply) {
        console.log(`      fp id ${o.oppId} created; backlink + provenance event written (authorised by ${by}).`);
      } else {
        console.log(`      would write: fp row + micro backlink + provenance event (authorised by ${by}).`);
      }
      break;
    }
  }
  console.log("");
}

for (const o of outcomes) describe(o);

const count = (k: PromotionOutcome["kind"]) => outcomes.filter((o) => o.kind === k).length;
console.log(
  `  summary: ${count("promoted")} ${apply ? "promoted" : "to promote"}, ${count("exists")} exist (skipped), ` +
    `${count("tombstoned")} refused (tombstoned), ${count("missing")} missing`,
);

// NOTE (2026-08-04): fp_opportunities has no first-class priority/flag field —
// the board surfaces by status column + deadline order. "High priority" is
// recorded in the provenance event only; a real flag needs a deliberate
// migration, not a bolt-on here.

if (!apply) {
  console.log("\ndry run complete — nothing was written. Re-run with --apply to promote.");
}
process.exit(ok ? 0 : 1);
