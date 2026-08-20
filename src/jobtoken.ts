import * as crypto from 'crypto';
import { getSecret } from './session';

// Ephemeral per-job credentials, so a workflow job can clone the repository
// it is running for even when that repository is private. The runner is a
// separate process on a separate machine and holds no vault token; the
// engine mints one of these into the job payload, and the runner presents it
// as the Basic-auth password on the clone, exactly as a user token would be
// presented.
//
// The token is an HMAC under the vault's session secret (<vault>/.secret)
// over what it grants: one repository, read only, until an expiry. Nothing
// is stored: verification is recomputing the signature, the way sessions and
// LFS transfer URLs already work, so a job token cannot be enumerated or
// revoked singly, and rotating .secret revokes them all at once. The grant
// is read-only by construction: checkReadAuth accepts these and the push
// path does not.

const PREFIX = 'cofferdamjob_';

export interface JobGrant {
  collection: string;
  repo: string;
  /** The run the token was minted for, so a log line can say which. */
  run: string;
}

function sign(root: string, body: string): string {
  return crypto.createHmac('sha256', getSecret(root)).update(`job:${body}`).digest('base64url');
}

export function mintJobToken(root: string, grant: JobGrant, ttlMs: number): string {
  const payload = { c: grant.collection, r: grant.repo, run: grant.run, exp: Date.now() + ttlMs };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${PREFIX}${body}.${sign(root, body)}`;
}

/** The grant a token carries, or null for anything expired, forged, or not a job token at all. */
export function verifyJobToken(root: string, token: string): JobGrant | null {
  if (!token.startsWith(PREFIX)) return null;
  const rest = token.slice(PREFIX.length);
  const dot = rest.lastIndexOf('.');
  if (dot === -1) return null;
  const body = rest.slice(0, dot);
  const sig = Buffer.from(rest.slice(dot + 1));
  const expected = Buffer.from(sign(root, body));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.c !== 'string' || typeof p.r !== 'string' || typeof p.run !== 'string') return null;
  if (typeof p.exp !== 'number' || p.exp < Date.now()) return null;
  return { collection: p.c, repo: p.r, run: p.run };
}

/** Whether a verified grant covers the repository being read. */
export function grantCovers(grant: JobGrant, collection: string, repo: string): boolean {
  return grant.collection === collection && grant.repo === repo;
}
