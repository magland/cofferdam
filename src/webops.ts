import express, { Express, Request, Response } from 'express';
import { CiEngine } from './ci/engine';
import { loadConfig, saveConfig } from './config';
import { isValidRefName, isValidRepoPath, isValidSha } from './git';
import { LfsContext } from './lfsstore';
import { looksLikePointer } from './pointer';
import { THEMES, findTheme, setActiveTheme } from './themes';
import * as forms from './forms';
import * as ops from './ops';
import { OpError } from './ops';
import { findRepo, isValidName, listCollections, repoDescription } from './scan';
import {
  Viewer,
  checkCsrf,
  clearSessionCookie,
  getViewer,
  setSessionCookie,
  viewerIsAdmin,
} from './session';
import { authenticate, canAdmin, canPush, loadVault, addUserToken, grantScope } from './vault';
import { encPath, repoUrl } from './views';
import { LoadedRepo, ah, loadRepo, makeCtx, send404, wildcard } from './web';
import { isBinary } from './render';

const MAX_EDIT_SIZE = 1024 * 1024;

// The parsed source is pasted into a command the reader runs in their own
// shell, so the accepted shapes are an allowlist of harmless characters rather
// than a general URL parse: no spaces, quotes, or shell metacharacters can
// survive it.
const HTTPS_SOURCE = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._/-]+$/;
const SSH_SOURCE = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/;
const GITHUB_SHORTHAND = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parseSource(input: string): { url: string; name: string } | null {
  const url = GITHUB_SHORTHAND.test(input) ? `https://github.com/${input}.git` : input;
  if (!HTTPS_SOURCE.test(url) && !SSH_SOURCE.test(url)) return null;
  const tail = url.split(/[/:]/).pop() ?? '';
  const name = tail.replace(/\.git$/i, '');
  return name === '' ? null : { url, name };
}

function urlOf(repo: { collection: string; name: string }): string {
  return repoUrl({ collection: repo.collection, repo: repo.name });
}

// UI operations: every handler here re-derives the actor's abilities from
// live vault.json (via the session cookie) and checks the CSRF field before
// calling into the ops layer. All POSTs follow POST-redirect-GET.

const form = express.urlencoded({ extended: false, limit: '3mb' });

function field(req: Request, name: string): string {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v : '';
}

/**
 * The commit box posts a summary and an optional extended description; git's
 * convention joins them with a blank line. An empty summary falls back to the
 * placeholder the form showed, so a commit is never made with no subject.
 */
function commitMessage(req: Request, fallback: string): string {
  const summary = field(req, 'message').trim() || fallback;
  const description = field(req, 'description').trim();
  return description ? `${summary}\n\n${description}` : summary;
}

function safeNext(v: string): string {
  return v.startsWith('/') && !v.startsWith('//') ? v : '/';
}

