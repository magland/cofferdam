import { Express, Request, Response } from 'express';
import { CiEngine } from '../ci/engine';
import { firePush } from '../ci/trigger';
import { isValidRefName } from '../git';
import { AuthLimiter } from '../limit';
import { previewMerge } from '../ops';
import {
  MergeConflict,
  addComment,
  deletePullBranch,
  editPull,
  listPulls,
  mergePull,
  openPull,
  readPull,
  setPullState,
} from '../pulls';
import { apiError, bodyOf, limitParam, requireRepo, requirePush, sendOpError, stringField } from './auth';

// Pull requests. The interesting route here is GET .../merge, which answers "will
// this apply" without writing anything: an agent that reads, thinks, and proposes
// wants to know before it asks. POST .../merge goes through pulls.mergePull, the
// same sequence the web merge button performs.

const MAX_LISTED = 500;

function pullNumber(raw: string | undefined): number | null {
  return /^[1-9][0-9]*$/.test(raw ?? '') ? parseInt(raw as string, 10) : null;
}

export function registerPullApi(app: Express, root: string, limiter: AuthLimiter, engine?: CiEngine): void {
  app.get('/api/repos/:collection/:repo/pulls', (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const stateAsked = String(req.query.state ?? 'open');
    if (!['open', 'closed', 'merged', 'all'].includes(stateAsked)) {
      apiError(res, 400, 'state must be open, closed, merged, or all');
      return;
    }
    const all = listPulls(root, found.repo.collection, found.repo.name);
    const selected = stateAsked === 'all' ? all : all.filter((p) => p.state === stateAsked);
    const limit = limitParam(req.query.limit, MAX_LISTED, MAX_LISTED);
    res.json({ pulls: selected.slice(0, limit), total: selected.length });
  });

  app.get('/api/repos/:collection/:repo/pulls/:n', (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const n = pullNumber(req.params.n);
    const pull = n === null ? null : readPull(root, found.repo.collection, found.repo.name, n);
    if (!pull) {
      apiError(res, 404, `no pull request ${req.params.n} in ${found.repo.collection}/${found.repo.name}`);
      return;
    }
    res.json(pull);
  });

  app.post('/api/repos/:collection/:repo/pulls', async (req, res) => {
    const found = requirePush(root, limiter, req, res);
    if (!found) return;
    const body = bodyOf(req);
    const title = stringField(body, 'title');
    const base = stringField(body, 'base');
    const head = stringField(body, 'head');
    if (title === null || base === null || head === null) {
      apiError(res, 400, '"title", "base", and "head" are required');
      return;
    }
    const branches = (await found.repo.listRefs('heads')).map((b) => b.name);
    try {
      const created = openPull(
        root,
        found.repo.collection,
        found.repo.name,
        { title, body: stringField(body, 'body') ?? '', author: found.actor.username, base, head },
        branches
      );
      res.status(201).json(created);
    } catch (e) {
      sendOpError(res, e, 'could not open the pull request');
    }
  });

  app.patch('/api/repos/:collection/:repo/pulls/:n', (req, res) => {
    const found = requirePush(root, limiter, req, res);
    if (!found) return;
    const n = pullNumber(req.params.n);
    if (n === null) {
      apiError(res, 404, `no pull request ${req.params.n}`);
      return;
    }
    const body = bodyOf(req);
    try {
      editPull(root, found.repo.collection, found.repo.name, n, {
        title: stringField(body, 'title') ?? undefined,
        body: stringField(body, 'body') ?? undefined,
      });
      res.json(readPull(root, found.repo.collection, found.repo.name, n));
    } catch (e) {
      sendOpError(res, e, 'could not edit the pull request');
    }
  });

  app.post('/api/repos/:collection/:repo/pulls/:n/comments', (req, res) => {
    const found = requirePush(root, limiter, req, res);
    if (!found) return;
    const n = pullNumber(req.params.n);
    const text = stringField(bodyOf(req), 'body');
    if (n === null) {
      apiError(res, 404, `no pull request ${req.params.n}`);
      return;
    }
    if (text === null) {
      apiError(res, 400, 'a "body" is required');
      return;
    }
    try {
      res.status(201).json(
        addComment(root, found.repo.collection, found.repo.name, n, { author: found.actor.username, body: text })
      );
    } catch (e) {
      sendOpError(res, e, 'could not add the comment');
    }
  });

  app.post('/api/repos/:collection/:repo/pulls/:n/state', (req, res) => {
    const found = requirePush(root, limiter, req, res);
    if (!found) return;
    const n = pullNumber(req.params.n);
    const state = stringField(bodyOf(req), 'state');
    if (n === null) {
      apiError(res, 404, `no pull request ${req.params.n}`);
      return;
    }
    if (state !== 'open' && state !== 'closed') {
      apiError(res, 400, '"state" must be "open" or "closed"');
      return;
    }
    try {
      setPullState(root, found.repo.collection, found.repo.name, n, state, found.actor.username);
      res.json(readPull(root, found.repo.collection, found.repo.name, n));
    } catch (e) {
      sendOpError(res, e, 'could not change the state');
    }
  });

  // The diff and the commits are questions for git, answered from base and head
  // at the moment they are asked. A pull request never stores either.
  const comparison = async (req: Request, res: Response, what: 'diff' | 'commits'): Promise<void> => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const n = pullNumber(req.params.n);
    const pull = n === null ? null : readPull(root, found.repo.collection, found.repo.name, n);
    if (!pull) {
      apiError(res, 404, `no pull request ${req.params.n}`);
      return;
    }
    if (!isValidRefName(pull.base) || !isValidRefName(pull.head)) {
      apiError(res, 409, 'this pull request names a ref that is no longer usable');
      return;
    }
    try {
      const cmp = await found.repo.compare(pull.base, pull.head);
      if (what === 'commits') {
        res.json({ base: pull.base, head: pull.head, ahead: cmp.ahead, commits: cmp.commits });
        return;
      }
      res.json({ base: pull.base, head: pull.head, ...cmp });
    } catch {
      apiError(res, 409, `could not compare ${pull.base} with ${pull.head}; one of them may be gone`);
    }
  };
  app.get('/api/repos/:collection/:repo/pulls/:n/diff', (req, res) => comparison(req, res, 'diff'));
  app.get('/api/repos/:collection/:repo/pulls/:n/commits', (req, res) => comparison(req, res, 'commits'));

  // Mergeability without merging: the single most useful read for a caller that
  // is about to write.
  app.get('/api/repos/:collection/:repo/pulls/:n/merge', async (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const n = pullNumber(req.params.n);
    const pull = n === null ? null : readPull(root, found.repo.collection, found.repo.name, n);
    if (!pull) {
      apiError(res, 404, `no pull request ${req.params.n}`);
      return;
    }
    if (pull.state !== 'open') {
      res.json({ state: pull.state, mergeable: false, status: pull.state });
      return;
    }
    try {
      const preview = await previewMerge(found.repo.dir, pull.base, pull.head);
      res.json({ state: pull.state, mergeable: preview.status === 'clean', ...preview });
    } catch (e) {
      sendOpError(res, e, 'the merge could not be computed');
    }
  });

  app.post('/api/repos/:collection/:repo/pulls/:n/merge', async (req, res) => {
    const found = requirePush(root, limiter, req, res);
    if (!found) return;
    const n = pullNumber(req.params.n);
    if (n === null) {
      apiError(res, 404, `no pull request ${req.params.n}`);
      return;
    }
    const body = bodyOf(req);
    const methodAsked = stringField(body, 'method') ?? 'merge';
    if (methodAsked !== 'merge' && methodAsked !== 'squash') {
      apiError(res, 400, '"method" must be "merge" or "squash"');
      return;
    }
    const pull = readPull(root, found.repo.collection, found.repo.name, n);
    const branches = await found.repo.listRefs('heads');
    try {
      const result = await mergePull(
        root,
        found.repo,
        n,
        found.actor,
        {
          method: methodAsked,
          message: stringField(body, 'message') ?? undefined,
          deleteBranch: body.deleteBranch === true,
        },
        { defaultBranch: await found.repo.defaultBranch(branches) }
      );
      // A merge moves a branch, which is a push as far as workflows are
      // concerned. Forgetting this here would be a silent divergence from the
      // web merge button, which fires it.
      if (pull) {
        firePush(
          root,
          engine,
          { collection: found.repo.collection, name: found.repo.name },
          pull.base,
          result.before,
          result.sha,
          found.actor.username
        );
      }
      res.json(result);
    } catch (e) {
      // A conflict is 409 with the conflicting paths, not a 400 and not a 500:
      // the caller can act on the list.
      if (e instanceof MergeConflict) {
        res.status(409).json({ error: e.message, conflicts: e.paths });
        return;
      }
      sendOpError(res, e, 'the merge failed');
    }
  });

  app.post('/api/repos/:collection/:repo/pulls/:n/delete-branch', async (req, res) => {
    const found = requirePush(root, limiter, req, res);
    if (!found) return;
    const n = pullNumber(req.params.n);
    if (n === null) {
      apiError(res, 404, `no pull request ${req.params.n}`);
      return;
    }
    const branches = await found.repo.listRefs('heads');
    try {
      const deleted = await deletePullBranch(root, found.repo, n, {
        defaultBranch: await found.repo.defaultBranch(branches),
      });
      res.json({ deleted });
    } catch (e) {
      sendOpError(res, e, 'could not delete the branch');
    }
  });
}
