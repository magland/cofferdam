import { CommitDetail, CommitSummary, RefInfo, TreeEntry } from './git';
import { esc, formatSize, timeTag } from './render';
import { Viewer, viewerIsAdmin } from './session';
import { activeTheme } from './themes';
import { WORDMARK } from './logo';
import { IconName, icon } from './icons';

export interface RepoCtx {
  collection: string;
  repo: string;
  ref: string;
  refIsBranch: boolean;
  defaultBranch: string;
  branches: RefInfo[];
  tags: RefInfo[];
  cloneUrl: string;
  hasSite: boolean;
  hasCi: boolean;
  viewer: Viewer | null;
  canPush: boolean;
  canAdmin: boolean;
}

export interface PageOpts {
  crumbs?: string;
  viewer?: Viewer | null;
  // Current request path, used as the ?next= target of the Sign in link.
  path?: string;
}

export function encPath(p: string): string {
  return p
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

export function repoUrl(ctx: { collection: string; repo: string }): string {
  return `/${encodeURIComponent(ctx.collection)}/${encodeURIComponent(ctx.repo)}`;
}

export function csrfField(viewer: Viewer): string {
  return `<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">`;
}

const FOLDER_ICON = icon('file-directory-fill', 'icon');
const FILE_ICON = icon('file', 'icon file');
const REPO_ICON = icon('repo', 'icon');

function userBox(opts: PageOpts): string {
  const viewer = opts.viewer ?? null;
  if (!viewer) {
    const next = opts.path && opts.path.startsWith('/') ? opts.path : '/';
    return `<a class="btn" href="/login?next=${encodeURIComponent(next)}">Sign in</a>`;
  }
  const admin = viewerIsAdmin(viewer) ? `<a href="/admin">Admin</a>` : '';
  return `${admin}<span class="user-name">${esc(viewer.auth.username)}</span><form method="post" action="/logout">${csrfField(
    viewer
  )}<button type="submit" class="btn-link">Sign out</button></form>`;
}

export function layout(title: string, content: string, opts: PageOpts = {}): string {
  // The theme name rides along as a query parameter so a changed theme busts
  // any cache in front of the stylesheets.
  const theme = activeTheme().name;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/assets/style.css?t=${encodeURIComponent(theme)}">
<link rel="stylesheet" href="/assets/hl.css?t=${encodeURIComponent(theme)}">
<link rel="stylesheet" href="/assets/katex/katex.css">
<link rel="icon" href="/favicon.svg?t=${encodeURIComponent(theme)}" type="image/svg+xml">
</head>
<body>
<header class="topbar"><div class="container"><a class="brand" href="/">${WORDMARK}</a><span class="crumbs">${
    opts.crumbs ?? ''
  }</span><div class="userbox">${userBox(opts)}</div></div></header>
<main class="container">
${content}
</main>
<script>
function copyCmd(btn) {
  var el = btn.previousElementSibling;
  var text = el && el.tagName === 'INPUT' ? el.value : el.textContent;
  function done() { btn.classList.add('copied'); setTimeout(function () { btn.classList.remove('copied'); }, 1400); }
  function fallback() {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { fallback(); done(); });
  } else { fallback(); done(); }
}
// Menus are <details> elements. These two handlers give them the rest of what
// a menu is expected to do: close when the reader clicks elsewhere or presses
// Escape. Nothing else about them needs script.
function closeMenus(except) {
  var open = document.querySelectorAll('details.dropdown[open]');
  for (var i = 0; i < open.length; i++) {
    if (!except || !open[i].contains(except)) open[i].open = false;
  }
}
document.addEventListener('click', function (e) { closeMenus(e.target); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenus(null); });
// The filter box in a menu of many items (branches and tags).
function filterMenu(input) {
  var menu = input.parentElement;
  var q = input.value.trim().toLowerCase();
  var groups = menu.querySelectorAll('.dd-group');
  for (var g = 0; g < groups.length; g++) {
    var items = groups[g].querySelectorAll('.dd-item');
    var shown = 0;
    for (var i = 0; i < items.length; i++) {
      var hit = q === '' || items[i].textContent.toLowerCase().indexOf(q) !== -1;
      items[i].hidden = !hit;
      if (hit) shown++;
    }
    groups[g].hidden = shown === 0;
  }
}
</script>
</body>
</html>`;
}

export function repoOpts(ctx: RepoCtx, path?: string): PageOpts {
  return { viewer: ctx.viewer, path };
}

/**
 * The copy button that sits after a <code> or <input> holding the text.
 * Confirmation is a class the script toggles rather than replaced markup, so
 * the idle and copied faces are both in the page and neither needs escaping
 * at click time.
 */
export function copyButton(label = ''): string {
  const face = (glyph: IconName, text: string, cls: string) =>
    `<span class="${cls}">${icon(glyph)}${label ? `<span>${esc(text)}</span>` : ''}</span>`;
  return `<button class="copy-btn" type="button" onclick="copyCmd(this)" aria-label="Copy${
    label ? ` ${esc(label.toLowerCase())}` : ''
  }">${face('copy', label, 'copy-idle')}${face('check', 'Copied', 'copy-done')}</button>`;
}