function normalizeContent(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function globsField(req: Request, name: string): string[] | null {
  const parts = field(req, name)
    .split(/[\s,]+/)
    .filter((s) => s.length > 0);
  if (parts.some((s) => s.length >= 200)) return null;
  return parts;
}

export function registerWebOps(
  app: Express,
  root: string,
  lfs: LfsContext | null = null,
  engine?: CiEngine
): void {
  // A commit made in the browser is a push like any other as far as
  // workflows are concerned, so the same event goes to the CI engine. A
  // failure here is logged and never allowed to affect the operation the
  // user asked for, which has already been committed by this point.
  function firePush(repo: { dir: string; collection: string; name: string }, branch: string, before: string | null, after: string, actor: string): void {
    if (!engine) return;
    const gitRepo = findRepo(root, repo.collection, repo.name);
    if (!gitRepo) return;
    engine
      .handlePush(gitRepo, {
        ref: `refs/heads/${branch}`,
        before: before ?? '0'.repeat(40),
        after,
        actor,
      })
      .catch((e) => console.error(`CI trigger failed: ${e instanceof Error ? e.message : e}`));
  }

  function fail(
    res: Response,
    status: number,
    message: string,
    viewer: Viewer | null,
    backUrl?: string
  ): void {
    res.status(status).type('html').send(forms.opErrorPage(status, message, { viewer, backUrl }));
  }

  // For GET form pages: an anonymous visitor is sent to sign in and come back.
  function requireViewerPage(req: Request, res: Response): Viewer | null {
    const viewer = getViewer(req, root);
    if (!viewer) {
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      return null;
    }
    return viewer;
  }

  // For POSTs: a missing session or a bad CSRF value is a hard 403.
  function requireViewerPost(req: Request, res: Response): Viewer | null {
    const viewer = getViewer(req, root);
    if (!viewer) {
      fail(res, 403, 'You must be signed in to do that.', null, '/login');
      return null;
    }
    if (!checkCsrf(req, viewer)) {
      fail(res, 403, 'The form has expired; go back, reload the page, and try again.', viewer);
      return null;
    }
    return viewer;
  }

  function authorFor(viewer: Viewer, req: Request): ops.CommitAuthor {
    const host = (req.get('host') ?? 'localhost').replace(/:\d+$/, '');
    return { name: viewer.auth.username, email: `${viewer.auth.username}@noreply.${host}` };
  }

  // ---- sign in / sign out ----

  app.get('/login', (req, res) => {
    const next = safeNext(String(req.query.next ?? '/'));
    if (getViewer(req, root)) {
      res.redirect(next);
      return;
    }
    res.type('html').send(forms.loginPage(next));
  });

  app.post('/login', form, (req, res) => {
    const next = safeNext(field(req, 'next'));
    const state = loadVault(root);
    if (state.status !== 'ok') {
      res.status(500).type('html').send(forms.loginPage(next, 'The vault is not available; try again later.'));
      return;
    }
    const auth = authenticate(state.vault, field(req, 'username'), field(req, 'token'));
    if (!auth) {
      // One generic message: no username/token distinction.
      res.status(401).type('html').send(forms.loginPage(next, 'Invalid username or token.'));
      return;
    }
    setSessionCookie(req, res, root, auth.username, auth.token.scope);
    res.redirect(next);
  });

  app.post('/logout', form, (req, res) => {
    const viewer = getViewer(req, root);
    if (viewer && checkCsrf(req, viewer)) clearSessionCookie(res);
    res.redirect('/');
  });

  // ---- new repository ----

  // The clone is --bare rather than --mirror: mirroring a GitHub repository
  // drags in refs/pull/*, thousands of refs the vault has no use for. A bare
  // clone carries branches and tags, which is what the push then mirrors.
  // Importing is a client-side operation: git copies the repository from its
  // current home and pushes it here, where push-to-create makes it. The server
  // never fetches from another host, so it needs no outbound access, no stored
  // credentials for other services, and no work that outlives a request. This
  // page only writes the command.
  app.get('/import', (req, res) => {
    const viewer = requireViewerPage(req, res);
    if (!viewer) return;
    const collections = listCollections(root).map((o) => o.name);
    const src = typeof req.query.src === 'string' ? req.query.src.trim() : '';
    const collection = typeof req.query.collection === 'string' ? req.query.collection.trim() : '';
    const wanted = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    const preset = { src, collection, name: wanted };
    const fail = (status: number, error: string) => {
      res.status(status).type('html').send(forms.importPage(viewer, collections, preset, null, error));
    };
    if (src === '') {
      res.type('html').send(forms.importPage(viewer, collections, preset, null));
      return;
    }
    const source = parseSource(src);
    if (!source) {
      fail(400, 'The source must be an https or ssh git URL, or owner/repo for GitHub.');
      return;
    }
    const name = wanted === '' ? source.name : wanted;
    if (!isValidName(collection) || !isValidName(name)) {
      fail(400, 'Collection and repository names may use letters, digits, dot, underscore, and dash, and must not be reserved words.');
      return;
    }
    if (!canPush(viewer.auth, collection, name)) {
      fail(403, `Your push scope does not cover ${collection}/${name}, so the push would be refused.`);
      return;
    }
    if (findRepo(root, collection, name)) {
      fail(409, `Repository ${collection}/${name} already exists; a mirror push would overwrite it.`);
      return;
    }
    const host = req.get('host') ?? '';
    if (!/^[A-Za-z0-9.:_-]+$/.test(host)) {
      fail(400, 'This vault is being served under a host name we will not put on a command line.');
      return;
    }
    const dest = `${req.protocol}://${encodeURIComponent(viewer.auth.username)}@${host}/${encodeURIComponent(
      collection
    )}/${encodeURIComponent(name)}`;
    // The clone is a scratch copy, so it goes to a temporary directory rather
    // than to whatever directory the command happens to be pasted into. A
    // fresh one each time means a failed attempt never blocks the next, and
    // what it leaves behind is under /tmp rather than in someone's work tree.
    // mktemp is given an explicit template because plain `mktemp -d` is a
    // usage error on BSD, and `-t prefix` is a usage error on GNU.
    //
    // GIT_ASKPASS= on the push keeps the password prompt in the terminal the
    // command was pasted into. Editors that set GIT_ASKPASS (VS Code does for
    // its integrated terminal) otherwise redirect it to a dialog elsewhere in
    // the window, and an unanswered dialog looks exactly like a hang: git
    // prints nothing after the clone and waits. Credential helpers are
    // consulted before askpass, so a stored credential still works.
    const command =
      `tmp="$(mktemp -d /tmp/import.XXXXXX)"` +
      ` && git clone --bare ${source.url} "$tmp"` +
      ` && GIT_ASKPASS= git -C "$tmp" push --mirror ${dest}` +
      ` && rm -rf "$tmp"`;
    res.type('html').send(forms.importPage(viewer, collections, preset, { command, collection, name }));
  });

  app.get('/new', (req, res) => {
    const viewer = requireViewerPage(req, res);
    if (!viewer) return;
    const collections = listCollections(root).map((o) => o.name);
    const collection = typeof req.query.collection === 'string' ? req.query.collection : '';
    res.type('html').send(forms.newRepoPage(viewer, collections, { collection }));
  });

  app.post(
    '/new',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const collection = field(req, 'collection').trim();
      const name = field(req, 'name').trim();
      const description = field(req, 'description').trim();
      const collections = listCollections(root).map((o) => o.name);
      const rerender = (status: number, error: string) => {
        res
          .status(status)
          .type('html')
          .send(forms.newRepoPage(viewer, collections, { collection, name, description }, error));
      };
      if (!isValidName(collection) || !isValidName(name)) {
        rerender(400, 'Collection and repository names may use letters, digits, dot, underscore, and dash, and must not be reserved words.');
        return;
      }
      if (!canPush(viewer.auth, collection, name)) {
        rerender(403, `Your push scope does not cover ${collection}/${name}.`);
        return;
      }
      if (findRepo(root, collection, name)) {
        rerender(409, `Repository ${collection}/${name} already exists.`);
        return;
      }
      const repo = await ops.createRepo(root, collection, name);
      if (description) ops.setDescription(repo.dir, description);
      if (field(req, 'init') === '1') {
        const sha = await ops.commitFileChange(repo.dir, {
          branch: 'main',
          filePath: 'README.md',
          message: 'Initial commit',
          author: authorFor(viewer, req),
          expectedHead: null,
          action: { kind: 'create', content: Buffer.from(`# ${name}\n${description ? `\n${description}\n` : ''}`) },
        });
        firePush(repo, 'main', null, sha, viewer.auth.username);
      }
      res.redirect(`/${encodeURIComponent(collection)}/${encodeURIComponent(name)}`);
    })
  );

  // ---- file operations ----

  interface FileOpTarget {
    loaded: LoadedRepo;
    branch: string;
    filePath: string;
    // Branch tip at load time (null only while the repository has no branches).
    tip: string | null;
  }

  // Resolves an /:collection/:repo/<verb>/<branch>/<path> URL and enforces what all
  // file operations share: the ref must be a branch (or the repository must
  // be empty) and the viewer needs push scope over the repository.
  async function loadFileTarget(
    req: Request,
    res: Response,
    viewer: Viewer,
    opts: { allowEmptyRepo: boolean }
  ): Promise<FileOpTarget | null> {
    const loaded = await loadRepo(root, req, res, viewer);
    if (!loaded) return null;
    const { ref, path: filePath } = loaded.repo.resolveRefAndPath(wildcard(req), loaded.refNames);
    if (!isValidRepoPath(filePath)) {
      send404(res, 'Not found', viewer);
      return null;
    }
    if (!canPush(viewer.auth, loaded.repo.collection, loaded.repo.name)) {
      fail(res, 403, `Your push scope does not cover ${loaded.repo.collection}/${loaded.repo.name}.`, viewer, urlOf(loaded.repo));
      return null;
    }
    const branchInfo = loaded.branches.find((b) => b.name === ref);
    if (!branchInfo) {
      if (opts.allowEmptyRepo && loaded.branches.length === 0 && isValidRefName(ref) && !ref.startsWith('-')) {
        return { loaded, branch: ref, filePath, tip: null };
      }
      fail(
        res,
        400,
        'Files can only be changed on a branch. Switch to a branch and try again.',
        viewer,
        urlOf(loaded.repo)
      );
      return null;
    }
    return { loaded, branch: ref, filePath, tip: branchInfo.sha };
  }

  async function handleOpError(
    e: unknown,
    req: Request,
    res: Response,
    viewer: Viewer,
    target: FileOpTarget,
    retryUrl: string
  ): Promise<void> {
    if (e instanceof OpError && e.kind === 'conflict') {
      const ctx = await makeCtx(root, req, target.loaded, target.branch, viewer);
      res.status(409).type('html').send(forms.conflictPage(ctx, target.branch, retryUrl));
      return;
    }
    if (e instanceof OpError) {
      fail(res, e.kind === 'notfound' ? 404 : 400, e.message, viewer, retryUrl);
      return;
    }
    throw e;
  }

  app.get(
    '/:collection/:repo/edit/*',
    ah(async (req, res) => {
      const viewer = requireViewerPage(req, res);
      if (!viewer) return;
      const target = await loadFileTarget(req, res, viewer, { allowEmptyRepo: false });
      if (!target) return;
      const { loaded, branch, filePath } = target;
      const type = await loaded.repo.entryType(branch, filePath);
      if (type !== 'blob') {
        send404(res, `File ${filePath} not found at ${branch}`, viewer);
        return;
      }
      const buf = await loaded.repo.catBlob(branch, filePath);
      // Editing a pointer as text would silently corrupt the repository's
      // LFS state, so it is refused outright (deletion remains allowed).
      if (looksLikePointer(buf)) {
        fail(
          res,
          400,
          'This file is stored with Git LFS; the repository holds only a pointer to it. Change the file with a git client instead.',
          viewer,
          urlOf(loaded.repo)
        );
        return;
      }
      if (isBinary(buf) || buf.length > MAX_EDIT_SIZE) {
        fail(res, 400, 'Only text files up to 1 MB can be edited in the browser.', viewer, urlOf(loaded.repo));
        return;
      }
      const ctx = await makeCtx(root, req, loaded, branch, viewer);
      res.type('html').send(forms.editFilePage(ctx, filePath, buf.toString('utf8'), target.tip!));
    })
  );

  app.post(
    '/:collection/:repo/edit/*',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const target = await loadFileTarget(req, res, viewer, { allowEmptyRepo: false });
      if (!target) return;
      const { loaded, branch, filePath } = target;
      const expected = field(req, 'expected');
      if (!isValidSha(expected)) {
        fail(res, 400, 'The form is missing its base commit; reload and try again.', viewer);
        return;
      }
      // The GET form refuses pointer files; re-check here so the refusal
      // cannot be bypassed by posting directly.
      let current: Buffer | null = null;
      try {
        current = await loaded.repo.catBlob(branch, filePath);
      } catch {
        current = null; // missing file surfaces as notfound from the commit below
      }
      if (current && looksLikePointer(current)) {
        fail(
          res,
          400,
          'This file is stored with Git LFS; the repository holds only a pointer to it. Change the file with a git client instead.',
          viewer,
          urlOf(loaded.repo)
        );
        return;
      }
      const content = normalizeContent(field(req, 'content'));
      const message = commitMessage(req, `Update ${filePath.split('/').pop()}`);
      const retryUrl = `${urlOf(loaded.repo)}/edit/${encPath(branch)}/${encPath(filePath)}`;
      try {
        const sha = await ops.commitFileChange(loaded.repo.dir, {
          branch,
          filePath,
          message,
          author: authorFor(viewer, req),
          expectedHead: expected,
          action: { kind: 'edit', content: Buffer.from(content, 'utf8') },
        });
        firePush(loaded.repo, branch, expected, sha, viewer.auth.username);
      } catch (e) {
        await handleOpError(e, req, res, viewer, target, retryUrl);
        return;
      }
      res.redirect(`${urlOf(loaded.repo)}/blob/${encPath(branch)}/${encPath(filePath)}`);
    })
  );

  app.get(
    '/:collection/:repo/new/*',
    ah(async (req, res) => {
      const viewer = requireViewerPage(req, res);
      if (!viewer) return;
      const target = await loadFileTarget(req, res, viewer, { allowEmptyRepo: true });
      if (!target) return;
      const ctx = await makeCtx(root, req, target.loaded, target.branch, viewer);
      const preset = target.tip === null ? { filename: 'README.md', content: `# ${target.loaded.repo.name}\n` } : {};
      res.type('html').send(forms.newFilePage(ctx, target.branch, target.filePath, target.tip, preset));
    })
  );

  app.post(
    '/:collection/:repo/new/*',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const target = await loadFileTarget(req, res, viewer, { allowEmptyRepo: true });
      if (!target) return;
      const { loaded, branch, filePath: dir } = target;
      const expectedField = field(req, 'expected');
      const expected = expectedField === '' ? null : expectedField;
      if (expected !== null && !isValidSha(expected)) {
        fail(res, 400, 'The form is missing its base commit; reload and try again.', viewer);
        return;
      }
      if (expected === null && target.tip !== null) {
        // The form was rendered against an empty repository, but a branch has
        // appeared since; treat it as the branch having moved.
        await handleOpError(new OpError('branch created meanwhile', 'conflict'), req, res, viewer, target, req.originalUrl);
        return;
      }
      const filename = field(req, 'filename').trim().replace(/^\/+|\/+$/g, '');
      const fullPath = dir === '' ? filename : `${dir}/${filename}`;
      const retryUrl = req.originalUrl;
      if (filename === '' || !isValidRepoPath(fullPath)) {
        fail(res, 400, 'Invalid file name.', viewer, retryUrl);
        return;
      }
      const content = normalizeContent(field(req, 'content'));
      const message = commitMessage(req, `Create ${filename.split('/').pop()}`);
      try {
        const sha = await ops.commitFileChange(loaded.repo.dir, {
          branch,
          filePath: fullPath,
          message,
          author: authorFor(viewer, req),
          expectedHead: expected,
          action: { kind: 'create', content: Buffer.from(content, 'utf8') },
        });
        firePush(loaded.repo, branch, expected, sha, viewer.auth.username);
      } catch (e) {
        await handleOpError(e, req, res, viewer, target, retryUrl);
        return;
      }
      res.redirect(`${urlOf(loaded.repo)}/blob/${encPath(branch)}/${encPath(fullPath)}`);
    })
  );

  app.get(
    '/:collection/:repo/delete/*',
    ah(async (req, res) => {
      const viewer = requireViewerPage(req, res);
      if (!viewer) return;
      const target = await loadFileTarget(req, res, viewer, { allowEmptyRepo: false });
      if (!target) return;
      const { loaded, branch, filePath } = target;
      const type = await loaded.repo.entryType(branch, filePath);
      if (type !== 'blob') {
        send404(res, `File ${filePath} not found at ${branch}`, viewer);
        return;
      }
      const ctx = await makeCtx(root, req, loaded, branch, viewer);
      res.type('html').send(forms.deleteFilePage(ctx, filePath, target.tip!));
    })
  );

  app.post(
    '/:collection/:repo/delete/*',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const target = await loadFileTarget(req, res, viewer, { allowEmptyRepo: false });
      if (!target) return;
      const { loaded, branch, filePath } = target;
      const expected = field(req, 'expected');
      if (!isValidSha(expected)) {
        fail(res, 400, 'The form is missing its base commit; reload and try again.', viewer);
        return;
      }
      const message = commitMessage(req, `Delete ${filePath.split('/').pop()}`);
      const retryUrl = `${urlOf(loaded.repo)}/delete/${encPath(branch)}/${encPath(filePath)}`;
      try {
        const sha = await ops.commitFileChange(loaded.repo.dir, {
          branch,
          filePath,
          message,
          author: authorFor(viewer, req),
          expectedHead: expected,
          action: { kind: 'delete' },
        });
        firePush(loaded.repo, branch, expected, sha, viewer.auth.username);
      } catch (e) {
        await handleOpError(e, req, res, viewer, target, retryUrl);
        return;
      }
      const parent = filePath.split('/').slice(0, -1).join('/');
      res.redirect(`${urlOf(loaded.repo)}/tree/${encPath(branch)}${parent ? `/${encPath(parent)}` : ''}`);
    })
  );

  // ---- branches and tags ----

  async function loadForRefOp(req: Request, res: Response, viewer: Viewer): Promise<LoadedRepo | null> {
    const loaded = await loadRepo(root, req, res, viewer);
    if (!loaded) return null;
    if (!canPush(viewer.auth, loaded.repo.collection, loaded.repo.name)) {
      fail(res, 403, `Your push scope does not cover ${loaded.repo.collection}/${loaded.repo.name}.`, viewer, urlOf(loaded.repo));
      return null;
    }
    return loaded;
  }

  app.post(
    '/:collection/:repo/branches/create',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const loaded = await loadForRefOp(req, res, viewer);
      if (!loaded) return;
      const backUrl = `${urlOf(loaded.repo)}/branches`;
      const name = field(req, 'name').trim();
      const from = field(req, 'from').trim() || loaded.defaultBranch || '';
      try {
        await ops.createBranch(loaded.repo.dir, name, from);
        const created = loaded.branches.find((b) => b.name === from);
        const tip = created?.sha ?? loaded.tags.find((t) => t.name === from)?.sha;
        if (tip) firePush(loaded.repo, name, null, tip, viewer.auth.username);
      } catch (e) {
        if (e instanceof OpError) {
          fail(res, e.kind === 'notfound' ? 404 : 400, e.message, viewer, backUrl);
          return;
        }
        throw e;
      }
      res.redirect(backUrl);
    })
  );

  app.post(
    '/:collection/:repo/branches/delete',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const loaded = await loadForRefOp(req, res, viewer);
      if (!loaded) return;
      const backUrl = `${urlOf(loaded.repo)}/branches`;
      const name = field(req, 'name');
      if (!loaded.branches.some((b) => b.name === name)) {
        fail(res, 404, `Branch ${name} not found.`, viewer, backUrl);
        return;
      }
      if (name === loaded.defaultBranch) {
        fail(res, 400, 'The default branch cannot be deleted. Change the default branch in Settings first.', viewer, backUrl);
        return;
      }
      await ops.deleteBranch(loaded.repo.dir, name);
      res.redirect(backUrl);
    })
  );

  app.post(
    '/:collection/:repo/tags/create',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const loaded = await loadForRefOp(req, res, viewer);
      if (!loaded) return;
      const backUrl = `${urlOf(loaded.repo)}/tags`;
      const name = field(req, 'name').trim();
      const at = field(req, 'at').trim() || loaded.defaultBranch || '';
      try {
        await ops.createTag(loaded.repo.dir, name, at);
      } catch (e) {
        if (e instanceof OpError) {
          fail(res, e.kind === 'notfound' ? 404 : 400, e.message, viewer, backUrl);
          return;
        }
        throw e;
      }
      res.redirect(backUrl);
    })
  );

  app.post(
    '/:collection/:repo/tags/delete',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const loaded = await loadForRefOp(req, res, viewer);
      if (!loaded) return;
      const backUrl = `${urlOf(loaded.repo)}/tags`;
      const name = field(req, 'name');
      if (!loaded.tags.some((t) => t.name === name)) {
        fail(res, 404, `Tag ${name} not found.`, viewer, backUrl);
        return;
      }
      await ops.deleteTag(loaded.repo.dir, name);
      res.redirect(backUrl);
    })
  );

  // ---- repository settings ----

  app.get(
    '/:collection/:repo/settings',
    ah(async (req, res) => {
      const viewer = requireViewerPage(req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      if (!ctx.canPush && !ctx.canAdmin) {
        fail(res, 403, 'You do not have access to this repository’s settings.', viewer, urlOf(loaded.repo));
        return;
      }
      const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
      res.type('html').send(forms.settingsPage(ctx, repoDescription(loaded.repo.dir) ?? '', msg));
    })
  );

  app.post(
    '/:collection/:repo/settings',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const backUrl = `${urlOf(loaded.repo)}/settings`;
      if (!canPush(viewer.auth, loaded.repo.collection, loaded.repo.name)) {
        fail(res, 403, `Your push scope does not cover ${loaded.repo.collection}/${loaded.repo.name}.`, viewer, backUrl);
        return;
      }
      ops.setDescription(loaded.repo.dir, field(req, 'description'));
      const defaultBranch = field(req, 'defaultBranch');
      if (defaultBranch !== '' && defaultBranch !== loaded.defaultBranch) {
        if (!loaded.branches.some((b) => b.name === defaultBranch)) {
          fail(res, 400, `Branch ${defaultBranch} not found.`, viewer, backUrl);
          return;
        }
        await ops.setDefaultBranch(loaded.repo.dir, defaultBranch);
      }
      res.redirect(`${backUrl}?msg=${encodeURIComponent('Settings saved.')}`);
    })
  );

  // ---- forking ----

  app.get(
    '/:collection/:repo/fork',
    ah(async (req, res) => {
      const viewer = requireViewerPage(req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      // A vault usually has a collection named after each user, so that is the
      // suggestion; anything the actor may push to is accepted.
      res
        .type('html')
        .send(
          forms.forkPage(ctx, viewer, listCollections(root).map((c) => c.name), {
            collection: viewer.auth.username,
            name: loaded.repo.name,
          })
        );
    })
  );

  app.post(
    '/:collection/:repo/fork',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      const toCollection = field(req, 'collection').trim();
      const toName = field(req, 'name').trim() || loaded.repo.name;
      const names = listCollections(root).map((c) => c.name);
      if (!canPush(viewer.auth, toCollection, toName)) {
        res
          .status(403)
          .type('html')
          .send(
            forms.forkPage(
              ctx,
              viewer,
              names,
              { collection: toCollection, name: toName },
              `You have no push scope over ${toCollection}/${toName}.`
            )
          );
        return;
      }
      try {
        await ops.forkRepo(root, loaded.repo.collection, loaded.repo.name, toCollection, toName);
      } catch (e) {
        const message = e instanceof OpError ? e.message : 'Could not fork the repository.';
        res
          .status(e instanceof OpError && e.kind === 'exists' ? 409 : 400)
          .type('html')
          .send(forms.forkPage(ctx, viewer, names, { collection: toCollection, name: toName }, message));
        return;
      }
      res.redirect(repoUrl({ collection: toCollection, repo: toName }));
    })
  );

  app.post(
    '/:collection/:repo/settings/rename',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const from = `${loaded.repo.collection}/${loaded.repo.name}`;
      const backUrl = `${urlOf(loaded.repo)}/settings`;
      const toCollection = field(req, 'collection').trim() || loaded.repo.collection;
      const toName = field(req, 'name').trim();
      // Two abilities, because a move is a deletion here and a creation there:
      // admin over what is being moved, push over where it is going.
      if (!canAdmin(viewer.auth, [from])) {
        fail(res, 403, `Renaming or moving a repository requires admin scope over ${from}.`, viewer, backUrl);
        return;
      }
      if (!canPush(viewer.auth, toCollection, toName)) {
        fail(res, 403, `You have no push scope over ${toCollection}/${toName}.`, viewer, backUrl);
        return;
      }
      try {
        // The engine indexes runs under the old identity; drop it before the
        // directories move out from under it.
        engine?.forgetRepo(loaded.repo.collection, loaded.repo.name);
        await ops.renameRepo(root, loaded.repo.collection, loaded.repo.name, toCollection, toName, lfs?.store);
      } catch (e) {
        const message = e instanceof OpError ? e.message : 'Could not move the repository.';
        fail(res, e instanceof OpError && e.kind === 'exists' ? 409 : 400, message, viewer, backUrl);
        return;
      }
      const to = repoUrl({ collection: toCollection, repo: toName });
      res.redirect(`${to}/settings?msg=${encodeURIComponent(`Moved from ${from}.`)}`);
    })
  );

  app.post(
    '/:collection/:repo/settings/delete',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const backUrl = `${urlOf(loaded.repo)}/settings`;
      const target = `${loaded.repo.collection}/${loaded.repo.name}`;
      if (!canAdmin(viewer.auth, [target])) {
        fail(res, 403, `Repository deletion requires admin scope over ${target}.`, viewer, backUrl);
        return;
      }
      if (field(req, 'confirm').trim() !== target) {
        fail(res, 400, `Type ${target} exactly to confirm deletion.`, viewer, backUrl);
        return;
      }
      // Drop the repository's runs from the live index first, so nothing is
      // dispatched for a repository whose files are about to disappear.
      engine?.forgetRepo(loaded.repo.collection, loaded.repo.name);
      await ops.deleteRepo(root, loaded.repo.collection, loaded.repo.name, lfs?.store);
      res.redirect(`/${encodeURIComponent(loaded.repo.collection)}`);
    })
  );

  // ---- user administration ----
  // Authorization mirrors the JSON API exactly: any admin may list; creating
  // and granting require the actor's admin globs to cover every requested
  // glob; minting for an existing user requires covering that user's scopes.

  function requireAdminPage(req: Request, res: Response): Viewer | null {
    const viewer = requireViewerPage(req, res);
    if (!viewer) return null;
    if (!viewerIsAdmin(viewer)) {
      fail(res, 403, 'Admin access required (sessions from restricted tokens carry no admin rights).', viewer, '/');
      return null;
    }
    return viewer;
  }

  function requireAdminPost(req: Request, res: Response): Viewer | null {
    const viewer = requireViewerPost(req, res);
    if (!viewer) return null;
    if (!viewerIsAdmin(viewer)) {
      fail(res, 403, 'Admin access required (sessions from restricted tokens carry no admin rights).', viewer, '/');
      return null;
    }
    return viewer;
  }

  // The theme is vault-wide, so changing it takes admin scope over everything:
  // a delegated collection administrator should not restyle the whole vault.
  function canSetTheme(viewer: Viewer): boolean {
    return canAdmin(viewer.auth, ['*']);
  }

  app.get('/admin', (req, res) => {
    const viewer = requireAdminPage(req, res);
    if (!viewer) return;
    res.type('html').send(forms.adminIndexPage(viewer, canSetTheme(viewer)));
  });

  app.get('/admin/appearance', (req, res) => {
    const viewer = requireAdminPage(req, res);
    if (!viewer) return;
    if (!canSetTheme(viewer)) {
      fail(res, 403, 'Changing the theme requires admin scope over the whole vault.', viewer, '/admin');
      return;
    }
    const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
    res.type('html').send(forms.appearancePage(viewer, THEMES, loadConfig(root).theme, msg));
  });

  app.post('/admin/appearance', form, (req, res) => {
    const viewer = requireAdminPost(req, res);
    if (!viewer) return;
    if (!canSetTheme(viewer)) {
      fail(res, 403, 'Changing the theme requires admin scope over the whole vault.', viewer, '/admin');
      return;
    }
    const name = field(req, 'theme');
    if (!findTheme(name)) {
      fail(res, 400, `Unknown theme: ${name || '(none selected)'}.`, viewer, '/admin/appearance');
      return;
    }
    saveConfig(root, { theme: name });
    setActiveTheme(name);
    res.redirect(`/admin/appearance?msg=${encodeURIComponent(`Theme set to ${name}.`)}`);
  });

  app.get('/admin/users', (req, res) => {
    const viewer = requireAdminPage(req, res);
    if (!viewer) return;
    const state = loadVault(root);
    if (state.status !== 'ok') {
      fail(res, 500, 'The vault is not available.', viewer);
      return;
    }
    const users = Object.entries(state.vault.users).map(([name, user]) => ({ name, user }));
    const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
    res.type('html').send(forms.adminUsersPage(viewer, users, msg));
  });

  app.post('/admin/users', form, (req, res) => {
    const viewer = requireAdminPost(req, res);
    if (!viewer) return;
    const username = field(req, 'username').trim();
    const backUrl = '/admin/users';
    if (!isValidName(username)) {
      fail(res, 400, 'A valid username is required (letters, digits, dot, underscore, dash).', viewer, backUrl);
      return;
    }
    const state = loadVault(root);
    if (state.status !== 'ok') {
      fail(res, 500, 'The vault is not available.', viewer, backUrl);
      return;
    }
    if (state.vault.users[username]) {
      fail(res, 409, `User ${username} already exists; use Grant or Mint token on the users page instead.`, viewer, backUrl);
      return;
    }
    const scopeIn = globsField(req, 'scope');
    const adminIn = globsField(req, 'admin');
    if (scopeIn === null || adminIn === null) {
      fail(res, 400, 'Scope globs are too long.', viewer, backUrl);
      return;
    }
    const scope = scopeIn.length ? scopeIn : ['*'];
    const admin = adminIn;
    const need = [...scope, ...admin];
    if (!canAdmin(viewer.auth, need)) {
      fail(res, 403, `Your admin scope does not cover: ${need.join(', ')}.`, viewer, backUrl);
      return;
    }
    const result = addUserToken(root, username, { scope, admin });
    res.type('html').send(forms.tokenPage(viewer, username, result.token, true));
  });

  app.post('/admin/users/:name/grant', form, (req, res) => {
    const viewer = requireAdminPost(req, res);
    if (!viewer) return;
    const username = req.params.name;
    const backUrl = '/admin/users';
    if (!isValidName(username)) {
      fail(res, 400, 'Invalid username.', viewer, backUrl);
      return;
    }
    const scope = globsField(req, 'scope');
    const admin = globsField(req, 'admin');
    if (scope === null || admin === null) {
      fail(res, 400, 'Scope globs are too long.', viewer, backUrl);
      return;
    }
    const globs = [...scope, ...admin];
    if (globs.length === 0) {
      fail(res, 400, 'Nothing to grant; provide push and/or admin globs.', viewer, backUrl);
      return;
    }
    if (!canAdmin(viewer.auth, globs)) {
      fail(res, 403, `Your admin scope does not cover: ${globs.join(', ')}.`, viewer, backUrl);
      return;
    }
    try {
      grantScope(root, username, { scope, admin });
    } catch (e) {
      fail(res, 404, e instanceof Error ? e.message : String(e), viewer, backUrl);
      return;
    }
    res.redirect(`${backUrl}?msg=${encodeURIComponent(`Granted to ${username}.`)}`);
  });

  app.post('/admin/users/:name/token', form, (req, res) => {
    const viewer = requireAdminPost(req, res);
    if (!viewer) return;
    const username = req.params.name;
    const backUrl = '/admin/users';
    if (!isValidName(username)) {
      fail(res, 400, 'Invalid username.', viewer, backUrl);
      return;
    }
    const state = loadVault(root);
    if (state.status !== 'ok') {
      fail(res, 500, 'The vault is not available.', viewer, backUrl);
      return;
    }
    const existing = state.vault.users[username];
    if (!existing) {
      fail(res, 404, `User ${username} does not exist.`, viewer, backUrl);
      return;
    }
    if (!canAdmin(viewer.auth, [...existing.scope, ...existing.admin])) {
      fail(res, 403, `Your admin scope does not cover user ${username}.`, viewer, backUrl);
      return;
    }
    const tokenScope = globsField(req, 'tokenScope');
    if (tokenScope === null) {
      fail(res, 400, 'Token scope globs are too long.', viewer, backUrl);
      return;
    }
    const result = addUserToken(root, username, {
      tokenScope: tokenScope.length ? tokenScope : undefined,
    });
    res.type('html').send(forms.tokenPage(viewer, username, result.token, false));
  });
}
