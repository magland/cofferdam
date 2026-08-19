import { Request, Response } from 'express';
import { AuthResult, authenticateToken, loadVault } from '../vault';

// Authorization for the JSON API, in one place because there is now more than
// one file of routes behind it. Only bearer tokens are accepted: session
// cookies never authorize an API call, and git's Basic auth never does either.

export function apiError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

/**
 * The caller's identity, or null having already answered with the refusal. A
 * handler that ignores the null is a handler that runs unauthenticated, so the
 * shape to write is `const auth = requireApiAuth(root, req, res); if (!auth) return;`.
 */
export function requireApiAuth(root: string, req: Request, res: Response): AuthResult | null {
  const state = loadVault(root);
  if (state.status === 'missing') {
    apiError(res, 401, 'no vault.json in this vault; restart the server to initialize one');
    return null;
  }
  if (state.status === 'error') {
    apiError(res, 500, `vault.json could not be read: ${state.message}`);
    return null;
  }
  const m = (req.get('authorization') ?? '').match(/^bearer\s+(.+)$/i);
  if (!m) {
    apiError(res, 401, 'missing bearer token: send Authorization: Bearer <token>');
    return null;
  }
  const auth = authenticateToken(state.vault, m[1].trim());
  if (!auth) {
    apiError(res, 401, 'invalid token');
    return null;
  }
  return auth;
}
