import express, { Express, Request, Response } from 'express';
import { avatar } from './avatar';
import * as forms from './forms';
import { icon } from './icons';
import * as issues from './issues';
import { Issue, IssueSummary } from './issues';
import { renderMarkdown } from './markdown';
import { OpError } from './ops';
import { esc, timeTag } from './render';
import { Viewer, checkCsrf, getViewer } from './session';
import { RepoCtx, csrfField, encPath, layout, repoHeader, repoOpts, repoUrl } from './views';
import { ah, loadRepo, makeCtx, send404 } from './web';

// The issue pages, over the store in issues.ts.
//
// Who may do what follows the vault's model rather than GitHub's: reading is
// anonymous like every other read, opening an issue and commenting need a
// session (a vault's users are its users; there is no public sign-up to
// abuse), and closing, reopening, or editing needs push scope over the
// repository or being the person who wrote the thing.

const form = express.urlencoded({ extended: false, limit: '3mb' });

function field(req: Request, name: string): string {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v : '';
}

function issuesUrl(ctx: RepoCtx): string {
  return `${repoUrl(ctx)}/issues`;
}

/** Issue bodies are markdown, rendered by the same sanitizing pipeline as a
 * README: this is text one user writes and another reads. Relative links
 * resolve against the default branch, since an issue has no file of its own. */
function body(ctx: RepoCtx, text: string): string {
  const base = repoUrl(ctx);
  const ref = encPath(ctx.defaultBranch || ctx.ref || 'HEAD');
  return renderMarkdown(text, {
    rawBase: `${base}/raw/${ref}`,
    blobBase: `${base}/blob/${ref}`,
    issueBase: `${base}/issues`,
    commitBase: `${base}/commit`,
  });
}

function stateBadge(state: 'open' | 'closed'): string {
  return state === 'open'
    ? `<span class="state-badge open">${icon('issue-opened')}<span>Open</span></span>`
    : `<span class="state-badge closed">${icon('issue-closed')}<span>Closed</span></span>`;
}

function labelChips(labels: string[]): string {
  return labels.map((l) => `<span class="chip label">${esc(l)}</span>`).join('');
}

function listPage(ctx: RepoCtx, list: IssueSummary[], state: 'open' | 'closed' | 'all', counts: { open: number; closed: number }): string {
  const base = issuesUrl(ctx);
  const tab = (id: string, label: string, n: number, glyph: 'issue-opened' | 'issue-closed' | 'comment') =>
    `<a class="state-tab${state === id ? ' current' : ''}" href="${base}?state=${id}">${icon(glyph)}<span>${n} ${label}</span></a>`;
  const rows = list
    .map(
      (i) =>
        `<tr>
<td class="issue-cell">${icon(i.state === 'open' ? 'issue-opened' : 'issue-closed', i.state === 'open' ? 'issue-open' : 'issue-closed')}<span>
<a class="issue-link" href="${base}/${i.number}">${esc(i.title)}</a>${labelChips(i.labels)}
<div class="muted small">#${i.number} opened ${timeTag(i.created)} by ${esc(i.author)}${
          i.state === 'closed' && i.closedAt ? ` &middot; closed ${timeTag(i.closedAt)}` : ''
        }</div></span></td>
<td class="right muted small">${
          i.comments > 0
            ? `<a class="issue-comments" href="${base}/${i.number}" title="${i.comments} comment${
                i.comments === 1 ? '' : 's'
              }">${icon('comment')}<span>${i.comments}</span></a>`
            : ''
        }</td>
</tr>`
    )
    .join('');
  const newBtn = ctx.viewer
    ? `<a class="btn btn-primary" href="${base}/new">${icon('plus')}<span>New issue</span></a>`
    : `<a class="btn" href="/login?next=${encodeURIComponent(`${base}/new`)}">${icon('plus')}<span>New issue</span></a>`;
  const empty =
    state === 'closed'
      ? 'No closed issues.'
      : state === 'open'
        ? 'No open issues. Anything that needs doing here can be written down.'
        : 'No issues yet.';
  const content = `${repoHeader(ctx, 'issues')}
