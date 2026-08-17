import express, { NextFunction, Request, Response } from 'express';
import * as fs from 'fs';
import { registerApi } from './api';
import { registerBrowse } from './browse';
import { registerGitHttp } from './githttp';
import { getViewer } from './session';
import { CSS } from './style';
import * as views from './views';
import { registerWebOps } from './webops';

export function createApp(root: string) {
  const app = express();
  app.disable('x-powered-by');
  // Behind a TLS proxy (Caddy, Fly, etc.) X-Forwarded-Proto/Host must win,
  // or clone URLs and Secure cookies would use the internal address.
  app.set('trust proxy', true);

  // ---- static assets ----

  let hlCss: string | null = null;
  app.get('/assets/style.css', (_req, res) => {
    res.type('text/css').send(CSS);
  });
  app.get('/assets/hl.css', (_req, res) => {
    if (hlCss === null) {
      try {
        hlCss = fs.readFileSync(require.resolve('highlight.js/styles/github.css'), 'utf8');
      } catch {
        hlCss = '';
      }
    }
    res.type('text/css').send(hlCss);
  });
  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  // Registration order matters: the API and the UI-owned top-level paths
  // (/login, /new, /admin, ...) come before the generic /:org and /:org/:repo
  // browse routes, and more-specific wildcard routes before their prefixes.
  registerApi(app, root);
  registerGitHttp(app, root);
  registerWebOps(app, root);
  registerBrowse(app, root);

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
