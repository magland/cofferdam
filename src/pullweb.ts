import express, { Express, Request, Response } from 'express';
import { avatar } from './avatar';
import { CiEngine } from './ci/engine';
import { renderDiff } from './diff';
import * as forms from './forms';
import { CommitSummary, isValidRefName } from './git';
import { icon } from './icons';
import { renderMarkdown } from './markdown';
import { OpError, mergeBranch, previewMerge, MergePreview } from './ops';
import * as pulls from './pulls';
import { Pull, PullSummary } from './pulls';
import { esc, timeTag } from './render';
import { findRepo } from './scan';
import { Viewer, checkCsrf, getViewer } from './session';
import { RepoCtx, csrfField, encPath, layout, repoHeader, repoOpts, repoUrl } from './views';
import { ah, loadRepo, makeCtx, send404 } from './web';

// Pull requests: the pages over the store in pulls.ts, and the merge button
// over ops.mergeBranch.
//
// A pull request here is one repository's branch proposed into another of its
// branches. Across repositories comes with forking, and nothing in the stored
// shape forbids it later; what it needs is a way to name a head somewhere
// else, which a vault does not have yet.
//
// Who may do what follows the vault's model, as issues do: reading is
// anonymous, opening one and commenting need a session, closing needs push
// scope or authorship, and merging needs push scope over the repository,
// because a merge is a write to a branch like any other.

const form = express.urlencoded({ extended: false, limit: '3mb' });

function field(req: Request, name: string): string {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v : '';
}

function pullsUrl(ctx: RepoCtx): string {
  return `${repoUrl(ctx)}/pulls`;
}

/** Descriptions and comments are markdown, through the same sanitizing path
 * as a README, with #12 and commit ids linked as they are in an issue. */
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

function stateBadge(state: PullSummary['state']): string {
  if (state === 'merged') return `<span class="state-badge merged">${icon('git-merge')}<span>Merged</span></span>`;
  if (state === 'closed')
    return `<span class="state-badge closed">${icon('git-pull-request-closed')}<span>Closed</span></span>`;
  return `<span class="state-badge open">${icon('git-pull-request')}<span>Open</span></span>`;
}

function stateIcon(state: PullSummary['state']): string {
  if (state === 'merged') return icon('git-merge', 'pull-merged');
  if (state === 'closed') return icon('git-pull-request-closed', 'issue-closed');
  return icon('git-pull-request', 'issue-open');
}

function branchPair(ctx: RepoCtx, pull: PullSummary): string {
  const base = repoUrl(ctx);
  const chip = (ref: string) =>
    `<a class="chip mono" href="${base}/tree/${encPath(ref)}">${esc(ref)}</a>`;
  return `${chip(pull.base)} <span class="muted">&larr;</span> ${chip(pull.head)}`;
}

function listPage(
  ctx: RepoCtx,
  list: PullSummary[],
  state: 'open' | 'closed' | 'all',
  counts: { open: number; closed: number }
): string {
  const base = pullsUrl(ctx);
  const tab = (id: string, label: string, n: number, glyph: 'git-pull-request' | 'git-merge') =>
    `<a class="state-tab${state === id ? ' current' : ''}" href="${base}?state=${id}">${icon(
      glyph
    )}<span>${n} ${label}</span></a>`;
  const rows = list
    .map(
      (p) =>
        `<tr>
<td class="issue-cell">${stateIcon(p.state)}<span>
<a class="issue-link" href="${base}/${p.number}">${esc(p.title)}</a>
<div class="muted small">#${p.number} opened ${timeTag(p.created)} by ${esc(p.author)} &middot; ${branchPair(
          ctx,
          p
        )}</div></span></td>
<td class="right muted small">${
          p.comments > 0
            ? `<a class="issue-comments" href="${base}/${p.number}" title="${p.comments} comment${
                p.comments === 1 ? '' : 's'
              }">${icon('comment')}<span>${p.comments}</span></a>`
            : ''
        }</td>
</tr>`
    )
    .join('');
  const newBtn = ctx.viewer
    ? `<a class="btn btn-primary" href="${base}/new">${icon('git-pull-request')}<span>New pull request</span></a>`
    : `<a class="btn" href="/login?next=${encodeURIComponent(`${base}/new`)}">${icon(
        'git-pull-request'
      )}<span>New pull request</span></a>`;
  const empty =
    state === 'closed'
      ? 'Nothing closed or merged yet.'
      : state === 'open'
        ? 'No open pull requests. Push a branch and propose it here.'
        : 'No pull requests yet.';
  const content = `${repoHeader(ctx, 'pulls')}
