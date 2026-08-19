import { BlameLine, CommitDetail, CommitSummary, RefInfo, TreeEntry } from './git';
import { LanguageStat } from './languages';
import { esc, formatDay, formatSize, highlightedLines, timeTag } from './render';
import { Viewer, viewerIsAdmin } from './session';
import { activeTheme } from './themes';
import { WORDMARK } from './logo';
import { IconName, icon } from './icons';
import { avatar } from './avatar';

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
  /** Where the Site tab points: the site's own origin when it has one. */
  siteUrl: string;
  hasCi: boolean;
  /** Tags that have release notes in the vault. */
  releases: string[];
  /** Open issues, for the Issues tab's count. */
  openIssues: number;
  /** Open pull requests, for the tab's counter. */
  openPulls: number;
  /** The repository this one was forked from, if it was. */
  forkedFrom: { collection: string; repo: string } | null;
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

const FOLDER_ICON = icon('folder', 'icon');
const FILE_ICON = icon('file', 'icon file');
const REPO_ICON = icon('repo', 'icon');

function userBox(opts: PageOpts): string {
  const viewer = opts.viewer ?? null;
  if (!viewer) {
    const next = opts.path && opts.path.startsWith('/') ? opts.path : '/';
    return `<a class="btn" href="/login?next=${encodeURIComponent(next)}">Sign in</a>`;
  }
  // The signed-in header is an avatar that opens a menu, as GitHub's is: the
  // name and what you can do with the account are one click away rather than
  // spread across the bar.
  const name = viewer.auth.username;
  const admin = viewerIsAdmin(viewer)
    ? `<a class="dd-item" href="/admin">${icon('sliders')}<span>Admin</span></a>`
    : '';
  return `<details class="dropdown user-menu">
<summary aria-label="Account menu">${avatar(name, 24)}${icon('chevron-down', 'caret')}</summary>
<div class="dropdown-menu dd-right">
  <div class="dd-section">Signed in as <b>${esc(name)}</b></div>
  ${admin}
  <form method="post" action="/logout">${csrfField(viewer)}<button type="submit" class="dd-item">${icon(
    'sign-out'
  )}<span>Sign out</span></button></form>
</div>
</details>`;
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
function copyText(btn, text) {
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
// The text to copy is the button's own data-copy when it carries one, and
// otherwise whatever sits just before it: a <code>, or an <input> holding a URL.
function copyCmd(btn) {
  var el = btn.previousElementSibling;
  var own = btn.getAttribute('data-copy');
  copyText(btn, own !== null ? own : (el && el.tagName === 'INPUT' ? el.value : el.textContent));
}
// A file view is one element per line, so its text is gathered rather than
// read off one node; the line numbers are separate elements and stay out.
function copyLines(btn) {
  var lines = document.querySelectorAll('.code-lines .ltext');
  var out = [];
  for (var i = 0; i < lines.length; i++) out.push(lines[i].textContent);
  copyText(btn, out.join('\\n'));
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
// The file finder's matching: every character of the query in order, though
// not necessarily together, so "srcmn" finds src/compute/mean.py. Matching is
// done here rather than on the server because the whole list is already in
// the page.
function findMatch(hay, needle) {
  var i = 0;
  for (var j = 0; j < hay.length && i < needle.length; j++) {
    if (hay.charCodeAt(j) === needle.charCodeAt(i)) i++;
  }
  return i === needle.length;
}
function filterFiles(input) {
  var items = document.getElementById('find-list').children;
  var q = input.value.trim().toLowerCase();
  var shown = 0;
  for (var i = 0; i < items.length; i++) {
    var hit = q === '' || findMatch(items[i].textContent.toLowerCase(), q);
    items[i].hidden = !hit;
    if (hit) shown++;
  }
  document.getElementById('find-empty').hidden = shown !== 0;
}
// Enter opens the first match, Escape clears the box.
function findKey(e, input) {
  if (e.key === 'Escape') { input.value = ''; filterFiles(input); return; }
  if (e.key !== 'Enter') return;
  var items = document.getElementById('find-list').children;
  for (var i = 0; i < items.length; i++) {
    if (!items[i].hidden) { e.preventDefault(); location.href = items[i].href; return; }
  }
}
// t goes to the file finder, as on GitHub, from any page offering it. A key
// pressed while typing into something is a keystroke, not a shortcut.
document.addEventListener('keydown', function (e) {
  if (e.key !== 't' || e.metaKey || e.ctrlKey || e.altKey) return;
  var el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  var btn = document.querySelector('[data-find-url]');
  if (!btn) return;
  e.preventDefault();
  location.href = btn.getAttribute('data-find-url');
});
// The filter box above a listing: hide the rows that do not match, and say so
// when none do.
function filterRows(input) {
  var id = input.getAttribute('data-target');
  var table = document.getElementById(id);
  var empty = document.getElementById(id + '-empty');
  var q = input.value.trim().toLowerCase();
  var rows = table.tBodies[0].rows;
  var shown = 0;
  for (var i = 0; i < rows.length; i++) {
    var hit = q === '' || rows[i].textContent.toLowerCase().indexOf(q) !== -1;
    rows[i].hidden = !hit;
    if (hit) shown++;
  }
  if (empty) empty.hidden = shown !== 0;
}
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
  // Every repository page puts its address in the top bar as well as at the
  // head of the page. The bar is what stays in view once the reader has
  // scrolled into a long file or a long thread, so it is the one place that
  // can always answer "where am I, and how do I get back up from here".
  const crumbs = ` / <a href="/${encodeURIComponent(ctx.collection)}">${esc(
    ctx.collection
  )}</a> / <a href="${repoUrl(ctx)}">${esc(ctx.repo)}</a>`;
  return { viewer: ctx.viewer, path, crumbs };
}

/**
 * The copy button that sits after a <code> or <input> holding the text.
 * Confirmation is a class the script toggles rather than replaced markup, so
 * the idle and copied faces are both in the page and neither needs escaping
 * at click time.
 */
export function copyButton(label = '', text?: string, title = ''): string {
  const face = (glyph: IconName, caption: string, cls: string) =>
    `<span class="${cls}">${icon(glyph)}${label ? `<span>${esc(caption)}</span>` : ''}</span>`;
  // With no text of its own the button copies the element before it, which is
  // how the command rows and the clone box use it.
  const payload = text === undefined ? '' : ` data-copy="${esc(text)}"`;
  return `<button class="copy-btn" type="button" onclick="copyCmd(this)"${payload}${
    title ? ` title="${esc(title)}"` : ''
  } aria-label="Copy${label ? ` ${esc(label.toLowerCase())}` : ''}">${face('copy', label, 'copy-idle')}${face(
    'check',
    'Copied',
    'copy-done'
  )}</button>`;
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

/**
 * The way in to the file finder. The data attribute is what the page script
 * watches for, so that t reaches the finder from any page that offers it, as
 * on GitHub.
 */
function findButton(ctx: RepoCtx): string {
  const href = `${repoUrl(ctx)}/find/${encPath(ctx.ref)}`;
  return `<a class="btn" href="${href}" data-find-url="${href}" title="Go to file (t)">${icon(
    'search'
  )}<span>Go to file</span></a>`;
}

/** The green Code button: the clone URL, and the source as an archive. */
function cloneMenu(ctx: RepoCtx): string {
  const archive = (ext: string, label: string) =>
    `<a class="dd-item" href="${repoUrl(ctx)}/archive/${encPath(ctx.ref)}.${ext}">${icon(
      'file-zip'
    )}<span class="dd-label">${label}</span></a>`;
  return `<details class="dropdown clone-menu">
<summary class="btn btn-primary">${icon('code')}<span>Code</span>${icon('chevron-down', 'caret')}</summary>
<div class="dropdown-menu dd-right">
  <div class="dd-section">Clone with HTTP</div>
  <div class="cmd-row"><input readonly value="${esc(ctx.cloneUrl)}" onclick="this.select()">${copyButton()}</div>
  <p class="muted small">Anyone can clone. Pushing asks for a username and a token.</p>
  <div class="dd-group"><div class="dd-section">Download ${esc(ctx.ref)}</div>
${archive('zip', 'Source as zip')}${archive('tar.gz', 'Source as tar.gz')}</div>
</div>
</details>`;
}

export function repoHeader(
  ctx: RepoCtx,
  active: 'code' | 'commits' | 'issues' | 'pulls' | 'actions' | 'branches' | 'tags' | 'settings'
): string {
  const base = repoUrl(ctx);
  const tab = (id: string, label: string, href: string, glyph: IconName, count?: number) =>
    `<a class="tab${active === id ? ' active' : ''}" href="${href}">${icon(glyph)}<span>${label}</span>${
      count !== undefined ? `<span class="counter">${count}</span>` : ''
    }</a>`;
  // The search box rides in the title row, so searching this repository is a
  // keystroke away from every one of its pages.
  const search = `<form class="repo-search" method="get" action="${base}/search" role="search"><input type="hidden" name="ref" value="${esc(
    ctx.ref
  )}"><input class="search-input" type="search" name="q" placeholder="Search this repository" aria-label="Search this repository">${icon(
    'search',
    'search-glyph'
  )}</form>`;
  const parent = ctx.forkedFrom
    ? `<div class="fork-note muted small">${icon('repo-forked')}<span>forked from <a href="/${encodeURIComponent(
        ctx.forkedFrom.collection
      )}/${encodeURIComponent(ctx.forkedFrom.repo)}">${esc(ctx.forkedFrom.collection)}/${esc(
        ctx.forkedFrom.repo
      )}</a></span></div>`
    : '';
  return `<div class="repo-title">${REPO_ICON}<a href="/${encodeURIComponent(ctx.collection)}">${esc(
    ctx.collection
  )}</a> <span class="muted">/</span> <a href="${base}"><b>${esc(ctx.repo)}</b></a>${search}</div>
${parent}
<nav class="tabs">
${tab('code', 'Code', base, 'code')}
${tab('commits', 'Commits', `${base}/commits/${encPath(ctx.ref)}`, 'history')}
${tab('issues', 'Issues', `${base}/issues`, 'issue-opened', ctx.openIssues)}
${tab('pulls', 'Pull requests', `${base}/pulls`, 'git-pull-request', ctx.openPulls)}
${ctx.hasCi || active === 'actions' ? tab('actions', 'Actions', `${base}/actions`, 'play') : ''}
${tab('branches', 'Branches', `${base}/branches`, 'git-branch', ctx.branches.length)}
${tab('tags', 'Tags', `${base}/tags`, 'tag', ctx.tags.length)}
${ctx.hasSite ? tab('site', 'Site', ctx.siteUrl, 'globe') : ''}
${ctx.canPush || ctx.canAdmin ? tab('settings', 'Settings', `${base}/settings`, 'sliders') : ''}
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

/**
 * The "find a repository" box GitHub puts above a long listing. It filters
 * rows in the page rather than asking the server, which is honest about what
 * it is: a way to find a name you already know in a list you can already see.
 * Short lists do not get one, since scanning five names is faster than typing.
 */
function listFilter(target: string, placeholder: string, rowCount: number): string {
  if (rowCount <= 5) return '';
  return `<div class="toolbar"><div class="left"><input class="list-filter" type="text" placeholder="${esc(
    placeholder
  )}" data-target="${esc(target)}" oninput="filterRows(this)" aria-label="${esc(placeholder)}"></div></div>`;
}

function noMatches(target: string): string {
  return `<div class="empty-state" id="${esc(target)}-empty" hidden>No match.</div>`;
}

export function homePage(
  rootLabel: string,
  collections: { name: string; repoCount: number }[],
  viewer: Viewer | null
): string {
  const rows = collections
    .map(
      (o) =>
        `<tr><td class="with-avatar">${avatar(o.name, 24, 'square')}<a href="/${encodeURIComponent(o.name)}">${esc(
          o.name
        )}</a></td><td class="right muted">${o.repoCount} ${
          o.repoCount === 1 ? 'repository' : 'repositories'
        }</td></tr>`
    )
    .join('');
  const body =
    collections.length === 0
      ? `<div class="empty-state">No repositories yet.${
          viewer ? ' Create one with the buttons above, or push to a new path.' : ''
        }</div>`
      : `${listFilter('collection-list', 'Find a collection', collections.length)}<table class="listing roster" id="collection-list"><tbody>${rows}</tbody></table>${noMatches(
          'collection-list'
        )}`;
  const newBtn = viewer
    ? `<a class="btn" href="/new/collection">${icon('plus')}<span>New collection</span></a><a class="btn btn-primary" href="/new">${icon(
        'plus'
      )}<span>New repository</span></a>`
    : '';
  const content = `<div class="page-head"><h1>Collections</h1><span class="right-group">${newBtn}</span></div>${body}<p class="muted small" style="margin-top:16px">Serving ${esc(
    rootLabel
  )}</p>`;
  return layout('cofferdam', content, { viewer, path: '/' });
}

export function collectionPage(
  collection: string,
  repoList: {
    name: string;
    description: string | null;
    updated: string | null;
    /** Where this repository's published site is, or null if it has none. */
    siteUrl?: string | null;
  }[],
  viewer: Viewer | null
): string {
  const rows = repoList
    .map(
      (r) =>
        `<tr><td>${REPO_ICON}<a href="/${encodeURIComponent(collection)}/${encodeURIComponent(r.name)}"><b>${esc(
          r.name
        )}</b></a>${
          r.siteUrl
            ? `<a class="site-link" href="${esc(r.siteUrl)}" title="Site" aria-label="Site for ${esc(
                r.name
              )}">${icon('globe')}</a>`
            : ''
        }${r.description ? `<div class="muted small">${esc(r.description)}</div>` : ''}</td><td class="right small">${
          r.updated ? `Updated ${timeTag(r.updated)}` : ''
        }</td></tr>`
    )
    .join('');
  const body =
    repoList.length === 0
      ? `<div class="empty-state">No repositories in this collection yet.${
          viewer ? ' Create one with the buttons above, or push to a new path.' : ''
        }</div>`
      : `${listFilter('repo-list', 'Find a repository', repoList.length)}<table class="listing roster" id="repo-list"><tbody>${rows}</tbody></table>${noMatches(
          'repo-list'
        )}`;
  const newBtn = viewer
    ? `<a class="btn" href="/import?collection=${encodeURIComponent(collection)}">${icon(
        'download'
      )}<span>Import</span></a><a class="btn btn-primary" href="/new?collection=${encodeURIComponent(
        collection
      )}">${icon('plus')}<span>New repository</span></a>`
    : '';
  const content = `<div class="page-head"><h1 class="with-avatar">${avatar(collection, 28, 'square')}${esc(
    collection
  )}</h1><span class="right-group">${newBtn}</span></div>${body}`;
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
  /** The language breakdown, measured at the root only and empty elsewhere. */
  languages: LanguageStat[];
  /** Who has committed on this ref, most commits first; the root only. */
  contributors: { name: string; email: string; commits: number }[];
}