<div class="page-head">
  <span class="state-filter">${tab('open', 'Open', counts.open, 'issue-opened')}${tab(
    'closed',
    'Closed',
    counts.closed,
    'issue-closed'
  )}</span>
  ${newBtn}
</div>
${rows ? `<table class="listing issues"><tbody>${rows}</tbody></table>` : `<div class="empty-state">${empty}</div>`}`;
  return layout(`Issues - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, base));
}

function commentCard(ctx: RepoCtx, author: string, when: string, html: string, note = ''): string {
  return `<article class="issue-comment">
<div class="issue-comment-head">${avatar(author, 24)}<b>${esc(author)}</b><span class="muted small">${note ||
    'commented'} ${timeTag(when)}</span></div>
<div class="issue-comment-body markdown-body">${html}</div>
</article>`;
}

function issuePage(ctx: RepoCtx, issue: Issue, canWrite: boolean): string {
  const base = issuesUrl(ctx);
  const viewer = ctx.viewer;
  const mine = viewer !== null && viewer.auth.username === issue.author;
  const canClose = canWrite || mine;
  const comments = issue.commentList
    .map((c) => commentCard(ctx, c.author, c.created, body(ctx, c.body)))
    .join('');
  const closedNote =
    issue.state === 'closed' && issue.closedAt
      ? `<div class="issue-event">${icon('issue-closed', 'issue-closed')}<span><b>${esc(
          issue.closedBy ?? 'someone'
        )}</b> closed this ${timeTag(issue.closedAt)}</span></div>`
      : '';
  let replyBox = '';
  if (viewer) {
    const toggle = canClose
      ? `<button class="btn" type="submit" name="state" value="${issue.state === 'open' ? 'closed' : 'open'}" formaction="${base}/${
          issue.number
        }/state">${icon(issue.state === 'open' ? 'issue-closed' : 'issue-opened')}<span>${
          issue.state === 'open' ? 'Close issue' : 'Reopen issue'
        }</span></button>`
      : '';
    replyBox = `<form class="issue-reply" method="post" action="${base}/${issue.number}/comment">${csrfField(viewer)}
<div class="issue-comment-head">${avatar(viewer.auth.username, 24)}<b>${esc(viewer.auth.username)}</b></div>
<textarea class="code-editor" name="body" rows="6" placeholder="Leave a comment"></textarea>
<div class="actions">${toggle}<button class="btn btn-primary" type="submit">Comment</button></div>
</form>`;
  } else {
    replyBox = `<p class="muted"><a href="/login?next=${encodeURIComponent(`${base}/${issue.number}`)}">Sign in</a> to comment.</p>`;
  }
  const edit =
    canClose
      ? `<a class="btn" href="${base}/${issue.number}/edit">${icon('pencil')}<span>Edit</span></a>`
      : '';
  const content = `${repoHeader(ctx, 'issues')}
<div class="issue-head">
  <h1 class="issue-title">${esc(issue.title)} <span class="muted">#${issue.number}</span></h1>
  <span class="right-group">${edit}<a class="btn" href="${base}">Back to issues</a></span>
</div>
<div class="issue-sub">${stateBadge(issue.state)}<span class="muted"><b>${esc(
    issue.author
  )}</b> opened this ${timeTag(issue.created)} &middot; ${issue.commentList.length} comment${
    issue.commentList.length === 1 ? '' : 's'
  }</span>${labelChips(issue.labels)}</div>
<div class="issue-thread">
${commentCard(ctx, issue.author, issue.created, body(ctx, issue.body) || '<p class="muted">No description.</p>', 'opened this')}
${comments}
${closedNote}
${replyBox}
</div>`;
  return layout(`${issue.title} · #${issue.number} - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, `${base}/${issue.number}`));
}

function editPage(
  ctx: RepoCtx,
  viewer: Viewer,
  mode: 'new' | 'edit',
  values: { number?: number; title: string; body: string; labels: string[] },
  error?: string
): string {
  const base = issuesUrl(ctx);
  const action = mode === 'new' ? `${base}/new` : `${base}/${values.number}/edit`;
  const content = `${repoHeader(ctx, 'issues')}
<div class="form-box wide">
<h1>${mode === 'new' ? 'New issue' : `Edit issue #${values.number}`}</h1>
${error ? `<div class="form-error">${esc(error)}</div>` : ''}
<form method="post" action="${action}">${csrfField(viewer)}
<div class="field"><label for="title">Title</label>
<input type="text" id="title" name="title" value="${esc(values.title)}" maxlength="${
    issues.MAX_TITLE
  }" required autofocus></div>
<div class="field"><label for="body">Description</label>
<textarea class="code-editor" id="body" name="body" rows="12" placeholder="Markdown is welcome">${esc(values.body)}</textarea></div>
${
  ctx.canPush
    ? `<div class="field"><label for="labels">Labels</label>
<input type="text" id="labels" name="labels" value="${esc(values.labels.join(', '))}" placeholder="bug, ui">
<p class="muted small">Separated by commas. Labels are for people with push access.</p></div>`
    : ''
}
<div class="actions"><button class="btn btn-primary" type="submit">${
    mode === 'new' ? 'Open issue' : 'Save changes'
  }</button><a class="btn" href="${mode === 'new' ? base : `${base}/${values.number}`}">Cancel</a></div>
</form>
</div>`;
  return layout(mode === 'new' ? `New issue - ${ctx.collection}/${ctx.repo}` : `Edit #${values.number}`, content, repoOpts(ctx, action));
}