export function copyRow(cmd: string): string {
  return `<div class="cmd-row"><code>${esc(cmd)}</code>${copyButton()}</div>`;
}

/**
 * The branch and tag picker: a button carrying the current ref, opening a
 * menu of every ref with a filter box, as on GitHub. It is a <details>
 * element, so it opens, closes, and takes the keyboard without a component
 * framework; the page script closes it on an outside click and filters the
 * list as you type.
 */
function refPicker(ctx: RepoCtx, urlForRef: (ref: string) => string): string {
  const isTag = ctx.tags.some((t) => t.name === ctx.ref);
  const known = isTag || ctx.branches.some((b) => b.name === ctx.ref);
  const item = (r: RefInfo) => {
    const current = r.name === ctx.ref;
    return `<a class="dd-item${current ? ' current' : ''}" href="${esc(urlForRef(r.name))}">${
      current ? icon('check', 'dd-check') : '<span class="dd-check"></span>'
    }<span class="dd-label">${esc(r.name)}</span></a>`;
  };
  const group = (label: string, refs: RefInfo[]) =>
    refs.length === 0
      ? ''
      : `<div class="dd-group"><div class="dd-section">${label}</div>${refs.map(item).join('')}</div>`;
  // A ref that is neither branch nor tag is a raw commit the reader navigated
  // to; name it on the button so the picker never lies about where they are.
  const glyph = known ? (isTag ? 'tag' : 'git-branch') : 'git-commit';
  const shown = known ? ctx.ref : ctx.ref.slice(0, 7);
  return `<details class="dropdown ref-picker">
<summary class="btn" title="Switch branches or tags">${icon(glyph)}<b class="dd-current">${esc(
    shown
  )}</b>${icon('chevron-down', 'caret')}</summary>
<div class="dropdown-menu">
  <input class="dd-filter" type="text" placeholder="Find a branch or tag" oninput="filterMenu(this)" aria-label="Filter branches and tags">
  <div class="dd-scroll">${group('Branches', ctx.branches)}${group('Tags', ctx.tags)}</div>
</div>
</details>`;
}

/** The green Code button, with the clone URL behind it. */
function cloneMenu(ctx: RepoCtx): string {
  return `<details class="dropdown clone-menu">
<summary class="btn btn-primary">${icon('code')}<span>Code</span>${icon('chevron-down', 'caret')}</summary>
<div class="dropdown-menu dd-right">
  <div class="dd-section">Clone with HTTP</div>
  <div class="cmd-row"><input readonly value="${esc(ctx.cloneUrl)}" onclick="this.select()">${copyButton()}</div>
  <p class="muted small">Anyone can clone. Pushing asks for a username and a token.</p>
</div>
</details>`;
}

