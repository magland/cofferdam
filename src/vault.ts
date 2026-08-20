import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeFileAtomic } from './atomic';

export const VAULT_FILE = 'vault.json';

export interface TokenRecord {
  hash: string;
  scope?: string[];
  /**
   * A stable identifier, so that a token can be named without naming its hash.
   * Minted with the token; a record from before this existed has none, and is
   * then identified by the first eight characters of its hash instead, so
   * existing vaults keep working without migration.
   */
  id?: string;
  /** When the token was minted. Absent on a record from before this existed. */
  created?: string;
}

/** How a token is named in a listing or a revocation: its id, or a stand-in for one. */
export function tokenId(t: TokenRecord): string {
  return t.id ?? t.hash.slice(0, 8);
}

export interface UserRecord {
  tokens: TokenRecord[];
  scope: string[];
  admin: string[];
}

export interface Vault {
  users: Record<string, UserRecord>;
}

export type VaultState =
  | { status: 'ok'; vault: Vault }
  | { status: 'missing' }
  | { status: 'error'; message: string };

export function vaultFilePath(root: string): string {
  return path.join(root, VAULT_FILE);
}

function asStringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

function normalizeVault(parsed: unknown): Vault {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('vault.json must be a JSON object');
  }
  const usersRaw = (parsed as Record<string, unknown>).users;
  if (typeof usersRaw !== 'object' || usersRaw === null) {
    throw new Error('vault.json must have a "users" object');
  }
  const users: Record<string, UserRecord> = {};
  for (const [name, u] of Object.entries(usersRaw as Record<string, unknown>)) {
    if (typeof u !== 'object' || u === null) {
      throw new Error(`user ${name} must be an object`);
    }
    const rec = u as Record<string, unknown>;
    const scope = asStringArray(rec.scope ?? []);
    if (!scope) {
      throw new Error(`user ${name}: "scope" must be a list of strings`);
    }
    const admin = asStringArray(rec.admin ?? []);
    if (!admin) {
      throw new Error(`user ${name}: "admin" must be a list of strings`);
    }
    const tokensRaw = rec.tokens ?? [];
    if (!Array.isArray(tokensRaw)) {
      throw new Error(`user ${name}: "tokens" must be a list`);
    }
    const tokens: TokenRecord[] = tokensRaw.map((t, i) => {
      if (typeof t === 'string') return { hash: t };
      if (typeof t === 'object' && t !== null && typeof (t as Record<string, unknown>).hash === 'string') {
        const tRec = t as Record<string, unknown>;
        const rec: TokenRecord = { hash: tRec.hash as string };
        if (typeof tRec.id === 'string' && tRec.id !== '') rec.id = tRec.id;
        if (typeof tRec.created === 'string' && tRec.created !== '') rec.created = tRec.created;
        if (tRec.scope !== undefined) {
          const ts = asStringArray(tRec.scope);
          if (!ts) throw new Error(`user ${name}: token ${i} "scope" must be a list of strings`);
          rec.scope = ts;
        }
        return rec;
      }
      throw new Error(`user ${name}: token ${i} must be a hash string or an object with a "hash"`);
    });
    users[name] = { tokens, scope, admin };
  }
  return { users };
}

let cache: { file: string; mtimeMs: number; size: number; state: VaultState } | null = null;

