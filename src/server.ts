import express, { NextFunction, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { registerApi } from './api';
import { registerBrowse } from './browse';
import { registerCiApi } from './ci/api';
import { CiEngine } from './ci/engine';
import { registerCiWeb } from './ci/web';
import { loadConfig } from './config';
import { registerCompare } from './compare';
import { registerFind, registerSearch } from './find';
import { registerGitHttp } from './githttp';
import { registerLfs } from './lfs';
import { createLfsStore } from './lfsstore';
import { faviconSvg } from './logo';
import { getViewer } from './session';
import { CSS } from './style';
import { activeTheme, setActiveTheme, themeVarsCss } from './themes';
import * as views from './views';
import { registerWebOps } from './webops';

export function createApp(root: string) {
  const app = express();
  app.disable('x-powered-by');
  // Behind a TLS proxy (Caddy, Fly, etc.) X-Forwarded-Proto/Host must win,
  // or clone URLs and Secure cookies would use the internal address.
  app.set('trust proxy', true);

  // The theme is vault state, so it is re-read (stat-cached) per request:
  // hand-editing config.json takes effect without a restart.
  app.use((_req, _res, next) => {
    setActiveTheme(loadConfig(root).theme);
    next();
  });

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
  // elsewhere (hubbit runner run), never in this process.
  const engine = new CiEngine(root, () => loadConfig(root).ci);

  // Registration order matters: the API and the UI-owned top-level paths
  // (/login, /new, /admin, ...) come before the generic /:collection and /:collection/:repo
  // browse routes, and more-specific wildcard routes before their prefixes.
  // LFS registers before git HTTP so its /info/lfs/* routes are matched ahead
  // of any /info/refs handling.
  registerApi(app, root);
  registerCiApi(app, root, engine);
  registerLfs(app, root, lfs);
  registerGitHttp(app, root, engine);
  registerCiWeb(app, root, engine);
  registerWebOps(app, root, lfs, engine);
  registerCompare(app, root);
  registerFind(app, root);
  registerSearch(app, root);
  registerBrowse(app, root, lfs);

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
