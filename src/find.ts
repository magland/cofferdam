import { Express } from 'express';
import { SearchHit, execGit, isValidRefName } from './git';
import { getViewer } from './session';
import * as views from './views';
import { ah, loadRepo, makeCtx, send404, wildcard } from './web';

// The two ways of finding something in a repository: by name and by content.
//
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

// How many files a result page groups, and how many lines it shows from any
// one of them: a search for something common should still fit on a page.
const MAX_RESULT_FILES = 40;
const MAX_LINES_PER_FILE = 10;

export interface SearchFileHits {
  path: string;
  hits: SearchHit[];
  /** Matching lines in this file beyond the ones shown. */
  more: number;
}

/**
 * Group a flat list of hits by file, keeping git's order and capping both the
 * number of files and the lines shown from each, so that what was left out is
 * reported rather than quietly dropped.
 */
function groupHits(hits: SearchHit[]): { files: SearchFileHits[]; capped: boolean } {
  const files: SearchFileHits[] = [];
  const byPath = new Map<string, SearchFileHits>();
  let capped = false;
  for (const hit of hits) {
    let file = byPath.get(hit.path);
    if (!file) {
      if (files.length >= MAX_RESULT_FILES) {
        capped = true;
        continue;
      }
      file = { path: hit.path, hits: [], more: 0 };
      byPath.set(hit.path, file);
      files.push(file);
    }
    if (file.hits.length < MAX_LINES_PER_FILE) file.hits.push(hit);
    else file.more++;
  }
  return { files, capped };
}

export function registerSearch(app: Express, root: string): void {
  app.get(
    '/:collection/:repo/search',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const asked = String(req.query.ref ?? '');
      const ref = asked !== '' && loaded.refNames.includes(asked) ? asked : loaded.defaultBranch ?? '';
      if (ref !== '' && !isValidRefName(ref)) {
        send404(res, 'Not found', viewer);
        return;
      }
      const ctx = await makeCtx(root, req, loaded, ref, viewer);
      // A query is a reader's typing, so it is bounded before it becomes an
      // argument: git grep is fast, but not on a pattern the length of a page.
      const query = String(req.query.q ?? '').slice(0, 256);
      if (query.trim() === '' || ref === '') {
        res.type('html').send(views.searchPage(ctx, query, { files: [], total: 0, truncated: false, capped: false }));
        return;
      }
      const { hits, truncated } = await loaded.repo.search(ref, query);
      const { files, capped } = groupHits(hits);
      res.type('html').send(views.searchPage(ctx, query, { files, total: hits.length, truncated, capped }));
    })
  );
}
