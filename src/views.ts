import { CommitDetail, CommitSummary, RefInfo, TreeEntry } from './git';
import { esc, formatDate, formatSize } from './render';
import { Viewer, viewerIsAdmin } from './session';
import { activeTheme } from './themes';
import { WORDMARK } from './logo';

export interface RepoCtx {
  collection: string;
  repo: string;
  ref: string;
  refIsBranch: boolean;
  defaultBranch: string;
  branches: RefInfo[];
  tags: RefInfo[];
  cloneUrl: string;
  hasPages: boolean;
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

const FOLDER_ICON =
  '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/></svg>';
const FILE_ICON =
  '<svg class="icon file" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/></svg>';

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
  function done() { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1200); }
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
</script>
</body>
</html>`;
}

export function repoOpts(ctx: RepoCtx, path?: string): PageOpts {
  return { viewer: ctx.viewer, path };
}

export function copyRow(cmd: string): string {
  return `<div class="cmd-row"><code>${esc(cmd)}</code><button class="copy-btn" type="button" onclick="copyCmd(this)">Copy</button></div>`;
}

function refSelector(ctx: RepoCtx, urlForRef: (ref: string) => string): string {
  const option = (r: RefInfo) =>
    `<option value="${esc(urlForRef(r.name))}"${r.name === ctx.ref ? ' selected' : ''}>${esc(r.name)}</option>`;
  const branchOpts = ctx.branches.map(option).join('');
  const tagOpts = ctx.tags.map(option).join('');
  let inner = '';
  if (branchOpts) inner += `<optgroup label="Branches">${branchOpts}</optgroup>`;
  if (tagOpts) inner += `<optgroup label="Tags">${tagOpts}</optgroup>`;
  const known = ctx.branches.some((b) => b.name === ctx.ref) || ctx.tags.some((t) => t.name === ctx.ref);
  if (!known) inner = `<option value="" selected>${esc(ctx.ref)}</option>` + inner;
  return `<select class="ref-select" onchange="if(this.value)location.href=this.value">${inner}</select>`;
}

export function repoHeader(
  ctx: RepoCtx,
  active: 'code' | 'commits' | 'branches' | 'tags' | 'settings'
): string {
  const base = repoUrl(ctx);
  const tab = (id: string, label: string, href: string, count?: number) =>
    `<a class="tab${active === id ? ' active' : ''}" href="${href}">${label}${
      count !== undefined ? `<span class="counter">${count}</span>` : ''
    }</a>`;
  return `<div class="repo-title"><a href="/${encodeURIComponent(ctx.collection)}">${esc(ctx.collection)}</a> / <a href="${base}"><b>${esc(
    ctx.repo
  )}</b></a></div>
