import { Express, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { GitRepo, isValidRefName, isValidRepoPath } from './git';
import { isMarkdownFile, renderMarkdown } from './markdown';
import { esc, highlightCode, isBinary } from './render';
import { renderDiff } from './diff';
import { displayName, isValidName, listOrgs, listRepoDirs, pagesDir, repoDescription } from './scan';
import { findRepo } from './scan';
import { getViewer } from './session';
import * as views from './views';
import { encPath, repoUrl } from './views';
import { LoadedRepo, ah, loadRepo, makeCtx, send404, wildcard } from './web';

const COMMITS_PER_PAGE = 35;
const MAX_RENDER_SIZE = 1024 * 1024;

export const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

export function registerBrowse(app: Express, root: string): void {
  app.get('/', (req, res) => {
    res.type('html').send(views.homePage(root, listOrgs(root), getViewer(req, root)));
  });

  app.get(
    '/:org',
    ah(async (req, res) => {
      const org = req.params.org;
      const viewer = getViewer(req, root);
      let orgIsDir = false;
      try {
        orgIsDir = fs.statSync(path.join(root, org)).isDirectory();
      } catch {
        orgIsDir = false;
      }
      if (!isValidName(org) || !orgIsDir) {
        send404(res, `Organization ${org} not found`, viewer);
        return;
      }
      const dirs = listRepoDirs(root, org);
      const repos = await Promise.all(
        dirs.map(async (d) => {
          const repo = new GitRepo(`${root}/${org}/${d}`, org, displayName(d));
          return {
            name: displayName(d),
            description: repoDescription(repo.dir),
            updated: await repo.lastUpdated(),
          };
        })
      );
      res.type('html').send(views.orgPage(org, repos, viewer));
    })
  );

  async function renderTree(req: Request, res: Response, loaded: LoadedRepo, ref: string, treePath: string) {
    const viewer = getViewer(req, root);
    const ctx = makeCtx(root, req, loaded, ref, viewer);
    let entries;
    try {
      entries = await loaded.repo.listTree(ref, treePath);
    } catch {
      send404(res, `Path ${treePath || '/'} not found at ${ref}`, viewer);
      return;
    }
    const latest = (await loaded.repo.log(ref, 0, 1, treePath || undefined))[0] ?? null;
    let readmeHtml: string | null = null;
    let readmeName: string | null = null;
    const readme = entries.find((e) => e.type === 'blob' && /^readme(\.(md|markdown|txt))?$/i.test(e.name));
    if (readme && (readme.size ?? 0) <= MAX_RENDER_SIZE) {
      const readmePath = treePath === '' ? readme.name : `${treePath}/${readme.name}`;
      const buf = await loaded.repo.catBlob(ref, readmePath);
      if (!isBinary(buf)) {
        const text = buf.toString('utf8');
        readmeName = readme.name;
        const base = repoUrl(ctx);
        const dirSuffix = treePath === '' ? '' : `/${encPath(treePath)}`;
        if (/\.(md|markdown)$/i.test(readme.name) || !readme.name.includes('.')) {
          readmeHtml = renderMarkdown(text, {
            rawBase: `${base}/raw/${encPath(ref)}${dirSuffix}`,
            blobBase: `${base}/blob/${encPath(ref)}${dirSuffix}`,
          });
        } else {
          readmeHtml = `<pre>${esc(text)}</pre>`;
        }
      }
    }
    res.type('html').send(views.treePage(ctx, treePath, entries, latest, readmeHtml, readmeName));
  }

  app.get(
    '/:org/:repo',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      if (!loaded.defaultBranch) {
        res.type('html').send(views.emptyRepoPage(makeCtx(root, req, loaded, '', viewer)));
        return;
      }
      await renderTree(req, res, loaded, loaded.defaultBranch, '');
    })
  );

  app.get(
    '/:org/:repo/tree/*',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const { ref, path: treePath } = loaded.repo.resolveRefAndPath(wildcard(req), loaded.refNames);
      if (!isValidRefName(ref) || !isValidRepoPath(treePath)) {
        send404(res, 'Not found', viewer);
        return;
      }
      if (treePath !== '') {
        const type = await loaded.repo.entryType(ref, treePath);
        if (type === 'blob') {
          res.redirect(`${repoUrl(makeCtx(root, req, loaded, ref, viewer))}/blob/${encPath(ref)}/${encPath(treePath)}`);
          return;
        }
      }
      await renderTree(req, res, loaded, ref, treePath);
    })
  );

  app.get(
    '/:org/:repo/blob/*',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const { ref, path: filePath } = loaded.repo.resolveRefAndPath(wildcard(req), loaded.refNames);
      if (!isValidRefName(ref) || !isValidRepoPath(filePath) || filePath === '') {
        send404(res, 'Not found', viewer);
        return;
      }
      const ctx = makeCtx(root, req, loaded, ref, viewer);
      const type = await loaded.repo.entryType(ref, filePath);
      if (type === 'tree') {
        res.redirect(`${repoUrl(ctx)}/tree/${encPath(ref)}/${encPath(filePath)}`);
        return;
      }
      if (type !== 'blob') {
        send404(res, `File ${filePath} not found at ${ref}`, viewer);
        return;
      }
      const buf = await loaded.repo.catBlob(ref, filePath);
      const ext = (filePath.split('.').pop() ?? '').toLowerCase();
      const rawUrl = `${repoUrl(ctx)}/raw/${encPath(ref)}/${encPath(filePath)}`;
      if (IMAGE_TYPES[ext]) {
        res.type('html').send(views.blobPage(ctx, filePath, { kind: 'image', rawUrl, size: buf.length }));
        return;
      }
      if (isBinary(buf)) {
        res.type('html').send(views.blobPage(ctx, filePath, { kind: 'binary', rawUrl, size: buf.length }));
        return;
      }
      if (buf.length > MAX_RENDER_SIZE) {
        res.type('html').send(views.blobPage(ctx, filePath, { kind: 'too-large', rawUrl, size: buf.length }));
        return;
      }
      const text = buf.toString('utf8');
      const editable = ctx.canPush && ctx.refIsBranch;
      const markdown = isMarkdownFile(filePath);
      // Markdown renders by default; ?plain=1 asks for the source, as on GitHub.
      if (markdown && req.query.plain !== '1') {
        const dir = filePath.includes('/') ? `/${encPath(filePath.slice(0, filePath.lastIndexOf('/')))}` : '';
        const html = renderMarkdown(text, {
          rawBase: `${repoUrl(ctx)}/raw/${encPath(ref)}${dir}`,
          blobBase: `${repoUrl(ctx)}/blob/${encPath(ref)}${dir}`,
        });
        res
          .type('html')
          .send(views.blobPage(ctx, filePath, { kind: 'markdown', html, size: buf.length, editable }, true));
        return;
      }
      const html = highlightCode(text, filePath);
      const lineCount = text === '' ? 1 : text.replace(/\n$/, '').split('\n').length;
      res
        .type('html')
        .send(
          views.blobPage(ctx, filePath, { kind: 'code', html, lineCount, size: buf.length, editable }, markdown)
        );
    })
  );

  app.get(
    '/:org/:repo/raw/*',
    ah(async (req, res) => {
      const loaded = await loadRepo(root, req, res, null);
      if (!loaded) return;
      const { ref, path: filePath } = loaded.repo.resolveRefAndPath(wildcard(req), loaded.refNames);
      if (!isValidRefName(ref) || !isValidRepoPath(filePath) || filePath === '') {
        send404(res);
        return;
      }
      const type = await loaded.repo.entryType(ref, filePath);
      if (type !== 'blob') {
        res.status(404).type('text/plain').send('not found');
        return;
      }
      const buf = await loaded.repo.catBlob(ref, filePath);
      const ext = (filePath.split('.').pop() ?? '').toLowerCase();
      // Repository content must never be able to inject HTML into this
      // origin: non-image types are served as text/plain in a sandbox.
      res.setHeader('Content-Security-Policy', 'sandbox');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (IMAGE_TYPES[ext]) {
        res.type(IMAGE_TYPES[ext]);
      } else if (isBinary(buf)) {
        res.type('application/octet-stream');
      } else {
        res.type('text/plain; charset=utf-8');
      }
      res.send(buf);
    })
  );

  app.get('/:org/:repo/commits', (req, res) => {
    res.redirect(`/${encodeURIComponent(req.params.org)}/${encodeURIComponent(req.params.repo)}`);
  });

  app.get(
    '/:org/:repo/commits/*',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const { ref, path: rest } = loaded.repo.resolveRefAndPath(wildcard(req), loaded.refNames);
      if (!isValidRefName(ref) || rest !== '') {
        send404(res, 'Not found', viewer);
        return;
      }
      const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
      let total: number;
      try {
        total = await loaded.repo.commitCount(ref);
      } catch {
        send404(res, `Ref ${ref} not found`, viewer);
        return;
      }
      const totalPages = Math.max(1, Math.ceil(total / COMMITS_PER_PAGE));
      const commits = await loaded.repo.log(ref, (page - 1) * COMMITS_PER_PAGE, COMMITS_PER_PAGE);
      res
        .type('html')
        .send(views.commitsPage(makeCtx(root, req, loaded, ref, viewer), commits, page, totalPages, total));
    })
  );

  app.get(
    '/:org/:repo/commit/:sha',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const sha = req.params.sha;
      if (!/^[0-9a-f]{4,40}$/i.test(sha)) {
        send404(res, 'Not found', viewer);
        return;
      }
      const detail = await loaded.repo.commit(sha);
      if (!detail) {
        send404(res, `Commit ${sha} not found`, viewer);
        return;
      }
      const patch = await loaded.repo.commitPatch(detail.sha);
      const ctx = makeCtx(root, req, loaded, loaded.defaultBranch ?? detail.sha, viewer);
      res.type('html').send(views.commitPage(ctx, detail, renderDiff(patch)));
    })
  );

  app.get(
    '/:org/:repo/branches',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      res.type('html').send(views.refListPage(ctx, 'branches'));
    })
  );

  app.get(
    '/:org/:repo/tags',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      res.type('html').send(views.refListPage(ctx, 'tags'));
    })
  );

  app.get(
    '/:org/:repo/pages/*',
    ah(async (req, res) => {
      const repo = findRepo(root, req.params.org, req.params.repo);
      if (!repo) {
        send404(res, `Repository ${req.params.org}/${req.params.repo} not found`);
        return;
      }
      const dir = pagesDir(root, repo.org, repo.name);
      if (!dir) {
        send404(
          res,
          `No pages site for ${repo.org}/${repo.name}. Create a ${repo.name}.pages directory next to the repository, with an index.html at its root.`
        );
        return;
      }
      const segs = wildcard(req)
        .split('/')
        .filter((s) => s !== '' && s !== '.');
      if (segs.some((s) => s === '..' || s.includes('\0'))) {
        send404(res);
        return;
      }
      let target = path.join(dir, ...segs);
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(target);
      } catch {
        stat = null;
      }
      if (stat && stat.isDirectory()) {
        if (!req.path.endsWith('/')) {
          res.redirect(`${req.path}/`);
          return;
        }
        target = path.join(target, 'index.html');
        try {
          stat = fs.statSync(target);
        } catch {
          stat = null;
        }
      }
      if (!stat || !stat.isFile()) {
        const notFound = path.join(dir, '404.html');
        if (fs.existsSync(notFound)) {
          res.status(404).sendFile(notFound);
        } else {
          send404(res, 'Page not found in this pages site');
        }
        return;
      }
      res.sendFile(target);
    })
  );

  app.get('/:org/:repo/pages', (req, res) => {
    res.redirect(
      `/${encodeURIComponent(req.params.org)}/${encodeURIComponent(displayName(req.params.repo))}/pages/`
    );
  });
}
