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
//
// A session is bound to the single token it was minted from, by recording that
// token's SHA-256 hash (the same value vault.json stores, so no new secret is
// put in the cookie, and the hash is useless as a credential). Resolving a
// session looks that token up in live vault.json, so deleting one token ends
// the sessions it started and leaves the user's other sessions alone. The
// token record found this way is the real one, which is why the session carries
// no copy of the token's scope: canPush and canAdmin read it from the vault.

// Cookies are not scoped by origin, so any document on any host under a shared
// parent domain can set a cookie named cofferdam_session with
// Domain=<parent>, which the browser then also sends here. With several vaults
// on sibling subdomains of one domain, that lets one of them shadow another's
// session. Browsers refuse a __Host--prefixed cookie that carries a Domain
// attribute at all, which closes it.
//
// The prefix also requires Secure and Path=/, so the name is conditional on
// exactly when the prefix is legal: setSessionCookie already sets path '/' and
// sets secure from req.protocol, and a plain-http vault keeps the bare name.
const HOST_COOKIE_NAME = '__Host-cofferdam_session';
const COOKIE_NAME = 'cofferdam_session';
const cookieName = (req: Request) => (req.protocol === 'https' ? HOST_COOKIE_NAME : COOKIE_NAME);
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

interface SessionPayload {
  u: string;
  exp: number;
  csrf: string;
  t: string;
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

export function setSessionCookie(req: Request, res: Response, root: string, auth: AuthResult): void {
  const payload: SessionPayload = {
    u: auth.username,
    exp: Date.now() + SESSION_MS,
    csrf: crypto.randomBytes(16).toString('hex'),
    t: auth.token.hash,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  res.cookie(cookieName(req), `${body}.${sign(root, body)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: SESSION_MS,
    path: '/',
  });
}

// Both names, since a session minted before the prefix existed, or over http
// on a vault that has since gained TLS, is still a session to clear.
export function clearSessionCookie(res: Response): void {
  res.clearCookie(HOST_COOKIE_NAME, { path: '/' });
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
  // The prefixed name first, then the bare one, so a session minted before this
  // existed survives. A sibling subdomain can still set the bare name, which is
  // why the prefixed one wins when both arrive.
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[HOST_COOKIE_NAME] ?? cookies[COOKIE_NAME];
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
  // A cookie from before sessions were bound to a token has no `t`, and is
  // rejected rather than accepted unbound: the holder is simply signed out and
  // signs in again, which is a smaller cost than leaving unrevocable sessions
  // alive for the rest of their thirty days.
  if (typeof p.t !== 'string' || p.t === '') return null;
  return { u: p.u, exp: p.exp, csrf: p.csrf, t: p.t };
}

// A Viewer is a signed-in browser session resolved against live vault.json.
// Its auth is the AuthResult that the session's own token would produce now, so
// canPush/canAdmin apply unchanged; a session minted from a restricted token
// resolves to that restricted token record and therefore has no admin rights.
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
  if (!user) return null;
  const token: TokenRecord | undefined = user.tokens.find((t) => t.hash === session.t);
  if (!token) return null;
  return { auth: { username: session.u, user, token }, csrf: session.csrf };
}

export function viewerIsAdmin(viewer: Viewer | null): boolean {
  return viewer !== null && canAdmin(viewer.auth, []);
}

export function checkCsrf(req: Request, viewer: Viewer): boolean {
  const presented = (req.body as Record<string, unknown> | undefined)?.csrf;
  return typeof presented === 'string' && csrfMatches(req, presented, viewer);
}

/**
 * A state-changing request whose Origin names somewhere else is refused. This
 * does nothing against same-origin script, which is what the site sandbox in
 * src/site.ts closes; it is a few lines that catch a misconfigured proxy, and it
 * belongs next to the CSRF check so the two are read together. An absent Origin
 * is not a failure: plenty of legitimate clients send none.
 */
function originOk(req: Request): boolean {
  const origin = req.get('origin');
  // Absent is allowed. Literal "null" is not: that is an opaque origin, which
  // is what a sandboxed document has, and nothing in the forge's own interface
  // sends it.
  if (!origin) return true;
  if (origin === 'null') return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  // The hostname only, and not the scheme or the port. req.hostname honours
  // X-Forwarded-Host, so it is the name the browser used; req.protocol is
  // http on a vault behind a TLS proxy that is not trusted, and comparing it
  // would then refuse every legitimate form on a merely misconfigured vault.
  // An attacker who can answer for our hostname over plain http is already
  // between the browser and the server.
  return u.hostname.toLowerCase() === req.hostname.toLowerCase();
}

/**
 * The comparison behind checkCsrf, for a handler that has the value in hand
 * rather than in req.body - a multipart form, which express does not parse.
 */
export function csrfMatches(req: Request, presented: string, viewer: Viewer): boolean {
  if (!originOk(req)) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(viewer.csrf);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