<div class="page-head">
  <span class="state-filter">${tab('open', 'Open', counts.open, 'git-pull-request')}${tab(
    'closed',
    'Closed',
    counts.closed,
    'git-merge'
  )}</span>
  ${newBtn}
</div>
${rows ? `<table class="listing issues"><tbody>${rows}</tbody></table>` : `<div class="empty-state">${empty}</div>`}`;
  return layout(`Pull requests - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, base));
}

function commentCard(author: string, when: string, html: string, note = ''): string {
  return `<article class="issue-comment">
<div class="issue-comment-head">${avatar(author, 24)}<b>${esc(author)}</b><span class="muted small">${
    note || 'commented'
  } ${timeTag(when)}</span></div>
<div class="issue-comment-body markdown-body">${html}</div>
</article>`;
}

/** The box that says whether this can be merged, and offers to do it. */
function mergeBox(ctx: RepoCtx, pull: Pull, preview: MergePreview | null, canMerge: boolean): string {
  const viewer = ctx.viewer;
  if (pull.state === 'merged') {
    return `<div class="merge-box merged">${icon('git-merge')}<div><b>Merged</b><div class="muted small">${esc(
      pull.mergedBy ?? 'someone'
    )} merged this ${pull.mergedAt ? timeTag(pull.mergedAt) : ''}${
      pull.mergeSha
        ? ` as <a class="sha" href="${repoUrl(ctx)}/commit/${esc(pull.mergeSha)}">${esc(pull.mergeSha.slice(0, 7))}</a>`
        : ''
    }</div></div></div>`;
  }
  if (pull.state === 'closed') {
    return `<div class="merge-box closed">${icon('git-pull-request-closed')}<div><b>Closed without merging</b><div class="muted small">${esc(
      pull.closedBy ?? 'someone'
    )} closed this ${pull.closedAt ? timeTag(pull.closedAt) : ''}</div></div></div>`;
  }
  if (!preview) {
    return `<div class="merge-box unknown">${icon('alert')}<div><b>This branch cannot be compared</b><div class="muted small">One of ${esc(
      pull.base
    )} and ${esc(pull.head)} no longer exists.</div></div></div>`;
  }
  if (preview.status === 'up-to-date') {
    return `<div class="merge-box unknown">${icon('check')}<div><b>Nothing to merge</b><div class="muted small">${esc(
      pull.base
    )} already contains everything on ${esc(pull.head)}.</div></div></div>`;
  }
  if (preview.status === 'conflict') {
    const paths = preview.paths.slice(0, 20).map((p) => `<li class="mono">${esc(p)}</li>`).join('');
    return `<div class="merge-box conflict">${icon('x')}<div><b>This branch has conflicts that must be resolved</b>
<div class="muted small">Merge ${esc(pull.base)} into ${esc(pull.head)} where you work, resolve them, and push.</div>
<ul class="merge-conflicts">${paths}</ul></div></div>`;
  }
  const button =
    canMerge && viewer
      ? `<form method="post" action="${pullsUrl(ctx)}/${pull.number}/merge">${csrfField(
          viewer
        )}<button class="btn btn-primary" type="submit">${icon('git-merge')}<span>Merge pull request</span></button></form>`
      : `<span class="muted small">${
          viewer ? 'Merging needs push access to this repository.' : 'Sign in with push access to merge.'
        }</span>`;
  return `<div class="merge-box clean">${icon('check')}<div><b>This branch has no conflicts with ${esc(
    pull.base
  )}</b><div class="muted small">${
    preview.fastForward
      ? 'It can be merged by moving the branch forward.'
      : 'Merging creates a merge commit on the base branch.'
  }</div></div>${button}</div>`;
}