/** "1,284" - counts in the interface are grouped, as they are on GitHub. */
function count(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * What the repository is written in: one bar in the languages' own colours and
 * the list that names them. The bar is the same information as the list and no
 * more, so it is hidden from a screen reader rather than repeated to one.
 *
 * The colours are inline because they belong to the languages rather than to
 * the theme (the rule that structural CSS names no colour holds for the rest
 * of style.ts); they come from the table in languages.ts and never from
 * anything a repository contains.
 */
function languagesBlock(languages: LanguageStat[]): string {
  if (languages.length === 0) return '';
  const pct = (share: number) => `${share.toFixed(1)}%`;
  const segments = languages
    .map((l) => `<span class="lang-seg" style="width:${l.share.toFixed(2)}%;background:${l.color}"></span>`)
    .join('');
  const items = languages
    .map(
      (l) =>
        `<li><span class="lang-dot" style="background:${l.color}"></span><span class="lang-name">${esc(
          l.name
        )}</span> <span class="lang-pct muted">${pct(l.share)}</span></li>`
    )
    .join('');
  return `<div class="side-block">
  <h3>Languages</h3>
  <div class="lang-bar" aria-hidden="true">${segments}</div>
  <ul class="lang-list">${items}</ul>
</div>`;
}

/**
 * The About panel beside the repository root: what the repository says it is,
 * and the way in to the documents a reader looks for first.
 */
/** The most faces the panel shows before it counts the rest as a number. */
const SHOWN_CONTRIBUTORS = 12;

/**
 * Who wrote this repository, by commit count, as GitHub lists in its About
 * panel. Each face leads to that person's commits rather than to a profile
 * page, since a vault has no profiles: the history is what it knows about
 * them.
 */
function contributorsBlock(ctx: RepoCtx, people: { name: string; email: string; commits: number }[]): string {
  if (people.length === 0) return '';
  const base = repoUrl(ctx);
  const faces = people
    .slice(0, SHOWN_CONTRIBUTORS)
    .map(
      (p) =>
        `<a class="contributor" href="${base}/commits/${encPath(ctx.ref)}?author=${encodeURIComponent(
          p.email || p.name
        )}" title="${esc(p.name)} - ${count(p.commits)} commit${p.commits === 1 ? '' : 's'}">${avatar(
          p.email || p.name,
          28
        )}</a>`
    )
    .join('');
  const more =
    people.length > SHOWN_CONTRIBUTORS
      ? `<span class="muted small">+${count(people.length - SHOWN_CONTRIBUTORS)} more</span>`
      : '';
  return `<div class="side-block">
  <h3>Contributors <span class="counter">${count(people.length)}</span></h3>
  <div class="contributors">${faces}${more}</div>
</div>`;
}

function aboutPanel(ctx: RepoCtx, view: TreeView): string {
  const base = repoUrl(ctx);
  const blob = (name: string) => `${base}/blob/${encPath(ctx.ref)}/${encPath(name)}`;
  const license = view.entries.find(
    (e) => e.type === 'blob' && /^(licen[cs]e|copying)(\.[a-z]+)?$/i.test(e.name)
  );
  const links: string[] = [];
  if (view.readmeName) links.push(`<a href="#readme">${icon('book')}<span>Readme</span></a>`);
  if (license) links.push(`<a href="${blob(license.name)}">${icon('law')}<span>${esc(license.name)}</span></a>`);
  if (ctx.hasSite) links.push(`<a href="${ctx.siteUrl}">${icon('globe')}<span>Site</span></a>`);
  if (ctx.releases.length)
    links.push(
      `<a href="${base}/releases">${icon('rocket')}<span>${count(ctx.releases.length)} release${
        ctx.releases.length === 1 ? '' : 's'
      }</span></a>`
    );
  const settings =
    ctx.canPush || ctx.canAdmin
      ? `<a class="side-edit" href="${base}/settings" title="Edit repository details" aria-label="Edit repository details">${icon(
          'sliders'
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
  // The documents a reader looks for and the counts they navigate by are both
  // facts about the repository, so they sit in the one About block rather than
  // under a second rule with no caption on it. A hairline keeps them apart.
  return `<aside class="repo-side">
<div class="side-block">
  <h3>About${settings}</h3>
  ${description}
  ${links.length ? `<div class="side-links">${links.join('')}</div><hr class="rule">` : ''}
  <div class="side-links">${facts.join('')}</div>
</div>
${contributorsBlock(ctx, view.contributors)}
${languagesBlock(view.languages)}
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
  // The history of this directory, which at the root is the history of the
  // repository: the same button GitHub puts above a listing.
  const historyBtn = `<a class="btn" href="${base}/commits/${encPath(ctx.ref)}${
    atRoot ? '' : `/${encPath(path)}`
  }" title="Commits touching this directory">${icon('history')}<span>History</span></a>`;
  // Forking is offered to anyone who can sign in; where the copy may go is
  // settled on the form, where the answer can be explained.
  const forkBtn = atRoot
    ? `<a class="btn" href="${
        ctx.viewer ? `${base}/fork` : `/login?next=${encodeURIComponent(`${base}/fork`)}`
      }" title="Copy this repository elsewhere in the vault">${icon('repo-forked')}<span>Fork</span></a>`
    : '';
  // GitHub's "Add file" is a menu of two: write one here, or upload some.
  const uploadUrl = `${base}/upload/${encPath(ctx.ref)}${atRoot ? '' : `/${encPath(path)}`}`;
  const addFileBtn =
    ctx.canPush && ctx.refIsBranch
      ? `<details class="dropdown">
<summary class="btn">${icon('plus')}<span>Add file</span>${icon('chevron-down', 'caret')}</summary>
<div class="dropdown-menu dd-right">
<a class="dd-item" href="${addFileUrl}">${icon('file')}<span class="dd-label">Create new file</span></a>
<a class="dd-item" href="${uploadUrl}">${icon('upload')}<span class="dd-label">Upload files</span></a>
</div>
</details>`
      : '';
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
  <div class="right-group">${findButton(ctx)}${historyBtn}${forkBtn}${addFileBtn}${cloneMenu(ctx)}</div>
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

/**
 * The file finder. The whole path list is in the page and the filter runs in
 * the browser, so it answers a keystroke without a request; what it costs is
 * a page proportional to the tree, which is why the caller caps the list.
 *
 * Matching is subsequence matching, as GitHub's is: "srcmn" finds
 * src/compute/mean.py. Enter opens the first match, which is what makes this
 * a way of navigating rather than a list to read.
 */
export interface SearchView {
  files: { path: string; hits: { line: number; text: string }[]; more: number }[];
  total: number;
  /** git stopped early: there are more matches than the cap allows. */
  truncated: boolean;
  /** Files beyond the ones grouped onto the page. */
  capped: boolean;
}

/**
 * Show one matching line with the query marked in it. The positions come from
 * the raw text, so the slices around them are escaped individually rather
 * than searching escaped HTML for something that may no longer look the same.
 * A long line is cut around its first match: a result list is for finding the
 * file, not for reading it.
 */
function markMatches(text: string, query: string): string {
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = needle === '' ? -1 : hay.indexOf(needle);
  const first = from;
  const WINDOW = 240;
  let start = 0;
  let cut = text;
  if (text.length > WINDOW && first > WINDOW / 2) {
    start = first - Math.floor(WINDOW / 3);
    cut = text.slice(start);
  }
  if (cut.length > WINDOW) cut = cut.slice(0, WINDOW);
  const body = cut.toLowerCase();
  let out = '';
  let at = 0;
  for (let i = needle === '' ? -1 : body.indexOf(needle); i !== -1; i = body.indexOf(needle, at)) {
    out += esc(cut.slice(at, i)) + `<mark>${esc(cut.slice(i, i + needle.length))}</mark>`;
    at = i + needle.length;
  }
  out += esc(cut.slice(at));
  return `${start > 0 ? '&hellip;' : ''}${out}${start + cut.length < text.length ? '&hellip;' : ''}`;
}

/** Search results: the matching lines, grouped by the file they are in. */
export function searchPage(ctx: RepoCtx, query: string, view: SearchView): string {
  const base = repoUrl(ctx);
  const searchUrl = (ref: string) => `${base}/search?q=${encodeURIComponent(query)}&ref=${encodeURIComponent(ref)}`;
  const form = `<form class="search-form" method="get" action="${base}/search" role="search"><input type="hidden" name="ref" value="${esc(
    ctx.ref
  )}"><input class="search-input" type="search" name="q" value="${esc(
    query
  )}" placeholder="Search this repository" aria-label="Search this repository" autofocus>${icon(
    'search',
    'search-glyph'
  )}</form>`;
  const boxes = view.files
    .map((f) => {
      const fileUrl = `${base}/blob/${encPath(ctx.ref)}/${encPath(f.path)}`;
      const lines = f.hits
        .map(
          (h) =>
            `<a class="search-hit" href="${fileUrl}#L${h.line}"><span class="lnum">${h.line}</span><span class="ltext">${markMatches(
              h.text,
              query
            )}</span></a>`
        )
        .join('');
      const more = f.more
        ? `<a class="search-more" href="${fileUrl}">${count(f.more)} more match${
            f.more === 1 ? '' : 'es'
          } in this file</a>`
        : '';
      return `<div class="box search-file"><div class="box-header">${FILE_ICON}<a href="${fileUrl}">${esc(
        f.path
      )}</a></div><div class="search-hits">${lines}${more}</div></div>`;
    })
    .join('');
  const notes: string[] = [];
  if (view.truncated) notes.push('There were more matches than this page can show.');
  if (view.capped) notes.push('Matches in further files were left out.');
  let body: string;
  if (query.trim() === '') {
    body = `<div class="empty-state">Type to search the files at ${esc(ctx.ref)}. Matching is literal text, not a pattern.</div>`;
  } else if (view.files.length === 0) {
    body = `<div class="empty-state">No file at ${esc(ctx.ref)} contains ${esc(query)}.</div>`;
  } else {
    body = `<p class="muted small">${count(view.total)} matching line${view.total === 1 ? '' : 's'} in ${count(
      view.files.length
    )} file${view.files.length === 1 ? '' : 's'}${notes.length ? ` &middot; ${esc(notes.join(' '))}` : ''}</p>${boxes}`;
  }
  const content = `${repoHeader(ctx, 'code')}
<div class="toolbar">
  <div class="left">${refPicker(ctx, searchUrl)}${form}</div>
  <div class="right-group">${findButton(ctx)}</div>
</div>
${body}`;
  return layout(
    `${query ? `Search: ${query}` : 'Search'} - ${ctx.collection}/${ctx.repo}`,
    content,
    repoOpts(ctx, `${base}/search`)
  );
}

export function findFilePage(ctx: RepoCtx, paths: string[], total: number): string {
  const base = repoUrl(ctx);
  const items = paths
    .map((p) => {
      const cut = p.lastIndexOf('/');
      const dir = cut === -1 ? '' : `<span class="muted">${esc(p.slice(0, cut + 1))}</span>`;
      return `<a class="find-item" href="${base}/blob/${encPath(ctx.ref)}/${encPath(p)}">${FILE_ICON}<span>${dir}${esc(
        p.slice(cut + 1)
      )}</span></a>`;
    })
    .join('');
  const capped =
    total > paths.length
      ? `<p class="muted small">Showing the first ${count(paths.length)} of ${count(total)} files.</p>`
      : '';
  const content = `${repoHeader(ctx, 'code')}
<div class="toolbar">
  <div class="left">${refPicker(ctx, (ref) => `${base}/find/${encPath(ref)}`)}<span class="muted small">${count(
    total
  )} file${total === 1 ? '' : 's'}</span></div>
</div>
<input class="find-input" type="text" placeholder="Go to file" autofocus autocomplete="off" spellcheck="false" aria-label="Go to file" oninput="filterFiles(this)" onkeydown="findKey(event, this)">
${capped}
<div class="find-list" id="find-list">${items}</div>
<div class="empty-state" id="find-empty" hidden>No file matches.</div>`;
  return layout(
    `Find a file - ${ctx.collection}/${ctx.repo}`,
    content,
    repoOpts(ctx, `${base}/find/${encPath(ctx.ref)}`)
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
    ? `<a class="btn" href="${base}/edit/${encPath(ctx.ref)}/${encPath(path)}" title="Edit this file">${icon(
        'pencil'
      )}<span>Edit</span></a><a class="btn btn-danger-outline" href="${base}/delete/${encPath(ctx.ref)}/${encPath(
        path
      )}" title="Delete this file">${icon('trash')}<span>Delete</span></a>`
    : '';
  // GitHub spells the source view of a rendered file ?plain=1; we follow that.
  const seg = (label: string, glyph: IconName, href: string, current: boolean) =>
    `<a${current ? ' class="current"' : ''} href="${href}">${icon(glyph)}<span>${label}</span></a>`;
  const toggle = isMarkdown
    ? `<span class="seg">${seg('Preview', 'book', blobUrl, view.kind === 'markdown')}${seg(
        'Code',
        'code',
        `${blobUrl}?plain=1`,
        view.kind !== 'markdown'
      )}</span>`
    : '';
  let body = '';
  const historyBtn = `<a class="btn" href="${base}/commits/${encPath(ctx.ref)}/${encPath(
    path
  )}" title="Commits touching this file">${icon('history')}<span>History</span></a>`;
  // Blame is for anything we render as text, which includes a markdown file
  // being shown as a document rather than as source.
  const blameBtn =
    view.kind === 'code' || view.kind === 'markdown'
      ? `<a class="btn" href="${base}/blame/${encPath(ctx.ref)}/${encPath(
          path
        )}" title="Who last changed each line">${icon('versions')}<span>Blame</span></a>`
      : '';
  const meta = (left: string, extra = '') =>
    `<div class="code-meta"><span class="muted small">${left}</span><span class="right-group">${toggle}${extra}${blameBtn}${historyBtn}<a class="btn" href="${rawUrl}" title="View the file as it was committed">${icon(
      'download'
    )}<span>Raw</span></a>${editBtns}</span></div>`;
  if (view.kind === 'code') {
    // One element per line, each an anchor: linking to a line is how people
    // point at code, and #L12 is the address GitHub taught them to expect.
    const rows = highlightedLines(view.html)
      .map((line, i) => {
        const n = i + 1;
        return `<div class="cline" id="L${n}"><a class="lnum" href="#L${n}" aria-label="Line ${n}">${n}</a><span class="ltext">${line}</span></div>`;
      })
      .join('');
    const copyRaw = `<button class="btn" type="button" onclick="copyLines(this)" title="Copy the file's contents"><span class="copy-idle">${icon(
      'copy'
    )}<span>Copy</span></span><span class="copy-done">${icon('check')}<span>Copied</span></span></button>`;
    body = `${meta(`${view.lineCount} line${view.lineCount === 1 ? '' : 's'} &middot; ${esc(formatSize(view.size))}`, copyRaw)}
<div class="code-lines">${rows}</div>`;
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
<p><a class="btn btn-primary" href="${rawUrl}">${icon('download')}<span>Download</span></a></p>
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

/**
 * The blame view: every line of a file beside the commit that last touched
 * it, with consecutive lines from the same commit forming a block, as on
 * GitHub. A block that has a previous revision also offers the blame as it
 * stood before that change, which is how a reader walks a line backwards
 * through history.
 */
export function blamePage(ctx: RepoCtx, path: string, html: string, lines: BlameLine[], size: number): string {
  const base = repoUrl(ctx);
  const blobUrl = `${base}/blob/${encPath(ctx.ref)}/${encPath(path)}`;
  const texts = highlightedLines(html);
  const rows = lines
    .map((l, i) => {
      const n = i + 1;
      const starts = i === 0 || lines[i - 1].sha !== l.sha;
      const prior =
        starts && l.previous
          ? `<a class="blame-prior" href="${base}/blame/${encPath(l.previous.sha)}/${encPath(
              l.previous.path
            )}" title="Blame this file before this change" aria-label="Blame this file before this change">${icon(
              'versions'
            )}</a>`
          : '';
      const about = starts
        ? `<a class="sha" href="${base}/commit/${l.sha}">${l.sha.slice(0, 7)}</a><a class="blame-subject" href="${base}/commit/${
            l.sha
          }" title="${esc(l.summary)}">${esc(l.summary)}</a><span class="blame-when small muted">${esc(
            l.author
          )} ${timeTag(l.date)}</span>${prior}`
        : '';
      return `<div class="blame-row${starts ? ' blame-start' : ''}" id="L${n}"><span class="blame-commit">${about}</span><a class="lnum" href="#L${n}" aria-label="Line ${n}">${n}</a><span class="ltext">${
        texts[i] ?? ''
      }</span></div>`;
    })
    .join('');
  const toggle = `<span class="seg"><a href="${blobUrl}">Code</a><a class="current" href="${base}/blame/${encPath(
    ctx.ref
  )}/${encPath(path)}">Blame</a></span>`;
  const content = `${repoHeader(ctx, 'code')}
<div class="toolbar">
  <div class="left">${refPicker(ctx, (ref) => `${base}/blame/${encPath(ref)}/${encPath(path)}`)}${breadcrumb(ctx, path)}</div>
</div>
<div class="code-meta"><span class="muted small">${lines.length} line${lines.length === 1 ? '' : 's'} &middot; ${esc(
    formatSize(size)
  )}</span><span class="right-group">${toggle}<a class="btn" href="${base}/commits/${encPath(ctx.ref)}/${encPath(
    path
  )}" title="Commits touching this file">${icon('history')}<span>History</span></a></span></div>
<div class="blame">${rows}</div>`;
  return layout(
    `Blame ${path} at ${ctx.ref} - ${ctx.collection}/${ctx.repo}`,
    content,
    repoOpts(ctx, `${base}/blame/${encPath(ctx.ref)}/${encPath(path)}`)
  );
}

export function commitsPage(
  ctx: RepoCtx,
  path: string,
  commits: CommitSummary[],
  page: number,
  totalPages: number,
  totalCount: number,
  author?: string
): string {
  const base = repoUrl(ctx);
  const suffix = path === '' ? '' : `/${encPath(path)}`;
  const query = author ? `?author=${encodeURIComponent(author)}` : '';
  // Each row carries what a reader might want next from that commit: to read
  // it, to take its id, or to browse the tree as it stood then.
  const row = (c: CommitSummary) =>
    `<div class="commit-row"><span class="commit-main">${avatar(c.author, 20)}<span><a class="title" href="${base}/commit/${
      c.sha
    }">${esc(c.subject)}</a><div class="muted small">${esc(c.author)} committed ${timeTag(
      c.date
    )}</div></span></span><span class="commit-actions"><a class="sha" href="${base}/commit/${c.sha}">${c.sha.slice(
      0,
      7
    )}</a>${copyButton('', c.sha, 'Copy the full commit id')}<a class="btn" href="${base}/tree/${
      c.sha
    }" title="Browse the repository at this commit" aria-label="Browse the repository at this commit">${icon(
      'code'
    )}</a></span></div>`;
  // Commits are grouped under the day they landed, as on GitHub: a history
  // reads as a sequence of days, and the dates stop repeating on every row.
  const groups: { day: string; rows: string[] }[] = [];
  for (const c of commits) {
    const day = formatDay(c.date);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(row(c));
    else groups.push({ day, rows: [row(c)] });
  }
  const rows = groups
    .map(
      (g) =>
        `<div class="commit-day">${icon('git-commit')}<span>Commits on ${esc(
          g.day
        )}</span></div><div class="commit-group">${g.rows.join('')}</div>`
    )
    .join('');
  const pager: string[] = [];
  const pageUrl = (p: number) =>
    `${base}/commits/${encPath(ctx.ref)}${suffix}?page=${p}${
      author ? `&author=${encodeURIComponent(author)}` : ''
    }`;
  if (page > 1) pager.push(`<a class="btn" href="${pageUrl(page - 1)}">&larr; Newer</a>`);
  if (page < totalPages) pager.push(`<a class="btn" href="${pageUrl(page + 1)}">Older &rarr;</a>`);
  const scope =
    path === ''
      ? `<span class="muted small">${count(totalCount)} commit${totalCount === 1 ? '' : 's'}</span>`
      : `${breadcrumb(ctx, path)}<span class="muted small">${count(totalCount)} commit${
          totalCount === 1 ? '' : 's'
        } touching this path</span>`;
  const empty = author
    ? `No commits here are by ${esc(author)}.`
    : path === ''
      ? 'No commits on this ref.'
      : `Nothing in this ref's history touches ${esc(path)}.`;
  // A filter the reader can see is a filter they can take off again.
  const byAuthor = author
    ? `<span class="filter-chip">${icon('person')}<span>${esc(author)}</span><a href="${base}/commits/${encPath(
        ctx.ref
      )}${suffix}" title="Show every author" aria-label="Show every author">${icon('x')}</a></span>`
    : '';
  const feed = `<a class="btn" href="${base}/commits/${encPath(ctx.ref)}${suffix}.atom" title="Atom feed of this history">${icon(
    'rss'
  )}<span>Feed</span></a>`;
  const content = `${repoHeader(ctx, 'commits')}
<div class="toolbar"><div class="left">${refPicker(
    ctx,
    (ref) => `${base}/commits/${encPath(ref)}${suffix}${query}`
  )}${byAuthor}${scope}</div><div class="right-group">${feed}</div></div>
${rows || `<div class="empty-state">${empty}</div>`}
${pager.length ? `<div class="pagination">${pager.join('')}</div>` : ''}`;
  return layout(
    `Commits${path ? ` for ${path}` : ''} at ${ctx.ref} - ${ctx.collection}/${ctx.repo}`,
    content,
    repoOpts(ctx, `${base}/commits/${encPath(ctx.ref)}${suffix}`)
  );
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
  const noun = kind === 'branches' ? 'branch' : 'tag';
  const listId = `${kind}-list`;
  const rows = refs
    .map((r) => {
      let action = '';
      if (ctx.canPush && viewer && (kind === 'tags' || r.name !== ctx.defaultBranch)) {
        action = `<form method="post" action="${base}/${kind}/delete" onsubmit="return confirm('Delete ${noun} ${esc(
          r.name
        )}?')">${csrfField(viewer)}<input type="hidden" name="name" value="${esc(
          r.name
        )}"><button type="submit" class="btn btn-danger-outline" title="Delete this ${noun}" aria-label="Delete ${esc(
          r.name
        )}">${icon('trash')}</button></form>`;
      }
      // A tag is what people download a release from, so its row carries the
      // archives, as the tags page on GitHub does.
      const archives =
        kind === 'tags'
          ? `<a class="btn" href="${base}/archive/${encPath(r.name)}.zip" title="Download this tag as a zip">${icon(
              'file-zip'
            )}<span>zip</span></a><a class="btn" href="${base}/archive/${encPath(
              r.name
            )}.tar.gz" title="Download this tag as a tar.gz">${icon('file-zip')}<span>tar.gz</span></a>`
          : '';
      const badge =
        kind === 'branches' && r.name === ctx.defaultBranch ? ' <span class="badge">Default</span>' : '';
      // A tag with notes leads to them; one without invites whoever may push
      // to write them, which is the only way a release is ever created.
      const release =
        kind === 'tags'
          ? ctx.releases.includes(r.name)
            ? `<a class="btn" href="${base}/releases/tag/${encPath(r.name)}" title="Release notes for ${esc(
                r.name
              )}">${icon('rocket')}<span>Release</span></a>`
            : ctx.canPush
              ? `<a class="btn" href="${base}/releases/new?tag=${encodeURIComponent(
                  r.name
                )}" title="Write release notes for ${esc(r.name)}">${icon('rocket')}<span>Draft release</span></a>`
              : ''
          : '';
      // Every ref but the default one can be compared against it, which is
      // the question a list of branches invites: what is on this one?
      const compare =
        ctx.defaultBranch && r.name !== ctx.defaultBranch
          ? `<a class="btn" href="${base}/compare/${encPath(ctx.defaultBranch)}...${encPath(
              r.name
            )}" title="Compare with ${esc(ctx.defaultBranch)}">${icon('git-compare')}<span>Compare</span></a>`
          : '';
      return `<tr>
<td class="ref-name">${icon(kind === 'branches' ? 'git-branch' : 'tag', 'icon')}<a href="${base}/tree/${encPath(
        r.name
      )}"><b>${esc(r.name)}</b></a>${badge}
<div class="muted small">Updated ${timeTag(r.date)} &middot; ${esc(r.subject)}</div></td>
<td class="right"><a class="sha" href="${base}/commit/${r.sha}">${r.sha.slice(0, 7)}</a></td>
<td class="right"><span class="right-group">${release}${compare}${archives}${action}</span></td>
</tr>`;
    })
    .join('');
  const body = rows
    ? `${listFilter(listId, `Find a ${noun}`, refs.length)}<table class="listing" id="${listId}"><tbody>${rows}</tbody></table>${noMatches(
        listId
      )}`
    : `<div class="empty-state">No ${kind} yet.</div>`;
  let createMenu = '';
  if (ctx.canPush && viewer && ctx.branches.length > 0) {
    const fromOptions = ctx.branches
      .map(
        (b) =>
          `<option value="${esc(b.name)}"${b.name === ctx.defaultBranch ? ' selected' : ''}>${esc(b.name)}</option>`
      )
      .join('');
    const form =
      kind === 'branches'
        ? `<form method="post" action="${base}/branches/create">${csrfField(viewer)}
<div class="field"><label for="new-ref">New branch name</label><input type="text" id="new-ref" name="name" placeholder="new-branch-name" required></div>
<div class="field"><label for="ref-from">From</label><select id="ref-from" name="from">${fromOptions}</select></div>
<button type="submit" class="btn btn-primary">Create branch</button></form>`
        : `<form method="post" action="${base}/tags/create">${csrfField(viewer)}
<div class="field"><label for="new-ref">Tag name</label><input type="text" id="new-ref" name="name" placeholder="v1.0.0" required></div>
<div class="field"><label for="ref-at">At</label><select id="ref-at" name="at">${fromOptions}</select></div>
<button type="submit" class="btn btn-primary">Create tag</button></form>`;
    createMenu = `<details class="dropdown">
<summary class="btn btn-primary">${icon('plus')}<span>New ${noun}</span>${icon('chevron-down', 'caret')}</summary>
<div class="dropdown-menu dd-right ref-form">${form}</div>
</details>`;
  }
  const content = `${repoHeader(ctx, kind)}<div class="page-head"><h2>${
    kind === 'branches' ? 'Branches' : 'Tags'
  }</h2>${createMenu}</div>${body}`;
  return layout(`${kind} - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, `${base}/${kind}`));
}

/**
 * The quick-setup page GitHub shows for a repository with no commits: the
 * address to push to, and the two command sequences that are the usual next
 * step. It is the one place in the interface that teaches git commands,
 * because it is the one place where the answer really is a command.
 */
export function emptyRepoPage(ctx: RepoCtx): string {
  const base = repoUrl(ctx);
  const url = ctx.cloneUrl;
  const block = (lines: string[]) =>
    `<div class="cmd-block"><pre>${esc(lines.join('\n'))}</pre>${copyButton()}</div>`;
  const readmeBtn = ctx.canPush
    ? `<a class="btn btn-primary" href="${base}/new/main">${icon('plus')}<span>Create a README</span></a>`
    : '';
  const content = `${repoHeader(ctx, 'code')}
<div class="box">
  <div class="box-header">${icon('repo')}Quick setup, if you have done this before</div>
  <div class="box-body">
    <div class="cmd-row"><code>${esc(url)}</code>${copyButton()}</div>
    <p class="muted">Cloning is anonymous. Pushing asks for your username and a token; <span class="mono">cofferdam login</span> hands the token to git once so it stops asking.</p>
    ${readmeBtn}
  </div>
</div>
<h3 class="setup-head">&hellip;or create a new repository on the command line</h3>
${block([
  `echo "# ${ctx.repo}" >> README.md`,
  'git init',
  'git add README.md',
  'git commit -m "first commit"',
  'git branch -M main',
  `git remote add origin ${url}`,
  'git push -u origin main',
])}
<h3 class="setup-head">&hellip;or push an existing repository from the command line</h3>
${block([`git remote add origin ${url}`, 'git branch -M main', 'git push -u origin main'])}`;
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
