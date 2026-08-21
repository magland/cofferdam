import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  displayName,
  isValidName,
  isValidUserName,
  reservedRepoSuffix,
} from '../src/scan';

test('names the UI owns, dotted traversals, and empty names are not valid', () => {
  assert.ok(isValidName('webapp'));
  assert.ok(isValidName('hello-numerics'));
  assert.ok(isValidName('.mochi'));
  assert.ok(!isValidName('admin'));
  assert.ok(!isValidName('about'));
  assert.ok(!isValidName('api'));
  assert.ok(!isValidName(''));
  assert.ok(!isValidName('..'));
  assert.ok(!isValidName('a..b'));
  assert.ok(!isValidName('has space'));
});

test('a username may not carry the leading dot a repository may', () => {
  assert.ok(isValidUserName('alice'));
  assert.ok(!isValidUserName('.mochi'));
});

test('a repository may not take a sibling suffix as its name, in any case', () => {
  assert.equal(reservedRepoSuffix('webapp.site'), '.site');
  assert.equal(reservedRepoSuffix('webapp.ISSUES'), '.issues');
  assert.equal(reservedRepoSuffix('webapp.lfs'), '.lfs');
  assert.equal(reservedRepoSuffix('webapp.git'), '.git');
  assert.equal(reservedRepoSuffix('website'), null);
});

test('displayName strips the optional .git and nothing else', () => {
  assert.equal(displayName('webapp.git'), 'webapp');
  assert.equal(displayName('webapp'), 'webapp');
  assert.equal(displayName('git.thing'), 'git.thing');
});
