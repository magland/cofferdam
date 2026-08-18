import { NextFunction, Request, Response } from 'express';
import { GitRepo, RefInfo } from './git';
import { findRepo, pagesDir } from './scan';
import { Viewer } from './session';
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

export function makeCtx(
  root: string,
  req: Request,
  loaded: LoadedRepo,
  ref: string,
  viewer: Viewer | null
): RepoCtx {
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
    hasPages: pagesDir(root, loaded.repo.collection, loaded.repo.name) !== null,
    viewer,
    canPush: viewer !== null && canPush(viewer.auth, loaded.repo.collection, loaded.repo.name),
    canAdmin: viewer !== null && canAdmin(viewer.auth, [`${loaded.repo.collection}/${loaded.repo.name}`]),
  };
}

export function baseUrlOf(req: Request): string {
  return `${req.protocol}://${req.get('host')}`;
}
