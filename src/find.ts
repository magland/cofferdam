import { Express } from 'express';
import { execGit, isValidRefName } from './git';
import { getViewer } from './session';
import * as views from './views';
import { ah, loadRepo, makeCtx, send404, wildcard } from './web';

// The file finder: every path in the tree at one ref, filtered as you type.
// GitHub reaches it with the "Go to file" button or the t key, and it is how
// people navigate a repository they already know; clicking down through
// directories is for a repository they do not.
//
// The whole list is rendered into the page and filtered in the browser. That
// is the trade this design implies: no search endpoint, no index, no state
// outside the vault, at the cost of a page whose size grows with the tree.
// The cap below bounds that page; a tree past it is listed as far as the cap
// and says so.

const MAX_PATHS = 20000;

export function registerFind(app: Express, root: string): void {
  const handler = ah(async (req, res) => {
    const viewer = getViewer(req, root);
    const loaded = await loadRepo(root, req, res, viewer);
    if (!loaded) return;
    const ref = wildcard(req) || loaded.defaultBranch || '';
    if (!isValidRefName(ref)) {
      send404(res, 'Not found', viewer);
      return;
    }
    let paths: string[];
    try {
      const out = (await execGit(loaded.repo.dir, ['ls-tree', '-r', '--name-only', '-z', ref])).toString('utf8');
      paths = out.split('\0').filter((p) => p !== '');
    } catch {
      send404(res, `Ref ${ref} not found`, viewer);
      return;
    }
    const ctx = await makeCtx(root, req, loaded, ref, viewer);
    res.type('html').send(views.findFilePage(ctx, paths.slice(0, MAX_PATHS), paths.length));
  });
  app.get('/:collection/:repo/find/*', handler);
  app.get('/:collection/:repo/find', handler);
}