export function repoHeader(
  ctx: RepoCtx,
  active: 'code' | 'commits' | 'actions' | 'branches' | 'tags' | 'settings'
): string {
  const base = repoUrl(ctx);
  const tab = (id: string, label: string, href: string, glyph: IconName, count?: number) =>
    `<a class="tab${active === id ? ' active' : ''}" href="${href}">${icon(glyph)}<span>${label}</span>${
      count !== undefined ? `<span class="counter">${count}</span>` : ''
    }</a>`;
  return `<div class="repo-title">${REPO_ICON}<a href="/${encodeURIComponent(ctx.collection)}">${esc(
    ctx.collection
  )}</a> <span class="muted">/</span> <a href="${base}"><b>${esc(ctx.repo)}</b></a></div>
<nav class="tabs">
${tab('code', 'Code', base, 'code')}
${tab('commits', 'Commits', `${base}/commits/${encPath(ctx.ref)}`, 'history')}
${ctx.hasCi || active === 'actions' ? tab('actions', 'Actions', `${base}/actions`, 'play') : ''}
${tab('branches', 'Branches', `${base}/branches`, 'git-branch', ctx.branches.length)}
${tab('tags', 'Tags', `${base}/tags`, 'tag', ctx.tags.length)}
${ctx.hasSite ? tab('site', 'Site', `${base}/site/`, 'globe') : ''}
${ctx.canPush || ctx.canAdmin ? tab('settings', 'Settings', `${base}/settings`, 'gear') : ''}
</nav>`;
}

function breadcrumb(ctx: RepoCtx, path: string): string {
  const base = repoUrl(ctx);
  const parts = path === '' ? [] : path.split('/');
  const pieces: string[] = [`<a href="${base}/tree/${encPath(ctx.ref)}">${esc(ctx.repo)}</a>`];
  let acc = '';
  parts.forEach((part, i) => {
    acc = acc === '' ? part : `${acc}/${part}`;
    const last = i === parts.length - 1;
    if (last) {
      pieces.push(`<b>${esc(part)}</b>`);
    } else {
      pieces.push(`<a href="${base}/tree/${encPath(ctx.ref)}/${encPath(acc)}">${esc(part)}</a>`);
    }
  });
  return `<span class="crumb">${pieces.join(' / ')}</span>`;
}

export function homePage(
  rootLabel: string,
  collections: { name: string; repoCount: number }[],
  viewer: Viewer | null
): string {
  const rows = collections
    .map(
      (o) =>
        `<tr><td>${FOLDER_ICON}<a href="/${encodeURIComponent(o.name)}">${esc(o.name)}</a></td><td class="right muted">${
          o.repoCount
        } ${o.repoCount === 1 ? 'repository' : 'repositories'}</td></tr>`
    )
    .join('');
  const body =
    collections.length === 0
      ? `<div class="empty-state">No repositories yet.${
          viewer ? ' Create one with the button above, or push to a new path.' : ''
        }</div>`
      : `<table class="listing"><tbody>${rows}</tbody></table>`;
  const newBtn = viewer ? `<a class="btn btn-primary" href="/new">New repository</a>` : '';
  const content = `<div class="page-head"><h1>Collections</h1>${newBtn}</div>${body}<p class="muted small" style="margin-top:16px">Serving ${esc(
    rootLabel
  )}</p>`;
  return layout('hubbit', content, { viewer, path: '/' });
}

export function collectionPage(
  collection: string,
  repoList: { name: string; description: string | null; updated: string | null }[],
  viewer: Viewer | null
): string {
  const rows = repoList
    .map(
      (r) =>
        `<tr><td>${REPO_ICON}<a href="/${encodeURIComponent(collection)}/${encodeURIComponent(r.name)}"><b>${esc(
          r.name
        )}</b></a>${r.description ? `<div class="muted small">${esc(r.description)}</div>` : ''}</td><td class="right small">${
          r.updated ? `Updated ${timeTag(r.updated)}` : ''
        }</td></tr>`
    )
    .join('');
  const body =
    repoList.length === 0
      ? `<div class="empty-state">No repositories in this collection yet.</div>`
      : `<table class="listing"><tbody>${rows}</tbody></table>`;
  const newBtn = viewer
    ? `<a class="btn" href="/import?collection=${encodeURIComponent(collection)}">Import</a><a class="btn btn-primary" href="/new?collection=${encodeURIComponent(
        collection
      )}">New repository</a>`
    : '';
  const content = `<div class="page-head"><h1>${esc(collection)}</h1><span class="right-group">${newBtn}</span></div>${body}`;
  return layout(collection, content, {
    crumbs: ` / <a href="/${encodeURIComponent(collection)}">${esc(collection)}</a>`,
    viewer,
    path: `/${encodeURIComponent(collection)}`,
  });
}

