import { Express } from 'express';
import {
  ISSUE_SORTS,
  IssueSort,
  addComment,
  authorsInUse,
  createIssue,
  editIssue,
  labelsInUse,
  listIssues,
  readIssue,
  selectIssues,
  setIssueState,
} from '../issues';
import { AuthLimiter } from '../limit';
import { apiError, bodyOf, limitParam, requireRepo, requirePush, sendOpError, stringField, stringsField } from './auth';

// Issues. The domain functions in src/issues.ts do all of the work; this is a
// transport over them, and the response objects are the IssueSummary and Issue
// interfaces unchanged, so a field added to an issue's state appears here without
// a decision being made about it.
//
// Who the author is comes from the bearer token, never from the body, on any
// route, ever. Reading an issue takes any valid token; writing one takes push
// scope over the repository, which is the same rule the web applies.

const MAX_LISTED = 500;

function issueNumber(raw: string | undefined): number | null {
  return /^[1-9][0-9]*$/.test(raw ?? '') ? parseInt(raw as string, 10) : null;
}

export function registerIssueApi(app: Express, root: string, limiter: AuthLimiter): void {
  // The labels route is registered before :n so that /issues/labels is not read
  // as issue number "labels".
  app.get('/api/repos/:collection/:repo/issues/labels', (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const all = listIssues(root, found.repo.collection, found.repo.name);
    res.json({ labels: labelsInUse(all), authors: authorsInUse(all) });
  });

  app.get('/api/repos/:collection/:repo/issues', (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const stateAsked = String(req.query.state ?? 'open');
    if (!['open', 'closed', 'all'].includes(stateAsked)) {
      apiError(res, 400, 'state must be open, closed, or all');
      return;
    }
    const sortAsked = String(req.query.sort ?? 'newest');
    if (!ISSUE_SORTS.some((s) => s.key === sortAsked)) {
      apiError(res, 400, `sort must be one of: ${ISSUE_SORTS.map((s) => s.key).join(', ')}`);
      return;
    }
    const all = listIssues(root, found.repo.collection, found.repo.name, {
      match: String(req.query.q ?? '') || undefined,
    });
    const selected = selectIssues(all, {
      state: stateAsked as 'open' | 'closed' | 'all',
      label: String(req.query.label ?? '') || undefined,
      author: String(req.query.author ?? '') || undefined,
      sort: sortAsked as IssueSort,
    });
    const limit = limitParam(req.query.limit, MAX_LISTED, MAX_LISTED);
    res.json({ issues: selected.slice(0, limit), total: selected.length });
  });

  app.get('/api/repos/:collection/:repo/issues/:n', (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const n = issueNumber(req.params.n);
    const issue = n === null ? null : readIssue(root, found.repo.collection, found.repo.name, n);
    if (!issue) {
      apiError(res, 404, `no issue ${req.params.n} in ${found.repo.collection}/${found.repo.name}`);
      return;
    }
    res.json(issue);
  });

  app.post('/api/repos/:collection/:repo/issues', (req, res) => {
    const found = requirePush(root, limiter, req, res);
    if (!found) return;
    const body = bodyOf(req);
    const title = stringField(body, 'title');
    if (title === null) {
      apiError(res, 400, 'a "title" is required');
      return;
    }
    const labels = stringsField(body, 'labels');
    if (labels === null) {
      apiError(res, 400, '"labels" must be a list of strings');
      return;
    }
    try {
      // The author is the token's user. No author field is read from the body.
      const created = createIssue(root, found.repo.collection, found.repo.name, {
        title,
        body: stringField(body, 'body') ?? '',
        author: found.actor.username,
        labels,
      });
      res.status(201).json(created);
    } catch (e) {
      sendOpError(res, e, 'could not create the issue');
    }
  });

  app.patch('/api/repos/:collection/:repo/issues/:n', (req, res) => {
    const found = requirePush(root, limiter, req, res);
    if (!found) return;
    const n = issueNumber(req.params.n);
    if (n === null) {
      apiError(res, 404, `no issue ${req.params.n}`);
      return;
    }
    const body = bodyOf(req);
    const labels = stringsField(body, 'labels');
    if (labels === null) {
      apiError(res, 400, '"labels" must be a list of strings');
      return;
    }
    try {
      editIssue(root, found.repo.collection, found.repo.name, n, {
        title: stringField(body, 'title') ?? undefined,
        body: stringField(body, 'body') ?? undefined,
        labels,
      });
      res.json(readIssue(root, found.repo.collection, found.repo.name, n));
    } catch (e) {
      sendOpError(res, e, 'could not edit the issue');
    }
  });

  app.post('/api/repos/:collection/:repo/issues/:n/comments', (req, res) => {
    const found = requirePush(root, limiter, req, res);
    if (!found) return;
    const n = issueNumber(req.params.n);
    const text = stringField(bodyOf(req), 'body');
    if (n === null) {
      apiError(res, 404, `no issue ${req.params.n}`);
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

  app.post('/api/repos/:collection/:repo/issues/:n/state', (req, res) => {
    const found = requirePush(root, limiter, req, res);
    if (!found) return;
    const n = issueNumber(req.params.n);
    const state = stringField(bodyOf(req), 'state');
    if (n === null) {
      apiError(res, 404, `no issue ${req.params.n}`);
      return;
    }
    if (state !== 'open' && state !== 'closed') {
      apiError(res, 400, '"state" must be "open" or "closed"');
      return;
    }
    try {
      setIssueState(root, found.repo.collection, found.repo.name, n, state, found.actor.username);
      res.json(readIssue(root, found.repo.collection, found.repo.name, n));
    } catch (e) {
      sendOpError(res, e, 'could not change the state');
    }
  });
}
