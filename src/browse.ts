import { Express, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { GitRepo, isValidRefName, isValidRepoPath } from './git';
import { languageBreakdown } from './languages';
import { LfsContext } from './lfsstore';
import { isMarkdownFile, renderMarkdown } from './markdown';
import { parsePointer } from './pointer';
import { esc, highlightCode, isBinary } from './render';
import { atomFeed } from './atom';
import { renderDiff } from './diff';
import { displayName, isValidName, listCollections, listRepoDirs, repoDescription, siteDir } from './scan';
import { findRepo } from './scan';
import { getViewer } from './session';
import * as views from './views';
import { encPath, repoUrl } from './views';
import { LoadedRepo, ah, baseUrlOf, loadRepo, makeCtx, send404, wildcard } from './web';

const COMMITS_PER_PAGE = 35;
const MAX_RENDER_SIZE = 1024 * 1024;
const MAX_LISTED_COMMITS = 250;

const ARCHIVE_FORMATS: Record<string, { format: 'tar.gz' | 'zip'; type: string }> = {
  'tar.gz': { format: 'tar.gz', type: 'application/gzip' },
  tgz: { format: 'tar.gz', type: 'application/gzip' },
  zip: { format: 'zip', type: 'application/zip' },
};

export const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

export function registerBrowse(app: Express, root: string, lfs: LfsContext | null = null): void {
  app.get('/', (req, res) => {
    res.type('html').send(views.homePage(root, listCollections(root), getViewer(req, root)));
  });

  app.get(
    '/:collection',
    ah(async (req, res) => {
      const collection = req.params.collection;
      const viewer = getViewer(req, root);
      let collectionIsDir = false;
      try {
        collectionIsDir = fs.statSync(path.join(root, collection)).isDirectory();
      } catch {
        collectionIsDir = false;
      }
      if (!isValidName(collection) || !collectionIsDir) {
        send404(res, `Collection ${collection} not found`, viewer);
        return;
      }
      const dirs = listRepoDirs(root, collection);
      const repoList = await Promise.all(
        dirs.map(async (d) => {
          const repo = new GitRepo(`${root}/${collection}/${d}`, collection, displayName(d));
          return {
            name: displayName(d),
            description: repoDescription(repo.dir),
            updated: await repo.lastUpdated(),
          };
        })
      );
      res.type('html').send(views.collectionPage(collection, repoList, viewer));
    })
  );

  async function renderTree(req: Request, res: Response, loaded: LoadedRepo, ref: string, treePath: string) {
    const viewer = getViewer(req, root);
    const ctx = await makeCtx(root, req, loaded, ref, viewer);
    let entries;
    try {
      entries = await loaded.repo.listTree(ref, treePath);
    } catch {
      send404(res, `Path ${treePath || '/'} not found at ${ref}`, viewer);
      return;
    }
    // The listing wants a commit per entry, which is a git log per entry: cheap
    // for the directory sizes people browse, and capped so that an unusually
    // wide one degrades into a listing without the message and age columns
    // rather than into a page that takes a second to build.
    const entryPaths = entries
      .slice(0, MAX_LISTED_COMMITS)
      .map((e) => (treePath === '' ? e.name : `${treePath}/${e.name}`));
    // The language breakdown reads the whole tree, so it is measured only at
    // the root, which is the only place the About panel that shows it appears.
    const [latest, entryCommits, commitCount, languages, contributors] = await Promise.all([
      loaded.repo.log(ref, 0, 1, treePath || undefined).then((cs) => cs[0] ?? null),
      loaded.repo.lastCommits(ref, entryPaths),
      loaded.repo.commitCount(ref).catch(() => 0),
      treePath === '' ? languageBreakdown(loaded.repo.dir, ref) : Promise.resolve([]),
      treePath === '' ? loaded.repo.contributors(ref) : Promise.resolve([]),
    ]);
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
    res.type('html').send(
      views.treePage(ctx, {
        path: treePath,
        entries,
        entryCommits,
        latest,
        commitCount,
        description: repoDescription(loaded.repo.dir),
        contributors,
        readmeHtml,
        readmeName,
        languages,
      })
    );
  }

  app.get(
    '/:collection/:repo',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      if (!loaded.defaultBranch) {
        res.type('html').send(views.emptyRepoPage(await makeCtx(root, req, loaded, '', viewer)));
        return;
      }
      await renderTree(req, res, loaded, loaded.defaultBranch, '');
    })
  );

  app.get(
    '/:collection/:repo/tree/*',
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
          res.redirect(`${repoUrl(await makeCtx(root, req, loaded, ref, viewer))}/blob/${encPath(ref)}/${encPath(treePath)}`);
          return;
        }
      }
      await renderTree(req, res, loaded, ref, treePath);
    })
  );

  app.get(
    '/:collection/:repo/blob/*',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const { ref, path: filePath } = loaded.repo.resolveRefAndPath(wildcard(req), loaded.refNames);
      if (!isValidRefName(ref) || !isValidRepoPath(filePath) || filePath === '') {
        send404(res, 'Not found', viewer);
        return;
      }
      const ctx = await makeCtx(root, req, loaded, ref, viewer);
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
      // LFS pointer detection precedes every content branch: an LFS-tracked
      // .md or .png must render as a download card, not as its pointer text.
      // ?plain=1 falls through to the source view, as on GitHub, keeping the
      // underlying pointer inspectable.
      const pointer = parsePointer(buf);
      if (pointer) {
        if (req.query.plain !== '1') {
          res
            .type('html')
            .send(
              views.blobPage(ctx, filePath, { kind: 'lfs', rawUrl, size: pointer.size, oid: pointer.oid }, true)
            );
          return;
        }
        // ?plain=1 shows the pointer itself, whatever the file is named: an
        // LFS-tracked .png must not be rendered from its pointer text as an
        // image, or the source view would be unreachable for it. Pointers are
        // never editable, so no edit controls here.
        const src = buf.toString('utf8');
        res.type('html').send(
          views.blobPage(
            ctx,
            filePath,
            {
              kind: 'code',
              html: esc(src),
              lineCount: src.replace(/\n$/, '').split('\n').length,
              size: buf.length,
              editable: false,
            },
            true
          )
        );
        return;
      }
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

  // Blame: who last changed each line, and the way back to the revision
  // before that change. Only for a file we would show as text anyway; the
  // rest redirect to the blob page, which explains what they are.
  app.get(
    '/:collection/:repo/blame/*',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const { ref, path: filePath } = loaded.repo.resolveRefAndPath(wildcard(req), loaded.refNames);
      if (!isValidRefName(ref) || !isValidRepoPath(filePath) || filePath === '') {
        send404(res, 'Not found', viewer);
        return;
      }
      const ctx = await makeCtx(root, req, loaded, ref, viewer);
      const blobUrl = `${repoUrl(ctx)}/blob/${encPath(ref)}/${encPath(filePath)}`;
      if ((await loaded.repo.entryType(ref, filePath)) !== 'blob') {
        send404(res, `File ${filePath} not found at ${ref}`, viewer);
        return;
      }
      const buf = await loaded.repo.catBlob(ref, filePath);
      if (isBinary(buf) || buf.length > MAX_RENDER_SIZE) {
        res.redirect(blobUrl);
        return;
      }
      const lines = await loaded.repo.blame(ref, filePath);
      const text = lines.map((l) => l.text).join('\n');
      res.type('html').send(views.blamePage(ctx, filePath, highlightCode(text, filePath), lines, buf.length));
    })
  );

  app.get(
    '/:collection/:repo/raw/*',
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
      // A pointer blob redirects to the stored object; the filename gives the
      // browser something better to save than a 64-character object id.
      const pointer = parsePointer(buf);
      if (pointer && lfs) {
        const info = await lfs.store.head(loaded.repo.collection, loaded.repo.name, pointer.oid);
        if (!info) {
          res
            .status(404)
            .type('text/plain')
            .send(
              'This file is stored with Git LFS, but its object is missing from storage (the commits were pushed without pushing the LFS objects).\n'
            );
          return;
        }
        const dl = await lfs.store.signDownload(loaded.repo.collection, loaded.repo.name, pointer.oid, {
          filename: filePath.split('/').pop(),
        });
        res.redirect(302, dl.href);
        return;
      }
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

  // Source downloads, as GitHub's Code button offers them: the extension on
  // the URL picks the format and the rest of it is the ref.
  app.get(
    '/:collection/:repo/archive/*',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const m = wildcard(req).match(/^(.+)\.(tar\.gz|tgz|zip)$/);
      if (!m) {
        send404(res, 'Ask for an archive as <ref>.tar.gz or <ref>.zip', viewer);
        return;
      }
      const [, ref, ext] = m;
      const spec = ARCHIVE_FORMATS[ext];
      // A ref this repository has, or a commit id: never an arbitrary
      // revision expression out of a URL.
      const known = loaded.refNames.includes(ref) || /^[0-9a-f]{7,40}$/.test(ref);
      if (!isValidRefName(ref) || !known || !(await loaded.repo.resolve(ref))) {
        send404(res, `Ref ${ref} not found`, viewer);
        return;
      }
      const stem = `${loaded.repo.name}-${ref.replace(/\//g, '-')}`;
      res.type(spec.type);
      res.setHeader('Content-Disposition', `attachment; filename="${stem}.${ext}"`);
      try {
        await loaded.repo.archiveTo(ref, spec.format, `${stem}/`, res);
        res.end();
      } catch {
        // The response is already streaming, so there is no status left to
        // send: break the connection rather than finish a truncated archive.
        res.destroy();
      }
    })
  );

  app.get('/:collection/:repo/commits', (req, res) => {
    res.redirect(`/${encodeURIComponent(req.params.collection)}/${encodeURIComponent(req.params.repo)}`);
  });

  app.get(
    '/:collection/:repo/commits/*',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      // A path after the ref narrows the history to that file or directory,
      // which is what the History button on a blob or tree page asks for.
      // A .atom suffix asks for the same history as a feed, as on GitHub.
      const asked = wildcard(req);
      const wantsFeed = asked.endsWith('.atom');
      const { ref, path: histPath } = loaded.repo.resolveRefAndPath(
        wantsFeed ? asked.slice(0, -'.atom'.length) : asked,
        loaded.refNames
      );
      if (!isValidRefName(ref) || !isValidRepoPath(histPath)) {
        send404(res, 'Not found', viewer);
        return;
      }
      const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
      // An author narrows it further: this is where a contributor in the
      // About panel leads, and it is a literal string rather than a pattern.
      const author = String(req.query.author ?? '').slice(0, 200) || undefined;
      let total: number;
      try {
        total = await loaded.repo.commitCount(ref, histPath || undefined, author);
      } catch {
        send404(res, `Ref ${ref} not found`, viewer);
        return;
      }
      const totalPages = Math.max(1, Math.ceil(total / COMMITS_PER_PAGE));
      const commits = await loaded.repo.log(
        ref,
        (page - 1) * COMMITS_PER_PAGE,
        COMMITS_PER_PAGE,
        histPath || undefined,
        author
      );
      if (wantsFeed) {
        const site = `${baseUrlOf(req)}/${encodeURIComponent(loaded.repo.collection)}/${encodeURIComponent(
          loaded.repo.name
        )}`;
        const where = `${encPath(ref)}${histPath ? `/${encPath(histPath)}` : ''}`;
        res.type('application/atom+xml; charset=utf-8').send(
          atomFeed({
            id: `${site}/commits/${where}`,
            title: `${loaded.repo.collection}/${loaded.repo.name}${histPath ? `: ${histPath}` : ''} at ${ref}`,
            selfLink: `${site}/commits/${where}.atom`,
            htmlLink: `${site}/commits/${where}`,
            entries: commits.map((c) => ({
              id: `${site}/commit/${c.sha}`,
              title: c.subject,
              updated: c.date,
              link: `${site}/commit/${c.sha}`,
              author: c.author,
            })),
          })
        );
        return;
      }
      res
        .type('html')
        .send(
          views.commitsPage(await makeCtx(root, req, loaded, ref, viewer), histPath, commits, page, totalPages, total, author)
        );
    })
  );

  app.get(
    '/:collection/:repo/commit/:sha',
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
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? detail.sha, viewer);
      res
        .type('html')
        .send(views.commitPage(ctx, detail, renderDiff(patch, { blobBase: `${repoUrl(ctx)}/blob/${detail.sha}` })));
    })
  );

  app.get(
    '/:collection/:repo/branches',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      res.type('html').send(views.refListPage(ctx, 'branches'));
    })
  );

  app.get(
    '/:collection/:repo/tags',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      res.type('html').send(views.refListPage(ctx, 'tags'));
    })
  );

  app.get(
    '/:collection/:repo/site/*',
    ah(async (req, res) => {
      const repo = findRepo(root, req.params.collection, req.params.repo);
      if (!repo) {
        send404(res, `Repository ${req.params.collection}/${req.params.repo} not found`);
        return;
      }
      const dir = siteDir(root, repo.collection, repo.name);
      if (!dir) {
        send404(
          res,
          `No site for ${repo.collection}/${repo.name}. Create a ${repo.name}.site directory next to the repository, with an index.html at its root.`
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
          send404(res, 'Page not found in this site');
        }
        return;
      }
      res.sendFile(target);
    })
  );

  app.get('/:collection/:repo/site', (req, res) => {
    res.redirect(
      `/${encodeURIComponent(req.params.collection)}/${encodeURIComponent(displayName(req.params.repo))}/site/`
    );
  });
}
