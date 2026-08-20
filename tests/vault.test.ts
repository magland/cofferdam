import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import {
  accountForEmail,
  addUserToken,
  AuthResult,
  authenticate,
  bootstrapVault,
  canAdmin,
  canAdminCollection,
  canCreateCollection,
  canPush,
  globMatch,
  hashToken,
  loadVault,
  mergeContributors,
  removeUser,
  revokeToken,
  setUserEmails,
  tokenId,
  TokenRecord,
  UserRecord,
  Vault,
} from '../src/vault';
import { makeVaultDir } from './helpers';

// ---- glob matching and the permission questions built on it ----

test('globMatch: * spans anything, ? one character, everything else is literal', () => {
  assert.ok(globMatch('*', 'demo/webapp'));
  assert.ok(globMatch('demo/*', 'demo/webapp'));
  assert.ok(!globMatch('demo/*', 'other/webapp'));
  assert.ok(globMatch('demo/?', 'demo/a'));
  assert.ok(!globMatch('demo/?', 'demo/ab'));
  // Regex metacharacters in a glob mean themselves.
  assert.ok(globMatch('a.b', 'a.b'));
  assert.ok(!globMatch('a.b', 'axb'));
  assert.ok(globMatch('a+b', 'a+b'));
});

function makeUser(scope: string[], admin: string[] = []): UserRecord {
  return { tokens: [], scope, admin };
}

function makeAuth(user: UserRecord, tokenScope?: string[]): AuthResult {
  const token: TokenRecord = { hash: 'unused' };
  if (tokenScope !== undefined) token.scope = tokenScope;
  return { username: 'someone', user, token };
}

test('canPush follows the user scope, narrowed by a token scope when one exists', () => {
  assert.ok(canPush(makeAuth(makeUser(['*'])), 'demo', 'webapp'));
  assert.ok(canPush(makeAuth(makeUser(['demo/*'])), 'demo', 'webapp'));
  assert.ok(!canPush(makeAuth(makeUser(['demo/*'])), 'other', 'webapp'));
  assert.ok(canPush(makeAuth(makeUser(['*']), ['demo/webapp']), 'demo', 'webapp'));
  assert.ok(!canPush(makeAuth(makeUser(['*']), ['demo/webapp']), 'demo', 'other'));
  // A token whose scope list is empty can push nowhere.
  assert.ok(!canPush(makeAuth(makeUser(['*']), []), 'demo', 'webapp'));
});

test('canCreateCollection matches the collection part of each glob', () => {
  assert.ok(canCreateCollection(makeAuth(makeUser(['demo/onerepo'])), 'demo'));
  assert.ok(!canCreateCollection(makeAuth(makeUser(['demo/onerepo'])), 'other'));
  assert.ok(canCreateCollection(makeAuth(makeUser(['*'])), 'anything'));
});

test('canAdmin needs an unrestricted token and cover for every glob asked about', () => {
  assert.ok(canAdmin(makeAuth(makeUser([], ['demo/*'])), ['demo/a', 'demo/b']));
  assert.ok(!canAdmin(makeAuth(makeUser([], ['demo/*'])), ['demo/a', 'other/b']));
  assert.ok(!canAdmin(makeAuth(makeUser([], [])), ['demo/a']));
  // A token-scoped session has no admin rights at all.
  assert.ok(!canAdmin(makeAuth(makeUser([], ['*']), ['*']), ['demo/a']));
});

test('canAdminCollection asks for a glob naming the collection even when it is empty', () => {
  assert.ok(canAdminCollection(makeAuth(makeUser([], ['demo/*'])), 'demo', []));
  assert.ok(!canAdminCollection(makeAuth(makeUser([], ['demo/*'])), 'other', []));
  assert.ok(canAdminCollection(makeAuth(makeUser([], ['*'])), 'demo', ['a', 'b']));
  assert.ok(!canAdminCollection(makeAuth(makeUser([], ['*']), ['*']), 'demo', []));
});

// ---- authentication ----

test('authenticate compares hashes and tolerates a malformed stored one', () => {
  const vault: Vault = {
    users: {
      alice: { tokens: [{ hash: 'not-hex-at-all' }, { hash: hashToken('secret'), id: 'ab12cd34' }], scope: ['*'], admin: [] },
    },
  };
  const hit = authenticate(vault, 'alice', 'secret');
  assert.ok(hit);
  assert.equal(hit.username, 'alice');
  assert.equal(hit.token.id, 'ab12cd34');
  assert.equal(authenticate(vault, 'alice', 'wrong'), null);
  assert.equal(authenticate(vault, 'nobody', 'secret'), null);
});

test('tokenId falls back to a hash prefix for a record from before ids existed', () => {
  assert.equal(tokenId({ hash: 'deadbeef00', id: 'given' }), 'given');
  assert.equal(tokenId({ hash: 'deadbeef00' }), 'deadbeef');
});

// ---- contributor identity ----

const identityVault: Vault = {
  users: {
    owner: { tokens: [], scope: ['*'], admin: ['*'], emails: ['Jeremy@Example.com'] },
    alice: { tokens: [], scope: ['*'], admin: [] },
  },
};

