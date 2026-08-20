import { Express } from 'express';
import * as fs from 'fs';
import { CiEngine } from '../ci/engine';
import { CiConfig, LimitsConfig, SitesConfig, isPlausibleHostname, loadConfig, saveConfig } from '../config';
import { Egress } from '../egress';
import { AuthLimiter } from '../limit';
import { LfsContext } from '../lfsstore';
import { REPOS_DIR, collectionDir, reposDir } from '../layout';
import { renameCollection } from '../ops';
import { forgetCollectionRedirects } from '../redirects';
import { displayName, isValidName, listRepoDirs } from '../scan';
import { normalizeHostname } from '../siteshost';
import { DEFAULT_THEME, findTheme, themeNames } from '../themes';
import {
  canAdmin,
  canAdminCollection,
  canCreateCollection,
  canPush,
  loadVault,
  removeUser,
  revokeToken,
  tokenId,
} from '../vault';
import { apiError, bodyOf, requireApiAuth, sendOpError, stringField } from './auth';

// Administration: users, their tokens, collections, and the vault's own settings.
//
// Reading a user's tokens never returns a token. Only a SHA-256 hash is stored, so
// there is nothing to return even if it were a good idea; what a caller gets is an
// id, a creation time, and a scope, which is enough to revoke one.

export function registerAdminApi(
  app: Express,
  root: string,
  limiter: AuthLimiter,
  lfs: LfsContext | null = null,
  engine?: CiEngine,
  egress?: Egress
): void {
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

  /**
   * Rename a collection, with everything in it. The same operation the web
   * offers on a collection's settings page, and the same two questions: admin
   * scope over what is moving, which for a collection means every repository
   * in it, and push scope over where it lands.
   *
   * Unlike a repository rename this is not offered under a typed
   * confirmation, here or on the web. A rename is undone by renaming back, and
   * the confirmation belongs to deletion.
   */
  app.post('/api/collections/:name/rename', async (req, res) => {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return;
    const name = req.params.name;
    if (!isValidName(name)) {
      apiError(res, 400, 'that is not a usable collection name');
      return;
    }
    let isDir = false;
    try {
      isDir = fs.statSync(collectionDir(root, name)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      apiError(res, 404, `no collection ${name} in this vault`);
      return;
    }
    const repos = listRepoDirs(root, name).map(displayName);
    if (!canAdminCollection(auth, name, repos)) {
      apiError(res, 403, `your admin scope does not cover ${name} and everything in it`);
      return;
    }
    const to = stringField(bodyOf(req), 'name')?.trim() ?? '';
    if (!isValidName(to)) {
      apiError(res, 400, 'a valid "name" is required (letters, digits, dot, underscore, dash; not a reserved word)');
      return;
    }
    // Every repository lands in the new collection, so push scope has to cover
    // each of them there; an empty collection is the weaker question
    // canCreateCollection answers.
    const unpushable = repos.filter((r) => !canPush(auth, to, r));
    if (unpushable.length > 0 || !canCreateCollection(auth, to)) {
      const what = unpushable.length > 0 ? `${to}/${unpushable[0]}` : to;
      apiError(res, 403, `your push scope does not cover ${what}`);
      return;
    }
    try {
      // The engine indexes runs under each repository's old identity; drop
      // them before the directories move out from under it.
      for (const repo of repos) engine?.forgetRepo(name, repo);
      await renameCollection(root, name, to, lfs?.store);
      res.json({ name: to, renamedFrom: name, repos: repos.length, renamed: true });
    } catch (e) {
      sendOpError(res, e, 'could not rename the collection');
    }
  });

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
    const dir = collectionDir(root, name);
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
    // Empty means the collection holds nothing but its own empty repos
    // directory: no repository, nothing beside one, and nothing of the
    // collection's own.
    const repos = reposDir(root, name);
    const own = fs.readdirSync(dir).filter((n) => n !== REPOS_DIR);
    const inRepos = fs.existsSync(repos) ? fs.readdirSync(repos) : [];
    if (own.length > 0 || inRepos.length > 0) {
      apiError(res, 409, `collection ${name} is not empty`);
      return;
    }
    try {
      fs.rmSync(dir, { recursive: true });
    } catch (e) {
      apiError(res, 409, `could not remove ${name}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // Any redirect that led here goes with it. A collection created later
    // under this name would otherwise inherit the traffic a former name of
    // this one still sends.
    forgetCollectionRedirects(root, name);
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
    const changes: { theme?: string; ci?: CiConfig; sites?: SitesConfig; limits?: LimitsConfig } = {};
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
    // The hostname whose subdomains serve repository sites. Every reader of it
    // calls loadConfig per request, so a change here is in effect on the next
    // one; it is the setting a hosted vault most needs to change, and reaching a
    // volume to edit config.json by hand is the worst step in that whole path.
    if (body.sites !== undefined) {
      if (typeof body.sites !== 'object' || body.sites === null || Array.isArray(body.sites)) {
        apiError(res, 400, '"sites" must be an object');
        return;
      }
      const sites = body.sites as Record<string, unknown>;
      if (typeof sites.host !== 'string') {
        apiError(res, 400, '"sites" takes a "host" string; send "" to serve sites on the forge host again');
        return;
      }
      const host = normalizeHostname(sites.host);
      // loadConfig ignores a value that is not a hostname and uses the default,
      // which is right for a hand-edited file and wrong here: a caller who just
      // asked for a change should be told it was not one, rather than reading
      // back a value they did not send.
      if (host !== '' && !isPlausibleHostname(host)) {
        apiError(
          res,
          400,
          `"${sites.host}" is not a hostname: give at least two labels of letters, digits, and interior hyphens, ` +
            'with no scheme, port, or path'
        );
        return;
      }
      changes.sites = { host };
    }
    // One field of the limits block is writable, and only the one: the daily
    // egress cap is read per request, so a change to it is in force on the next
    // one. The rest of the block is read at startup, so a route that changed it
    // would report a change the running server had not made.
    //
    // The whole block is written back, merged over what is on disk, because
    // saveConfig replaces a top-level key rather than merging into it.
    if (body.limits !== undefined) {
      if (typeof body.limits !== 'object' || body.limits === null || Array.isArray(body.limits)) {
        apiError(res, 400, '"limits" must be an object');
        return;
      }
      const limits = body.limits as Record<string, unknown>;
      const unknown = Object.keys(limits).filter((k) => k !== 'egressGbPerDay');
      if (unknown.length > 0) {
        apiError(
          res,
          400,
          `only "egressGbPerDay" can be set here; ${unknown.join(', ')} ${
            unknown.length === 1 ? 'is' : 'are'
          } read when the server starts, so edit config.json in the vault and restart`
        );
        return;
      }
      const gb = limits.egressGbPerDay;
      if (typeof gb !== 'number' || !Number.isFinite(gb) || gb < 0) {
        apiError(res, 400, '"egressGbPerDay" must be a number of gigabytes, 0 to send without a daily limit');
        return;
      }
      changes.limits = { ...loadConfig(root).limits, egressGbPerDay: gb };
    }
    if (Object.keys(changes).length === 0) {
      apiError(res, 400, 'nothing to change; provide "theme", "ci", "sites", and/or "limits"');
      return;
    }
    // network is deliberately not writable here, and neither is the rest of
    // limits: both are read once at startup, so a route that changed them would
    // report a change the running server had not made. docs/deploying.md says to
    // edit config.json and restart.
    res.json(saveConfig(root, changes));
  });

  // ---- outgoing bytes ----

  /**
   * What the vault has sent today, per repository, and what it sent on the days
   * before. The same numbers /admin/egress shows, for anyone who would rather
   * watch a bill from a script.
   *
   * Owner scope, like the rest of the vault's own settings: the breakdown says
   * which repositories are being read and how heavily, which is more than a
   * collection administrator is owed about a collection that is not theirs.
   */
  app.get('/api/egress', (req, res) => {
    const auth = requireOwner(req, res);
    if (!auth) return;
    if (!egress) {
      apiError(res, 503, 'this server is not counting outgoing bytes');
      return;
    }
    const snap = egress.snapshot();
    res.json({
      ...snap,
      // Said here as well as on the page: a caller adding these numbers up
      // against a hosting bill needs to know what is missing from them.
      lfsBucketExcluded: lfs?.offloaded ?? false,
    });
  });
}
