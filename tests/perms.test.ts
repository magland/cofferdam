import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { migratePermissions } from '../src/migrate';
import {
  addCollectionOwner,
  atLeast,
  canAdminCollection,
  canAdminRunnerGlobs,
  canCreateCollection,
  canCreateRepo,
  collectionOwners,
  isCollectionOwner,
  isSiteAdmin,
  removeCollaborator,
  removeCollectionOwner,
  removeUserGrants,
  repoAccess,
  repoIsPrivate,
  repoRenameBlocker,
  repoRole,
  setCollaborator,
  setRepoPrivate,
} from '../src/perms';
import { AuthResult, TokenRecord, UserRecord, hashToken, loadVault } from '../src/vault';
import { makeBareRepo, makeVaultDir } from './helpers';

// Who may do what: roles on repositories, owners on collections, the
// site-admin bit, and the migration that translates glob scopes into them.

function makeAuth(username: string, opts: { siteAdmin?: boolean; tokenScope?: string[] } = {}): AuthResult {
  const user: UserRecord = { tokens: [], ...(opts.siteAdmin ? { siteAdmin: true } : {}) };
  const token: TokenRecord = { hash: 'unused' };
  if (opts.tokenScope !== undefined) token.scope = opts.tokenScope;
  return { username, user, token };
}

function ref(root: string, collection: string, name: string) {
  return { collection, name, dir: path.join(root, 'collections', collection, 'repos', `${name}.git`) };
}

// ---- the per-repository access file ----

test('a repository with no access file is public with no collaborators', () => {
  const root = makeVaultDir();
  const dir = makeBareRepo(root, 'demo', 'webapp');
  assert.deepEqual(repoAccess(dir), { private: false, collaborators: {} });
  assert.ok(!repoIsPrivate(dir));
});

test('setRepoPrivate and collaborators round-trip through cofferdam.json', () => {
  const root = makeVaultDir();
  const dir = makeBareRepo(root, 'demo', 'webapp');
  setRepoPrivate(dir, true);
  setCollaborator(dir, 'bob', 'write');
  setCollaborator(dir, 'carol', 'read');
  assert.ok(repoIsPrivate(dir));
  assert.deepEqual(repoAccess(dir).collaborators, { bob: 'write', carol: 'read' });
  // Adding again replaces the role rather than stacking entries.
  setCollaborator(dir, 'bob', 'admin');
  assert.equal(repoAccess(dir).collaborators.bob, 'admin');
  removeCollaborator(dir, 'carol');
  assert.deepEqual(Object.keys(repoAccess(dir).collaborators), ['bob']);
  setRepoPrivate(dir, false);
  assert.ok(!repoIsPrivate(dir));
  // The file is ordinary JSON in the bare repository.
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'cofferdam.json'), 'utf8'));
  assert.equal(raw.collaborators.bob, 'admin');
});

test('an unreadable access file fails closed: private, nobody in', () => {
  const root = makeVaultDir();
  const dir = makeBareRepo(root, 'demo', 'webapp');
  fs.writeFileSync(path.join(dir, 'cofferdam.json'), '{broken');
  assert.deepEqual(repoAccess(dir), { private: true, collaborators: {} });
});

test('a malformed role in the file is dropped rather than trusted', () => {
  const root = makeVaultDir();
  const dir = makeBareRepo(root, 'demo', 'webapp');
  fs.writeFileSync(path.join(dir, 'cofferdam.json'), JSON.stringify({ collaborators: { bob: 'owner' } }));
  assert.deepEqual(repoAccess(dir).collaborators, {});
});

// ---- collection owners ----

