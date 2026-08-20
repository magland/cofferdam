import { avatar } from './avatar';
import { IconName, icon } from './icons';
import { MARK } from './logo';
import { esc } from './render';
import { Viewer } from './session';
import { Theme } from './themes';
import { UserRecord, canAdmin } from './vault';
import { PageOpts, RepoCtx, copyButton, copyRow, csrfField, encPath, layout, repoHeader, repoOpts, repoUrl } from './views';

// Form pages for the UI operations. Every mutating form embeds the session's
// CSRF value and posts back to a handler that re-checks authorization against
// live vault.json.

function errorBanner(error?: string): string {
  return error ? `<div class="form-error">${esc(error)}</div>` : '';
}

export function flashBanner(msg?: string): string {
  return msg ? `<div class="flash">${esc(msg)}</div>` : '';
}

export function loginPage(next: string, error?: string): string {
  // A narrow card under the mark, centred on the page: signing in is the one
  // thing this page is for, so nothing else is on it.
  const content = `<div class="signin">
<div class="signin-mark">${MARK}</div>
<h1>Sign in to cofferdam</h1>
${errorBanner(error)}
<div class="form-box">
<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(next)}">
<div class="field"><label for="username">Username</label><input type="text" id="username" name="username" autocomplete="username" autofocus required></div>
<div class="field"><label for="token">Token</label><input type="password" id="token" name="token" autocomplete="current-password" required></div>
<button type="submit" class="btn btn-primary">Sign in</button>
</form>
</div>
<p class="muted small signin-note">A token is what git uses for pushing. Tokens are minted by an administrator; there are no passwords.</p>
</div>`;
  return layout('Sign in', content, { path: '/login' });
}

export function newRepoPage(
  viewer: Viewer,
  collectionNames: string[],
  preset: { collection?: string; name?: string; description?: string },
  error?: string
): string {
  const datalist = collectionNames.map((o) => `<option value="${esc(o)}">`).join('');
  const content = `<div class="form-box wide">
<h1>Create a new repository</h1>
<p class="muted">A repository is a directory in the vault holding a bare git repository. Its name and the collection it sits in are its address.</p>
<hr class="rule">
${errorBanner(error)}
<form method="post" action="/new">
${csrfField(viewer)}
<div class="name-row">
  <div class="field"><label for="collection">Collection</label><input type="text" id="collection" name="collection" list="collections" value="${esc(
    preset.collection ?? ''
  )}" required><datalist id="collections">${datalist}</datalist></div>
  <div class="name-slash">/</div>
  <div class="field"><label for="name">Repository name</label><input type="text" id="name" name="name" value="${esc(
    preset.name ?? ''
  )}" required></div>
</div>
<p class="muted small">The collection may be one that exists or a new one to create along with the repository.</p>
<div class="field"><label for="description">Description <span class="muted">(optional)</span></label><input type="text" id="description" name="description" value="${esc(
    preset.description ?? ''
  )}"></div>
<hr class="rule">
<div class="field"><label class="checkbox"><input type="checkbox" name="init" value="1" checked> Initialize with a README</label>
<p class="muted small">Gives the repository a first commit on <span class="mono">main</span>, so it can be browsed and cloned straight away.</p></div>
<button type="submit" class="btn btn-primary">${icon('repo')}<span>Create repository</span></button>
</form>
</div>`;
  return layout('New repository', content, { viewer, path: '/new' });
}

/**
 * The fork form. GitHub asks where the copy should go and lets the name be
 * changed on the way; so does this, with the collection defaulting to one
 * named after the signed-in user, which is the shape most vaults have.
 */
