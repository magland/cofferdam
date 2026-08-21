import * as crypto from 'crypto';
import { Express, Request, Response } from 'express';
import { avatar } from './avatar';
import { IconName, icon } from './icons';
import * as issues from './issues';
import { Issue, IssueSummary } from './issues';
import { Html, html, joinHtml, raw } from './html';
import { renderMarkdown } from './markdown';
import { markdownEditor, previewUrl } from './mdedit';
import { OpError } from './ops';
import { timeTag } from './render';
import { Viewer, getViewer } from './session';
import { RepoCtx, csrfField, encPath, layout, repoHeader, repoOpts, repoUrl, userLink } from './views';
import {
  ah,
  fail,
  field,
  loadRepo,
  makeCtx,
  requireViewerPage,
  requireViewerPost,
  send404,
  urlencodedForm,
} from './web';

// The issue pages, over the store in issues.ts.
//
// Who may do what follows the vault's model rather than GitHub's: reading is
// anonymous like every other read, opening an issue and commenting need a
// session (a vault's users are its users; there is no public sign-up to
// abuse), and closing, reopening, or editing needs the write role on the
// repository or being the person who wrote the thing.

// Issue bodies and comments are the long fields here, and people paste logs
// into them.
const form = urlencodedForm('3mb');

function issuesUrl(ctx: RepoCtx): string {
  return `${repoUrl(ctx)}/issues`;
}

/** Issue bodies are markdown, rendered by the same sanitizing pipeline as a
 * README: this is text one user writes and another reads. Relative links
 * resolve against the default branch, since an issue has no file of its own. */
function body(ctx: RepoCtx, text: string): Html {
  const base = repoUrl(ctx);
  const ref = encPath(ctx.defaultBranch || ctx.ref || 'HEAD');
  return raw(
    renderMarkdown(text, {
      rawBase: `${base}/raw/${ref}`,
      blobBase: `${base}/blob/${ref}`,
      issueBase: `${base}/issues`,
      commitBase: `${base}/commit`,
      mentions: ctx.hasUser,
    })
  );
}

function stateBadge(state: 'open' | 'closed'): Html {
  return state === 'open'
    ? html`<span class="state-badge open">${icon('issue-opened')}<span>Open</span></span>`
    : html`<span class="state-badge closed">${icon('issue-closed')}<span>Closed</span></span>`;
}

/** What the reader has narrowed the list to, and what the links must carry. */
interface IssueFilter {
  state: 'open' | 'closed' | 'all';
  label: string;
  author: string;
  query: string;
  sort: issues.IssueSort;
}

/** The same filter with one field changed, as a query string. */
function filterUrl(base: string, filter: IssueFilter, change: Partial<IssueFilter>): string {
  const next = { ...filter, ...change };
  const params = new URLSearchParams();
  if (next.state !== 'open') params.set('state', next.state);
  if (next.label) params.set('label', next.label);
  if (next.author) params.set('author', next.author);
  if (next.query) params.set('q', next.query);
  if (next.sort !== 'newest') params.set('sort', next.sort);
  const q = params.toString();
  return q === '' ? base : `${base}?${q}`;
}

/**
 * A label's colour is derived from its name, the way an identicon is: a vault
 * keeps no label registry, so the set of labels is whatever the issues carry,
 * and a colour that comes from the name is stable without one being stored.
 */
function labelStyle(label: string): string {
  const hash = crypto.createHash('sha256').update(label.trim().toLowerCase()).digest();
  return `background: hsl(${Math.round((hash[0] / 256) * 360)} 58% 46%); color: #fff;`;
}

function labelChips(labels: string[], base?: string, filter?: IssueFilter): Html {
  return joinHtml(
    labels.map((l) =>
      base && filter
        ? html`<a class="chip label" style="${raw(labelStyle(l))}" href="${filterUrl(base, filter, {
            label: l,
          })}">${l}</a>`
        : html`<span class="chip label" style="${raw(labelStyle(l))}">${l}</span>`
    )
  );
}