test('ownership is the explicit list plus bearing the collection name', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'webapp');
  assert.ok(isCollectionOwner(root, 'demo', 'demo'));
  assert.ok(!isCollectionOwner(root, 'demo', 'bob'));
  addCollectionOwner(root, 'demo', 'bob');
  assert.ok(isCollectionOwner(root, 'demo', 'bob'));
  assert.deepEqual(collectionOwners(root, 'demo'), ['bob']);
  // Adding again is a no-op; the implicit owner is never listed.
  addCollectionOwner(root, 'demo', 'bob');
  assert.deepEqual(collectionOwners(root, 'demo'), ['bob']);
  removeCollectionOwner(root, 'demo', 'bob');
  assert.deepEqual(collectionOwners(root, 'demo'), []);
});

// ---- repoRole ----

test('a public repository reads anonymously; roles stack above that', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'webapp');
  const repo = ref(root, 'demo', 'webapp');
  assert.equal(repoRole(root, null, repo), 'read');
  assert.equal(repoRole(root, makeAuth('stranger'), repo), 'read');
  assert.equal(repoRole(root, makeAuth('demo'), repo), 'admin'); // implicit owner
  assert.equal(repoRole(root, makeAuth('root', { siteAdmin: true }), repo), 'admin');
  setCollaborator(repo.dir, 'bob', 'write');
  assert.equal(repoRole(root, makeAuth('bob'), repo), 'write');
});

test('a private repository is null to everyone without a role there', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'webapp');
  const repo = ref(root, 'demo', 'webapp');
  setRepoPrivate(repo.dir, true);
  setCollaborator(repo.dir, 'carol', 'read');
  addCollectionOwner(root, 'demo', 'olive');
  assert.equal(repoRole(root, null, repo), null);
  assert.equal(repoRole(root, makeAuth('stranger'), repo), null);
  assert.equal(repoRole(root, makeAuth('carol'), repo), 'read');
  assert.equal(repoRole(root, makeAuth('olive'), repo), 'admin');
  assert.equal(repoRole(root, makeAuth('demo'), repo), 'admin');
  assert.equal(repoRole(root, makeAuth('root', { siteAdmin: true }), repo), 'admin');
});

test('a scoped token acts only inside its globs and never administers', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'webapp');
  makeBareRepo(root, 'demo', 'other');
  const webapp = ref(root, 'demo', 'webapp');
  const other = ref(root, 'demo', 'other');
  // The owner's scoped token caps at write inside the glob...
  assert.equal(repoRole(root, makeAuth('demo', { tokenScope: ['demo/webapp'] }), webapp), 'write');
  // ...and grants nothing beyond anonymous outside it.
  assert.equal(repoRole(root, makeAuth('demo', { tokenScope: ['demo/webapp'] }), other), 'read');
  setRepoPrivate(other.dir, true);
  assert.equal(repoRole(root, makeAuth('demo', { tokenScope: ['demo/webapp'] }), other), null);
  // A read collaborator through a matching scoped token keeps read.
  setRepoPrivate(webapp.dir, true);
  setCollaborator(webapp.dir, 'carol', 'read');
  assert.equal(repoRole(root, makeAuth('carol', { tokenScope: ['demo/*'] }), webapp), 'read');
  // An empty scope list reaches nothing.
  assert.equal(repoRole(root, makeAuth('demo', { tokenScope: [] }), webapp), null);
});

test('atLeast orders read < write < admin with null below all', () => {
  assert.ok(atLeast('admin', 'read'));
  assert.ok(atLeast('write', 'write'));
  assert.ok(!atLeast('read', 'write'));
  assert.ok(!atLeast(null, 'read'));
});

// ---- creation and collection administration ----

test('canCreateRepo: owners in their collections, site admins anywhere, tokens narrowed', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'webapp');
  addCollectionOwner(root, 'demo', 'bob');
  assert.ok(canCreateRepo(root, makeAuth('demo'), 'demo', 'x'));
  assert.ok(canCreateRepo(root, makeAuth('bob'), 'demo', 'x'));
  assert.ok(!canCreateRepo(root, makeAuth('stranger'), 'demo', 'x'));
  assert.ok(canCreateRepo(root, makeAuth('root', { siteAdmin: true }), 'anywhere', 'x'));
  assert.ok(canCreateRepo(root, makeAuth('demo', { tokenScope: ['demo/x'] }), 'demo', 'x'));
  assert.ok(!canCreateRepo(root, makeAuth('demo', { tokenScope: ['demo/y'] }), 'demo', 'x'));
});