export function forkPage(
  ctx: RepoCtx,
  viewer: Viewer,
  collectionNames: string[],
  preset: { collection?: string; name?: string },
  error?: string
): string {
  const base = repoUrl(ctx);
  const datalist = collectionNames.map((o) => `<option value="${esc(o)}">`).join('');
  const content = `${repoHeader(ctx, 'code')}
<div class="form-box wide">
<h1>Fork ${esc(ctx.collection)}/${esc(ctx.repo)}</h1>
<p class="muted">A fork is a copy of the repository somewhere else in this vault. Its objects are shared with the original on disk until one of them gains new ones, so a fork costs almost nothing.</p>
<hr class="rule">
${errorBanner(error)}
<form method="post" action="${base}/fork">
${csrfField(viewer)}
<div class="name-row">
  <div class="field"><label for="collection">Collection</label><input type="text" id="collection" name="collection" list="collections" value="${esc(
    preset.collection ?? ''
  )}" required><datalist id="collections">${datalist}</datalist></div>
  <div class="name-slash">/</div>
  <div class="field"><label for="name">Repository name</label><input type="text" id="name" name="name" value="${esc(
    preset.name ?? ctx.repo
  )}" required></div>
</div>
<p class="muted small">You need push scope over the destination. Branches and tags come across; issues, releases, and workflow runs stay with the original.</p>
<button type="submit" class="btn btn-primary">${icon('repo-forked')}<span>Create fork</span></button>
</form>
</div>`;
  return layout(`Fork ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, `${base}/fork`));
}

/**
 * The import page. Importing has always run on the reader's machine rather than
 * on the server, and what this page does is hand them the command
 * that does it. Earlier it asked for the source in a form and wrote a shell
 * one-liner from the answers, which put a form in front of an operation the
 * page cannot perform; now `cofferdam import` performs it, so the page only has
 * to say what to run, with the collection and the vault's own URL filled in.
 * The git commands remain below for a machine with no Node on it.
 */
export function importPage(
  viewer: Viewer,
  opts: { collection: string | null; vaultUrl: string; gitCommand: string | null }
): string {
  const collection = opts.collection ?? 'mycollection';
  const back = opts.collection
    ? `<p><a class="btn" href="/${encodeURIComponent(opts.collection)}">Back to ${esc(opts.collection)}</a></p>`
    : '';
  const fallback = opts.gitCommand
    ? `<hr class="rule">
<h2>Without the CLI</h2>
<p class="muted small">The same two steps by hand. Replace the source URL, and the name after the collection if you want one other than the source's.</p>
${copyRow(opts.gitCommand)}`
    : '';
  const content = `<div class="form-box wide">
<h1>Import a repository</h1>
<p class="muted">Importing runs on your machine, not on this server: git reads the source with the credentials you already have there and pushes it here, which creates the repository. The <span class="mono">cofferdam</span> command does both.</p>
<hr class="rule">
<h2>Once per machine</h2>
${copyRow('npm install -g @magland/cofferdam')}
${copyRow(`cofferdam login ${opts.vaultUrl}`)}
<h2>Then, for each repository</h2>
${copyRow(`cofferdam import https://github.com/owner/repo ${collection}`)}
<p class="muted small">The source may be an https or ssh git URL, or <span class="mono">owner/repo</span> for GitHub. The repository takes its name from the source; write <span class="mono">${esc(
    collection
  )}/another-name</span> to choose another. Add <span class="mono">--lfs</span> to carry Git LFS objects too. A collection that does not exist yet is created by the push. A public GitHub source also has its description read from GitHub and set here.</p>
${fallback}
${back}
</div>`;
  return layout('Import a repository', content, { viewer, path: '/import' });
}

/**
 * Creating a collection on its own. A push creates the collection it lands in,
 * so this is for the order where the collection comes first: an empty one to
 * import into, or to hand someone push access over before anything is in it.
 */
export function newCollectionPage(viewer: Viewer, preset: { name?: string }, error?: string): string {
  const content = `<div class="form-box wide">
<h1>Create a new collection</h1>
<p class="muted">A collection is a directory in the vault holding repositories. It may be empty; repositories arrive by creation, import, or push.</p>
<hr class="rule">
${errorBanner(error)}
<form method="post" action="/new/collection">
${csrfField(viewer)}
<div class="field"><label for="name">Collection name</label><input type="text" id="name" name="name" value="${esc(
    preset.name ?? ''
  )}" required autofocus></div>
