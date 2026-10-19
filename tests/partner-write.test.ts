// Round-trip tests for the partner write layer (upsertPartner). Points the
// loader at a temp fixture dir via PARTNER_CAPABILITIES_DIR. Node runs each
// test file in its own process, so this env + module cache is isolated from
// the other partner tests.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

let partners: typeof import('../lib/partners');
let dir: string;

const SEED = {
  partners: {
    existing: {
      id: 'existing',
      name: 'Existing Partner',
      type: 'prime',
      description: 'seeded',
      capabilities: ['cybersecurity'],
      commission_structure: '10%',
      integration_notes: '',
      contact: '',
      status: 'active',
    },
  },
  capability_mapping: { grant_writing: ['existing'] },
  auto_match_rules: { keywords: { grant: ['existing'] } },
  metadata: { version: 'test' },
};

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'partner-write-'));
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(SEED), 'utf8');
  process.env.PARTNER_CAPABILITIES_DIR = dir;
  partners = await import('../lib/partners');
});

describe('upsertPartner', () => {
  it('creates a new partner with a slug id and active default', async () => {
    const p = await partners.upsertPartner({ name: 'Bright Futures Coalition' });
    assert.equal(p.id, 'bright-futures-coalition');
    assert.equal(p.status, 'active');
    const loaded = await partners.loadPartners([p.id]);
    assert.equal(loaded[0]?.name, 'Bright Futures Coalition');
  });

  it('suffixes the id to avoid clobbering an existing same-name partner', async () => {
    const a = await partners.upsertPartner({ name: 'Acme Services' });
    const b = await partners.upsertPartner({ name: 'Acme Services' });
    assert.equal(a.id, 'acme-services');
    assert.equal(b.id, 'acme-services-2');
  });

  it('updates in place when an explicit id is passed', async () => {
    await partners.upsertPartner({ id: 'existing', name: 'Existing Partner', status: 'preferred' });
    const loaded = await partners.loadPartners(['existing']);
    assert.equal(loaded[0]?.status, 'preferred');
    // Untouched fields survive the merge.
    assert.deepEqual(loaded[0]?.capabilities, ['cybersecurity']);
  });

  it('writes the markdown body to <id>.md', async () => {
    const p = await partners.upsertPartner({
      name: 'Profile Co',
      body: '# Profile Co\n\nReference prose.',
    });
    const loaded = await partners.loadPartners([p.id]);
    assert.match(loaded[0]?.body ?? '', /Reference prose/);
  });

  it('preserves capability_mapping and auto_match_rules in the index', async () => {
    await partners.upsertPartner({ name: 'Another Org' });
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'));
    assert.deepEqual(raw.capability_mapping, SEED.capability_mapping);
    assert.deepEqual(raw.auto_match_rules, SEED.auto_match_rules);
    assert.equal(raw.metadata.version, 'test');
  });

  it('rejects an empty name', async () => {
    await assert.rejects(() => partners.upsertPartner({ name: '   ' }), /name required/);
  });

  // P0 regression: a caller/model-supplied id is also a filename, so a crafted
  // id must never escape the partner directory. Reject before any write.
  it('rejects a path-traversal id and writes nothing outside the dir', async () => {
    for (const badId of ['../evil', 'foo/bar', 'a/../../etc/passwd', '.', '..', 'UPPER', 'has space']) {
      await assert.rejects(
        () => partners.upsertPartner({ id: badId, name: 'Malicious', body: 'x' }),
        /invalid partner id/,
        `expected "${badId}" to be rejected`,
      );
    }
    // Nothing leaked above the fixture dir (e.g. a stray evil.md).
    const parent = path.dirname(dir);
    const leaked = await fs.readdir(parent).then((names) => names.filter((n) => /evil|passwd/.test(n)));
    assert.deepEqual(leaked, []);
  });

  // P2 regression: two concurrent saves must both persist (no lost update).
  // Without the write mutex the read-modify-write of the shared index races and
  // one of these would be silently dropped.
  it('serializes concurrent writes without losing updates', async () => {
    await Promise.all([
      partners.upsertPartner({ name: 'Concurrent Alpha' }),
      partners.upsertPartner({ name: 'Concurrent Beta' }),
      partners.upsertPartner({ name: 'Concurrent Gamma' }),
    ]);
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'));
    const names = Object.values(raw.partners).map((p) => (p as { name: string }).name);
    assert.ok(names.includes('Concurrent Alpha'), 'Alpha persisted');
    assert.ok(names.includes('Concurrent Beta'), 'Beta persisted');
    assert.ok(names.includes('Concurrent Gamma'), 'Gamma persisted');
  });
});
