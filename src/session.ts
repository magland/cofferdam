import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Request, Response } from 'express';
import { AuthResult, TokenRecord, canAdmin, loadVault } from './vault';

// Stateless signed-cookie sessions on top of the token model. The payload is
// base64url JSON plus an HMAC keyed by <vault>/.secret. There is no server-side
// session store: permissions are re-derived from live vault.json on every
// request, so deleting a user's tokens cuts them off, and rotating .secret
// invalidates every session at once.

const COOKIE_NAME = 'repos_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

interface SessionPayload {
  u: string;
  exp: number;
  csrf: string;
  ts?: string[];
}

let secretCache: { root: string; secret: Buffer } | null = null;

export function getSecret(root: string): Buffer {
  if (secretCache && secretCache.root === root) return secretCache.secret;
  const file = path.join(root, '.secret');
  let secret: Buffer;
  try {
    secret = fs.readFileSync(file);
    if (secret.length < 32) throw new Error('secret too short');
  } catch {
    secret = crypto.randomBytes(32);
    fs.writeFileSync(file, secret, { mode: 0o600 });
  }
  secretCache = { root, secret };
  return secret;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(root: string, data: string): string {
  return b64url(crypto.createHmac('sha256', getSecret(root)).update(data).digest());
}

export function setSessionCookie(
  req: Request,
  res: Response,
  root: string,
  username: string,
  tokenScope?: string[]
): void {
  const payload: SessionPayload = {
    u: username,
    exp: Date.now() + SESSION_MS,
    csrf: crypto.randomBytes(16).toString('hex'),
    ...(tokenScope !== undefined ? { ts: tokenScope } : {}),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  res.cookie(COOKIE_NAME, `${body}.${sign(root, body)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: SESSION_MS,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // malformed cookie value; skip
    }
  }
  return out;
}

function readSession(req: Request, root: string): SessionPayload | null {
  const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = sign(root, body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.u !== 'string' || typeof p.exp !== 'number' || typeof p.csrf !== 'string') return null;
  if (p.exp < Date.now()) return null;
  if (p.ts !== undefined && !(Array.isArray(p.ts) && p.ts.every((x) => typeof x === 'string'))) return null;
  return { u: p.u, exp: p.exp, csrf: p.csrf, ...(p.ts !== undefined ? { ts: p.ts as string[] } : {}) };
}

// A Viewer is a signed-in browser session resolved against live vault.json.
// Its auth is shaped like a token AuthResult so canPush/canAdmin apply
// unchanged; a session minted from a restricted token carries that token's
// scope and therefore no admin rights.
export interface Viewer {
  auth: AuthResult;
  csrf: string;
}

export function getViewer(req: Request, root: string): Viewer | null {
  const session = readSession(req, root);
  if (!session) return null;
  const state = loadVault(root);
  if (state.status !== 'ok') return null;
  const user = state.vault.users[session.u];
  if (!user || user.tokens.length === 0) return null;
  const token: TokenRecord = session.ts !== undefined ? { hash: '', scope: session.ts } : { hash: '' };
  return { auth: { username: session.u, user, token }, csrf: session.csrf };
}

export function viewerIsAdmin(viewer: Viewer | null): boolean {
  return viewer !== null && canAdmin(viewer.auth, []);
}

export function checkCsrf(req: Request, viewer: Viewer): boolean {
  const presented = (req.body as Record<string, unknown> | undefined)?.csrf;
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(viewer.csrf);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