<p class="muted small">Letters, digits, dot, underscore, and dash. You need push scope over something in it.</p>
<button type="submit" class="btn btn-primary">${icon('plus')}<span>Create collection</span></button>
</form>
</div>`;
  return layout('New collection', content, { viewer, path: '/new/collection' });
}

/**
 * A collection's own settings, which today is one operation: its name.
 *
 * Repository settings live under the repository, so a collection's live under
 * the collection, at the same place in the path. The rename is graded amber
 * rather than red for the same reason a repository's is: what it breaks can be
 * put back by renaming it again.
 */
export function collectionSettingsPage(
  viewer: Viewer,
  collection: string,
  repoCount: number,
  msg?: string,
  error?: string
): string {
  const base = `/${encodeURIComponent(collection)}`;
  const holds =
    repoCount === 0
      ? 'This collection is empty.'
      : `Every one of its ${
          repoCount === 1 ? 'repository' : `${repoCount} repositories`
        } moves with it, along with their sites, workflow runs, issues, pull requests, releases, and LFS objects.`;
  const content = `<div class="page-head"><h1 class="with-avatar">${avatar(collection, 28, 'square')}${esc(
    collection
  )}</h1></div>
<h2>Settings</h2>
${flashBanner(msg)}
${errorBanner(error)}
<div class="danger-zone caution">
<h3>Rename</h3>
<p>${holds} Clones and remotes pointing at the old address stop working until they are changed, and token scopes naming the old collection have to be granted again under the new name.</p>
<form method="post" action="${base}/settings/rename" class="inline-form">
${csrfField(viewer)}
<label for="toName">Collection name</label><input type="text" id="toName" name="name" value="${esc(
    collection
  )}" required>
<button type="submit" class="btn">${icon('pencil')}<span>Rename</span></button>
</form>
</div>`;
  return layout(`Settings - ${collection}`, content, {
    crumbs: ` / <a href="${base}">${esc(collection)}</a>`,
    viewer,
    path: `${base}/settings`,
  });
}

/**
 * The commit box: a summary and an optional extended description, which is
 * GitHub's shape and git's own (the two are joined by a blank line before the
 * commit is made). The face beside the heading is whose commit it will be.
 */
function commitFields(
  viewer: Viewer,
  expectedHead: string | null,
  messagePlaceholder: string,
  branch?: string
): string {
  // Committing to a new branch is GitHub's second choice in this box, and the
  // one that keeps a shared branch clean. The name field is only read when
  // that choice is made, so leaving it filled in is harmless.
  const branchChoice =
    branch === undefined
      ? ''
      : `<div class="commit-target">
<label class="checkbox"><input type="checkbox" name="newBranchWanted" value="1"> Commit to a new branch</label>
<div class="field"><label class="sr-only" for="newBranch">New branch name</label><input type="text" id="newBranch" name="newBranch" placeholder="${esc(
          branch
        )}-patch" autocomplete="off"></div>
<p class="muted small">Leave it unticked to commit straight to <span class="mono">${esc(branch)}</span>.</p>
</div>`;
  return `${csrfField(viewer)}
<input type="hidden" name="expected" value="${esc(expectedHead ?? '')}">
<div class="commit-box-head">${avatar(viewer.auth.username, 28)}<b>Commit changes</b></div>
<div class="field"><label class="sr-only" for="message">Commit message</label><input type="text" id="message" name="message" placeholder="${esc(
    messagePlaceholder
  )}"></div>
<div class="field"><label class="sr-only" for="description">Extended description</label><textarea id="description" name="description" rows="3" placeholder="Add an optional extended description"></textarea></div>
${branchChoice}`;
}

export function editFilePage(
  ctx: RepoCtx,
  filePath: string,
  content: string,
  expectedHead: string,
  error?: string
): string {
  const base = repoUrl(ctx);
  const action = `${base}/edit/${encPath(ctx.ref)}/${encPath(filePath)}`;
  const cancel = `${base}/blob/${encPath(ctx.ref)}/${encPath(filePath)}`;
  const rows = Math.min(30, Math.max(12, content.split('\n').length + 2));
  const body = `${repoHeader(ctx, 'code')}
<h2 class="file-head">Editing <span class="mono">${esc(filePath)}</span> on <span class="mono">${esc(ctx.ref)}</span></h2>
${errorBanner(error)}
<form method="post" action="${action}">
<div class="field"><label for="path">Path</label><input type="text" id="path" name="path" value="${esc(
    filePath
  )}" spellcheck="false"><p class="muted small">Changing it renames or moves the file in the same commit.</p></div>