function pullPage(
  ctx: RepoCtx,
  pull: Pull,
  view: { commits: CommitSummary[]; patch: string; ahead: number; preview: MergePreview | null }
): string {
  const base = pullsUrl(ctx);
  const repo = repoUrl(ctx);
  const viewer = ctx.viewer;
  const mine = viewer !== null && viewer.auth.username === pull.author;
  const canClose = ctx.canPush || mine;
  const comments = pull.commentList.map((c) => commentCard(c.author, c.created, body(ctx, c.body))).join('');
  let replyBox = '';
  if (viewer) {
    const toggle =
      canClose && pull.state !== 'merged'
        ? `<button class="btn" type="submit" name="state" value="${
            pull.state === 'open' ? 'closed' : 'open'
          }" formaction="${base}/${pull.number}/state">${icon(
            pull.state === 'open' ? 'git-pull-request-closed' : 'git-pull-request'
          )}<span>${pull.state === 'open' ? 'Close pull request' : 'Reopen'}</span></button>`
        : '';
    replyBox = `<form class="issue-reply" method="post" action="${base}/${pull.number}/comment">${csrfField(viewer)}
<div class="issue-comment-head">${avatar(viewer.auth.username, 24)}<b>${esc(viewer.auth.username)}</b></div>
<textarea class="code-editor" name="body" rows="6" placeholder="Leave a comment"></textarea>
<div class="actions">${toggle}<button class="btn btn-primary" type="submit">Comment</button></div>
</form>`;
  } else {
    replyBox = `<p class="muted"><a href="/login?next=${encodeURIComponent(
      `${base}/${pull.number}`
    )}">Sign in</a> to comment.</p>`;
  }
  const commitRows = view.commits
    .map(
      (c) =>
        `<div class="commit-row"><span class="commit-main"><a class="title" href="${repo}/commit/${c.sha}">${esc(
          c.subject
        )}</a><div class="muted small">${esc(c.author)} committed ${timeTag(c.date)}</div></span><a class="sha" href="${repo}/commit/${
          c.sha
        }">${c.sha.slice(0, 7)}</a></div>`
    )
    .join('');
  const content = `${repoHeader(ctx, 'pulls')}
<div class="issue-head">
  <h1 class="issue-title">${esc(pull.title)} <span class="muted">#${pull.number}</span></h1>
  <span class="right-group"><a class="btn" href="${base}">Back to pull requests</a></span>
</div>
<div class="issue-sub">${stateBadge(pull.state)}<span class="muted"><b>${esc(
    pull.author
  )}</b> wants to merge ${view.ahead} commit${view.ahead === 1 ? '' : 's'} into </span>${branchPair(ctx, pull)}</div>
${mergeBox(ctx, pull, view.preview, ctx.canPush)}
<div class="issue-thread">
${commentCard(pull.author, pull.created, body(ctx, pull.body) || '<p class="muted">No description.</p>', 'opened this')}
${comments}
${replyBox}
</div>
<div class="box"><div class="box-header">${icon('git-commit')}<span>${view.commits.length} commit${
    view.commits.length === 1 ? '' : 's'
  }</span></div><div class="box-body pull-commits">${
    commitRows || '<p class="muted">Nothing to merge.</p>'
  }</div></div>
<h2 class="pull-files">Files changed</h2>
${renderDiff(view.patch, { blobBase: `${repo}/blob/${encPath(pull.head)}` })}`;
  return layout(
    `${pull.title} · #${pull.number} - ${ctx.collection}/${ctx.repo}`,
    content,
    repoOpts(ctx, `${base}/${pull.number}`)
  );
}

function newPage(
  ctx: RepoCtx,
  viewer: Viewer,
  values: { base: string; head: string; title: string; body: string },
  info: { ahead: number; commits: CommitSummary[] } | null,
  error?: string
): string {
  const base = pullsUrl(ctx);
  const options = (selected: string) =>
    ctx.branches.map((b) => `<option value="${esc(b.name)}"${b.name === selected ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
  const content = `${repoHeader(ctx, 'pulls')}
<div class="form-box wide">
<h1>New pull request</h1>
${error ? `<div class="form-error">${esc(error)}</div>` : ''}
<form method="get" action="${base}/new" class="cmp-form">
${icon('git-compare')}<label class="cmp-picker">base <select name="base">${options(values.base)}</select></label>
<span class="muted">&larr;</span>
<label class="cmp-picker">compare <select name="head">${options(values.head)}</select></label>
<button class="btn" type="submit">Change branches</button>
</form>
${
  info
    ? `<p class="muted">${info.ahead} commit${info.ahead === 1 ? '' : 's'} would be merged into <b>${esc(
        values.base
      )}</b> from <b>${esc(values.head)}</b>.</p>`
    : ''
}
<form method="post" action="${base}/new">${csrfField(viewer)}
<input type="hidden" name="base" value="${esc(values.base)}">
<input type="hidden" name="head" value="${esc(values.head)}">
<div class="field"><label for="title">Title</label>
<input type="text" id="title" name="title" value="${esc(values.title)}" maxlength="${
    pulls.MAX_TITLE
  }" required autofocus></div>
<div class="field"><label for="body">Description</label>
<textarea class="code-editor" id="body" name="body" rows="10" placeholder="What this changes, and why. Markdown is welcome.">${esc(
    values.body
  )}</textarea></div>
<div class="actions"><button class="btn btn-primary" type="submit">${icon(
    'git-pull-request'
  )}<span>Create pull request</span></button><a class="btn" href="${base}">Cancel</a></div>
</form>
</div>`;
  return layout(`New pull request - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, `${base}/new`));
}

