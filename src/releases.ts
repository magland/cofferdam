import { Express, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { atomFeed } from './atom';
import { writeFileAtomic } from './atomic';
import { RefInfo, isValidRefName } from './git';
import { icon } from './icons';
import { renderMarkdown } from './markdown';
import { esc, timeTag } from './render';
import { Viewer, checkCsrf, getViewer } from './session';
import { isValidName } from './scan';
import { RepoCtx, csrfField, encPath, layout, repoHeader, repoOpts, repoUrl } from './views';
import { ah, baseUrlOf, fail, field, loadRepo, makeCtx, send404, urlencodedForm, wildcard } from './web';

// Releases: notes attached to a tag.
//
// A tag says which commit; a release says what it was for. GitHub keeps the
// two apart for that reason, and the notes are what people actually read when
// deciding whether to take a new version.
//
// State lives in the vault, in a sibling directory beside the repository, the
// way sites and workflow runs do: <repo>.releases/<tag>.md, YAML frontmatter
// and markdown notes. One file per release, which is the whole record: a
// release has no comments and no history of its own, so nothing here needs a
// directory. The tag is percent-encoded into the filename, since a tag may
// contain a slash and a release is still one file.
//
// The downloads on a release are the archive routes (browse.ts): the source at
// that tag, built on demand by git. Nothing is uploaded and nothing is stored
// twice.

export interface Release {
  tag: string;
  /** The title. Empty means the tag names itself. */
  name: string;
  author: string;
  created: string;
  prerelease: boolean;
  body: string;
}

const MAX_NAME = 200;
const MAX_NOTES = 64 * 1024;

export function releasesDir(root: string, collection: string, repo: string): string {
  return path.join(root, collection, `${repo}.releases`);
}

function fileFor(dir: string, tag: string): string {
  // encodeURIComponent leaves no slash and no dot-dot, so the name cannot
  // climb out of the directory however the tag was written.
  return path.join(dir, `${encodeURIComponent(tag)}.md`);
}

function parseRelease(text: string, tag: string): Release {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  let head: Record<string, unknown> = {};
  let body = text;
  if (m) {
    try {
      head = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>;
    } catch {
      head = {};
    }
    body = m[2];
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    tag: str(head.tag) || tag,
    name: str(head.name),
    author: str(head.author),
    created: str(head.created),
    prerelease: head.prerelease === true,
    body,
  };
}

export function readRelease(root: string, collection: string, repo: string, tag: string): Release | null {
  if (!isValidName(collection) || !isValidName(repo) || !isValidRefName(tag)) return null;
  try {
    const text = fs.readFileSync(fileFor(releasesDir(root, collection, repo), tag), 'utf8');
    return parseRelease(text, tag);
  } catch {
    return null;
  }
}

/** Every release in the vault for this repository, newest first by tag date. */
export function listReleases(root: string, collection: string, repo: string): Release[] {
  const dir = releasesDir(root, collection, repo);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Release[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    let tag: string;
    try {
      tag = decodeURIComponent(name.slice(0, -3));
    } catch {
      continue;
    }
    const release = readRelease(root, collection, repo, tag);
    if (release) out.push(release);
  }
  return out;
}

/**
 * The tag of every release, from the directory alone.
 *
 * A release's file is named for its tag, so counting releases and asking
 * whether a tag has one needs no file opened and no front matter parsed --
 * which is all that a repository page wants, and it wants it on every page.
 * listReleases reads and YAML-parses every release to answer the same two
 * questions, which at a hundred releases is 19ms and a hundred opens spent on
 * bodies nobody looks at.
 */
export function releaseTags(root: string, collection: string, repo: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(releasesDir(root, collection, repo));
  } catch {
    return [];
  }
  const tags: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    try {
      tags.push(decodeURIComponent(name.slice(0, -3)));
    } catch {
      // A name that is not a tag this forge wrote; listReleases skips it too.
    }
  }
  return tags;
}

export function saveRelease(root: string, collection: string, repo: string, release: Release): void {
  const dir = releasesDir(root, collection, repo);
  fs.mkdirSync(dir, { recursive: true });
  const head = YAML.stringify({
    tag: release.tag,
    name: release.name,
    author: release.author,
    created: release.created,
    prerelease: release.prerelease,
  }).trimEnd();
  writeFileAtomic(fileFor(dir, release.tag), `---\n${head}\n---\n${release.body}\n`);
}