test('accountForEmail recognises the synthetic address by shape and listed emails by value', () => {
  assert.equal(accountForEmail(identityVault, 'owner@noreply.vault1.example.org'), 'owner');
  assert.equal(accountForEmail(identityVault, 'Alice@noreply.elsewhere'), 'alice');
  // The shape only counts for a user the vault actually has.
  assert.equal(accountForEmail(identityVault, 'bob@noreply.vault1.example.org'), null);
  assert.equal(accountForEmail(identityVault, 'jeremy@example.COM'), 'owner');
  assert.equal(accountForEmail(identityVault, 'stranger@example.com'), null);
});

test('mergeContributors folds one person into one row, fronted by the human identity', () => {
  const merged = mergeContributors(identityVault, [
    { name: 'owner', email: 'owner@noreply.vault1.example.org', commits: 3 },
    { name: 'Jeremy Magland', email: 'jeremy@example.com', commits: 5 },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].commits, 8);
  assert.equal(merged[0].name, 'Jeremy Magland');
  assert.equal(merged[0].email, 'jeremy@example.com');
  assert.equal(merged[0].account, 'owner');
});

test('a group holding only the synthetic identity keeps it', () => {
  const merged = mergeContributors(identityVault, [
    { name: 'alice', email: 'alice@noreply.vault1.example.org', commits: 2 },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].email, 'alice@noreply.vault1.example.org');
  assert.equal(merged[0].account, 'alice');
});

test('without a vault, grouping falls back to the email, case-insensitively', () => {
  const merged = mergeContributors(null, [
    { name: 'A', email: 'X@y.z', commits: 2 },
    { name: 'B', email: 'x@Y.z', commits: 1 },
    { name: 'C', email: 'other@y.z', commits: 4 },
  ]);
  assert.equal(merged.length, 2);
  // Sorted by commits, and the best-represented identity fronts each group.
  assert.equal(merged[0].name, 'C');
  assert.equal(merged[1].name, 'A');
  assert.equal(merged[1].commits, 3);
  assert.equal(merged[1].account, null);
});

test('a committer with no email at all is grouped by name', () => {
  const merged = mergeContributors(null, [
    { name: 'Anon', email: '', commits: 1 },
    { name: 'Anon', email: '', commits: 2 },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].commits, 3);
});

// ---- the file-backed operations, against a throwaway vault ----

test('bootstrapVault creates the owner once, and holds a preset token to shape', () => {
  const root = makeVaultDir();
  assert.throws(() => bootstrapVault(root, 'short'), /24 to 256/);
  assert.throws(() => bootstrapVault(root, '   '), /blank/);
  const preset = 'operator-supplied-token-24ch';
  const made = bootstrapVault(root, preset);
  assert.ok(made);
  assert.equal(made.username, 'owner');
  assert.equal(made.token, preset);
  assert.ok(made.preset);
  // A second bootstrap finds the vault and declines.
  assert.equal(bootstrapVault(root), null);
  const state = loadVault(root);
  assert.equal(state.status, 'ok');
  if (state.status === 'ok') {
    assert.ok(authenticate(state.vault, 'owner', preset));
  }
});

test('tokens are minted, revoked by id, and a revoked token stops authenticating', () => {
  const root = makeVaultDir();
  const { token, created, user } = addUserToken(root, 'alice', { scope: ['demo/*'] });
  assert.ok(created);
  assert.deepEqual(user.scope, ['demo/*']);
  // Creating the same user again with a scope is refused rather than merged.
  assert.throws(() => addUserToken(root, 'alice', { scope: ['*'] }), /already exists/);
  const id = user.tokens[0].id;
  assert.ok(id);
  const gone = revokeToken(root, 'alice', id);
  assert.deepEqual(gone, { revoked: true, remaining: 0 });
  assert.deepEqual(revokeToken(root, 'alice', id), { revoked: false, remaining: 0 });
  const state = loadVault(root);
  assert.equal(state.status, 'ok');
  if (state.status === 'ok') {
    assert.equal(authenticate(state.vault, 'alice', token), null);
  }
});

test('setUserEmails stores a list and an empty list clears the field', () => {
  const root = makeVaultDir();
  addUserToken(root, 'alice', { scope: ['*'] });
  setUserEmails(root, 'alice', ['a@example.com']);
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'vault.json'), 'utf8'));
  assert.deepEqual(raw.users.alice.emails, ['a@example.com']);
  setUserEmails(root, 'alice', []);
  const cleared = JSON.parse(fs.readFileSync(path.join(root, 'vault.json'), 'utf8'));
  assert.equal(cleared.users.alice.emails, undefined);
});

test('removeUser takes the user and answers whether there was one', () => {
  const root = makeVaultDir();
  addUserToken(root, 'alice', { scope: ['*'] });
  assert.ok(removeUser(root, 'alice'));
  assert.ok(!removeUser(root, 'alice'));
});

test('a vault.json that does not parse is an error state, not a crash', () => {
  const root = makeVaultDir();
  fs.writeFileSync(path.join(root, 'vault.json'), '{not json');
  const state = loadVault(root);
  assert.equal(state.status, 'error');
});

test('a username may not begin with a dot', () => {
  const root = makeVaultDir();
  assert.throws(() => addUserToken(root, '.hidden', { scope: ['*'] }), /invalid username/);
});