export function registerPulls(app: Express, root: string, engine?: CiEngine): void {
  // A merge moves a branch, which is a push as far as workflows are
  // concerned, so the same event goes to the CI engine. A failure there is
  // logged and never allowed to affect the merge, which has already happened.
  function firePush(
    repo: { collection: string; name: string },
    branch: string,
    before: string,
    after: string,
    actor: string
  ): void {
    if (!engine) return;
    const gitRepo = findRepo(root, repo.collection, repo.name);
    if (!gitRepo) return;
    engine
      .handlePush(gitRepo, { ref: `refs/heads/${branch}`, before, after, actor })
      .catch((e) => console.error(`CI trigger failed: ${e instanceof Error ? e.message : e}`));
  }

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

  /** The repository context plus the pull request named in the URL. */
  async function withPull(req: Request, res: Response, viewer: Viewer | null) {
    const loaded = await loadRepo(root, req, res, viewer);
    if (!loaded) return null;
    const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
    if (!/^[1-9][0-9]*$/.test(req.params.n ?? '')) {
      send404(res, 'No such pull request', viewer);
      return null;
    }
    const n = parseInt(req.params.n, 10);
    const pull = pulls.readPull(root, ctx.collection, ctx.repo, n);
    if (!pull) {
      send404(res, `Pull request #${n} does not exist in ${ctx.collection}/${ctx.repo}`, viewer);
      return null;
    }
    return { ctx, pull, loaded };
  }

  app.get(
    '/:collection/:repo/pulls',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      const asked = String(req.query.state ?? 'open');
      const state = asked === 'closed' ? 'closed' : asked === 'all' ? 'all' : 'open';
      const all = pulls.listPulls(root, ctx.collection, ctx.repo);
      const counts = {
        open: all.filter((p) => p.state === 'open').length,
        closed: all.filter((p) => p.state !== 'open').length,
      };
      const list = state === 'all' ? all : all.filter((p) => (state === 'open' ? p.state === 'open' : p.state !== 'open'));
      res.type('html').send(listPage(ctx, list, state, counts));
    })
  );

  app.get(
    '/:collection/:repo/pulls/new',
    ah(async (req, res) => {
      const viewer = requireViewerPage(req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      const names = ctx.branches.map((b) => b.name);
      const asked = (name: string, fallback: string) => {
        const value = String(req.query[name] ?? '');
        return names.includes(value) ? value : fallback;
      };
      const baseRef = asked('base', ctx.defaultBranch || names[0] || '');
      const headRef = asked('head', names.find((n) => n !== baseRef) ?? baseRef);
      if (names.length < 2) {
        fail(
          res,
          400,
          'A pull request needs two branches; this repository has fewer.',
          viewer,
          repoUrl(ctx)
        );
        return;
      }
      const cmp = await loaded.repo.compare(baseRef, headRef);
      res.type('html').send(
        newPage(
          ctx,
          viewer,
          {
            base: baseRef,
            head: headRef,
            // The first commit's subject is what people would type anyway.
            title: cmp.commits.length === 1 ? cmp.commits[0].subject : '',
            body: '',
          },
          { ahead: cmp.ahead, commits: cmp.commits }
        )
      );
    })
  );

  app.post(
    '/:collection/:repo/pulls/new',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      const baseRef = field(req, 'base');
      const headRef = field(req, 'head');
      const names = ctx.branches.map((b) => b.name);
      if (!names.includes(baseRef) || !names.includes(headRef)) {
        fail(res, 400, 'Both the base and the compare branch must exist.', viewer, `${pullsUrl(ctx)}/new`);
        return;
      }
      const title = field(req, 'title');
      const text = field(req, 'body');
      try {
        const created = pulls.createPull(root, ctx.collection, ctx.repo, {
          title,
          body: text,
          author: viewer.auth.username,
          base: baseRef,
          head: headRef,
        });
        res.redirect(`${pullsUrl(ctx)}/${created.number}`);
      } catch (e) {
        const message = e instanceof OpError ? e.message : 'Could not open the pull request.';
        res
          .status(400)
          .type('html')
          .send(newPage(ctx, viewer, { base: baseRef, head: headRef, title, body: text }, null, message));
      }
    })
  );

  app.get(
    '/:collection/:repo/pulls/:n',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const found = await withPull(req, res, viewer);
      if (!found) return;
      const { ctx, pull, loaded } = found;
      const known = (ref: string) => ctx.branches.some((b) => b.name === ref);
      let view = { commits: [] as CommitSummary[], patch: '', ahead: 0, preview: null as MergePreview | null };
      if (isValidRefName(pull.base) && isValidRefName(pull.head) && known(pull.base) && known(pull.head)) {
        const cmp = await loaded.repo.compare(pull.base, pull.head);
        // A merged or closed pull request is history: what it did is on the
        // base branch already, so no merge is planned for it.
        const preview =
          pull.state === 'open' ? await previewMerge(loaded.repo.dir, pull.base, pull.head).catch(() => null) : null;
        view = { commits: cmp.commits, patch: cmp.patch, ahead: cmp.ahead, preview };
      }
      res.type('html').send(pullPage(ctx, pull, view));
    })
  );

  app.post(
    '/:collection/:repo/pulls/:n/comment',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const found = await withPull(req, res, viewer);
      if (!found) return;
      const { ctx, pull } = found;
      try {
        pulls.addComment(root, ctx.collection, ctx.repo, pull.number, {
          author: viewer.auth.username,
          body: field(req, 'body'),
        });
      } catch (e) {
        fail(
          res,
          400,
          e instanceof OpError ? e.message : 'Could not add the comment.',
          viewer,
          `${pullsUrl(ctx)}/${pull.number}`
        );
        return;
      }
      res.redirect(`${pullsUrl(ctx)}/${pull.number}`);
    })
  );

  app.post(
    '/:collection/:repo/pulls/:n/state',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const found = await withPull(req, res, viewer);
      if (!found) return;
      const { ctx, pull } = found;
      if (!ctx.canPush && viewer.auth.username !== pull.author) {
        fail(
          res,
          403,
          'Only the author or someone with push access can close this pull request.',
          viewer,
          `${pullsUrl(ctx)}/${pull.number}`
        );
        return;
      }
      const state = field(req, 'state') === 'closed' ? 'closed' : 'open';
      const text = field(req, 'body').trim();
      if (text !== '') {
        try {
          pulls.addComment(root, ctx.collection, ctx.repo, pull.number, {
            author: viewer.auth.username,
            body: text,
          });
        } catch {
          // A comment too long to store must not stop the state change.
        }
      }
      try {
        pulls.setPullState(root, ctx.collection, ctx.repo, pull.number, state, viewer.auth.username);
      } catch (e) {
        fail(
          res,
          400,
          e instanceof OpError ? e.message : 'Could not change the state.',
          viewer,
          `${pullsUrl(ctx)}/${pull.number}`
        );
        return;
      }
      res.redirect(`${pullsUrl(ctx)}/${pull.number}`);
    })
  );

  app.post(
    '/:collection/:repo/pulls/:n/merge',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(req, res);
      if (!viewer) return;
      const found = await withPull(req, res, viewer);
      if (!found) return;
      const { ctx, pull, loaded } = found;
      const back = `${pullsUrl(ctx)}/${pull.number}`;
      // Merging writes to a branch, so it takes push scope over the
      // repository: authorship is not enough, as it is for closing.
      if (!ctx.canPush) {
        fail(res, 403, `You do not have push access to ${ctx.collection}/${ctx.repo}.`, viewer, back);
        return;
      }
      if (pull.state !== 'open') {
        fail(res, 400, 'This pull request is not open.', viewer, back);
        return;
      }
      const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
      const host = (req.get('host') ?? 'localhost').replace(/:\d+$/, '');
      let outcome;
      try {
        outcome = await mergeBranch(loaded.repo.dir, pull.base, pull.head, message, {
          name: viewer.auth.username,
          email: `${viewer.auth.username}@noreply.${host}`,
        });
      } catch (e) {
        fail(res, 400, e instanceof OpError ? e.message : 'The merge failed.', viewer, back);
        return;
      }
      if (outcome.status === 'conflict') {
        fail(res, 409, 'This branch has conflicts that must be resolved before it can be merged.', viewer, back);
        return;
      }
      if (outcome.status === 'up-to-date') {
        fail(res, 400, `${pull.base} already contains everything on ${pull.head}.`, viewer, back);
        return;
      }
      pulls.recordMerge(root, ctx.collection, ctx.repo, pull.number, {
        actor: viewer.auth.username,
        sha: outcome.sha,
      });
      firePush(
        { collection: ctx.collection, name: ctx.repo },
        pull.base,
        outcome.before,
        outcome.sha,
        viewer.auth.username
      );
      res.redirect(back);
    })
  );
}
