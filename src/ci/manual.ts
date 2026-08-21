import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../atomic';
import { runsDir } from './runs';

// Manual jobs: a job whose runs-on names the reserved label `manual` is never
// handed to a registered runner. It runs when someone with the write role
// mints a command from the run page and pastes it on a machine of their
// choosing, which is the arrangement for a machine that should execute
// repository code only while a person is watching it do so.
//
// The pasted command carries a *mint token*: single-use, scoped to one run,
// and dead fifteen minutes after minting if nobody redeems it. Redeeming it
// returns a *session token* that lives only in the redeeming process and
// works until the run completes. The split is the point: a command lands in
// shell history and terminal scrollback, and a copy found there later must
// buy nothing. Only hashes of either token are stored, as with every other
// credential in a vault.
//
// Grants live in <run dir>/manual.json, beside run.json rather than inside
// it, so that the run records served by the API and rendered by the UI never
// carry them. They are pruned with the run.

export const MANUAL_LABEL = 'manual';

/** Whether a job (by its resolved runs-on labels) runs only by pasted command. */
export function isManualJob(runsOn: string[]): boolean {
  return runsOn.includes(MANUAL_LABEL);
}

/** How long a minted command waits to be pasted before it dies. */
export const MINT_TTL_MS = 15 * 60 * 1000;

const MINT_PREFIX = 'feorge_run_';
const SESSION_PREFIX = 'feorge_manual_';

export interface ManualGrant {
  /** Short id; the lease's runner name is derived from it as `manual:<id>`. */
  id: string;
  /** sha256 of the mint token, hex. */
  hash: string;
  mintedBy: string;
  mintedAt: string;
  /** Redemption deadline; meaningless once redeemed. */
  expiresAt: string;
  /** sha256 of the session token, hex; present once redeemed. */
  sessionHash?: string;
  redeemedAt?: string;
  /** The hostname the redeeming process reported. Self-reported, and said so where shown. */
  host?: string;
}

/** The runner name a session's leases are held under. */
export function sessionRunnerName(grant: ManualGrant): string {
  return `manual:${grant.id}`;
}

export function isManualRunnerName(name: string): boolean {
  return name.startsWith('manual:');
}

function grantsPath(root: string, collection: string, repo: string, n: number): string | null {
  const base = runsDir(root, collection, repo);
  return base ? path.join(base, String(n), 'manual.json') : null;
}

export function loadGrants(root: string, collection: string, repo: string, n: number): ManualGrant[] {
  const file = grantsPath(root, collection, repo, n);
  if (!file) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (g): g is ManualGrant =>
      typeof g === 'object' &&
      g !== null &&
      typeof (g as ManualGrant).id === 'string' &&
      typeof (g as ManualGrant).hash === 'string'
  );
}

function saveGrants(root: string, collection: string, repo: string, n: number, grants: ManualGrant[]): void {
  const file = grantsPath(root, collection, repo, n);
  if (!file) throw new Error('invalid repository');
  writeFileAtomic(file, JSON.stringify(grants, null, 1) + '\n', { mode: 0o600 });
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  let x: Buffer;
  let y: Buffer;
  try {
    x = Buffer.from(a, 'hex');
    y = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * Mint a grant for a run and return the token, which is shown once and only
 * its hash kept. Expired grants that were never redeemed are dropped on the
 * way through: they are dead weight, and pruning them here means the file
 * never accumulates the residue of commands nobody pasted.
 */
export function mintGrant(
  root: string,
  collection: string,
  repo: string,
  n: number,
  mintedBy: string
): { token: string; grant: ManualGrant } {
  const now = Date.now();
  const grants = loadGrants(root, collection, repo, n).filter(
    (g) => g.redeemedAt !== undefined || Date.parse(g.expiresAt) > now
  );
  const token = MINT_PREFIX + crypto.randomBytes(24).toString('hex');
  const grant: ManualGrant = {
    id: crypto.randomBytes(4).toString('hex'),
    hash: hashToken(token),
    mintedBy,
    mintedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + MINT_TTL_MS).toISOString(),
  };
  grants.push(grant);
  saveGrants(root, collection, repo, n, grants);
  return { token, grant };
}

/** The grant a presented mint token names, if it is unexpired and unredeemed. */
export function findMintable(grants: ManualGrant[], token: string): ManualGrant | null {
  if (!token.startsWith(MINT_PREFIX)) return null;
  const presented = hashToken(token);
  for (const g of grants) {
    if (g.redeemedAt !== undefined) continue;
    if (Date.parse(g.expiresAt) <= Date.now()) continue;
    if (sameHash(g.hash, presented)) return g;
  }
  return null;
}

/**
 * Redeem a grant: mark it redeemed, record the reported host, and mint the
 * session token whose hash it will answer to from now on. The mint token is
 * spent by this; presenting it again finds nothing.
 */
export function redeemGrant(
  root: string,
  collection: string,
  repo: string,
  n: number,
  grantId: string,
  host: string
): string | null {
  const grants = loadGrants(root, collection, repo, n);
  const grant = grants.find((g) => g.id === grantId);
  if (!grant || grant.redeemedAt !== undefined) return null;
  const session = SESSION_PREFIX + crypto.randomBytes(32).toString('hex');
  grant.sessionHash = hashToken(session);
  grant.redeemedAt = new Date().toISOString();
  grant.host = host.slice(0, 200);
  saveGrants(root, collection, repo, n, grants);
  return session;
}

/** The redeemed grant a presented session token belongs to, or null. */
export function findSession(grants: ManualGrant[], token: string): ManualGrant | null {
  if (!token.startsWith(SESSION_PREFIX)) return null;
  const presented = hashToken(token);
  for (const g of grants) {
    if (g.sessionHash === undefined) continue;
    if (sameHash(g.sessionHash, presented)) return g;
  }
  return null;
}

export function looksLikeSessionToken(token: string): boolean {
  return token.startsWith(SESSION_PREFIX);
}

export function looksLikeMintToken(token: string): boolean {
  return token.startsWith(MINT_PREFIX);
}