<textarea class="code-editor" name="content" rows="${rows}" spellcheck="false">${esc(content)}</textarea>
<div class="commit-box">
${commitFields(ctx.viewer!, expectedHead, `Update ${filePath.split('/').pop()}`, ctx.ref)}
<div class="actions"><button type="submit" class="btn btn-primary">Commit changes</button><a class="btn" href="${cancel}">Cancel</a></div>
</div>
</form>`;
  return layout(`Editing ${filePath} - ${ctx.collection}/${ctx.repo}`, body, repoOpts(ctx));
}

export function newFilePage(
  ctx: RepoCtx,
  branch: string,
  dir: string,
  expectedHead: string | null,
  preset: { filename?: string; content?: string },
  error?: string
): string {
  const base = repoUrl(ctx);
  const action = `${base}/new/${encPath(branch)}${dir === '' ? '' : `/${encPath(dir)}`}`;
  const cancel = expectedHead === null ? base : `${base}/tree/${encPath(branch)}${dir === '' ? '' : `/${encPath(dir)}`}`;
  const prefix = dir === '' ? '' : `${dir}/`;
  const branchNote =
    expectedHead === null
      ? `<p class="muted small">This repository is empty; committing will create the <span class="mono">${esc(branch)}</span> branch.</p>`
      : '';
  const body = `${repoHeader(ctx, 'code')}
<h2 class="file-head">New file in <span class="mono">${esc(prefix) || '/'}</span> on <span class="mono">${esc(branch)}</span></h2>
${branchNote}
${errorBanner(error)}
<form method="post" action="${action}">
<div class="field"><label for="filename">File name</label><div class="filename-row"><span class="mono muted">${esc(
    prefix
  )}</span><input type="text" id="filename" name="filename" value="${esc(
    preset.filename ?? ''
  )}" placeholder="path/to/file.md" required></div></div>
<textarea class="code-editor" name="content" rows="18" spellcheck="false">${esc(preset.content ?? '')}</textarea>
<div class="commit-box">
${commitFields(ctx.viewer!, expectedHead, 'Create new file', expectedHead === null ? undefined : branch)}
<div class="actions"><button type="submit" class="btn btn-primary">Commit new file</button><a class="btn" href="${cancel}">Cancel</a></div>
</div>
</form>`;
  return layout(`New file - ${ctx.collection}/${ctx.repo}`, body, repoOpts(ctx));
}

/**
 * The upload form. A file input and the same commit box as the editor, so
 * uploading is the same act as writing a file: a commit with a message, on
 * this branch or on a new one.
 */
export function uploadPage(
  ctx: RepoCtx,
  branch: string,
  dir: string,
  expectedHead: string | null,
  maxBytes: number,
  error?: string
): string {
  const base = repoUrl(ctx);
  const action = `${base}/upload/${encPath(branch)}${dir === '' ? '' : `/${encPath(dir)}`}`;
  const cancel = `${base}/tree/${encPath(branch)}${dir === '' ? '' : `/${encPath(dir)}`}`;
  const body = `${repoHeader(ctx, 'code')}
<h2 class="file-head">Uploading to <span class="mono">${esc(dir === '' ? '/' : `${dir}/`)}</span> on <span class="mono">${esc(
    branch
  )}</span></h2>
${errorBanner(error)}
<form method="post" action="${action}" enctype="multipart/form-data">
<div class="field"><label for="files">Files</label>
<input type="file" id="files" name="files" multiple required>
<p class="muted small">Up to ${Math.floor(maxBytes / (1024 * 1024))} MB in one commit. A file that is already there is replaced, keeping its mode. Large binaries are better pushed with Git LFS.</p></div>
<div class="commit-box">
${commitFields(ctx.viewer!, expectedHead, 'Add files via upload', branch)}
<div class="actions"><button type="submit" class="btn btn-primary">${icon(
    'upload'
  )}<span>Commit changes</span></button><a class="btn" href="${cancel}">Cancel</a></div>