export function deleteRelease(root: string, collection: string, repo: string, tag: string): boolean {
  if (!isValidRefName(tag)) return false;
  try {
    fs.unlinkSync(fileFor(releasesDir(root, collection, repo), tag));
    return true;
  } catch {
    return false;
  }
}

export function hasReleases(root: string, collection: string, repo: string): boolean {
  try {
    return fs.readdirSync(releasesDir(root, collection, repo)).some((n) => n.endsWith('.md'));
  } catch {
    return false;
  }
}

// ---- pages ----

function releaseTitle(release: Release): string {
  return release.name || release.tag;
}

/** The download links: the source at that tag, from the archive routes. */
function downloads(ctx: RepoCtx, tag: string): string {
  const base = `${repoUrl(ctx)}/archive/${encPath(tag)}`;
  const one = (ext: string, label: string) =>
    `<a class="release-download" href="${base}.${ext}">${icon('file-zip')}<span>${label}</span></a>`;
  return `<div class="release-downloads">${one('zip', 'Source code (zip)')}${one(
    'tar.gz',
    'Source code (tar.gz)'
  )}</div>`;
}

function releaseCard(ctx: RepoCtx, release: Release, ref: RefInfo | undefined, latest: boolean, notes: string): string {
  const base = repoUrl(ctx);
  const chips = [
    latest ? '<span class="chip chip-latest">Latest</span>' : '',
    release.prerelease ? '<span class="chip chip-pre">Pre-release</span>' : '',
  ].join('');
  const edit = ctx.canPush
    ? `<a class="btn" href="${base}/releases/new?tag=${encodeURIComponent(release.tag)}">${icon(
        'pencil'
      )}<span>Edit</span></a>`
    : '';
  return `<div class="release">
  <div class="release-side">
    <a class="release-tag" href="${base}/tree/${encPath(release.tag)}">${icon('tag')}<b>${esc(release.tag)}</b></a>
    ${ref ? `<div class="small muted">${timeTag(ref.date)}</div>` : ''}
    ${ref ? `<a class="sha" href="${base}/commit/${ref.sha}">${ref.sha.slice(0, 7)}</a>` : ''}
  </div>
  <div class="release-main">
    <div class="release-head"><h2><a href="${base}/releases/tag/${encPath(release.tag)}">${esc(
      releaseTitle(release)
    )}</a></h2>${chips}<span class="release-actions">${edit}</span></div>
    <div class="muted small">${release.author ? `${esc(release.author)} released this` : 'Released'} ${
      release.created ? timeTag(release.created) : ''
    }</div>
    ${notes ? `<div class="markdown-body release-notes">${notes}</div>` : '<p class="muted">No notes.</p>'}
    ${downloads(ctx, release.tag)}
  </div>
</div>`;
}

function releasesPage(
  ctx: RepoCtx,
  cards: string,
  count: number
): string {
  const base = repoUrl(ctx);
  const newBtn = ctx.canPush
    ? `<a class="btn btn-primary" href="${base}/releases/new">${icon('plus')}<span>Draft a release</span></a>`
    : '';
  const feed = `<a class="btn" href="${base}/releases.atom" title="Atom feed of releases">${icon('rss')}<span>Feed</span></a>`;
  const body =
    count === 0
      ? `<div class="empty-state"><p>No releases yet.</p><p class="small">A release is notes attached to a tag. ${
          ctx.canPush ? 'Draft one above,' : 'Someone with push access can draft one,'
        } or browse the <a href="${base}/tags">tags</a>.</p></div>`
      : cards;
  const content = `${repoHeader(ctx, 'tags')}
<div class="page-head"><h1>Releases</h1><span class="right-group">${feed}${newBtn}</span></div>
${body}`;
  return layout(`Releases - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, `${base}/releases`));
}

function releaseFormPage(
  ctx: RepoCtx,
  viewer: Viewer,
  tags: RefInfo[],
  editing: Release | null,
  error?: string
): string {
  const base = repoUrl(ctx);
  const options = tags
    .map(
      (t) => `<option value="${esc(t.name)}"${editing && t.name === editing.tag ? ' selected' : ''}>${esc(t.name)}</option>`
    )
    .join('');
  const del =
    editing && ctx.canPush
      ? `<form method="post" action="${base}/releases/delete" onsubmit="return confirm('Delete the notes for ${esc(
          editing.tag
        )}? The tag itself is not touched.')">${csrfField(viewer)}<input type="hidden" name="tag" value="${esc(
          editing.tag
        )}"><button type="submit" class="btn btn-danger-outline">${icon('trash')}<span>Delete release</span></button></form>`
      : '';
  const content = `${repoHeader(ctx, 'tags')}
<div class="form-box wide">
<h1>${editing ? 'Edit release' : 'Draft a release'}</h1>
${error ? `<div class="form-error">${esc(error)}</div>` : ''}
<form method="post" action="${base}/releases/new">
${csrfField(viewer)}
<div class="field"><label for="tag">Tag</label>
${
  editing
    ? `<input type="hidden" name="tag" value="${esc(editing.tag)}"><p class="mono">${esc(editing.tag)}</p>`
    : `<select id="tag" name="tag" required>${options}</select>