function listPage(
  ctx: RepoCtx,
  list: IssueSummary[],
  filter: IssueFilter,
  counts: { open: number; closed: number },
  labels: { label: string; count: number }[],
  authors: { author: string; count: number }[]
): string {
  const base = issuesUrl(ctx);
  const tab = (id: 'open' | 'closed', label: string, n: number, glyph: 'issue-opened' | 'issue-closed') =>
    html`<a class="state-tab${filter.state === id ? ' current' : ''}" href="${filterUrl(base, filter, {
      state: id,
    })}">${icon(glyph)}<span>${n} ${label}</span></a>`;
  const rows = list.map(
    (i) =>
      html`<tr>
<td class="issue-cell">${icon(i.state === 'open' ? 'issue-opened' : 'issue-closed', i.state === 'open' ? 'issue-open' : 'issue-closed')}<span>
<a class="issue-link" href="${base}/${i.number}">${i.title}</a>${labelChips(i.labels, base, filter)}
<div class="muted small">#${i.number} opened ${timeTag(i.created)} by ${userLink(i.author)}${
        i.state === 'closed' && i.closedAt ? html` &middot; closed ${timeTag(i.closedAt)}` : ''
      }</div></span></td>
<td class="right muted small">${
        i.comments > 0
          ? html`<a class="issue-comments" href="${base}/${i.number}" title="${i.comments} comment${
              i.comments === 1 ? '' : 's'
            }">${icon('comment')}<span>${i.comments}</span></a>`
          : ''
      }</td>
</tr>`
  );
  const newBtn = ctx.viewer
    ? html`<a class="btn btn-primary" href="${base}/new">${icon('plus')}<span>New issue</span></a>`
    : html`<a class="btn" href="/login?next=${encodeURIComponent(`${base}/new`)}">${icon(
        'plus'
      )}<span>New issue</span></a>`;

  // The three menus and the search box. Each menu is a list of links carrying
  // the rest of the filter, so narrowing never loses what was already chosen
  // and nothing here needs script.
  const menu = (label: string, current: string, glyph: IconName, items: Html[]) =>
    html`<details class="dropdown">