export function loadVault(root: string): VaultState {
  const file = vaultFilePath(root);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    cache = null;
    return { status: 'missing' };
  }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    return cache.state;
  }
  let state: VaultState;
  try {
    state = { status: 'ok', vault: normalizeVault(JSON.parse(fs.readFileSync(file, 'utf8'))) };
  } catch (e) {
    state = { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
  cache = { file, mtimeMs: st.mtimeMs, size: st.size, state };
  return state;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function mintToken(): { token: string; hash: string } {
  const token = 'cofferdam_' + crypto.randomBytes(32).toString('hex');
  return { token, hash: hashToken(token) };
}

export function globMatch(pattern: string, target: string): boolean {
  const rx = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${rx}$`).test(target);
}

export interface AuthResult {
  username: string;
  user: UserRecord;
  token: TokenRecord;
}

export function authenticate(vault: Vault, username: string, tokenPlain: string): AuthResult | null {
  const user = vault.users[username];
  if (!user) return null;
  const presented = Buffer.from(hashToken(tokenPlain), 'hex');
  for (const t of user.tokens) {
    let stored: Buffer;
    try {
      stored = Buffer.from(t.hash, 'hex');
    } catch {
      continue;
    }
    if (stored.length === presented.length && crypto.timingSafeEqual(stored, presented)) {
      return { username, user, token: t };
    }
  }
  return null;
}

export function authenticateToken(vault: Vault, tokenPlain: string): AuthResult | null {
  const presented = Buffer.from(hashToken(tokenPlain), 'hex');
  for (const [username, user] of Object.entries(vault.users)) {
    for (const t of user.tokens) {
      let stored: Buffer;
      try {
        stored = Buffer.from(t.hash, 'hex');
      } catch {
        continue;
      }
      if (stored.length === presented.length && crypto.timingSafeEqual(stored, presented)) {
        return { username, user, token: t };
      }
    }
  }
  return null;
}

export function canPush(auth: AuthResult, collection: string, repo: string): boolean {
  const target = `${collection}/${repo}`;
  const matches = (globs: string[]) => globs.some((g) => globMatch(g, target));
  if (!matches(auth.user.scope)) return false;
  if (auth.token.scope !== undefined && !matches(auth.token.scope)) return false;
  return true;
}

/**
 * Whether a user may create the collection named, which is a weaker question
 * than canPush over any repository in it: a push scope of
 * `mycollection/onerepo` lets its holder create `mycollection` implicitly, by
 * pushing that one repository, so making the empty directory first is refused
 * for no gain. The collection part of each glob is what is matched, and a glob
 * with no slash in it (`*`) covers every collection.
 */
export function canCreateCollection(auth: AuthResult, collection: string): boolean {
  const collectionOf = (glob: string) => (glob.includes('/') ? glob.slice(0, glob.indexOf('/')) : glob);
  const matches = (globs: string[]) => globs.some((g) => globMatch(collectionOf(g), collection));
  if (!matches(auth.user.scope)) return false;
  if (auth.token.scope !== undefined && !matches(auth.token.scope)) return false;
  return true;
}

export function canAdmin(auth: AuthResult, globs: string[]): boolean {
  if (auth.token.scope !== undefined) return false;
  if (auth.user.admin.length === 0) return false;
  return globs.every((g) => auth.user.admin.some((a) => globMatch(a, g)));
}

/**
 * Whether a user may administer a collection as a whole, which is what
 * renaming one asks. A rename moves every repository in the collection, so
 * admin scope has to cover each of them one by one; asking that alone would
 * be too weak for an empty collection, where there is nothing to cover and
 * `canAdmin` would answer yes to any administrator, so at least one of the
 * actor's admin globs must also name this collection. The collection part of
 * each glob is what is matched, as in canCreateCollection, and a glob with no
 * slash in it (`*`) covers every collection.
 */
export function canAdminCollection(auth: AuthResult, collection: string, repos: string[]): boolean {
  const collectionOf = (glob: string) => (glob.includes('/') ? glob.slice(0, glob.indexOf('/')) : glob);
  if (auth.token.scope !== undefined) return false;
  if (!auth.user.admin.some((a) => globMatch(collectionOf(a), collection))) return false;
  return canAdmin(
    auth,
    repos.map((r) => `${collection}/${r}`)
  );
}

function writeVault(file: string, vault: Vault): void {
  writeFileAtomic(file, JSON.stringify(vault, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Every edit to vault.json is a read, a change in memory, and a write back, and
 * they are all short. Holding one lock across the whole of one makes them
 * serial against a second server and against a CLI run on the same directory,
 * which is the arrangement the documentation invites by saying a vault is just
 * a directory. Readers do not take the lock: they see the old file or the new
 * one, which the atomic rename already guarantees.
 */
function editVault<T>(root: string, fn: (file: string) => T): T {
  return withFileLock(path.join(root, `${VAULT_FILE}.lock`), () => fn(vaultFilePath(root)));
}

// The body of addUserToken, without the lock, so that bootstrapVault can put
// its own check-then-act inside the same one rather than nesting a second.
function addUserTokenLocked(
  file: string,
  username: string,
  opts: { scope?: string[]; admin?: string[]; tokenScope?: string[]; token?: string }
): { token: string; created: boolean; user: UserRecord } {
  let vault: Vault = { users: {} };
  if (fs.existsSync(file)) {
    vault = normalizeVault(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  let user = vault.users[username];
  const created = !user;
  if (!user) {
    user = { tokens: [], scope: opts.scope ?? ['*'], admin: opts.admin ?? [] };
    vault.users[username] = user;
  } else if (opts.scope || opts.admin) {
    throw new Error(
      `user ${username} already exists; use 'cofferdam user grant ${username} --scope <glob>' to extend its scope`
    );
  }
  // A caller may supply the token instead of taking a minted one, which is how
  // a vault can be bootstrapped with a token its operator already holds. Only
  // the hash is stored either way, so the two cases differ in nothing else.
  const { token, hash } = opts.token ? { token: opts.token, hash: hashToken(opts.token) } : mintToken();
  const rec: TokenRecord = { hash, id: crypto.randomBytes(4).toString('hex'), created: new Date().toISOString() };
  if (opts.tokenScope && opts.tokenScope.length) rec.scope = opts.tokenScope;
  user.tokens.push(rec);
  writeVault(file, vault);
  return { token, created, user };
}

export function addUserToken(
  root: string,
  username: string,
  opts: { scope?: string[]; admin?: string[]; tokenScope?: string[]; token?: string } = {}
): { token: string; created: boolean; user: UserRecord } {
  return editVault(root, (file) => addUserTokenLocked(file, username, opts));
}

export function grantScope(
  root: string,
  username: string,
  globs: { scope?: string[]; admin?: string[] }
): UserRecord {
  return editVault(root, (file) => {
    if (!fs.existsSync(file)) {
      throw new Error(`no vault.json at ${file}; create the user first with: cofferdam user add ${username}`);
    }
    const vault = normalizeVault(JSON.parse(fs.readFileSync(file, 'utf8')));
    const user = vault.users[username];
    if (!user) {
      throw new Error(`user ${username} does not exist; create it with: cofferdam user add ${username}`);
    }
    for (const g of globs.scope ?? []) {
      if (!user.scope.includes(g)) user.scope.push(g);
    }
    for (const g of globs.admin ?? []) {
      if (!user.admin.includes(g)) user.admin.push(g);
    }
    writeVault(file, vault);
    return user;
  });
}

/**
 * Initialize a vault that has none, creating the owner and its first token.
 * Returns null when there is already a vault.json, since a vault is
 * initialized once and everything after that is the operator's own doing.
 *
 * `presetToken` lets the token be handed in rather than minted, which is what
 * `cofferdam deploy` does: it mints the token on the operator's machine and
 * passes it to the server as an environment secret, so a fresh remote vault can
 * be logged in to without reading a token back out of the logs. A preset token
 * is never echoed by the caller, so it does not reach the log at all.
 */
export function bootstrapVault(
  root: string,
  presetToken?: string | null
): { username: string; token: string; preset: boolean } | null {
  const preset = (presetToken ?? '').trim();
  if (presetToken !== undefined && presetToken !== null && presetToken !== '' && !preset) {
    throw new Error('the owner token given for a new vault is blank');
  }
  // A token travels as a Basic-auth password and lands in URLs' credential
  // slots, so a supplied one is held to the shape of a minted one rather than
  // taken as given: printable, no spaces, and long enough not to be guessed.
  if (preset && !/^[\x21-\x7e]{24,256}$/.test(preset)) {
    throw new Error(
      'the owner token given for a new vault is not usable: it must be 24 to 256 characters, ' +
        'printable, and contain no spaces'
    );
  }
  // The existence check and the creation are one operation. Two servers started
  // against one fresh directory would otherwise both find no vault.json and both
  // bootstrap, and the second owner token to be written would be the only one
  // that worked, while both had been printed as if they were the credential.
  return editVault(root, (file) => {
    if (fs.existsSync(file)) return null;
    const { token } = addUserTokenLocked(file, 'owner', {
      scope: ['*'],
      admin: ['*'],
      ...(preset ? { token: preset } : {}),
    });
    return { username: 'owner', token, preset: preset !== '' };
  });
}


/**
 * Revoke one token by its id. Revoking the token currently in use is allowed and
 * reported plainly rather than refused: locking yourself out is your business,
 * and vault.json remains hand-editable either way.
 */
export function revokeToken(root: string, username: string, id: string): { revoked: boolean; remaining: number } {
  return editVault(root, (file) => {
    const vault = normalizeVault(JSON.parse(fs.readFileSync(file, 'utf8')));
    const user = vault.users[username];
    if (!user) throw new Error(`no user ${username}`);
    const before = user.tokens.length;
    user.tokens = user.tokens.filter((t) => tokenId(t) !== id);
    if (user.tokens.length === before) return { revoked: false, remaining: before };
    writeVault(file, vault);
    return { revoked: true, remaining: user.tokens.length };
  });
}

/** Remove a user, and with them every token they hold. */
export function removeUser(root: string, username: string): boolean {
  return editVault(root, (file) => {
    const vault = normalizeVault(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!vault.users[username]) return false;
    delete vault.users[username];
    writeVault(file, vault);
    return true;
  });
}
