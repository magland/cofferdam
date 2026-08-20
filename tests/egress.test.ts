import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import type { Request } from 'express';
import { createEgress, egressFilePath } from '../src/egress';
import { makeBareRepo, makeVaultDir } from './helpers';

// Attribution and the startup migration: rows are keyed by the repository a
// name resolves to, a name resolving to none joins one unmatched row, and
// re-bucketing moves bytes without gaining or losing any.

function utcDay(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

test('startup re-buckets old names and dead names, preserving every total', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'x');
  fs.writeFileSync(path.join(root, 'redirects.json'), JSON.stringify({ repos: { 'demo/old': 'demo/x' } }));
  fs.writeFileSync(
    egressFilePath(root),
    JSON.stringify({
      version: 1,
      days: [
        {
          day: utcDay(),
          total: 194,
          keys: { 'demo/x': 100, 'demo/old': 50, 'demo/old:site': 9, 'no/thing': 25, '(vault)': 10 },
        },
        { day: utcDay(-1), total: 7, keys: { 'gone/name': 7 } },
      ],
    })
  );
  const egress = createEgress(root, () => 0);
  const snap = egress.snapshot();
  assert.equal(snap.total, 194);
  const row = (repo: string, site = false) => snap.rows.find((r) => r.repo === repo && r.site === site);
  assert.equal(row('demo/x')?.bytes, 150);
  assert.equal(row('demo/x', true)?.bytes, 9);
  assert.equal(row('(unmatched)')?.bytes, 25);
  assert.equal(row('(vault)')?.bytes, 10);
  assert.equal(row('demo/old'), undefined);
  assert.deepEqual(snap.history, [{ day: utcDay(-1), total: 7 }]);
  // The migration is written back, so the file itself now names only rows a
  // link can reach; yesterday's dead name joined the unmatched row with its
  // total intact.
  const onDisk = JSON.parse(fs.readFileSync(egressFilePath(root), 'utf8'));
  const today = onDisk.days.find((d: { day: string }) => d.day === utcDay());
  assert.deepEqual(today.keys, { 'demo/x': 150, 'demo/x:site': 9, '(unmatched)': 25, '(vault)': 10 });
  const yesterday = onDisk.days.find((d: { day: string }) => d.day === utcDay(-1));
  assert.deepEqual(yesterday.keys, { '(unmatched)': 7 });
});

test('a file whose keys all stand is left exactly as it is', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'x');
  const content = JSON.stringify({
    version: 1,
    days: [{ day: utcDay(), total: 15, keys: { 'demo/x': 10, '(vault)': 5 } }],
  });
  fs.writeFileSync(egressFilePath(root), content);
  createEgress(root, () => 0);
  assert.equal(fs.readFileSync(egressFilePath(root), 'utf8'), content);
});

test('over the cap, ordinary traffic is refused and the admin paths still answer', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'x');
  fs.writeFileSync(
    egressFilePath(root),
    JSON.stringify({ version: 1, days: [{ day: utcDay(), total: 5000, keys: { 'demo/x': 5000 } }] })
  );
  // About 1 KB of cap against 5 KB already sent.
  const egress = createEgress(root, () => 0.000001);
  const req = (p: string) => ({ path: p, hostname: 'vault.example' }) as unknown as Request;
  const refused = egress.allow(req('/demo/x'));
  assert.ok(refused);
  assert.ok(refused.retryAfter >= 1);
  assert.equal(egress.allow(req('/admin/egress')), null);
  assert.equal(egress.allow(req('/login')), null);
  assert.ok(egress.snapshot().overBudget);
});

test('with the cap disabled, nothing is refused', () => {
  const root = makeVaultDir();
  const egress = createEgress(root, () => 0);
  const req = { path: '/demo/x', hostname: 'vault.example' } as unknown as Request;
  assert.equal(egress.allow(req), null);
  assert.ok(!egress.snapshot().overBudget);
  assert.equal(egress.snapshot().capBytes, 0);
});