<summary class="btn">${icon(glyph)}<span>${current || label}</span>${icon('chevron-down', 'caret')}</summary>
<div class="dropdown-menu"><div class="dd-scroll">${items}</div></div>
</details>`;
  const labelMenu = menu(
    'Labels',
    filter.label,
    'tag',
    [
      html`<a class="dd-item${filter.label === '' ? ' current' : ''}" href="${filterUrl(base, filter, {
        label: '',
      })}"><span class="dd-check"></span><span class="dd-label">Any label</span></a>`,
      ...labels.map(
        (l) =>
          html`<a class="dd-item${filter.label === l.label ? ' current' : ''}" href="${filterUrl(base, filter, {
            label: l.label,
          })}">${
            filter.label === l.label ? icon('check', 'dd-check') : raw('<span class="dd-check"></span>')
          }<span class="dd-label">${l.label}</span><span class="muted small">${l.count}</span></a>`
      ),
    ]
  );
  const authorMenu = menu(
    'Author',
    filter.author,
    'person',
    [
      html`<a class="dd-item${filter.author === '' ? ' current' : ''}" href="${filterUrl(base, filter, {
        author: '',
      })}"><span class="dd-check"></span><span class="dd-label">Anyone</span></a>`,
      ...authors.map(
        (a) =>
          html`<a class="dd-item${filter.author === a.author ? ' current' : ''}" href="${filterUrl(base, filter, {
            author: a.author,
          })}">${
            filter.author === a.author ? icon('check', 'dd-check') : raw('<span class="dd-check"></span>')
          }<span class="dd-label">${a.author}</span><span class="muted small">${a.count}</span></a>`
      ),
    ]
  );
  const sortMenu = menu(
    'Sort',
    issues.ISSUE_SORTS.find((x) => x.key === filter.sort)?.label ?? 'Newest',
    'filter',
    issues.ISSUE_SORTS.map(
      (x) =>
        html`<a class="dd-item${filter.sort === x.key ? ' current' : ''}" href="${filterUrl(base, filter, {
          sort: x.key,
        })}">${
          filter.sort === x.key ? icon('check', 'dd-check') : raw('<span class="dd-check"></span>')
        }<span class="dd-label">${x.label}</span></a>`
    )
  );
  const hidden = [
    filter.state === 'open' ? '' : html`<input type="hidden" name="state" value="${filter.state}">`,
    filter.label === '' ? '' : html`<input type="hidden" name="label" value="${filter.label}">`,
    filter.author === '' ? '' : html`<input type="hidden" name="author" value="${filter.author}">`,
    filter.sort === 'newest' ? '' : html`<input type="hidden" name="sort" value="${filter.sort}">`,
  ];
  const search = html`<form class="issue-search" method="get" action="${base}" role="search">${hidden}
<input class="search-input" type="search" name="q" value="${
    filter.query
  }" placeholder="Search issues" aria-label="Search issues">${icon('search', 'search-glyph')}</form>`;
  const narrowed = filter.label !== '' || filter.author !== '' || filter.query !== '';
  const clear = narrowed
    ? html`<a class="btn" href="${filterUrl(base, filter, { label: '', author: '', query: '' })}">${icon(
        'x'
      )}<span>Clear</span></a>`
    : '';
  const empty = narrowed
    ? 'No issues match that.'
    : filter.state === 'closed'
      ? 'No closed issues.'
      : filter.state === 'open'
        ? 'No open issues. Anything that needs doing here can be written down.'
        : 'No issues yet.';
  const content = html`${repoHeader(ctx, 'issues')}
<div class="page-head">
  <span class="state-filter">${tab('open', 'Open', counts.open, 'issue-opened')}${tab(
    'closed',
    'Closed',
    counts.closed,
    'issue-closed'
  )}</span>
  ${newBtn}
</div>
<div class="issue-filters">${search}<span class="right-group">${labelMenu}${authorMenu}${sortMenu}${clear}</span></div>
${
    rows.length
      ? html`<table class="listing issues"><tbody>${rows}</tbody></table>`
      : html`<div class="empty-state">${empty}</div>`
  }`;
  return layout(`Issues - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, filterUrl(base, filter, {})));
}

function commentCard(author: string, when: string, rendered: Html, note = ''): Html {
  return html`<article class="issue-comment">
<div class="issue-comment-head">${userLink(author, { face: 24, bold: true })}<span class="muted small">${
    note || 'commented'
  } ${timeTag(when)}</span></div>
<div class="issue-comment-body markdown-body">${rendered}</div>
</article>`;
}

function issuePage(ctx: RepoCtx, issue: Issue, canWrite: boolean): string {
  const base = issuesUrl(ctx);
  const viewer = ctx.viewer;
  const mine = viewer !== null && viewer.auth.username === issue.author;
  const canClose = canWrite || mine;
  const comments = issue.commentList.map((c) => commentCard(c.author, c.created, body(ctx, c.body)));
  const closedNote =
    issue.state === 'closed' && issue.closedAt
      ? html`<div class="issue-event">${icon('issue-closed', 'issue-closed')}<span>${
          issue.closedBy ? userLink(issue.closedBy, { bold: true }) : html`<b>someone</b>`
        } closed this ${timeTag(issue.closedAt)}</span></div>`
      : '';
  let replyBox: Html;
  if (viewer) {
    const toggle = canClose
      ? html`<button class="btn" type="submit" name="state" value="${
          issue.state === 'open' ? 'closed' : 'open'
        }" formaction="${base}/${issue.number}/state">${icon(
          issue.state === 'open' ? 'issue-closed' : 'issue-opened'
        )}<span>${issue.state === 'open' ? 'Close issue' : 'Reopen issue'}</span></button>`
      : '';
    replyBox = html`<form class="issue-reply" method="post" action="${base}/${issue.number}/comment">${csrfField(
      viewer
    )}
