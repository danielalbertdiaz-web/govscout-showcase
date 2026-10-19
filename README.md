# GovScout — grant & contract pipeline workbench (showcase)

GovScout is a single-operator workbench for finding, scoring, and pursuing
government funding: federal/state/county grants, contract opportunities, and
underutilized funding pools. It pairs continuous automated discovery with an
AI-assisted drafting pipeline, so one person can run a pipeline that would
normally take a team.

> **Showcase copy of a private production system; client data and integrations
> removed.** All organizations, people, credentials, and dollar figures in the
> sample data are fictional. Source available for viewing; **all rights
> reserved** (no license is granted).

## What it does

- **Discovery scouts** — profile-driven scanners sweep SAM.gov, USAspending,
  Grants.gov-style sources, foundation registries (IRS BMF, ProPublica,
  Candid), opioid-settlement boards, and teaming notices, once per enabled
  vertical.
- **Scoring** — every item is fit-scored (0–100) against a business profile by
  an LLM with strict-JSON output, plus strategic and gate-based re-scoring.
- **Pipeline** — opportunities move through a bid board with dispositions,
  deadlines, compliance checklists, partner-fit analysis, and go/no-go memos.
- **Drafting** — a working-draft pane assembles proposal sections from a
  versioned boilerplate library (approval status, expiry, confidentiality and
  reuse controls), runs a multi-persona "council" review, budget engine, and a
  preflight gate (banned-name hard blocks, placeholder detection, flagged-term
  scan) before anything is exported to DOCX.
- **Multi-client panels** — client-scoped workspaces (`acme`, `riverside`,
  `northstar` in the sample set) with a validated client-id chokepoint so one
  tenant's rows can never leak into another's view.
- **Ops surface** — activity feed, decision queue, suggestion inbox, cron
  health monitor, usage/cost ledger, and an embedded assistant chat
  (optional OpenClaw gateway integration).

## Stack

- **Next.js 15** (App Router, React server components) + TypeScript
- **SQLite** via better-sqlite3 — 46 ordered migrations, no ORM
- **Anthropic API** for scoring, drafting, synthesis, and council review
- Node test runner (`node --test`) — 800+ unit tests, no mocking framework

## Run it locally

```bash
pnpm install
pnpm build
pnpm start          # or: pnpm dev
```

- First run creates `data/govscout.db` and applies all migrations.
- Set `ANTHROPIC_API_KEY` to enable scoring/drafting; the UI works without it.
- Auth is a simple single-user session: set `GOVSCOUT_AUTH_SECRET` and
  `GOVSCOUT_USERS` per `lib/auth-users.ts`, or read the login route for the
  dev defaults.

```bash
pnpm test           # full suite against a throwaway test DB
```

## Layout

| Path | What's there |
|---|---|
| `app/` | Next.js routes — bid board, drafts, scouts, pools, partners, panels |
| `lib/` | Domain logic — scoring, pipeline, drafting, council, migrations |
| `lib/migrations/` | Ordered SQL migrations (schema history doubles as docs) |
| `scripts/` | CLI runners — scanners, probes, smoke tests, maintenance |
| `tests/` | Node test-runner suites |
| `data/` | Fake sample seed data (DB itself is gitignored) |

---

Built by Daniel Diaz. Showcase copy — not accepting contributions.
