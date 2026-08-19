import * as fs from 'fs';
import * as path from 'path';
import express, { Express, Request, Response } from 'express';
import * as ops from './ops';
import { OpError } from './ops';
import { displayName, isValidName, listCollections, listRepoDirs } from './scan';
import { addUserToken, canAdmin, canCreateCollection, grantScope, loadVault } from './vault';
import { apiError, requireApiAuth as authenticateRequest } from './api/auth';
import { AuthLimiter } from './limit';

// The bearer-token JSON API used by the cofferdam CLI. Only Bearer tokens are
// accepted; session cookies never authorize API calls.

export function registerApi(app: Express, root: string, authLimiter: AuthLimiter): void {
  app.use('/api', express.json());

  // Both helpers live in src/api/auth.ts now that more than one file of routes
  // uses them; this closure only saves passing root at every call site.
  const requireApiAuth = (req: Request, res: Response) => authenticateRequest(root, authLimiter, req, res);

  function sanitizeGlobs(v: unknown): string[] | null | undefined {
    if (v === undefined || v === null) return undefined;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0 && x.length < 200)) {
      return v as string[];
    }
    return null;
  }

  app.get('/api/whoami', (req, res) => {
    const auth = requireApiAuth(req, res);
    if (!auth) return;
    res.json({
      username: auth.username,
      scope: auth.user.scope,
      admin: auth.user.admin,
      tokenScope: auth.token.scope ?? null,
    });
  });

  // Collections, for the CLI. `cofferdam import` asks what is already in a
  // collection before it pushes, and `cofferdam collection add` makes an empty
  // one, which is the case a push cannot cover: pushing creates the collection
  // it lands in, so a collection with nothing in it yet has to be asked for.
  app.get('/api/collections', (req, res) => {
    if (!requireApiAuth(req, res)) return;
    res.json({ collections: listCollections(root) });
  });

  app.get('/api/collections/:name', (req, res) => {
    if (!requireApiAuth(req, res)) return;
    const name = req.params.name;
    let isDir = false;
    try {
      isDir = fs.statSync(path.join(root, name)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isValidName(name) || !isDir) {
      apiError(res, 404, `no collection ${name} in this vault`);
      return;
    }
    res.json({ name, repos: listRepoDirs(root, name).map(displayName) });
  });

  app.post('/api/collections', (req, res) => {
    const auth = requireApiAuth(req, res);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!isValidName(name)) {
      apiError(res, 400, 'a valid "name" is required (letters, digits, dot, underscore, dash; not a reserved word)');
      return;
    }
    if (!canCreateCollection(auth, name)) {
      apiError(res, 403, `your push scope does not cover anything in ${name}`);
      return;
    }
    try {
      ops.createCollection(root, name);
    } catch (e) {
      if (e instanceof OpError) {
        apiError(res, e.kind === 'exists' ? 409 : 400, e.message);
        return;
      }
      throw e;
    }
    res.json({ name, created: true });
  });

  app.get('/api/users', (req, res) => {
    const auth = requireApiAuth(req, res);
    if (!auth) return;
    if (!canAdmin(auth, [])) {
      apiError(res, 403, 'admin access required (with an unrestricted token)');
      return;
    }
    const state = loadVault(root);
    if (state.status !== 'ok') {
      apiError(res, 500, 'vault unavailable');
      return;
    }
    res.json({
      users: Object.entries(state.vault.users).map(([name, u]) => ({
        name,
        scope: u.scope,
        admin: u.admin,
        tokens: u.tokens.length,
      })),
    });
  });

  app.post('/api/users', (req, res) => {
    const auth = requireApiAuth(req, res);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body.username === 'string' ? body.username : '';
    if (!isValidName(username)) {
      apiError(res, 400, 'a valid "username" is required');
      return;
    }
    const scope = sanitizeGlobs(body.scope);
    const admin = sanitizeGlobs(body.admin);
    const tokenScope = sanitizeGlobs(body.tokenScope);
    if (scope === null || admin === null || tokenScope === null) {
      apiError(res, 400, '"scope", "admin", and "tokenScope" must be lists of strings');
      return;
    }
    const state = loadVault(root);
    if (state.status !== 'ok') {
      apiError(res, 500, 'vault unavailable');
      return;
    }
    const existing = state.vault.users[username];
    if (existing) {
      if (scope || admin) {
        apiError(res, 409, `user ${username} already exists; use 'cofferdam user grant' to extend it`);
        return;
      }
      if (!canAdmin(auth, [...existing.scope, ...existing.admin])) {
        apiError(res, 403, `your admin scope does not cover user ${username}`);
        return;
      }
      const result = addUserToken(root, username, { tokenScope: tokenScope ?? undefined });
      res.json({
        username,
        created: false,
        token: result.token,
        scope: result.user.scope,
        admin: result.user.admin,
      });
      return;
    }
    const newScope = scope ?? ['*'];
    const newAdmin = admin ?? [];
    const need = [...newScope, ...newAdmin];
    if (!canAdmin(auth, need)) {
      apiError(res, 403, `your admin scope does not cover: ${need.join(', ')} (pass --scope to narrow the new user)`);
      return;
    }
    const result = addUserToken(root, username, {
      scope: newScope,
      admin: newAdmin,
      tokenScope: tokenScope ?? undefined,
    });
    res.json({
      username,
      created: true,
      token: result.token,
      scope: result.user.scope,
      admin: result.user.admin,
    });
  });

  app.post('/api/users/:name/grant', (req, res) => {
    const auth = requireApiAuth(req, res);
    if (!auth) return;
    const username = req.params.name;
    if (!isValidName(username)) {
      apiError(res, 400, 'invalid username');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const scope = sanitizeGlobs(body.scope);
    const admin = sanitizeGlobs(body.admin);
    if (scope === null || admin === null) {
      apiError(res, 400, '"scope" and "admin" must be lists of strings');
      return;
    }
    const globs = [...(scope ?? []), ...(admin ?? [])];
    if (globs.length === 0) {
      apiError(res, 400, 'nothing to grant; provide "scope" and/or "admin"');
      return;
    }
    if (!canAdmin(auth, globs)) {
      apiError(res, 403, `your admin scope does not cover: ${globs.join(', ')}`);
      return;
    }
    let user;
    try {
      user = grantScope(root, username, { scope: scope ?? [], admin: admin ?? [] });
    } catch (e) {
      apiError(res, 404, e instanceof Error ? e.message : String(e));
      return;
    }
    res.json({ username, scope: user.scope, admin: user.admin });
  });
}