<p class="muted small">Releases attach to a tag that already exists. Create one on the <a href="${base}/tags">tags page</a> first.</p>`
}
</div>
<div class="field"><label for="name">Title</label>
<input type="text" id="name" name="name" maxlength="${MAX_NAME}" value="${esc(editing?.name ?? '')}" placeholder="Leave empty to use the tag name"></div>
<div class="field"><label for="body">Notes</label>
<textarea class="code-editor" id="body" name="body" rows="16" placeholder="What changed, and what it means for anyone upgrading. Markdown.">${esc(
    editing?.body ?? ''
  )}</textarea></div>
<div class="field"><label class="checkbox"><input type="checkbox" name="prerelease" value="1"${
    editing?.prerelease ? ' checked' : ''
  }> This is a pre-release</label></div>
<div class="actions"><button type="submit" class="btn btn-primary">${
    editing ? 'Save release' : 'Publish release'
  }</button><a class="btn" href="${base}/releases">Cancel</a>${del}</div>
</form>
</div>`;
  return layout(
    `${editing ? 'Edit' : 'Draft'} release - ${ctx.collection}/${ctx.repo}`,
    content,
    repoOpts(ctx, `${base}/releases/new`)
  );
}

// ---- routes ----

export function registerReleases(app: Express, root: string): void {
  // Release notes are prose about a version, not a place to paste an artifact,
  // so this form is held to a much smaller body than the file editor's.
  const form = urlencodedForm('256kb');

  // Writing a release is a write to the vault, so it needs the same session,
  // CSRF check, and push scope over the repository that editing a file does.
  function requirePusher(req: Request, res: Response, ctx: RepoCtx, viewer: Viewer | null): viewer is Viewer {
    if (!viewer) {
      fail(res, 403, 'You must be signed in to do that.', null, '/login');
      return false;
    }
    if (!checkCsrf(req, viewer)) {
      fail(res, 403, 'The form has expired; go back, reload the page, and try again.', viewer);
      return false;
    }
    if (!ctx.canPush) {
      fail(res, 403, `You do not have push access to ${ctx.collection}/${ctx.repo}.`, viewer, repoUrl(ctx));
      return false;
    }
    return true;
  }

  /** Releases with the tag each one points at, newest tag first. */
  function ordered(root: string, ctx: RepoCtx): { release: Release; ref: RefInfo | undefined }[] {
    const byName = new Map(ctx.tags.map((t) => [t.name, t]));
    return listReleases(root, ctx.collection, ctx.repo)
      .map((release) => ({ release, ref: byName.get(release.tag) }))
      .sort((a, b) => {
        const at = a.ref?.date ?? a.release.created;
        const bt = b.ref?.date ?? b.release.created;
        return bt.localeCompare(at);
      });
  }

  app.get(
    '/:collection/:repo/releases',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      const rows = ordered(root, ctx);
      const cards = rows
        .map(({ release, ref }, i) =>
          releaseCard(ctx, release, ref, i === 0 && !release.prerelease, notesHtml(ctx, release))
        )
        .join('');
      res.type('html').send(releasesPage(ctx, cards, rows.length));
    })
  );

  app.get(
    '/:collection/:repo/releases.atom',
    ah(async (req, res) => {
      const loaded = await loadRepo(root, req, res, null);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', null);
      const base = `${baseUrlOf(req)}${repoUrl(ctx)}`;
      const rows = ordered(root, ctx);
      res
        .type('application/atom+xml; charset=utf-8')
        .send(
          atomFeed({
            id: `${base}/releases`,
            title: `${ctx.collection}/${ctx.repo} releases`,
            selfLink: `${base}/releases.atom`,
            htmlLink: `${base}/releases`,
            entries: rows.map(({ release, ref }) => ({
              id: `${base}/releases/tag/${encPath(release.tag)}`,
              title: releaseTitle(release),
              updated: ref?.date || release.created,
              link: `${base}/releases/tag/${encPath(release.tag)}`,
              author: release.author || ctx.collection,
              summary: release.body,
            })),
          })
        );
    })
  );

  app.get(
    '/:collection/:repo/releases/new',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      if (!viewer) {
        res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
        return;
      }
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      if (!ctx.canPush) {
        fail(res, 403, `You do not have push access to ${ctx.collection}/${ctx.repo}.`, viewer, repoUrl(ctx));
        return;
      }
      const asked = String(req.query.tag ?? '');
      const editing = asked ? readRelease(root, ctx.collection, ctx.repo, asked) : null;
      if (asked && !editing && !ctx.tags.some((t) => t.name === asked)) {
        send404(res, `Tag ${asked} not found`, viewer);
        return;
      }
      // A tag that already has notes is edited rather than drafted twice.
      const draft: Release | null =
        editing ??
        (asked
          ? { tag: asked, name: '', author: viewer.auth.username, created: '', prerelease: false, body: '' }
          : null);
      res.type('html').send(releaseFormPage(ctx, viewer, ctx.tags, draft));
    })
  );

  app.post(
    '/:collection/:repo/releases/new',
    form,
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      if (!requirePusher(req, res, ctx, viewer)) return;
      const tag = field(req, 'tag');
      if (!isValidRefName(tag) || !ctx.tags.some((t) => t.name === tag)) {
        fail(res, 400, `There is no tag named ${tag} in this repository.`, viewer, `${repoUrl(ctx)}/releases`);
        return;
      }
      const existing = readRelease(root, ctx.collection, ctx.repo, tag);
      const body = field(req, 'body').replace(/\r\n/g, '\n').slice(0, MAX_NOTES);
      saveRelease(root, ctx.collection, ctx.repo, {
        tag,
        name: field(req, 'name').slice(0, MAX_NAME).trim(),
        // The first publisher keeps the byline; an edit does not steal it.
        author: existing?.author || viewer.auth.username,
        created: existing?.created || new Date().toISOString(),
        prerelease: field(req, 'prerelease') === '1',
        body,
      });
      res.redirect(`${repoUrl(ctx)}/releases/tag/${encPath(tag)}`);
    })
  );

  app.post(
    '/:collection/:repo/releases/delete',
    form,
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      if (!requirePusher(req, res, ctx, viewer)) return;
      deleteRelease(root, ctx.collection, ctx.repo, field(req, 'tag'));
      res.redirect(`${repoUrl(ctx)}/releases`);
    })
  );

  app.get(
    '/:collection/:repo/releases/tag/*',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const tag = wildcard(req);
      const ctx = await makeCtx(root, req, loaded, tag, viewer);
      const release = readRelease(root, ctx.collection, ctx.repo, tag);
      if (!release) {
        send404(res, `No release for ${tag}`, viewer);
        return;
      }
      const ref = ctx.tags.find((t) => t.name === tag);
      const rows = ordered(root, ctx);
      const latest = rows.length > 0 && rows[0].release.tag === tag && !release.prerelease;
      const content = `${repoHeader(ctx, 'tags')}
<div class="page-head"><h1><a href="${repoUrl(ctx)}/releases">Releases</a></h1></div>
${releaseCard(ctx, release, ref, latest, notesHtml(ctx, release))}`;
      res
        .type('html')
        .send(
          layout(
            `${releaseTitle(release)} - ${ctx.collection}/${ctx.repo}`,
            content,
            repoOpts(ctx, `${repoUrl(ctx)}/releases/tag/${encPath(tag)}`)
          )
        );
    })
  );

  /** Notes are markdown from a repository writer, rendered by the same sanitizing path as a README. */
  function notesHtml(ctx: RepoCtx, release: Release): string {
    if (release.body.trim() === '') return '';
    const base = repoUrl(ctx);
    return renderMarkdown(release.body, {
      rawBase: `${base}/raw/${encPath(release.tag)}`,
      blobBase: `${base}/blob/${encPath(release.tag)}`,
      issueBase: `${base}/issues`,
      commitBase: `${base}/commit`,
    });
  }
}
