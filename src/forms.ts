import { esc } from './render';
import { Viewer } from './session';
import { UserRecord } from './vault';
import { PageOpts, RepoCtx, csrfField, encPath, layout, repoHeader, repoOpts, repoUrl } from './views';

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
  const content = `<div class="form-box">
<h1>Sign in</h1>
${errorBanner(error)}
<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(next)}">
<div class="field"><label for="username">Username</label><input type="text" id="username" name="username" autocomplete="username" autofocus required></div>
<div class="field"><label for="token">Token</label><input type="password" id="token" name="token" autocomplete="current-password" required>
<p class="muted small">The same token git uses for pushing. Tokens are minted by an administrator; there are no passwords.</p></div>
<button type="submit" class="btn btn-primary">Sign in</button>
</form>
</div>`;
  return layout('Sign in', content, { path: '/login' });
}

export function newRepoPage(
  viewer: Viewer,
  orgNames: string[],
  preset: { org?: string; name?: string; description?: string },
  error?: string
): string {
  const datalist = orgNames.map((o) => `<option value="${esc(o)}">`).join('');
  const content = `<div class="form-box">
<h1>New repository</h1>
${errorBanner(error)}
<form method="post" action="/new">
${csrfField(viewer)}
<div class="field"><label for="org">Organization</label><input type="text" id="org" name="org" list="orgs" value="${esc(
    preset.org ?? ''
  )}" required><datalist id="orgs">${datalist}</datalist>
<p class="muted small">An existing organization, or a new one to create with the repository.</p></div>
<div class="field"><label for="name">Repository name</label><input type="text" id="name" name="name" value="${esc(
    preset.name ?? ''
  )}" required></div>
<div class="field"><label for="description">Description <span class="muted">(optional)</span></label><input type="text" id="description" name="description" value="${esc(
    preset.description ?? ''
  )}"></div>
<div class="field"><label class="checkbox"><input type="checkbox" name="init" value="1" checked> Initialize with a README</label></div>
<button type="submit" class="btn btn-primary">Create repository</button>
</form>
</div>`;
  return layout('New repository', content, { viewer, path: '/new' });
}

function commitFields(viewer: Viewer, expectedHead: string | null, messagePlaceholder: string): string {
  return `${csrfField(viewer)}
<input type="hidden" name="expected" value="${esc(expectedHead ?? '')}">
<div class="field"><label for="message">Commit message</label><input type="text" id="message" name="message" placeholder="${esc(
    messagePlaceholder
  )}"></div>`;
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
<textarea class="code-editor" name="content" rows="${rows}" spellcheck="false">${esc(content)}</textarea>
<div class="commit-box">
${commitFields(ctx.viewer!, expectedHead, `Update ${filePath.split('/').pop()}`)}
<div class="actions"><button type="submit" class="btn btn-primary">Commit changes</button><a class="btn" href="${cancel}">Cancel</a></div>
</div>
</form>`;
  return layout(`Editing ${filePath} - ${ctx.org}/${ctx.repo}`, body, repoOpts(ctx));
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
${commitFields(ctx.viewer!, expectedHead, 'Create new file')}
<div class="actions"><button type="submit" class="btn btn-primary">Commit new file</button><a class="btn" href="${cancel}">Cancel</a></div>
</div>
</form>`;
  return layout(`New file - ${ctx.org}/${ctx.repo}`, body, repoOpts(ctx));
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
  return layout(`Delete ${filePath} - ${ctx.org}/${ctx.repo}`, body, repoOpts(ctx));
}