</div>
</form>`;
  return layout(`Upload to ${ctx.collection}/${ctx.repo}`, body, repoOpts(ctx, action));
}

export function deleteFilePage(ctx: RepoCtx, filePath: string, expectedHead: string, error?: string): string {
  const base = repoUrl(ctx);
  const action = `${base}/delete/${encPath(ctx.ref)}/${encPath(filePath)}`;
  const cancel = `${base}/blob/${encPath(ctx.ref)}/${encPath(filePath)}`;
  const body = `${repoHeader(ctx, 'code')}
<h2 class="file-head">Delete <span class="mono">${esc(filePath)}</span> from <span class="mono">${esc(ctx.ref)}</span></h2>
${errorBanner(error)}
<div class="form-box">
<p>This commits the removal of <b>${esc(filePath)}</b> to the <b>${esc(ctx.ref)}</b> branch. The file stays in the history.</p>
<form method="post" action="${action}">
${commitFields(ctx.viewer!, expectedHead, `Delete ${filePath.split('/').pop()}`)}
<div class="actions"><button type="submit" class="btn btn-danger">Delete file</button><a class="btn" href="${cancel}">Cancel</a></div>
</form>
</div>`;
  return layout(`Delete ${filePath} - ${ctx.collection}/${ctx.repo}`, body, repoOpts(ctx));
}

export function conflictPage(ctx: RepoCtx, branch: string, retryUrl: string): string {
  const body = `${repoHeader(ctx, 'code')}
<div class="form-box">
<h2>The branch has moved</h2>
<p>Someone updated <b>${esc(branch)}</b> while you were editing, so your change was not committed; committing it now could silently undo theirs.</p>
<p><a class="btn btn-primary" href="${esc(retryUrl)}">Reload and try again</a></p>
</div>`;
  return layout(`Conflict - ${ctx.collection}/${ctx.repo}`, body, repoOpts(ctx));
}

export function settingsPage(ctx: RepoCtx, description: string, msg?: string, error?: string): string {
  const base = repoUrl(ctx);
  const branchOptions = ctx.branches
    .map(
      (b) =>
        `<option value="${esc(b.name)}"${b.name === ctx.defaultBranch ? ' selected' : ''}>${esc(b.name)}</option>`
    )
    .join('');
  const defaultBranchField =
    ctx.branches.length > 0
      ? `<div class="field"><label for="defaultBranch">Default branch</label><select id="defaultBranch" name="defaultBranch">${branchOptions}</select></div>`
      : '';
  const settingsForm = ctx.canPush
    ? `<div class="box settings-box"><div class="box-header">${icon('sliders')}General</div><div class="box-body">
<form method="post" action="${base}/settings">
${csrfField(ctx.viewer!)}
<div class="field"><label for="description">Description</label><input type="text" id="description" name="description" value="${esc(
        description
      )}"><p class="muted small">Shown beside the repository in listings and in the About panel.</p></div>
${defaultBranchField}
<button type="submit" class="btn btn-primary">${icon('check')}<span>Save</span></button>
</form>
</div></div>`
    : '';
  // Renaming and moving are one operation, since both are a directory rename.
  // It is flagged because every URL to this repository, and every remote
  // pointing at it, changes with it; it takes the amber grade rather than the
  // red one because what it breaks can be put back by renaming it again.
  const renameForm = ctx.canAdmin
    ? `<div class="danger-zone caution">
<h3>Rename or move</h3>
<p>Everything moves with the repository: its site, its workflow runs, its issues, its releases, and its LFS objects. Clones pointing at the old address stop working until their remote is changed.</p>
<form method="post" action="${base}/settings/rename" class="inline-form">
${csrfField(ctx.viewer!)}
<label for="toCollection">Collection</label><input type="text" id="toCollection" name="collection" value="${esc(
        ctx.collection
      )}" required>
<label for="toName">Name</label><input type="text" id="toName" name="name" value="${esc(ctx.repo)}" required>
<button type="submit" class="btn">${icon('pencil')}<span>Rename</span></button>
</form>
</div>`
    : '';
  const dangerZone = ctx.canAdmin
    ? `<div class="danger-zone">