export interface TreeView {
  path: string;
  entries: TreeEntry[];
  /** The newest commit touching each entry, keyed by its path from the root. */
  entryCommits: Map<string, CommitSummary>;
  /** The newest commit at this path, for the bar above the listing. */
  latest: CommitSummary | null;
  commitCount: number;
  description: string | null;
  readmeHtml: string | null;
  readmeName: string | null;
}

/** "1,284" - counts in the interface are grouped, as they are on GitHub. */
function count(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * The About panel beside the repository root: what the repository says it is,
 * and the way in to the documents a reader looks for first.
 */
function aboutPanel(ctx: RepoCtx, view: TreeView): string {
  const base = repoUrl(ctx);
  const blob = (name: string) => `${base}/blob/${encPath(ctx.ref)}/${encPath(name)}`;
  const license = view.entries.find(
    (e) => e.type === 'blob' && /^(licen[cs]e|copying)(\.[a-z]+)?$/i.test(e.name)
  );
  const links: string[] = [];
  if (view.readmeName) links.push(`<a href="#readme">${icon('book')}<span>Readme</span></a>`);
  if (license) links.push(`<a href="${blob(license.name)}">${icon('law')}<span>${esc(license.name)}</span></a>`);
  if (ctx.hasSite) links.push(`<a href="${base}/site/">${icon('globe')}<span>Site</span></a>`);
  const settings =
    ctx.canPush || ctx.canAdmin
      ? `<a class="side-edit" href="${base}/settings" title="Edit repository details" aria-label="Edit repository details">${icon(
          'gear'
        )}</a>`
      : '';
  const description = view.description
    ? `<p class="side-desc">${esc(view.description)}</p>`
    : `<p class="side-desc muted">No description provided.</p>`;
  const facts = [
    `<a href="${base}/commits/${encPath(ctx.ref)}">${icon('history')}<span>${count(view.commitCount)} commit${
      view.commitCount === 1 ? '' : 's'
    }</span></a>`,
    `<a href="${base}/branches">${icon('git-branch')}<span>${count(ctx.branches.length)} branch${
      ctx.branches.length === 1 ? '' : 'es'
    }</span></a>`,
    `<a href="${base}/tags">${icon('tag')}<span>${count(ctx.tags.length)} tag${ctx.tags.length === 1 ? '' : 's'}</span></a>`,
  ];
  return `<aside class="repo-side">
<div class="side-block">
  <h3>About${settings}</h3>
  ${description}
  ${links.length ? `<div class="side-links">${links.join('')}</div>` : ''}
</div>
<div class="side-block"><div class="side-links">${facts.join('')}</div></div>
</aside>`;
}

export function treePage(ctx: RepoCtx, view: TreeView): string {
  const base = repoUrl(ctx);
  const { path, entries } = view;
  const refBase = `${base}/tree/${encPath(ctx.ref)}`;
  const atRoot = path === '';
  const rows: string[] = [];
  if (!atRoot) {
    const parent = path.split('/').slice(0, -1).join('/');
    const up = parent === '' ? refBase : `${refBase}/${encPath(parent)}`;
    rows.push(`<tr><td class="tree-name"><a href="${up}" aria-label="Parent directory">..</a></td><td></td><td></td></tr>`);
  }
  for (const e of entries) {
    const childPath = atRoot ? e.name : `${path}/${e.name}`;
    let name: string;
    if (e.type === 'tree') {
      name = `${FOLDER_ICON}<a href="${refBase}/${encPath(childPath)}">${esc(e.name)}</a>`;
    } else if (e.type === 'blob') {
      name = `${FILE_ICON}<a href="${base}/blob/${encPath(ctx.ref)}/${encPath(childPath)}">${esc(e.name)}</a>`;
    } else {
      name = `${FOLDER_ICON}<span>${esc(e.name)}</span> <span class="muted small mono">@ ${e.sha.slice(
        0,
        7
      )}</span>`;
    }
    // The message and age columns are what a directory listing on GitHub
    // shows, and they answer the question a listing is usually asked: what
    // changed here lately.
    const commit = view.entryCommits.get(childPath);
    const message = commit
      ? `<a href="${base}/commit/${commit.sha}" title="${esc(commit.subject)}">${esc(commit.subject)}</a>`
      : '';
    rows.push(
      `<tr><td class="tree-name">${name}</td><td class="tree-message muted small">${message}</td><td class="tree-age right small">${
        commit ? timeTag(commit.date) : ''
      }</td></tr>`
    );
  }
  const latest = view.latest;
  const latestBar = latest
    ? `<div class="latest-commit">
  <span class="lc-main"><b>${esc(latest.author)}</b> <a href="${base}/commit/${latest.sha}">${esc(latest.subject)}</a></span>
  <span class="lc-meta"><a class="sha" href="${base}/commit/${latest.sha}">${latest.sha.slice(
        0,
        7
      )}</a> ${timeTag(latest.date)} <a class="lc-history" href="${base}/commits/${encPath(ctx.ref)}">${icon(
        'history'
      )}<b>${count(view.commitCount)}</b> <span>Commits</span></a></span>
</div>`
    : '';
  const addFileUrl = `${base}/new/${encPath(ctx.ref)}${atRoot ? '' : `/${encPath(path)}`}`;
  const addFileBtn =
    ctx.canPush && ctx.refIsBranch ? `<a class="btn" href="${addFileUrl}">${icon('plus')}<span>Add file</span></a>` : '';
  const readmePath = atRoot ? view.readmeName : `${path}/${view.readmeName}`;
  const readme = view.readmeHtml
    ? `<div class="box" id="readme"><div class="box-header">${icon('book')}<a href="${base}/blob/${encPath(
        ctx.ref
      )}/${encPath(readmePath ?? 'README')}">${esc(view.readmeName ?? 'README')}</a></div><div class="box-body markdown-body">${
        view.readmeHtml
      }</div></div>`
    : '';
  const content = `${repoHeader(ctx, 'code')}
<div class="toolbar">
  <div class="left">${refPicker(ctx, (ref) => `${base}/tree/${encPath(ref)}`)}${breadcrumb(ctx, path)}</div>
  <div class="right-group">${addFileBtn}${cloneMenu(ctx)}</div>
</div>
<div class="repo-layout">
<div class="repo-main">
${latestBar}
<table class="listing tree"><tbody>${rows.join('')}</tbody></table>
${readme}
</div>
${atRoot ? aboutPanel(ctx, view) : ''}
</div>`;
  return layout(
    `${ctx.collection}/${ctx.repo}${path ? ` at ${path}` : ''}`,
    content,
    repoOpts(ctx, atRoot ? repoUrl(ctx) : `${refBase}/${encPath(path)}`)
  );
}

export function blobPage(
  ctx: RepoCtx,
  path: string,
  view:
    | { kind: 'code'; html: string; lineCount: number; size: number; editable: boolean }
    | { kind: 'markdown'; html: string; size: number; editable: boolean }
    | { kind: 'image'; rawUrl: string; size: number }
    | { kind: 'binary'; rawUrl: string; size: number }
    | { kind: 'too-large'; rawUrl: string; size: number }
    | { kind: 'lfs'; rawUrl: string; size: number; oid: string },
  isMarkdown = false
): string {
  const base = repoUrl(ctx);
  const blobUrl = `${base}/blob/${encPath(ctx.ref)}/${encPath(path)}`;
  const rawUrl = `${base}/raw/${encPath(ctx.ref)}/${encPath(path)}`;
  const editable = (view.kind === 'code' || view.kind === 'markdown') && view.editable;
  const editBtns = editable
    ? `<a class="btn" href="${base}/edit/${encPath(ctx.ref)}/${encPath(path)}">Edit</a><a class="btn btn-danger-outline" href="${base}/delete/${encPath(
        ctx.ref
      )}/${encPath(path)}">Delete</a>`
    : '';
  // GitHub spells the source view of a rendered file ?plain=1; we follow that.
  const seg = (label: string, href: string, current: boolean) =>
    `<a${current ? ' class="current"' : ''} href="${href}">${label}</a>`;
  const toggle = isMarkdown
    ? `<span class="seg">${seg('Preview', blobUrl, view.kind === 'markdown')}${seg(
        'Code',
        `${blobUrl}?plain=1`,
        view.kind !== 'markdown'
      )}</span>`
    : '';
  let body = '';
  const meta = (left: string) =>
    `<div class="code-meta"><span class="muted small">${left}</span><span class="right-group">${toggle}<a class="btn" href="${rawUrl}">Raw</a>${editBtns}</span></div>`;
  if (view.kind === 'code') {
    const gutter = Array.from({ length: view.lineCount }, (_, i) => i + 1).join('\n');
    body = `${meta(`${view.lineCount} lines &middot; ${esc(formatSize(view.size))}`)}
<div class="code-wrap"><pre class="gutter">${gutter}</pre><pre class="codeview"><code>${view.html}</code></pre></div>`;
  } else if (view.kind === 'markdown') {
    body = `${meta(esc(formatSize(view.size)))}
<div class="rendered markdown-body">${view.html}</div>`;
  } else if (view.kind === 'image') {
    body = `${meta(esc(formatSize(view.size)))}<div class="blob-image"><img src="${rawUrl}" alt="${esc(path)}"></div>`;
  } else if (view.kind === 'too-large') {
    body = `${meta(esc(formatSize(view.size)))}<div class="blob-binary">File is too large to display. <a href="${rawUrl}">View raw</a></div>`;
  } else if (view.kind === 'lfs') {
    // The size comes from the pointer, so no storage request is needed to
    // render this card.
    body = `${meta(esc(formatSize(view.size)))}<div class="blob-binary">
<p><b>Stored with Git LFS</b></p>
<p>This file is ${esc(formatSize(view.size))}; the repository holds a pointer to it.</p>
<p class="muted small mono">sha256:${esc(view.oid)}</p>
<p><a class="btn btn-primary" href="${rawUrl}">Download</a></p>
</div>`;
  } else {
    body = `${meta(esc(formatSize(view.size)))}<div class="blob-binary">Binary file. <a href="${rawUrl}">View raw</a></div>`;
  }
  const content = `${repoHeader(ctx, 'code')}
<div class="toolbar">
  <div class="left">${refPicker(ctx, (ref) => `${base}/blob/${encPath(ref)}/${encPath(path)}`)}${breadcrumb(ctx, path)}</div>
</div>
${body}`;
  return layout(`${path} at ${ctx.ref} - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, blobUrl));
}

export function commitsPage(
  ctx: RepoCtx,
  commits: CommitSummary[],
  page: number,
  totalPages: number,
  totalCount: number
): string {
  const base = repoUrl(ctx);
  const rows = commits
    .map(
      (c) =>
        `<div class="commit-row"><span><a class="title" href="${base}/commit/${c.sha}">${esc(
          c.subject
        )}</a><div class="muted small">${esc(c.author)} committed ${timeTag(c.date)}</div></span><a class="sha" href="${base}/commit/${
          c.sha
        }">${c.sha.slice(0, 7)}</a></div>`
    )
    .join('');
  const pager: string[] = [];
  const pageUrl = (p: number) => `${base}/commits/${encPath(ctx.ref)}?page=${p}`;
  if (page > 1) pager.push(`<a class="btn" href="${pageUrl(page - 1)}">&larr; Newer</a>`);
  if (page < totalPages) pager.push(`<a class="btn" href="${pageUrl(page + 1)}">Older &rarr;</a>`);
  const content = `${repoHeader(ctx, 'commits')}
<div class="toolbar"><div class="left">${refPicker(ctx, (ref) => `${base}/commits/${encPath(ref)}`)}<span class="muted small">${count(
    totalCount
  )} commit${totalCount === 1 ? '' : 's'}</span></div></div>
${rows || '<div class="empty-state">No commits on this ref.</div>'}
${pager.length ? `<div class="pagination">${pager.join('')}</div>` : ''}`;
  return layout(`Commits at ${ctx.ref} - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, `${base}/commits/${encPath(ctx.ref)}`));
}

export function commitPage(ctx: RepoCtx, detail: CommitDetail, diffHtml: string): string {
  const base = repoUrl(ctx);
  const lines = detail.message.split('\n');
  const subject = lines[0] ?? '';
  const body = lines.slice(1).join('\n').trim();
  const parents = detail.parents
    .map((p) => `<a class="sha" href="${base}/commit/${p}">${p.slice(0, 7)}</a>`)
    .join(' ');
  const content = `${repoHeader(ctx, 'commits')}
<div class="commit-head">
  <div class="subject">${esc(subject)}</div>
  ${body ? `<div class="body">${esc(body)}</div>` : ''}
  <div class="meta">
    <span><b>${esc(detail.author)}</b> &lt;${esc(detail.email)}&gt;</span>
    <span>committed ${timeTag(detail.date, '')}</span>
    <span>commit <span class="sha">${detail.sha.slice(0, 12)}</span></span>
    ${parents ? `<span>parent${detail.parents.length > 1 ? 's' : ''} ${parents}</span>` : ''}
    <span><a href="${base}/tree/${detail.sha}">Browse files</a></span>
  </div>
</div>
${diffHtml}`;
  return layout(`${subject} - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, `${base}/commit/${detail.sha}`));
}