<div class="issue-comment-head">${avatar(viewer.auth.username, 24)}<b>${viewer.auth.username}</b></div>
${markdownEditor({ name: 'body', rows: 6, placeholder: 'Leave a comment', preview: previewUrl(ctx) })}
<div class="actions">${toggle}<button class="btn btn-primary" type="submit">Comment</button></div>
</form>`;
  } else {
    replyBox = html`<p class="muted"><a href="/login?next=${encodeURIComponent(
      `${base}/${issue.number}`
    )}">Sign in</a> to comment.</p>`;
  }
  const edit = canClose
    ? html`<a class="btn" href="${base}/${issue.number}/edit">${icon('pencil')}<span>Edit</span></a>`
    : '';
  const description = body(ctx, issue.body);
  const content = html`${repoHeader(ctx, 'issues')}
<div class="issue-head">
  <h1 class="issue-title">${issue.title} <span class="muted">#${issue.number}</span></h1>
  <span class="right-group">${edit}<a class="btn" href="${base}">Back to issues</a></span>
</div>
<div class="issue-sub">${stateBadge(issue.state)}<span class="muted">${userLink(issue.author, {
    bold: true,
  })} opened this ${timeTag(issue.created)} &middot; ${issue.commentList.length} comment${
    issue.commentList.length === 1 ? '' : 's'
  }</span>${labelChips(issue.labels)}</div>
<div class="issue-thread">
${commentCard(
    issue.author,
    issue.created,
    description.text ? description : raw('<p class="muted">No description.</p>'),
    'opened this'
  )}
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
  const content = html`${repoHeader(ctx, 'issues')}
<div class="form-box wide">
<h1>${mode === 'new' ? 'New issue' : `Edit issue #${values.number}`}</h1>
${error ? html`<div class="form-error">${error}</div>` : ''}
<form method="post" action="${action}">${csrfField(viewer)}
<div class="field"><label for="title">Title</label>
<input type="text" id="title" name="title" value="${values.title}" maxlength="${
    issues.MAX_TITLE
  }" required autofocus></div>
<div class="field"><label for="body">Description</label>
${markdownEditor({ name: 'body', id: 'body', rows: 12, placeholder: 'Markdown is welcome', value: values.body, preview: previewUrl(ctx) })}</div>
${
  ctx.canPush
    ? html`<div class="field"><label for="labels">Labels</label>
<input type="text" id="labels" name="labels" value="${values.labels.join(', ')}" placeholder="bug, ui">
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
      const sortAsked = String(req.query.sort ?? 'newest');
      const filter: IssueFilter = {
        state: asked === 'closed' ? 'closed' : asked === 'all' ? 'all' : 'open',
        label: String(req.query.label ?? '').slice(0, 60),
        author: String(req.query.author ?? '').slice(0, 60),
        // A query is a reader's typing and becomes a substring match, not a
        // pattern, so its only bound is a sane length.
        query: String(req.query.q ?? '').slice(0, 200),
        sort: (issues.ISSUE_SORTS.find((x) => x.key === sortAsked)?.key ?? 'newest') as issues.IssueSort,
      };
      // Counts on the state tabs are of the whole repository, as GitHub's are,
      // so they do not move as the other filters narrow the list.
      const { all, matched } = issues.listIssuesAndMatches(root, ctx.collection, ctx.repo, filter.query);
      const counts = {
        open: all.filter((i) => i.state === 'open').length,
        closed: all.filter((i) => i.state === 'closed').length,
      };
      const list = issues.selectIssues(matched, filter);
      res
        .type('html')
        .send(listPage(ctx, list, filter, counts, issues.labelsInUse(all), issues.authorsInUse(all)));
    })
  );

  app.get(
    '/:collection/:repo/issues/new',
    ah(async (req, res) => {
      const viewer = requireViewerPage(root, req, res);
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
      const viewer = requireViewerPost(root, req, res);
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
      const viewer = requireViewerPage(root, req, res);
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
      const viewer = requireViewerPost(root, req, res);
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
      const viewer = requireViewerPost(root, req, res);
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
      const viewer = requireViewerPost(root, req, res);
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
        } catch (e) {
          // A comment too long to store must not stop the state change, which
          // is the reason this is swallowed rather than reported. Only the
          // validation failures are: a disk that is full or a directory that
          // cannot be written is not something to close an issue quietly over.
          if (!(e instanceof OpError)) throw e;
        }
      }
      issues.setIssueState(root, ctx.collection, ctx.repo, issue.number, state, viewer.auth.username);
      res.redirect(`${issuesUrl(ctx)}/${issue.number}`);
    })
  );
}
