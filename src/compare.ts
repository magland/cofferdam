import { Express } from 'express';
import { renderDiff } from './diff';
import { CommitSummary, RefInfo, isValidRefName } from './git';
import { Html, html, joinHtml, raw } from './html';
import { icon } from './icons';
import { timeTag } from './render';
import { getViewer } from './session';
import { RepoCtx, encPath, layout, repoHeader, repoOpts, repoUrl } from './views';
import { ah, loadRepo, makeCtx, send404, wildcard } from './web';

// Comparing two revisions: what one branch has that another does not, and the
// patch between them. Without it, seeing how a branch differs from main means
// cloning the repository, which is a strange thing for a web interface to
// require of a reader.
//
// The address is GitHub's: /compare/<base>...<head>, three dots for the
// comparison taken from the merge base. The form posts to /compare with the
// two refs as query parameters and the handler accepts either shape, since a
// GET form cannot build a path.

/** The most commits a comparison lists before saying there are more. */
const MAX_COMMITS = 250;

function refOptions(refs: RefInfo[], selected: string): Html {
  return joinHtml(
    refs.map((r) => html`<option value="${r.name}"${r.name === selected ? raw(' selected') : ''}>${r.name}</option>`)
  );
}

function picker(ctx: RepoCtx, name: string, label: string, selected: string): Html {
  const groups = [
    ctx.branches.length ? html`<optgroup label="Branches">${refOptions(ctx.branches, selected)}</optgroup>` : '',
    ctx.tags.length ? html`<optgroup label="Tags">${refOptions(ctx.tags, selected)}</optgroup>` : '',
  ];
  const known = [...ctx.branches, ...ctx.tags].some((r) => r.name === selected);
  const loose = known ? '' : html`<option value="${selected}" selected>${selected}</option>`;
  return html`<label class="cmp-picker">${label}
<select name="${name}">${loose}${groups}</select></label>`;
}

function commitRows(ctx: RepoCtx, commits: CommitSummary[]): Html {
  const base = repoUrl(ctx);
  return joinHtml(
    commits.map(
      (c) =>
        html`<div class="commit-row"><span class="commit-main"><a class="title" href="${base}/commit/${c.sha}">${
          c.subject
        }</a><div class="muted small">${c.author} committed ${timeTag(c.date)}</div></span><span class="commit-actions"><a class="sha" href="${base}/commit/${
          c.sha
        }">${c.sha.slice(0, 7)}</a></span></div>`
    )
  );
}

function comparePage(
  ctx: RepoCtx,
  baseRef: string,
  headRef: string,
  result: { ahead: number; behind: number; commits: CommitSummary[]; patch: string; mergeBase: string | null } | null
): string {
  const base = repoUrl(ctx);
  const url = `${base}/compare/${encPath(baseRef)}...${encPath(headRef)}`;
  const form = html`<form class="cmp-form" method="get" action="${base}/compare">
${icon('git-branch')}${picker(ctx, 'base', 'base', baseRef)}<span class="muted">&hellip;</span>${picker(
    ctx,
    'head',
    'compare',
    headRef
  )}
<a class="btn" href="${base}/compare/${encPath(headRef)}...${encPath(
    baseRef
  )}" title="Swap the two revisions">${icon('sync')}<span>Swap</span></a>
<button class="btn btn-primary" type="submit">Compare</button>
</form>`;
  let body: Html;
  if (!result) {
    body = html`<div class="empty-state">Choose two revisions to compare.</div>`;
  } else if (result.commits.length === 0 && result.patch === '') {
    body = html`<div class="empty-state">These two revisions are identical.</div>`;
  } else {
    const behind =
      result.behind > 0
        ? html` <span class="muted">and is ${result.behind} commit${result.behind === 1 ? '' : 's'} behind</span>`
        : '';
    const more =
      result.ahead > result.commits.length
        ? html`<p class="muted small">Showing the newest ${result.commits.length} of ${result.ahead} commits.</p>`
        : '';
    // A comparison with something on it is a pull request waiting to be
    // written, which is the path GitHub puts here too.
    const propose =
      result.ahead > 0 && ctx.branches.some((b) => b.name === headRef) && ctx.branches.some((b) => b.name === baseRef)
        ? html`<a class="btn btn-primary" href="${base}/pulls/new?base=${encodeURIComponent(
            baseRef
          )}&amp;head=${encodeURIComponent(headRef)}">${icon('git-pull-request')}<span>Create pull request</span></a>`
        : '';
    body = html`<div class="cmp-status">
  <span><b>${headRef}</b> is <b>${result.ahead} commit${result.ahead === 1 ? '' : 's'}</b> ahead of <b>${baseRef}</b>${behind}.</span>
  ${propose}
</div>
${more}
<div class="cmp-commits">${commitRows(ctx, result.commits)}</div>
<div class="cmp-diff">${raw(renderDiff(result.patch, { blobBase: `${base}/blob/${encPath(headRef)}` }))}</div>`;
  }
  const content = html`${repoHeader(ctx, 'branches')}
<div class="page-head"><h2>Comparing changes</h2></div>
${form}
${body}`;
  return layout(`Comparing ${baseRef}...${headRef} - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, url));
}

export function registerCompare(app: Express, root: string): void {
  const handler = ah(async (req, res) => {
    const viewer = getViewer(req, root);
    const loaded = await loadRepo(root, req, res, viewer);
    if (!loaded) return;
    const fallback = loaded.defaultBranch ?? '';
    // Either shape: /compare/<base>...<head> from a link, or ?base=&head=
    // from the form. Two dots are accepted as well, since people type them.
    const spec = wildcard(req);
    const split = spec.includes('...') ? spec.split('...') : spec.includes('..') ? spec.split('..') : null;
    const baseRef = (split ? split[0] : String(req.query.base ?? '')) || fallback;
    const headRef = (split ? split[1] : String(req.query.head ?? '')) || fallback;
    const ctx = await makeCtx(root, req, loaded, headRef || fallback, viewer);
    // Only revisions this repository has: a comparison takes two arguments
    // from a URL and hands both to git.
    const known = (r: string) => loaded.refNames.includes(r) || /^[0-9a-f]{7,40}$/.test(r);
    if (baseRef === '' || headRef === '') {
      res.type('html').send(comparePage(ctx, baseRef, headRef, null));
      return;
    }
    if (!isValidRefName(baseRef) || !isValidRefName(headRef) || !known(baseRef) || !known(headRef)) {
      send404(res, `No revision ${known(baseRef) ? headRef : baseRef} here`, viewer);
      return;
    }
    const result = await loaded.repo.compare(baseRef, headRef, MAX_COMMITS);
    res.type('html').send(comparePage(ctx, baseRef, headRef, result));
  });
  app.get('/:collection/:repo/compare/*', handler);
  app.get('/:collection/:repo/compare', handler);
}