<h3>Danger zone</h3>
<p>Deleting a repository removes its directory${ctx.hasSite ? ' and its site' : ''} from the vault permanently. There is no undo.</p>
<form method="post" action="${base}/settings/delete">
${csrfField(ctx.viewer!)}
<div class="field"><label for="confirm">Type <b class="mono">${esc(ctx.collection)}/${esc(ctx.repo)}</b> to confirm</label><input type="text" id="confirm" name="confirm" autocomplete="off"></div>
<button type="submit" class="btn btn-danger">${icon('trash')}<span>Delete this repository</span></button>
</form>
</div>`
    : '';
  const body = `${repoHeader(ctx, 'settings')}
<h2>Settings</h2>
${flashBanner(msg)}
${errorBanner(error)}
${settingsForm}
${renameForm}
${dangerZone}`;
  return layout(`Settings - ${ctx.collection}/${ctx.repo}`, body, repoOpts(ctx, `${base}/settings`));
}

export function adminUsersPage(
  viewer: Viewer,
  users: { name: string; user: UserRecord }[],
  msg?: string,
  error?: string
): string {
  const rows = users
    .map(({ name, user }) => {
      const actions = `<details class="dropdown"><summary class="btn">${icon(
        'kebab'
      )}<span>Manage</span></summary><div class="dropdown-menu dd-right user-actions">
<form method="post" action="/admin/users/${encodeURIComponent(name)}/grant" class="inline-form">
${csrfField(viewer)}
<input type="text" name="scope" placeholder="push globs, e.g. mycollection/*">
<input type="text" name="admin" placeholder="admin globs">
<button type="submit" class="btn">Grant</button>
</form>
<form method="post" action="/admin/users/${encodeURIComponent(name)}/token" class="inline-form">
${csrfField(viewer)}
<input type="text" name="tokenScope" placeholder="token scope (optional)">
<button type="submit" class="btn">Mint token</button>
</form>
</div></details>`;
      return `<tr><td class="with-avatar">${avatar(name, 24)}<b>${esc(name)}</b></td><td class="mono small">${esc(user.scope.join(' ') || '(none)')}</td><td class="mono small">${esc(
        user.admin.join(' ')
      )}</td><td class="right muted small">${user.tokens.length} token${user.tokens.length === 1 ? '' : 's'}</td><td>${actions}</td></tr>`;
    })
    .join('');
  const content = `<h1>Users</h1>
${flashBanner(msg)}
${errorBanner(error)}
<table class="listing"><tbody><tr><th>User</th><th>Push scope</th><th>Admin scope</th><th class="right">Tokens</th><th></th></tr>${rows}</tbody></table>
<div class="form-box" style="margin-top:24px">
<h2>Add user</h2>
<form method="post" action="/admin/users">
${csrfField(viewer)}
<div class="field"><label for="username">Username</label><input type="text" id="username" name="username" required></div>
<div class="field"><label for="scope">Push scope globs</label><input type="text" id="scope" name="scope" value="*" placeholder="e.g. mycollection/*">
<p class="muted small">Space-separated globs over <span class="mono">collection/repo</span>. <span class="mono">*</span> matches everything.</p></div>
<div class="field"><label for="admin">Admin scope globs <span class="muted">(optional)</span></label><input type="text" id="admin" name="admin" placeholder="e.g. mycollection/*"></div>
<button type="submit" class="btn btn-primary">Create user and mint token</button>
</form>
<p class="muted small">Your admin scope must cover every glob you assign. The new token is shown once on the next page.</p>
</div>`;
  return adminShell(viewer, 'users', 'Users', '/admin/users', content);
}

/**
 * The shell every administration page sits in: the sections down the left, as
 * GitHub's settings pages have. It saves each page a "Back" link and makes it
 * plain what else there is to administer.
 */
export function adminShell(
  viewer: Viewer,
  active: 'index' | 'users' | 'runners' | 'appearance',
  title: string,
  path: string,
  body: string
): string {
  const item = (id: string, href: string, label: string, glyph: IconName) =>
    `<a class="${active === id ? 'current' : ''}" href="${href}">${icon(glyph)}<span>${label}</span></a>`;
  // Appearance is vault-wide, so it is offered only to an administrator whose
  // scope covers the whole vault; the same check the route makes.
  const canTheme = canAdmin(viewer.auth, ['*']);
  const nav = `<aside class="admin-side"><div class="side-block"><h3>${icon('sliders')}Administration</h3><div class="side-links">
