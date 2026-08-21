import { createOneTimeStore, mintHandoffCode, normalizeHandoffCode } from './onetime';

// The two ways a signed-in credential mints a sign-in for somewhere else:
//
//   - A login link: `mochi web` presents its bearer token to /api/login-url
//     and gets a URL that signs the browser in as the same user. The code in
//     the URL is opaque and short-lived, and redeeming it is a click on a
//     page that names the account first, so a link someone was tricked into
//     opening cannot sign them in silently as somebody else.
//
//   - A handoff code: a signed-in browser shows a short code, and typing it
//     on another device signs that device in. The code is typeable on
//     purpose, so it is shorter-lived and its redemption is charged to the
//     sign-in rate limiter.
//
// Either way the new session is bound to the same underlying credential the
// minting session was (the token's hash, or a passkey binding), so revoking
// that credential ends every session it fanned out to, exactly as it ends the
// first one. Nothing new is minted into vault.json.
//
// The stores are module-level and the process may serve several vaults in
// tests, so each entry records the root it was minted for and answers only
// to it.

export interface PendingLogin {
  root: string;
  username: string;
  /** What the session will be bound to: a token hash, or `pk:<credential id>`. */
  binding: string;
  /** Where the browser lands after signing in; checked by safeNext at redeem. */
  next?: string;
}

export const LOGIN_LINK_TTL_MS = 2 * 60 * 1000;
export const HANDOFF_TTL_MS = 5 * 60 * 1000;

const loginLinks = createOneTimeStore<PendingLogin>();
const handoffCodes = createOneTimeStore<PendingLogin>(mintHandoffCode);

export function mintLoginLink(root: string, username: string, binding: string, next?: string): string {
  return loginLinks.put({ root, username, binding, next }, LOGIN_LINK_TTL_MS);
}

export function peekLoginLink(root: string, code: string): PendingLogin | null {
  const p = loginLinks.peek(code);
  return p && p.root === root ? p : null;
}

export function takeLoginLink(root: string, code: string): PendingLogin | null {
  const p = loginLinks.take(code);
  return p && p.root === root ? p : null;
}

export function mintHandoff(root: string, username: string, binding: string): string {
  return handoffCodes.put({ root, username, binding }, HANDOFF_TTL_MS);
}

export function takeHandoff(root: string, typed: string): PendingLogin | null {
  const p = handoffCodes.take(normalizeHandoffCode(typed));
  return p && p.root === root ? p : null;
}
