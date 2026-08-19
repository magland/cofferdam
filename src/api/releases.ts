import { Express } from 'express';
import { isValidRefName } from '../git';
import { AuthLimiter } from '../limit';
import { deleteRelease, listReleases, readRelease, saveRelease } from '../releases';
import { apiError, bodyOf, requireRepo, requirePush, stringField } from './auth';

// Releases: notes attached to a tag.
//
// A release's downloads are the archive routes, so there is nothing to upload and
// no asset endpoints. Anyone who knows `gh release upload` will look for one, and
// docs/agents.md says plainly that it is not here.

export function registerReleaseApi(app: Express, root: string, limiter: AuthLimiter): void {
  app.get('/api/repos/:collection/:repo/releases', (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    res.json({ releases: listReleases(root, found.repo.collection, found.repo.name) });
  });

  app.get('/api/repos/:collection/:repo/releases/:tag', (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const tag = decodeURIComponent(req.params.tag);
    const release = readRelease(root, found.repo.collection, found.repo.name, tag);
    if (!release) {
      apiError(res, 404, `no release for tag ${tag}`);
      return;
    }
    res.json(release);
  });

  // PUT rather than POST, because a release is keyed by its tag and the file is
  // one saveRelease either way. Creating and editing being the same call takes a
  // whole class of "already exists, retry as an edit" logic out of the caller.
  app.put('/api/repos/:collection/:repo/releases/:tag', async (req, res) => {
    const ctx = requirePush(root, limiter, req, res);
    if (!ctx) return;
    const tag = decodeURIComponent(req.params.tag);
    if (!isValidRefName(tag)) {
      apiError(res, 400, 'that is not a usable tag name');
      return;
    }
    // The tag has to exist in the repository, which is what the web form checks:
    // release notes for a tag nobody can check out are notes about nothing.
    const tags = await ctx.repo.listRefs('tags');
    if (!tags.some((t) => t.name === tag)) {
      apiError(res, 404, `no tag ${tag} in this repository; create the tag first`);
      return;
    }
    const body = bodyOf(req);
    const existing = readRelease(root, ctx.repo.collection, ctx.repo.name, tag);
    const prerelease = body.prerelease;
    if (prerelease !== undefined && typeof prerelease !== 'boolean') {
      apiError(res, 400, '"prerelease" must be true or false');
      return;
    }
    const release = {
      tag,
      name: stringField(body, 'name') ?? existing?.name ?? '',
      // The author is whoever first published it, so an edit by someone else
      // does not quietly reassign it.
      author: existing?.author ?? ctx.actor.username,
      created: existing?.created ?? new Date().toISOString(),
      prerelease: prerelease ?? existing?.prerelease ?? false,
      body: stringField(body, 'body') ?? existing?.body ?? '',
    };
    saveRelease(root, ctx.repo.collection, ctx.repo.name, release);
    res.status(existing ? 200 : 201).json(release);
  });

  app.delete('/api/repos/:collection/:repo/releases/:tag', (req, res) => {
    const ctx = requirePush(root, limiter, req, res);
    if (!ctx) return;
    const tag = decodeURIComponent(req.params.tag);
    if (!deleteRelease(root, ctx.repo.collection, ctx.repo.name, tag)) {
      apiError(res, 404, `no release for tag ${tag}`);
      return;
    }
    // The tag itself is left alone: deleting release notes is not deleting a
    // release's history, and the two are separate operations on purpose.
    res.json({ deleted: tag, tagKept: true });
  });
}
