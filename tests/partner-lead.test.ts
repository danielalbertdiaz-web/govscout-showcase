// Unit tests for the partner-lead scorer (weighted blend used by the
// scouts→decisions "who should lead this draft?" recommendation).
//
//   node --import tsx --test tests/partner-lead.test.ts
//
// The scorer reads the partner index from PARTNER_CAPABILITIES_DIR, so we point
// it at a temp fixture dir. readIndex() caches for 5s, but each fixture here
// uses a fresh temp dir (distinct path → distinct first read), and we set the
// env before the first call in this file.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

let scorePartnersForLead: typeof import('../lib/partners')['scorePartnersForLead'];
let fixtureDir: string;

const INDEX = {
  partners: {
    // Strong capability overlap with the opportunity text below.
    alpha: {
      id: 'alpha',
      name: 'Alpha Grants',
      type: 'nonprofit',
      description: '',
      capabilities: ['grant writing', 'workforce development', 'data evaluation'],
      commission_structure: '15% referral',
      status: 'active',
    },
    // Preferred status + commission, but no capability overlap.
    bravo: {
      id: 'bravo',
      name: 'Bravo Partners',
      type: 'prime',
      description: '',
      capabilities: ['cybersecurity', 'cloud migration'],
      commission_structure: '20% referral',
      status: 'preferred',
    },
    // Inactive — must never appear in a default (all-candidate) ranking.
    charlie: {
      id: 'charlie',
      name: 'Charlie Co',
      type: 'sub',
      description: '',
      capabilities: ['grant writing'],
      commission_structure: '',
      status: 'inactive',
    },
  },
  capability_mapping: {},
  auto_match_rules: {},
  metadata: {},
};

const OPP_TEXT =
  'Seeking a partner for grant writing and workforce development with strong data evaluation.';

before(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'partner-lead-'));
  await fs.writeFile(path.join(fixtureDir, 'index.json'), JSON.stringify(INDEX), 'utf8');
  process.env.PARTNER_CAPABILITIES_DIR = fixtureDir;
  ({ scorePartnersForLead } = await import('../lib/partners'));
});

describe('scorePartnersForLead', () => {
  it('ranks the capability-overlapping partner first under default weights', async () => {
    const r = await scorePartnersForLead({ opportunityText: OPP_TEXT });
    assert.equal(r.best?.id, 'alpha');
    assert.equal(r.ranked[0].id, 'alpha');
    assert.ok(
      r.ranked[0].matchedCapabilities.length >= 3,
      `expected alpha to match its 3 capabilities, got ${r.ranked[0].matchedCapabilities.length}`,
    );
  });

  it('excludes inactive partners from the default candidate set', async () => {
    const r = await scorePartnersForLead({ opportunityText: OPP_TEXT });
    assert.ok(!r.ranked.some((p) => p.id === 'charlie'), 'inactive partner leaked into ranking');
  });

  it('honors an explicit candidate list', async () => {
    const r = await scorePartnersForLead({ opportunityText: OPP_TEXT, candidateIds: ['bravo'] });
    assert.equal(r.ranked.length, 1);
    assert.equal(r.best?.id, 'bravo');
  });

  it('lets capability weight dominate when set high', async () => {
    const r = await scorePartnersForLead({
      opportunityText: OPP_TEXT,
      weights: { capability: 1, commission: 0, status: 0 },
    });
    // alpha has overlap (score > 0); bravo has none (capabilityScore 0 → score 0).
    assert.equal(r.best?.id, 'alpha');
    const bravo = r.ranked.find((p) => p.id === 'bravo');
    assert.equal(bravo?.score, 0);
  });

  it('lets status weight flip the winner when capability is ignored', async () => {
    const r = await scorePartnersForLead({
      opportunityText: OPP_TEXT,
      weights: { capability: 0, commission: 0, status: 1 },
    });
    // bravo is "preferred" (1.0) vs alpha "active" (0.7).
    assert.equal(r.best?.id, 'bravo');
  });

  it('returns null best for an empty candidate set', async () => {
    const r = await scorePartnersForLead({ opportunityText: OPP_TEXT, candidateIds: ['nope'] });
    assert.equal(r.best, null);
    assert.equal(r.ranked.length, 0);
  });
});