${item('users', '/admin/users', 'Users', 'people')}
${item('runners', '/admin/runners', 'Runners', 'server')}
${canTheme ? item('appearance', '/admin/appearance', 'Appearance', 'appearance') : ''}
</div></div></aside>`;
  return layout(title, `<div class="admin-layout">${nav}<div class="admin-main">${body}</div></div>`, {
    viewer,
    path,
  });
}

export function adminIndexPage(viewer: Viewer, canTheme: boolean): string {
  const card = (href: string, title: string, blurb: string) =>
    `<a class="card" href="${href}"><b>${esc(title)}</b><span class="muted small">${esc(blurb)}</span></a>`;
  const content = `<h1>Administration</h1>
<div class="card-list">
${card('/admin/users', 'Users', 'Create users, grant push and admin scope, mint tokens.')}
${card('/admin/runners', 'Runners', 'Register the machines that execute workflow jobs.')}
${
  canTheme
    ? card('/admin/appearance', 'Appearance', 'Choose the theme this vault is served with.')
    : ''
}
</div>
${
  canTheme
    ? ''
    : `<p class="muted small">Appearance is a vault-wide setting, so it is limited to administrators whose admin scope covers everything.</p>`
}`;
  return adminShell(viewer, 'index', 'Administration', '/admin', content);
}

export function appearancePage(
  viewer: Viewer,
  themes: Theme[],
  current: string,
  msg?: string
): string {
  const cards = themes
    .map((t) => {
      const v = t.vars;
      const swatch = `<div class="theme-swatch" style="background:${v.bg}">
<div class="bar" style="background:${v.surface};border:1px solid ${v.border}"></div>
<div class="row"><span class="dot" style="background:${v.accent}"></span><span class="dot" style="background:${v.primary}"></span><span class="dot" style="background:${v.tabMarker}"></span><span style="color:${v.fg};font-size:12px;font-family:${v.fontHead}">Aa</span><span style="color:${v.fgMuted};font-size:12px">muted</span></div>
</div>`;
      return `<div class="theme-card${t.name === current ? ' current' : ''}">
<label>
${swatch}
<div class="theme-meta">
<span class="name"><input type="radio" name="theme" value="${esc(t.name)}"${
        t.name === current ? ' checked' : ''
      }> ${esc(t.label)}${t.dark ? ' <span class="counter">dark</span>' : ''}</span>
<p class="muted small">${esc(t.blurb)}</p>
</div>
</label>
</div>`;
    })
    .join('');
  const content = `<div class="page-head"><h1>Appearance</h1></div>
${flashBanner(msg)}
<p class="muted">The theme applies to the whole vault, for every visitor. It is stored in <span class="mono">config.json</span> next to <span class="mono">vault.json</span>, so it can also be set by hand.</p>
<form method="post" action="/admin/appearance">
${csrfField(viewer)}
<div class="theme-grid">${cards}</div>
<button type="submit" class="btn btn-primary">${icon('check')}<span>Save theme</span></button>
</form>`;
  return adminShell(viewer, 'appearance', 'Appearance', '/admin/appearance', content);
}

export function tokenPage(viewer: Viewer, username: string, token: string, created: boolean): string {
  const heading = created ? `Created user ${username}` : `New token for ${username}`;
  const content = `<div class="form-box">
<h1>${esc(heading)}</h1>
<p>Copy the token now; only its SHA-256 hash is stored, so it cannot be shown again.</p>
<div class="cmd-row"><code>${esc(token)}</code>${copyButton()}</div>
<p class="muted small">Use it as the password with username <b>${esc(
    username
  )}</b> when git asks for credentials, or to sign in here.</p>
<p><a class="btn" href="/admin/users">Back to users</a></p>
</div>`;
  return layout(heading, content, { viewer, path: '/admin/users' });
}

export function opErrorPage(message: string, opts: PageOpts & { backUrl?: string } = {}): string {
  const back = opts.backUrl ? `<p><a class="btn" href="${esc(opts.backUrl)}">Go back</a></p>` : '';
  return layout(
    'Error',
    `<div class="form-box"><h1>That did not work</h1><div class="form-error">${esc(message)}</div>${back}</div>`,
    opts
  );
}
