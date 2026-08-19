import express, { NextFunction, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { registerApi } from './api';
import { registerBrowse } from './browse';
import { registerCiApi } from './ci/api';
import { CiEngine } from './ci/engine';
import { registerCiWeb } from './ci/web';
import { loadConfig } from './config';
import { clientKey, createAuthLimiter, createGates, createLimiter } from './limit';
import { registerCompare } from './compare';
import { registerFind, registerSearch } from './find';
import { registerIssues } from './issueweb';
import { registerGitHttp } from './githttp';
import { registerLfs } from './lfs';
import { registerPulls } from './pullweb';
import { registerReleases } from './releases';
import { createLfsStore } from './lfsstore';
import { faviconSvg } from './logo';
import { getViewer } from './session';
import { registerSiteHost } from './site';
import { isUnderSitesHost } from './siteshost';
import { CSS } from './style';
import { activeTheme, setActiveTheme, themeVarsCss } from './themes';
import * as views from './views';
import { registerWebOps } from './webops';

// Exempt from the coarse ceiling, checked before anything is charged.
//
// /api/runner/* because the runner's long poll and its log posts are
// legitimately high-volume from one address, and a runner sharing an address
// with a person must not throttle either. The assets because they are served
// from memory or a package directory and are cheaper to answer than to count.
//
// The asset prefixes are exempt on the forge's own hostname only: on a sites
// hostname those paths belong to the site being served, and are ordinary traffic.
function isRateExempt(root: string, req: Request): boolean {
  if (req.path.startsWith('/api/runner/')) return true;
  if (isUnderSitesHost(loadConfig(root).sites.host, req.hostname)) return false;
  return req.path.startsWith('/assets/') || req.path === '/favicon.svg' || req.path === '/favicon.ico';
}

export function createApp(root: string) {
  const app = express();
  app.disable('x-powered-by');
  const config = loadConfig(root);
  // Behind a TLS proxy (Caddy, Fly, etc.) X-Forwarded-Proto/Host must win, or
  // clone URLs and Secure cookies would use the internal address. On a vault
  // exposed directly they must not: req.ip would then be read from a
  // client-supplied X-Forwarded-For, which defeats every per-address limit and
  // makes the limiter's own key space unbounded.
  //
  // Read once at startup rather than per request, unlike the theme and the CI
  // settings. Express resolves 'trust proxy' when the Request prototype is
  // built, so it is not a per-request decision to make, and changing whether the
  // internet is trusted is a restart-worthy event in a way that changing a
  // colour scheme is not. The same goes for the limits below, which hold live
  // counts that cannot be rebuilt per request without discarding them.
  app.set('trust proxy', config.network.trustProxy);

  const gates = createGates(config.limits);
  const authLimiter = createAuthLimiter(config.limits.authFailures);
  const requestLimiter = createLimiter({
    limit: config.limits.requestsPerMinute,
    windowMs: 60000,
    maxKeys: 20000,
  });

  // The theme is vault state, so it is re-read (stat-cached) per request:
  // hand-editing config.json takes effect without a restart.
  app.use((_req, _res, next) => {
    setActiveTheme(loadConfig(root).theme);
    next();
  });

  // The bluntest of the three limits: a ceiling on ordinary traffic, so that one
  // misbehaving crawler cannot saturate the process with cheap page renders. It
  // is high on purpose. One page load of a static site can be dozens of requests,
  // and a limit that makes a site feel broken will be turned off and take the
  // useful limits with it.
  //
  // Registered before the sites middleware, so that traffic to a site's own
  // hostname is counted too, which is exactly where a burst of requests per page
  // comes from.
  app.use((req, res, next) => {
    if (isRateExempt(root, req)) return next();
    const decision = requestLimiter.hit(clientKey(req));
    if (decision.ok) return next();
    res.status(429).setHeader('Retry-After', String(decision.retryAfter));
    res
      .type('html')
      .send(views.errorPage(429, 'Too many requests from this address. Try again in a moment.', { viewer: null }));
  });

  // Sites served from their own hostname are answered before every other route,
  // the asset routes included: otherwise /assets/style.css would give a site the
  // forge's stylesheet instead of its own, and /favicon.svg the forge's icon.
  // Nothing here runs unless a sites host is configured.
  registerSiteHost(app, root);

  // ---- static assets ----

  const hlCache = new Map<string, string>();
  app.get('/assets/style.css', (_req, res) => {
    const theme = activeTheme();
    res.type('text/css').set('Cache-Control', 'no-cache').send(themeVarsCss(theme) + CSS);
  });
  app.get('/assets/hl.css', (_req, res) => {
    // The name comes from the theme table, never from the request.
    const name = activeTheme().hljs;
    let css = hlCache.get(name);
    if (css === undefined) {
      try {
        css = fs.readFileSync(require.resolve(`highlight.js/styles/${name}.css`), 'utf8');
      } catch {
        css = '';
      }
      hlCache.set(name, css);
    }
    res.type('text/css').set('Cache-Control', 'no-cache').send(css);
  });
  // KaTeX ships the stylesheet and fonts its output needs; serving them from
  // the installed package keeps rendered math working with no external
  // requests, which matters for vaults on closed networks.
  const katexDir = path.dirname(require.resolve('katex/dist/katex.min.css'));
  let katexCss: string | null = null;
  app.get('/assets/katex/katex.css', (_req, res) => {
    if (katexCss === null) katexCss = fs.readFileSync(path.join(katexDir, 'katex.min.css'), 'utf8');
    res.type('text/css').set('Cache-Control', 'public, max-age=86400').send(katexCss);
  });
  app.get('/assets/katex/fonts/:file', (req, res) => {
    // The request never reaches the filesystem unless it names a KaTeX font.
    if (!/^KaTeX_[A-Za-z0-9]+-[A-Za-z]+\.(woff2|woff|ttf)$/.test(req.params.file)) {
      res.status(404).end();
      return;
    }
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(path.join(katexDir, 'fonts', req.params.file));
  });
  // The favicon is the logo mark on a tile coloured from the active theme, so
  // it changes with the vault's appearance. Browsers that will not take an SVG
  // icon fall back to /favicon.ico, which stays empty.
  app.get('/favicon.svg', (_req, res) => {
    res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(faviconSvg());
  });
  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  // The LFS store is built from the environment once at startup; a partial
  // bucket configuration throws here, which the CLI turns into a non-zero
  // exit naming the missing variables.
  const lfs = createLfsStore(root);
  console.log(`Git LFS storage backend: ${lfs.label}`);

  // The CI engine plans and schedules workflow runs; jobs execute on runners
  // elsewhere (cofferdam runner run), never in this process.
  const engine = new CiEngine(root, () => loadConfig(root).ci);

  // Registration order matters: the API and the UI-owned top-level paths
  // (/login, /new, /admin, ...) come before the generic /:collection and /:collection/:repo
  // browse routes, and more-specific wildcard routes before their prefixes.
  // LFS registers before git HTTP so its /info/lfs/* routes are matched ahead
  // of any /info/refs handling.
  registerApi(app, root, authLimiter, gates, engine);
  registerCiApi(app, root, engine, authLimiter);
  registerLfs(app, root, lfs, authLimiter);
  registerGitHttp(app, root, gates, authLimiter, engine);
  registerCiWeb(app, root, engine);
  registerWebOps(app, root, authLimiter, lfs, engine);
  registerCompare(app, root);
  registerIssues(app, root);
  registerPulls(app, root, engine);
  registerReleases(app, root);
  registerFind(app, root, gates);
  registerSearch(app, root, gates);
  registerBrowse(app, root, gates, lfs);

  app.use((req, res) => {
    res.status(404).type('html').send(views.errorPage(404, 'Page not found', { viewer: getViewer(req, root) }));
  });

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    if (!res.headersSent) {
      let viewer = null;
      try {
        viewer = getViewer(req, root);
      } catch {
        viewer = null;
      }
      res.status(500).type('html').send(views.errorPage(500, 'Internal server error', { viewer }));
    } else {
      res.end();
    }
  });

  return app;
}
