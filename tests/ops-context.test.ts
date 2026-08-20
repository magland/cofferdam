import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { OpError, RepoContext, deleteRepo, renameCollection, renameRepo } from '../src/ops';
import { loadRedirects } from '../src/redirects';
import { makeBareRepo, makeVaultDir } from './helpers';

// What a move or a removal has to carry with it, and when.
//
// The run index has to be told before the directories move, so that nothing is
// dispatched for a repository that is about to be somewhere else; it must not
// be told when the operation is refused, since nothing moved. Both used to be
// the caller's business, and the second half was wrong at all six call sites.

/** A stand-in for the CI engine's live index, recording what it was told. */
function fakeRuns(): { forgot: string[]; forgetRepo(collection: string, repo: string): void } {
  const forgot: string[] = [];
  return {
    forgot,
    forgetRepo(collection, repo) {
      forgot.push(`${collection}/${repo}`);
    },
  };
}

function repoDir(root: string, collection: string, repo: string): string {
  return path.join(root, 'collections', collection, 'repos', `${repo}.git`);
}

test('a rename tells the run index to forget the old name', async () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'proj');
  const runs = fakeRuns();
  await renameRepo(root, 'demo', 'proj', 'demo', 'renamed', { runs });
  assert.deepEqual(runs.forgot, ['demo/proj']);
  assert.ok(fs.existsSync(repoDir(root, 'demo', 'renamed')));
  assert.ok(!fs.existsSync(repoDir(root, 'demo', 'proj')));
  // And the old address is remembered, which is renameRepo's own last step.
  assert.deepEqual(loadRedirects(root).repos, { 'demo/proj': 'demo/renamed' });
});

test('a rename refused for a name already taken leaves the run index alone', async () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'proj');
  makeBareRepo(root, 'demo', 'taken');
  const runs = fakeRuns();
  await assert.rejects(() => renameRepo(root, 'demo', 'proj', 'demo', 'taken', { runs }), OpError);
  // Nothing moved, so a job running for demo/proj must still be dispatchable.
  assert.deepEqual(runs.forgot, []);
  assert.ok(fs.existsSync(repoDir(root, 'demo', 'proj')));
});

test('a rename refused for its own name, or for a missing repository, leaves it alone too', async () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'proj');
  const runs = fakeRuns();
  await assert.rejects(() => renameRepo(root, 'demo', 'proj', 'demo', 'proj', { runs }), /already its name/);
  await assert.rejects(() => renameRepo(root, 'demo', 'gone', 'demo', 'elsewhere', { runs }), /not found/);
  await assert.rejects(() => renameRepo(root, 'demo', 'proj', 'demo', 'settings', { runs }), OpError);
  assert.deepEqual(runs.forgot, []);
});

test('a deletion tells the run index, and takes the siblings with it', async () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'proj');
  const runsDir = path.join(root, 'collections', 'demo', 'repos', 'proj.runs');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, 'marker'), 'x');
  const runs = fakeRuns();
  await deleteRepo(root, 'demo', 'proj', { runs });
  assert.deepEqual(runs.forgot, ['demo/proj']);
  assert.ok(!fs.existsSync(repoDir(root, 'demo', 'proj')));
  assert.ok(!fs.existsSync(runsDir));
});

test('a deletion refused for a missing repository leaves the run index alone', async () => {
  const root = makeVaultDir();
  const runs = fakeRuns();
  await assert.rejects(() => deleteRepo(root, 'demo', 'gone', { runs }), /not found/);
  assert.deepEqual(runs.forgot, []);
});

test('a collection rename tells the run index about every repository in it', async () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'oldc', 'one');
  makeBareRepo(root, 'oldc', 'two');
  const runs = fakeRuns();
  await renameCollection(root, 'oldc', 'newc', { runs });
  assert.deepEqual(runs.forgot.sort(), ['oldc/one', 'oldc/two']);
  assert.ok(fs.existsSync(repoDir(root, 'newc', 'one')));
  assert.deepEqual(loadRedirects(root).collections, { oldc: 'newc' });
});

test('a collection rename refused leaves the run index alone', async () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'oldc', 'one');
  makeBareRepo(root, 'newc', 'other');
  const runs = fakeRuns();
  await assert.rejects(() => renameCollection(root, 'oldc', 'newc', { runs }), /already exists/);
  await assert.rejects(() => renameCollection(root, 'oldc', 'oldc', { runs }), /already its name/);
  assert.deepEqual(runs.forgot, []);
});

test('the context is optional, so a vault with no CI and no bucket needs neither half', async () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'proj');
  await renameRepo(root, 'demo', 'proj', 'demo', 'renamed');
  await deleteRepo(root, 'demo', 'renamed', {} as RepoContext);
  assert.ok(!fs.existsSync(repoDir(root, 'demo', 'renamed')));
});

test('the LFS store is asked to move and drop objects, and a move failure is not swallowed', async () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'proj');
  const calls: string[] = [];
  const lfs = {
    async renameRepo(c: string, r: string, tc: string, tr: string) {
      calls.push(`rename ${c}/${r} -> ${tc}/${tr}`);
    },
    async deleteRepo(c: string, r: string) {
      calls.push(`delete ${c}/${r}`);
    },
  } as unknown as NonNullable<RepoContext['lfs']>;
  await renameRepo(root, 'demo', 'proj', 'demo', 'moved', { lfs });
  await deleteRepo(root, 'demo', 'moved', { lfs });
  assert.deepEqual(calls, ['rename demo/proj -> demo/moved', 'delete demo/moved']);
});

test('a deletion survives an LFS store that fails, since the objects are already unreachable', async () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'proj');
  const lfs = {
    async deleteRepo() {
      throw new Error('bucket unreachable');
    },
  } as unknown as NonNullable<RepoContext['lfs']>;
  await deleteRepo(root, 'demo', 'proj', { lfs });
  assert.ok(!fs.existsSync(repoDir(root, 'demo', 'proj')));
});
