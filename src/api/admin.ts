import { Express } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { CiConfig, loadConfig, saveConfig } from '../config';
import { AuthLimiter } from '../limit';
import { isValidName, listRepoDirs } from '../scan';
import { DEFAULT_THEME, findTheme, themeNames } from '../themes';
import { canAdmin, loadVault, removeUser, revokeToken, tokenId } from '../vault';
import { apiError, bodyOf, requireApiAuth } from './auth';

// Administration: users, their tokens, collections, and the vault's own settings.
//
// Reading a user's tokens never returns a token. Only a SHA-256 hash is stored, so
// there is nothing to return even if it were a good idea; what a caller gets is an
// id, a creation time, and a scope, which is enough to revoke one.

export function registerAdminApi(app: Express, root: string, limiter: AuthLimiter): void {
  /**
   * An admin over everything, which is what a vault-wide setting takes. Not
   * merely an admin: a delegated collection administrator should not restyle the
   * whole vault or remove a collection that is not theirs, which is the same rule
   * canSetTheme applies on the web.
   */
  const requireOwner = (req: Parameters<typeof requireApiAuth>[2], res: Parameters<typeof requireApiAuth>[3]) => {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return null;
    if (!canAdmin(auth, ['*'])) {
      apiError(res, 403, 'admin scope over the whole vault is required');
      return null;
    }
    return auth;
  };

  // ---- collections ----

  // Only an empty one, and only a directory: a collection is a directory, so
  // removing it is an rmdir and refusing a non-empty one is the filesystem's own
  // rule rather than a policy invented here.
  app.delete('/api/collections/:name', (req, res) => {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return;
    const name = req.params.name;
    if (!canAdmin(auth, [`${name}/*`])) {
      apiError(res, 403, `your admin scope does not cover ${name}`);
      return;
    }
    if (!isValidName(name)) {
      apiError(res, 400, 'that is not a usable collection name');
      return;
    }
    const dir = path.join(root, name);
    let isDir = false;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      apiError(res, 404, `no collection ${name} in this vault`);
      return;
    }
    if (listRepoDirs(root, name).length > 0 || fs.readdirSync(dir).length > 0) {
      apiError(res, 409, `collection ${name} is not empty`);
      return;
    }
    try {
      fs.rmdirSync(dir);
    } catch (e) {
      apiError(res, 409, `could not remove ${name}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    res.json({ deleted: name });
  });

  // ---- users and their tokens ----

  app.get('/api/users/:name', (req, res) => {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return;
    const state = loadVault(root);
    if (state.status !== 'ok') {
      apiError(res, 500, 'vault unavailable');
      return;
    }
    const user = state.vault.users[req.params.name];
    if (!user) {
      apiError(res, 404, `no user ${req.params.name}`);
      return;
    }
    // A user may read their own record; reading anyone else's needs admin scope
    // over what that user can reach.
    if (req.params.name !== auth.username && !canAdmin(auth, [...user.scope, ...user.admin])) {
      apiError(res, 403, `your admin scope does not cover user ${req.params.name}`);
      return;
    }
    res.json({
      name: req.params.name,
      scope: user.scope,
      admin: user.admin,
      tokens: user.tokens.map((t) => ({ id: tokenId(t), created: t.created ?? null, scope: t.scope ?? null })),
    });
  });

  app.get('/api/users/:name/tokens', (req, res) => {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return;
    const state = loadVault(root);
    if (state.status !== 'ok') {
      apiError(res, 500, 'vault unavailable');
      return;
    }
    const user = state.vault.users[req.params.name];
    if (!user) {
      apiError(res, 404, `no user ${req.params.name}`);
      return;
    }
    if (req.params.name !== auth.username && !canAdmin(auth, [...user.scope, ...user.admin])) {
      apiError(res, 403, `your admin scope does not cover user ${req.params.name}`);
      return;
    }
    // Never the token, and never the hash either: an id is what revocation
    // takes, and the hash is a credential-shaped thing with no reason to travel.
    res.json({
      tokens: user.tokens.map((t) => ({ id: tokenId(t), created: t.created ?? null, scope: t.scope ?? null })),
    });
  });

  app.delete('/api/users/:name/tokens/:id', (req, res) => {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return;
    const state = loadVault(root);
    if (state.status !== 'ok') {
      apiError(res, 500, 'vault unavailable');
      return;
    }
    const user = state.vault.users[req.params.name];
    if (!user) {
      apiError(res, 404, `no user ${req.params.name}`);
      return;
    }
    const ownToken = req.params.name === auth.username && tokenId(auth.token) === req.params.id;
    if (req.params.name !== auth.username && !canAdmin(auth, [...user.scope, ...user.admin])) {
      apiError(res, 403, `your admin scope does not cover user ${req.params.name}`);
      return;
    }
    let result;
    try {
      result = revokeToken(root, req.params.name, req.params.id);
    } catch (e) {
      apiError(res, 500, e instanceof Error ? e.message : String(e));
      return;
    }
    if (!result.revoked) {
      apiError(res, 404, `no token ${req.params.id} for ${req.params.name}`);
      return;
    }
    // Revoking the token in use is allowed. It is reported rather than refused:
    // locking yourself out is your business, and vault.json stays hand-editable.
    res.json({ revoked: req.params.id, remaining: result.remaining, wasThisToken: ownToken });
  });

  app.delete('/api/users/:name', (req, res) => {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return;
    const state = loadVault(root);
    if (state.status !== 'ok') {
      apiError(res, 500, 'vault unavailable');
      return;
    }
    const user = state.vault.users[req.params.name];
    if (!user) {
      apiError(res, 404, `no user ${req.params.name}`);
      return;
    }
    if (!canAdmin(auth, [...user.scope, ...user.admin])) {
      apiError(res, 403, `your admin scope does not cover user ${req.params.name}`);
      return;
    }
    // Deleting yourself would leave a vault an owner cannot administer except by
    // hand, and unlike revoking one token it cannot be undone by minting another.
    if (req.params.name === auth.username) {
      apiError(res, 409, 'a user cannot delete themselves; another admin can, or edit vault.json by hand');
      return;
    }
    if (String(req.query.confirm ?? '') !== req.params.name) {
      apiError(res, 400, `to remove this user and every token they hold, send ?confirm=${req.params.name}`);
      return;
    }
    res.json({ deleted: req.params.name, removed: removeUser(root, req.params.name) });
  });

  // ---- vault settings ----

  app.get('/api/config', (req, res) => {
    const auth = requireOwner(req, res);
    if (!auth) return;
    const config = loadConfig(root);
    res.json({ ...config, themes: themeNames() });
  });

  app.patch('/api/config', (req, res) => {
    const auth = requireOwner(req, res);
    if (!auth) return;
    const body = bodyOf(req);
    const changes: { theme?: string; ci?: CiConfig } = {};
    if (body.theme !== undefined) {
      if (typeof body.theme !== 'string' || !findTheme(body.theme)) {
        apiError(res, 400, `"theme" must be one of: ${themeNames().join(', ')} (default ${DEFAULT_THEME})`);
        return;
      }
      changes.theme = body.theme;
    }
    if (body.ci !== undefined) {
      if (typeof body.ci !== 'object' || body.ci === null || Array.isArray(body.ci)) {
        apiError(res, 400, '"ci" must be an object');
        return;
      }
      const ci = body.ci as Record<string, unknown>;
      const current = loadConfig(root).ci;
      const number = (v: unknown, fallback: number, min: number) =>
        typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.floor(v) : fallback;
      changes.ci = {
        runs: number(ci.runs, current.runs, 0),
        days: number(ci.days, current.days, 0),
        artifactMb: number(ci.artifactMb, current.artifactMb, 1),
      };
    }
    if (Object.keys(changes).length === 0) {
      apiError(res, 400, 'nothing to change; provide "theme" and/or "ci"');
      return;
    }
    // network and limits are deliberately not writable here: they are read once
    // at startup, so a route that changed them would report a change the running
    // server had not made. docs/deploying.md says to edit config.json and
    // restart.
    res.json(saveConfig(root, changes));
  });
}