<nav class="tabs">
${tab('code', 'Code', base)}
${tab('commits', 'Commits', `${base}/commits/${encPath(ctx.ref)}`)}
${tab('branches', 'Branches', `${base}/branches`, ctx.branches.length)}
${tab('tags', 'Tags', `${base}/tags`, ctx.tags.length)}
${ctx.hasPages ? tab('pages', 'Pages', `${base}/pages/`) : ''}
${ctx.canPush || ctx.canAdmin ? tab('settings', 'Settings', `${base}/settings`) : ''}
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
        `<tr><td>${FILE_ICON}<a href="/${encodeURIComponent(collection)}/${encodeURIComponent(r.name)}"><b>${esc(
          r.name
        )}</b></a>${r.description ? `<div class="muted small">${esc(r.description)}</div>` : ''}</td><td class="right muted small">${
          r.updated ? `Updated ${esc(formatDate(r.updated))}` : ''
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

export function treePage(
  ctx: RepoCtx,
  path: string,
  entries: TreeEntry[],
  latest: CommitSummary | null,
  readmeHtml: string | null,
  readmeName: string | null
): string {
  const base = repoUrl(ctx);
  const refBase = `${base}/tree/${encPath(ctx.ref)}`;
  const rows: string[] = [];
  if (path !== '') {
    const parent = path.split('/').slice(0, -1).join('/');
    const up = parent === '' ? refBase : `${refBase}/${encPath(parent)}`;
    rows.push(`<tr><td><a href="${up}">..</a></td><td></td><td></td></tr>`);
  }
  for (const e of entries) {
    const childPath = path === '' ? e.name : `${path}/${e.name}`;
    if (e.type === 'tree') {
      rows.push(
        `<tr><td>${FOLDER_ICON}<a href="${base}/tree/${encPath(ctx.ref)}/${encPath(childPath)}">${esc(
          e.name
        )}</a></td><td></td><td></td></tr>`
      );
    } else if (e.type === 'blob') {
      rows.push(
        `<tr><td>${FILE_ICON}<a href="${base}/blob/${encPath(ctx.ref)}/${encPath(childPath)}">${esc(
          e.name
        )}</a></td><td class="right muted small">${e.size !== null ? formatSize(e.size) : ''}</td><td class="right muted small mono">${e.sha.slice(
          0,
          7
        )}</td></tr>`
      );
    } else {
      rows.push(
        `<tr><td>${FOLDER_ICON}${esc(e.name)} <span class="muted small">@ ${e.sha.slice(0, 7)} (submodule)</span></td><td></td><td></td></tr>`
      );
    }
  }
  const latestBar = latest
    ? `<div class="latest-commit"><span><a href="${base}/commit/${latest.sha}"><b>${esc(
        latest.subject
      )}</b></a> <span class="muted small">by ${esc(latest.author)}</span></span><span class="muted small">${esc(
        formatDate(latest.date)
      )} <a class="sha" href="${base}/commit/${latest.sha}">${latest.sha.slice(0, 7)}</a></span></div>`
    : '';
  const addFileUrl = `${base}/new/${encPath(ctx.ref)}${path === '' ? '' : `/${encPath(path)}`}`;
  const addFileBtn =
    ctx.canPush && ctx.refIsBranch ? `<a class="btn" href="${addFileUrl}">Add file</a>` : '';
  const cloneBox =
    path === ''
      ? `<div class="clone-box"><input readonly value="git clone ${esc(ctx.cloneUrl)}" onclick="this.select()"><button class="copy-btn" type="button" onclick="copyCmd(this)">Copy</button></div>`
      : '';
  const readmePath = path === '' ? readmeName : `${path}/${readmeName}`;
  const readme = readmeHtml
    ? `<div class="box"><div class="box-header"><a href="${base}/blob/${encPath(ctx.ref)}/${encPath(
        readmePath ?? 'README'
      )}">${esc(readmeName ?? 'README')}</a></div><div class="box-body markdown-body">${readmeHtml}</div></div>`
    : '';
  const content = `${repoHeader(ctx, 'code')}
<div class="toolbar">
  <div class="left">${refSelector(ctx, (ref) => `${base}/tree/${encPath(ref)}`)}${breadcrumb(ctx, path)}</div>
  <div class="right-group">${addFileBtn}${cloneBox}</div>
</div>
${latestBar}
<table class="listing"><tbody>${rows.join('')}</tbody></table>
${readme}`;
  return layout(
    `${ctx.collection}/${ctx.repo}${path ? ` at ${path}` : ''}`,
    content,
    repoOpts(ctx, path === '' ? repoUrl(ctx) : `${refBase}/${encPath(path)}`)
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
  <div class="left">${refSelector(ctx, (ref) => `${base}/blob/${encPath(ref)}/${encPath(path)}`)}${breadcrumb(ctx, path)}</div>
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
        )}</a><div class="muted small">${esc(c.author)} committed ${esc(formatDate(c.date))}</div></span><a class="sha" href="${base}/commit/${
          c.sha
        }">${c.sha.slice(0, 7)}</a></div>`
    )
    .join('');
  const pager: string[] = [];
  const pageUrl = (p: number) => `${base}/commits/${encPath(ctx.ref)}?page=${p}`;
  if (page > 1) pager.push(`<a class="btn" href="${pageUrl(page - 1)}">&larr; Newer</a>`);
  if (page < totalPages) pager.push(`<a class="btn" href="${pageUrl(page + 1)}">Older &rarr;</a>`);
  const content = `${repoHeader(ctx, 'commits')}
<div class="toolbar"><div class="left">${refSelector(ctx, (ref) => `${base}/commits/${encPath(ref)}`)}<span class="muted">${totalCount} commits</span></div></div>
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
    <span>${esc(formatDate(detail.date))}</span>
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
      }<div class="muted small">${esc(r.subject)}</div></td><td class="right muted small">${esc(
        formatDate(r.date)
      )}</td><td class="right"><a class="sha" href="${base}/commit/${r.sha}">${r.sha.slice(0, 7)}</a></td><td class="right">${action}</td></tr>`;
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