export function conflictPage(ctx: RepoCtx, branch: string, retryUrl: string): string {
  const body = `${repoHeader(ctx, 'code')}
<div class="form-box">
<h2>The branch has moved</h2>
<p>Someone updated <b>${esc(branch)}</b> while you were editing, so your change was not committed; committing it now could silently undo theirs.</p>
<p><a class="btn btn-primary" href="${esc(retryUrl)}">Reload and try again</a></p>
</div>`;
  return layout(`Conflict - ${ctx.org}/${ctx.repo}`, body, repoOpts(ctx));
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
    ? `<div class="form-box">
<form method="post" action="${base}/settings">
${csrfField(ctx.viewer!)}
<div class="field"><label for="description">Description</label><input type="text" id="description" name="description" value="${esc(
        description
      )}"></div>
${defaultBranchField}
<button type="submit" class="btn btn-primary">Save</button>
</form>
</div>`
    : '';
  const dangerZone = ctx.canAdmin
    ? `<div class="danger-zone">
<h3>Danger zone</h3>
<p>Deleting a repository removes its directory${ctx.hasPages ? ' and its pages site' : ''} from the vault permanently. There is no undo.</p>
<form method="post" action="${base}/settings/delete">
${csrfField(ctx.viewer!)}
<div class="field"><label for="confirm">Type <b class="mono">${esc(ctx.org)}/${esc(ctx.repo)}</b> to confirm</label><input type="text" id="confirm" name="confirm" autocomplete="off"></div>
<button type="submit" class="btn btn-danger">Delete this repository</button>
</form>
</div>`
    : '';
  const body = `${repoHeader(ctx, 'settings')}
<h2>Settings</h2>
${flashBanner(msg)}
${errorBanner(error)}
${settingsForm}
${dangerZone}`;
  return layout(`Settings - ${ctx.org}/${ctx.repo}`, body, repoOpts(ctx, `${base}/settings`));
}

export function adminUsersPage(
  viewer: Viewer,
  users: { name: string; user: UserRecord }[],
  msg?: string,
  error?: string
): string {
  const rows = users
    .map(({ name, user }) => {
      const actions = `<details><summary>Manage</summary><div class="user-actions">
<form method="post" action="/admin/users/${encodeURIComponent(name)}/grant" class="inline-form">
${csrfField(viewer)}
<input type="text" name="scope" placeholder="push globs, e.g. myorg/*">
<input type="text" name="admin" placeholder="admin globs">
<button type="submit" class="btn">Grant</button>
</form>
<form method="post" action="/admin/users/${encodeURIComponent(name)}/token" class="inline-form">
${csrfField(viewer)}
<input type="text" name="tokenScope" placeholder="token scope (optional)">
<button type="submit" class="btn">Mint token</button>
</form>
</div></details>`;
      return `<tr><td><b>${esc(name)}</b></td><td class="mono small">${esc(user.scope.join(' ') || '(none)')}</td><td class="mono small">${esc(
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
<div class="field"><label for="scope">Push scope globs</label><input type="text" id="scope" name="scope" value="*" placeholder="e.g. myorg/*">
<p class="muted small">Space-separated globs over <span class="mono">org/repo</span>. <span class="mono">*</span> matches everything.</p></div>
<div class="field"><label for="admin">Admin scope globs <span class="muted">(optional)</span></label><input type="text" id="admin" name="admin" placeholder="e.g. myorg/*"></div>
<button type="submit" class="btn btn-primary">Create user and mint token</button>
</form>
<p class="muted small">Your admin scope must cover every glob you assign. The new token is shown once on the next page.</p>
</div>`;
  return layout('Users', content, { viewer, path: '/admin/users' });
}

export function tokenPage(viewer: Viewer, username: string, token: string, created: boolean): string {
  const heading = created ? `Created user ${username}` : `New token for ${username}`;
  const content = `<div class="form-box">
<h1>${esc(heading)}</h1>
<p>Copy the token now; only its SHA-256 hash is stored, so it cannot be shown again.</p>
<div class="cmd-row"><code>${esc(token)}</code><button class="copy-btn" type="button" onclick="copyCmd(this)">Copy</button></div>
<p class="muted small">Use it as the password with username <b>${esc(
    username
  )}</b> when git asks for credentials, or to sign in here.</p>
<p><a class="btn" href="/admin/users">Back to users</a></p>
</div>`;
  return layout(heading, content, { viewer, path: '/admin/users' });
}

export function opErrorPage(
  status: number,
  message: string,
  opts: PageOpts & { backUrl?: string } = {}
): string {
  const back = opts.backUrl ? `<p><a class="btn" href="${esc(opts.backUrl)}">Go back</a></p>` : '';
  return layout(
    'Error',
    `<div class="form-box"><h1>That did not work</h1><div class="form-error">${esc(message)}</div>${back}</div>`,
    opts
  );
}