export function registerIssues(app: Express, root: string): void {
  function fail(res: Response, status: number, message: string, viewer: Viewer | null, backUrl?: string): void {
    res.status(status).type('html').send(forms.opErrorPage(status, message, { viewer, backUrl }));
  }

  function requireViewerPage(req: Request, res: Response): Viewer | null {
    const viewer = getViewer(req, root);
    if (!viewer) {
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      return null;
    }
    return viewer;
  }

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

  /** The repository context plus the issue named in the URL. */
  async function withIssue(req: Request, res: Response, viewer: Viewer | null) {
    const loaded = await loadRepo(root, req, res, viewer);
    if (!loaded) return null;
    const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
    const n = parseInt(req.params.n ?? '', 10);
    if (!/^[1-9][0-9]*$/.test(req.params.n ?? '')) {
      send404(res, 'No such issue', viewer);
      return null;
    }
    const issue = issues.readIssue(root, ctx.collection, ctx.repo, n);
    if (!issue) {
      send404(res, `Issue #${n} does not exist in ${ctx.collection}/${ctx.repo}`, viewer);
      return null;
    }
    return { ctx, issue, n };
  }

  app.get(
    '/:collection/:repo/issues',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      const asked = String(req.query.state ?? 'open');
      const state = asked === 'closed' ? 'closed' : asked === 'all' ? 'all' : 'open';
      const all = issues.listIssues(root, ctx.collection, ctx.repo);
      const counts = { open: all.filter((i) => i.state === 'open').length, closed: all.filter((i) => i.state === 'closed').length };
      const list = state === 'all' ? all : all.filter((i) => i.state === state);
      res.type('html').send(listPage(ctx, list, state, counts));
    })
  );

  app.get(
    '/:collection/:repo/issues/new',
    ah(async (req, res) => {
      const viewer = requireViewerPage(req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      res.type('html').send(editPage(ctx, viewer, 'new', { title: '', body: '', labels: [] }));
    })
  );

  app.post(
    '/:collection/:repo/issues/new',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      const title = field(req, 'title');
      const text = field(req, 'body');
      // Labels are a push-scope decision, so a form that carries them from
      // someone without it is simply read without them.
      const labels = ctx.canPush ? field(req, 'labels').split(',') : [];
      try {
        const created = issues.createIssue(root, ctx.collection, ctx.repo, {
          title,
          body: text,
          author: viewer.auth.username,
          labels,
        });
        res.redirect(`${issuesUrl(ctx)}/${created.number}`);
      } catch (e) {
        const message = e instanceof OpError ? e.message : 'Could not open the issue.';
        res
          .status(400)
          .type('html')
          .send(editPage(ctx, viewer, 'new', { title, body: text, labels: labels.map((l) => l.trim()).filter(Boolean) }, message));
      }
    })
  );

  app.get(
    '/:collection/:repo/issues/:n',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const found = await withIssue(req, res, viewer);
      if (!found) return;
      res.type('html').send(issuePage(found.ctx, found.issue, found.ctx.canPush));
    })
  );

  app.get(
    '/:collection/:repo/issues/:n/edit',
    ah(async (req, res) => {
      const viewer = requireViewerPage(req, res);
      if (!viewer) return;
      const found = await withIssue(req, res, viewer);
      if (!found) return;
      const { ctx, issue } = found;
      if (!ctx.canPush && viewer.auth.username !== issue.author) {
        fail(res, 403, 'Only the author or someone with push access can edit this issue.', viewer, `${issuesUrl(ctx)}/${issue.number}`);
        return;
      }
      res
        .type('html')
        .send(editPage(ctx, viewer, 'edit', { number: issue.number, title: issue.title, body: issue.body, labels: issue.labels }));
    })
  );

  app.post(
    '/:collection/:repo/issues/:n/edit',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const found = await withIssue(req, res, viewer);
      if (!found) return;
      const { ctx, issue } = found;
      if (!ctx.canPush && viewer.auth.username !== issue.author) {
        fail(res, 403, 'Only the author or someone with push access can edit this issue.', viewer, `${issuesUrl(ctx)}/${issue.number}`);
        return;
      }
      const title = field(req, 'title');
      const text = field(req, 'body');
      try {
        issues.editIssue(root, ctx.collection, ctx.repo, issue.number, {
          title,
          body: text,
          labels: ctx.canPush ? field(req, 'labels').split(',') : undefined,
        });
        res.redirect(`${issuesUrl(ctx)}/${issue.number}`);
      } catch (e) {
        const message = e instanceof OpError ? e.message : 'Could not save the issue.';
        res
          .status(400)
          .type('html')
          .send(editPage(ctx, viewer, 'edit', { number: issue.number, title, body: text, labels: issue.labels }, message));
      }
    })
  );

  app.post(
    '/:collection/:repo/issues/:n/comment',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const found = await withIssue(req, res, viewer);
      if (!found) return;
      const { ctx, issue } = found;
      try {
        issues.addComment(root, ctx.collection, ctx.repo, issue.number, {
          author: viewer.auth.username,
          body: field(req, 'body'),
        });
      } catch (e) {
        const message = e instanceof OpError ? e.message : 'Could not add the comment.';
        fail(res, 400, message, viewer, `${issuesUrl(ctx)}/${issue.number}`);
        return;
      }
      res.redirect(`${issuesUrl(ctx)}/${issue.number}`);
    })
  );

  app.post(
    '/:collection/:repo/issues/:n/state',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const found = await withIssue(req, res, viewer);
      if (!found) return;
      const { ctx, issue } = found;
      if (!ctx.canPush && viewer.auth.username !== issue.author) {
        fail(res, 403, 'Only the author or someone with push access can close this issue.', viewer, `${issuesUrl(ctx)}/${issue.number}`);
        return;
      }
      const state = field(req, 'state') === 'closed' ? 'closed' : 'open';
      // A comment posted with the button is kept, so "close with a comment"
      // is one action rather than two.
      const text = field(req, 'body').trim();
      if (text !== '') {
        try {
          issues.addComment(root, ctx.collection, ctx.repo, issue.number, { author: viewer.auth.username, body: text });
        } catch {
          // A comment too long to store must not stop the state change.
        }
      }
      issues.setIssueState(root, ctx.collection, ctx.repo, issue.number, state, viewer.auth.username);
      res.redirect(`${issuesUrl(ctx)}/${issue.number}`);
    })
  );
}
