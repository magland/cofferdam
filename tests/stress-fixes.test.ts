import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidNewRefName, isValidNewRepoPath, isValidRefName, isValidRepoPath } from '../src/git';
import { MAX_NAME_LENGTH, collectionCaseClash, isValidUserName, repoCaseClash } from '../src/scan';
import { MAX_DESCRIPTION_LENGTH, OpError, createCollection, renameCollection, setDescription } from '../src/ops';
import { DuplicatePullError, createPull } from '../src/pulls';
import { makeBareRepo, makeVaultDir } from './helpers';

// The rules added after the August 2026 stress test: what may become a new
// ref, path, or name is stricter than what may be looked up, so a vault that
// already holds an awkward name keeps serving it while nobody creates another.

test('a new ref may not be a pseudo-ref, a pasted full ref, or too long for a loose-ref file', () => {
  assert.ok(isValidNewRefName('feature-1'));
  assert.ok(isValidNewRefName('release/1.0'));
  assert.ok(!isValidNewRefName('HEAD'));
  assert.ok(!isValidNewRefName('FETCH_HEAD'));
  assert.ok(!isValidNewRefName('MERGE_HEAD'));
  assert.ok(!isValidNewRefName('refs/heads/x'));
  assert.ok(!isValidNewRefName('refs'));
  assert.ok(!isValidNewRefName('-option'));
  assert.ok(!isValidNewRefName('L'.repeat(300)));
  // The permissive lookup validator still takes what the strict one refuses,
  // so a ref that somehow exists can still be resolved.
  assert.ok(isValidRefName('HEAD'));
  assert.ok(isValidRefName('L'.repeat(300)));
});

test('a new path may not enter .git or carry a backslash; reading stays permissive', () => {
  assert.ok(isValidNewRepoPath('.gitignore'));
  assert.ok(isValidNewRepoPath('.githidden/x.txt'));
  assert.ok(!isValidNewRepoPath('.git'));
  assert.ok(!isValidNewRepoPath('.git/config'));
  assert.ok(!isValidNewRepoPath('.GIT/config'));
  assert.ok(!isValidNewRepoPath('sub/.git/hooks/x'));
  assert.ok(!isValidNewRepoPath('a\\b.txt'));
  assert.ok(!isValidNewRepoPath('/etc/pwned.txt'));
  assert.ok(isValidRepoPath('a\\b.txt'));
  assert.ok(isValidRepoPath('.git/config'));
});

test('a name past MAX_NAME_LENGTH or ending in a dot is refused where it comes into being', () => {
  const root = makeVaultDir();
  assert.throws(() => createCollection(root, 'q'.repeat(MAX_NAME_LENGTH + 1)), /at most/);
  assert.throws(() => createCollection(root, 'trailing.'), /may not end with a dot/);
  createCollection(root, 'q'.repeat(MAX_NAME_LENGTH));
  assert.ok(!isValidUserName('u'.repeat(MAX_NAME_LENGTH + 1)));
});

test('names differing only in letter case are refused, but a case-only rename of itself is not', () => {
  const root = makeVaultDir();
  createCollection(root, 'baseline');
  assert.throws(() => createCollection(root, 'BASELINE'), (e: unknown) => {
    assert.ok(e instanceof OpError);
    assert.equal(e.kind, 'exists');
    assert.match(e.message, /baseline/);
    return true;
  });
  makeBareRepo(root, 'baseline', 'proj');
  assert.equal(repoCaseClash(root, 'baseline', 'PROJ'), 'proj');
  assert.equal(repoCaseClash(root, 'baseline', 'proj'), null);
  assert.equal(collectionCaseClash(root, 'Baseline'), 'baseline');
  // Renaming a collection to a case-variant of its own name collides with
  // nothing but itself, which is allowed.
  return renameCollection(root, 'baseline', 'Baseline');
});

test('a description past MAX_DESCRIPTION_LENGTH is refused rather than written', () => {
  const root = makeVaultDir();
  const dir = makeBareRepo(root, 'demo', 'proj');
  setDescription(dir, 'a'.repeat(MAX_DESCRIPTION_LENGTH));
  assert.throws(() => setDescription(dir, 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1)), /at most/);
});

test('a second open pull request for the same base and head names the first instead of existing', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'proj');
  const input = { title: 'Test PR', body: '', author: 'alice', base: 'main', head: 'feature-1' };
  const first = createPull(root, 'demo', 'proj', input);
  assert.throws(() => createPull(root, 'demo', 'proj', { ...input, title: 'Test PR again' }), (e: unknown) => {
    assert.ok(e instanceof DuplicatePullError);
    assert.equal(e.number, first.number);
    return true;
  });
  // A different head is a different proposal, and goes through.
  createPull(root, 'demo', 'proj', { ...input, head: 'feature-2' });
});