test('canCreateCollection: your own namespace, or a site admin', () => {
  const root = makeVaultDir();
  assert.ok(canCreateCollection(root, makeAuth('alice'), 'alice'));
  assert.ok(!canCreateCollection(root, makeAuth('alice'), 'team'));
  assert.ok(canCreateCollection(root, makeAuth('root', { siteAdmin: true }), 'team'));
  // A scoped token needs a glob whose collection part reaches the namespace,
  // and a scoped site admin creates nothing.
  assert.ok(canCreateCollection(root, makeAuth('alice', { tokenScope: ['alice/*'] }), 'alice'));
  assert.ok(!canCreateCollection(root, makeAuth('alice', { tokenScope: ['other/*'] }), 'alice'));
  assert.ok(!canCreateCollection(root, makeAuth('root', { siteAdmin: true, tokenScope: ['*'] }), 'team'));
});

test('canAdminCollection: owners and site admins, never a scoped token', () => {
  const root = makeVaultDir();
  addCollectionOwner(root, 'team', 'bob');
  assert.ok(canAdminCollection(root, makeAuth('team'), 'team'));
  assert.ok(canAdminCollection(root, makeAuth('bob'), 'team'));
  assert.ok(!canAdminCollection(root, makeAuth('stranger'), 'team'));
  assert.ok(canAdminCollection(root, makeAuth('root', { siteAdmin: true }), 'team'));
  assert.ok(!canAdminCollection(root, makeAuth('bob', { tokenScope: ['*'] }), 'team'));
});

test('isSiteAdmin requires the bit and an unrestricted token', () => {
  assert.ok(isSiteAdmin(makeAuth('root', { siteAdmin: true })));
  assert.ok(!isSiteAdmin(makeAuth('root', { siteAdmin: true, tokenScope: ['*'] })));
  assert.ok(!isSiteAdmin(makeAuth('alice')));
  assert.ok(!isSiteAdmin(null));
});

// ---- the composite rules ----

test('a rename in place takes the admin role; a move also takes creation over there', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'webapp');
  const repo = ref(root, 'demo', 'webapp');
  const owner = makeAuth('demo');
  assert.equal(repoRenameBlocker(root, owner, repo, 'demo', 'renamed'), null);
  assert.equal(
    repoRenameBlocker(root, owner, repo, 'elsewhere', 'webapp'),
    'permission to create repositories in elsewhere'
  );
  setCollaborator(repo.dir, 'bob', 'write');
  assert.equal(repoRenameBlocker(root, makeAuth('bob'), repo, 'demo', 'renamed'), 'the admin role on demo/webapp');
  // An admin collaborator renames in place, and moves into their own namespace.
  setCollaborator(repo.dir, 'bob', 'admin');
  assert.equal(repoRenameBlocker(root, makeAuth('bob'), repo, 'demo', 'renamed'), null);
  assert.equal(repoRenameBlocker(root, makeAuth('bob'), repo, 'bob', 'webapp'), null);
});

test('canAdminRunnerGlobs: site admins always; owners over literal collections they own', () => {
  const root = makeVaultDir();
  addCollectionOwner(root, 'team', 'bob');
  assert.ok(canAdminRunnerGlobs(root, makeAuth('root', { siteAdmin: true }), ['*']));
  assert.ok(canAdminRunnerGlobs(root, makeAuth('bob'), ['team/*', 'team/one']));
  assert.ok(canAdminRunnerGlobs(root, makeAuth('bob'), ['bob/*']));
  assert.ok(!canAdminRunnerGlobs(root, makeAuth('bob'), ['team/*', 'other/*']));
  // A pattern in the collection part reaches collections nobody owns.
  assert.ok(!canAdminRunnerGlobs(root, makeAuth('bob'), ['*']));
  assert.ok(!canAdminRunnerGlobs(root, makeAuth('bob'), []));
  assert.ok(!canAdminRunnerGlobs(root, makeAuth('bob', { tokenScope: ['*'] }), ['bob/*']));
});

