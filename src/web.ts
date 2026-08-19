import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import { hasCiState } from './ci/present';
import * as forms from './forms';
import { GitRepo, RefInfo } from './git';
import { issueCounts } from './issues';
import { pullCounts } from './pulls';
import { listReleases } from './releases';
import { findRepo, forkParent, siteDir } from './scan';
import { Viewer, checkCsrf, getViewer } from './session';
import { canAdmin, canPush } from './vault';
import { RepoCtx } from './views';
import * as views from './views';

// Helpers shared by the HTML route modules.

export function ah(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export function wildcard(req: Request): string {
  return (req.params as Record<string, string>)['0'] ?? '';
}

export function send404(res: Response, message = 'Not found', viewer: Viewer | null = null) {
  res.status(404).type('html').send(views.errorPage(404, message, { viewer }));
}

// Form posts are read as urlencoded bodies with express's simple parser: the
// forms here are flat, so the extended syntax would only widen what a body may
// say. The limit is left to the caller, because what one page may reasonably
// carry (a file being edited) is not what another should (a release note).
export function urlencodedForm(limit: string): RequestHandler {
  return express.urlencoded({ extended: false, limit });
}

// A form field as a string. Anything the parser did not give us as a string
// (a missing field, or a repeated one arriving as an array) reads as empty
// rather than being passed on as something a handler did not expect.
export function field(req: Request, name: string): string {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v : '';
}

// How an operation refuses. backUrl, when given, is where the page offers to
// send the reader back to, which is usually the form they came from.
export function fail(
  res: Response,
  status: number,
  message: string,
  viewer: Viewer | null,
  backUrl?: string
): void {
  res.status(status).type('html').send(forms.opErrorPage(message, { viewer, backUrl }));
}

// For GET form pages: an anonymous visitor is sent to sign in and come back.
export function requireViewerPage(root: string, req: Request, res: Response): Viewer | null {
  const viewer = getViewer(req, root);
  if (!viewer) {
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    return null;
  }
  return viewer;
}

// For POSTs: a missing session or a bad CSRF value is a hard 403.
export function requireViewerPost(root: string, req: Request, res: Response): Viewer | null {
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

export interface LoadedRepo {
  repo: GitRepo;
  branches: RefInfo[];
  tags: RefInfo[];
  defaultBranch: string | null;
  refNames: string[];
}

export async function loadRepo(
  root: string,
  req: Request,
  res: Response,
  viewer: Viewer | null
): Promise<LoadedRepo | null> {
  const repo = findRepo(root, req.params.collection, req.params.repo);
  if (!repo) {
    send404(res, `Repository ${req.params.collection}/${req.params.repo} not found`, viewer);
    return null;
  }
  const [branches, tags] = await Promise.all([repo.listRefs('heads'), repo.listRefs('tags')]);
  const defaultBranch = await repo.defaultBranch(branches);
  return {
    repo,
    branches,
    tags,
    defaultBranch,
    refNames: [...branches.map((b) => b.name), ...tags.map((t) => t.name)],
  };
}

export async function makeCtx(
  root: string,
  req: Request,
  loaded: LoadedRepo,
  ref: string,
  viewer: Viewer | null
): Promise<RepoCtx> {
  const cloneUrl = `${req.protocol}://${req.get('host')}/${encodeURIComponent(loaded.repo.collection)}/${encodeURIComponent(
    loaded.repo.name
  )}`;
  return {
    collection: loaded.repo.collection,
    repo: loaded.repo.name,
    ref,
    refIsBranch: loaded.branches.some((b) => b.name === ref),
    defaultBranch: loaded.defaultBranch ?? '',
    branches: loaded.branches,
    tags: loaded.tags,
    cloneUrl,
    hasSite: siteDir(root, loaded.repo.collection, loaded.repo.name) !== null,
    releases: listReleases(root, loaded.repo.collection, loaded.repo.name).map((r) => r.tag),
    hasCi: await hasCiState(root, loaded.repo, loaded.defaultBranch, loaded.branches),
    openIssues: issueCounts(root, loaded.repo.collection, loaded.repo.name).open,
    openPulls: pullCounts(root, loaded.repo.collection, loaded.repo.name).open,
    forkedFrom: forkParent(loaded.repo.dir),
    viewer,
    canPush: viewer !== null && canPush(viewer.auth, loaded.repo.collection, loaded.repo.name),
    canAdmin: viewer !== null && canAdmin(viewer.auth, [`${loaded.repo.collection}/${loaded.repo.name}`]),
  };
}

export function baseUrlOf(req: Request): string {
  return `${req.protocol}://${req.get('host')}`;
}