export function refListPage(ctx: RepoCtx, kind: 'branches' | 'tags'): string {
  const base = repoUrl(ctx);
  const refs = kind === 'branches' ? ctx.branches : ctx.tags;
  const viewer = ctx.viewer;
  const rows = refs
    .map((r) => {
      let action = '';
      if (ctx.canPush && viewer && (kind === 'tags' || r.name !== ctx.defaultBranch)) {
        const noun = kind === 'branches' ? 'branch' : 'tag';
        action = `<form method="post" action="${base}/${kind}/delete" onsubmit="return confirm('Delete ${noun} ${esc(
          r.name
        )}?')">${csrfField(viewer)}<input type="hidden" name="name" value="${esc(
          r.name
        )}"><button type="submit" class="btn btn-danger-outline">Delete</button></form>`;
      }
      return `<tr><td><a href="${base}/tree/${encPath(r.name)}"><b>${esc(r.name)}</b></a>${
        kind === 'branches' && r.name === ctx.defaultBranch ? ' <span class="counter">default</span>' : ''
      }<div class="muted small">${esc(r.subject)}</div></td><td class="right small">${timeTag(r.date)}</td><td class="right"><a class="sha" href="${base}/commit/${r.sha}">${r.sha.slice(0, 7)}</a></td><td class="right">${action}</td></tr>`;
    })
    .join('');
  const body = rows
    ? `<table class="listing"><tbody>${rows}</tbody></table>`
    : `<div class="empty-state">No ${kind} yet.</div>`;
  let createForm = '';
  if (ctx.canPush && viewer && ctx.branches.length > 0) {
    const fromOptions = ctx.branches
      .map(
        (b) =>
          `<option value="${esc(b.name)}"${b.name === ctx.defaultBranch ? ' selected' : ''}>${esc(b.name)}</option>`
      )
      .join('');
    createForm =
      kind === 'branches'
        ? `<form method="post" action="${base}/branches/create" class="inline-form">${csrfField(
            viewer
          )}<input type="text" name="name" placeholder="new-branch-name" required> <label>from <select name="from">${fromOptions}</select></label> <button type="submit" class="btn btn-primary">Create branch</button></form>`
        : `<form method="post" action="${base}/tags/create" class="inline-form">${csrfField(
            viewer
          )}<input type="text" name="name" placeholder="v1.0.0" required> <label>at <select name="at">${fromOptions}</select></label> <button type="submit" class="btn btn-primary">Create tag</button></form>`;
  }
  const content = `${repoHeader(ctx, kind)}<div class="page-head"><h2>${
    kind === 'branches' ? 'Branches' : 'Tags'
  }</h2>${createForm}</div>${body}`;
  return layout(`${kind} - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, `${base}/${kind}`));
}

export function emptyRepoPage(ctx: RepoCtx): string {
  const base = repoUrl(ctx);
  const readmeBtn = ctx.canPush
    ? `<p><a class="btn btn-primary" href="${base}/new/main">Create a README</a></p>`
    : '';
  const content = `${repoHeader(ctx, 'code')}
<div class="empty-state">
  <p><b>This repository is empty.</b></p>
  ${readmeBtn}
  <div class="empty-cmds">
${copyRow(`git clone ${ctx.cloneUrl}`)}
${copyRow(`git push ${ctx.cloneUrl} main`)}
  </div>
  <p class="small">Pushing requires a username and token.</p>
</div>`;
  return layout(`${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, base));
}

export function errorPage(status: number, message: string, opts: PageOpts & { backUrl?: string } = {}): string {
  const back = opts.backUrl
    ? `<p><a href="${esc(opts.backUrl)}">Go back</a></p>`
    : `<p><a href="/">Back to home</a></p>`;
  return layout(
    `${status}`,
    `<div class="error-page"><div class="code">${status}</div><p>${esc(message)}</p>${back}</div>`,
    opts
  );
}