test('removeUserGrants sweeps owners lists and collaborator entries vault-wide', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'webapp');
  makeBareRepo(root, 'team', 'shared');
  addCollectionOwner(root, 'team', 'bob');
  setCollaborator(ref(root, 'demo', 'webapp').dir, 'bob', 'admin');
  setCollaborator(ref(root, 'team', 'shared').dir, 'carol', 'read');
  removeUserGrants(root, 'bob');
  // Everything bob held is gone; what others hold is untouched. A grant is
  // keyed by name alone, so a swept name grants nothing to whoever gets the
  // name next.
  assert.deepEqual(collectionOwners(root, 'team'), []);
  assert.deepEqual(repoAccess(ref(root, 'demo', 'webapp').dir).collaborators, {});
  assert.deepEqual(repoAccess(ref(root, 'team', 'shared').dir).collaborators, { carol: 'read' });
});

// ---- the migration from glob scopes ----

function writeV1Vault(root: string, users: Record<string, { scope: string[]; admin: string[] }>): void {
  const out: Record<string, unknown> = {};
  for (const [name, u] of Object.entries(users)) {
    out[name] = { tokens: [{ hash: hashToken(`${name}-token`) }], scope: u.scope, admin: u.admin };
  }
  fs.writeFileSync(path.join(root, 'vault.json'), JSON.stringify({ users: out }));
}

test('migratePermissions translates globs to the site-admin bit, owners, and collaborators', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'webapp');
  makeBareRepo(root, 'demo', 'tools');
  makeBareRepo(root, 'team', 'shared');
  writeV1Vault(root, {
    owner: { scope: ['*'], admin: ['*'] },
    alice: { scope: ['alice/*', 'team/shared'], admin: [] },
    bob: { scope: [], admin: ['demo/*', 'team/shared'] },
  });
  const notes = migratePermissions(root);
  assert.ok(notes && notes.length > 0);
  // The original file survives beside the migrated one.
  assert.ok(fs.existsSync(path.join(root, 'vault.json.pre-roles')));
  const state = loadVault(root);
  assert.equal(state.status, 'ok');
  if (state.status !== 'ok') return;
  assert.ok(!state.vault.legacy);
  // admin '*' becomes the site-admin bit.
  assert.equal(state.vault.users.owner.siteAdmin, true);
  assert.ok(!state.vault.users.alice.siteAdmin);
  // scope 'alice/*' is the implicit namespace and needs no entry.
  assert.deepEqual(collectionOwners(root, 'alice'), []);
  // admin 'demo/*' becomes ownership of demo.
  assert.deepEqual(collectionOwners(root, 'demo'), ['bob']);
  // A single-repository glob becomes a collaborator with the matching role.
  const shared = repoAccess(path.join(root, 'collections', 'team', 'repos', 'shared.git'));
  assert.equal(shared.collaborators.alice, 'write');
  assert.equal(shared.collaborators.bob, 'admin');
  // Running again finds nothing to do.
  assert.equal(migratePermissions(root), null);
});

test('migratePermissions drops a glob naming a repository that is not there, with a note', () => {
  const root = makeVaultDir();
  writeV1Vault(root, { alice: { scope: ['demo/ghost'], admin: [] } });
  const notes = migratePermissions(root);
  assert.ok(notes);
  assert.ok(notes.some((n) => n.includes('demo/ghost') && n.includes('dropped')));
});
