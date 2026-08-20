import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import {
  forgetRepoRedirects,
  hasRedirects,
  loadRedirects,
  recordRepoRename,
  redirectTargetPath,
  resolveCollectionRedirect,
  resolveRepoRedirect,
} from '../src/redirects';
import { makeBareRepo, makeVaultDir, removeBareRepo } from './helpers';

function writeMap(root: string, map: { repos?: Record<string, string>; collections?: Record<string, string> }): void {
  fs.writeFileSync(path.join(root, 'redirects.json'), JSON.stringify(map));
}

test('a vault that has never renamed anything has no redirects and resolves nothing', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'webapp');
  assert.ok(!hasRedirects(root));
  assert.equal(resolveRepoRedirect(root, 'demo', 'webapp'), null);
  assert.equal(resolveRepoRedirect(root, 'demo', 'nothing'), null);
});

test('a renamed repository resolves from its old name, and chains resolve hop by hop', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'c');
  writeMap(root, { repos: { 'demo/a': 'demo/b', 'demo/b': 'demo/c' } });
  assert.deepEqual(resolveRepoRedirect(root, 'demo', 'a'), { collection: 'demo', repo: 'c' });
  assert.deepEqual(resolveRepoRedirect(root, 'demo', 'b'), { collection: 'demo', repo: 'c' });
});

test('a hand-edited cycle terminates instead of hanging', () => {
  const root = makeVaultDir();
  writeMap(root, { repos: { 'demo/a': 'demo/b', 'demo/b': 'demo/a' } });
  assert.equal(resolveRepoRedirect(root, 'demo', 'a'), null);
});

test('a redirect goes quiet the moment the old name is in use again', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'old');
  makeBareRepo(root, 'demo', 'new');
  writeMap(root, { repos: { 'demo/old': 'demo/new' } });
  assert.equal(resolveRepoRedirect(root, 'demo', 'old'), null);
});

test('a collection rename carries its repositories, and a repo entry is preferred over it', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'newc', 'webapp');
  makeBareRepo(root, 'other', 'moved');
  writeMap(root, {
    repos: { 'oldc/special': 'other/moved' },
    collections: { oldc: 'newc' },
  });
  assert.deepEqual(resolveRepoRedirect(root, 'oldc', 'webapp'), { collection: 'newc', repo: 'webapp' });
  assert.deepEqual(resolveRepoRedirect(root, 'oldc', 'special'), { collection: 'other', repo: 'moved' });
  assert.equal(resolveCollectionRedirect(root, 'oldc'), 'newc');
  assert.equal(resolveCollectionRedirect(root, 'newc'), null);
});

test('recordRepoRename remembers the move, and renaming back leaves only the reverse entry', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'first');
  const reposDir = path.join(root, 'collections', 'demo', 'repos');
  fs.renameSync(path.join(reposDir, 'first.git'), path.join(reposDir, 'second.git'));
  recordRepoRename(root, 'demo', 'first', 'demo', 'second');
  assert.deepEqual(resolveRepoRedirect(root, 'demo', 'first'), { collection: 'demo', repo: 'second' });
  fs.renameSync(path.join(reposDir, 'second.git'), path.join(reposDir, 'first.git'));
  recordRepoRename(root, 'demo', 'second', 'demo', 'first');
  // The entry out of the reoccupied name is pruned; the reverse one stands.
  assert.deepEqual(loadRedirects(root).repos, { 'demo/second': 'demo/first' });
  assert.deepEqual(resolveRepoRedirect(root, 'demo', 'second'), { collection: 'demo', repo: 'first' });
});

test('deleting a repository forgets every redirect that led to it', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'final');
  writeMap(root, { repos: { 'demo/first': 'demo/second', 'demo/second': 'demo/final' } });
  removeBareRepo(root, 'demo', 'final');
  forgetRepoRedirects(root, 'demo', 'final');
  // Dropping the entry into the deleted name strands the chain behind it, and
  // pruning takes the stranded entry with it: the file empties and is removed.
  assert.ok(!fs.existsSync(path.join(root, 'redirects.json')));
  assert.ok(!hasRedirects(root));
});

test('redirectTargetPath rewrites the name and carries the tail untouched', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'renamed');
  makeBareRepo(root, 'newc', 'webapp');
  writeMap(root, { repos: { 'demo/proj': 'demo/renamed' }, collections: { oldc: 'newc' } });
  assert.equal(
    redirectTargetPath(root, '/demo/proj/blob/main/README.md'),
    '/demo/renamed/blob/main/README.md'
  );
  // The .git spelling is kept as the request wrote it, for clones.
  assert.equal(redirectTargetPath(root, '/demo/proj.git/info/refs'), '/demo/renamed.git/info/refs');
  assert.equal(redirectTargetPath(root, '/api/repos/demo/proj/contents'), '/api/repos/demo/renamed/contents');
  assert.equal(redirectTargetPath(root, '/oldc'), '/newc');
  assert.equal(redirectTargetPath(root, '/oldc/webapp/issues'), '/newc/webapp/issues');
  assert.equal(redirectTargetPath(root, '/api/collections/oldc'), '/api/collections/newc');
  // Addresses that answer for themselves, or lead nowhere, are left alone.
  assert.equal(redirectTargetPath(root, '/demo/renamed'), null);
  assert.equal(redirectTargetPath(root, '/nosuch/thing'), null);
  assert.equal(redirectTargetPath(root, '/'), null);
});

test('a redirects.json that does not parse reads as no redirects rather than a crash', () => {
  const root = makeVaultDir();
  fs.writeFileSync(path.join(root, 'redirects.json'), '{broken');
  const map = loadRedirects(root);
  assert.deepEqual(map, { repos: {}, collections: {} });
});
