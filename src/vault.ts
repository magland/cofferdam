import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const VAULT_FILE = 'vault.json';

export interface TokenRecord {
  hash: string;
  scope?: string[];
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
        if (tRec.scope === undefined) return { hash: tRec.hash as string };
        const ts = asStringArray(tRec.scope);
        if (!ts) throw new Error(`user ${name}: token ${i} "scope" must be a list of strings`);
        return { hash: tRec.hash as string, scope: ts };
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

function writeVault(file: string, vault: Vault): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(vault, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function addUserToken(
  root: string,
  username: string,
  opts: { scope?: string[]; admin?: string[]; tokenScope?: string[] } = {}
): { token: string; created: boolean; user: UserRecord } {
  const file = vaultFilePath(root);
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
  const { token, hash } = mintToken();
  const rec: TokenRecord =
    opts.tokenScope && opts.tokenScope.length ? { hash, scope: opts.tokenScope } : { hash };
  user.tokens.push(rec);
  writeVault(file, vault);
  return { token, created, user };
}

export function grantScope(
  root: string,
  username: string,
  globs: { scope?: string[]; admin?: string[] }
): UserRecord {
  const file = vaultFilePath(root);
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
}

export function bootstrapVault(root: string): { username: string; token: string } | null {
  if (fs.existsSync(vaultFilePath(root))) return null;
  const { token } = addUserToken(root, 'owner', { scope: ['*'], admin: ['*'] });
  return { username: 'owner', token };
}
