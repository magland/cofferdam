import type { Express } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeFileAtomic } from './atomic';
import { collectionDir } from './layout';
import { displayName, findRepo, isValidName } from './scan';

// Where a renamed thing used to be, in <vault>/redirects.json.
//
// A rename moves directories, so every address anyone already holds stops
// working: a clone's remote, a link in an issue, a bookmark, a workflow that
// fetches a file over HTTP. The alternative to remembering the old address is
// asking everyone who held one to notice and fix it, which for a clone means
// the failure arrives as an authentication prompt or a 404 in the middle of
// someone's day.
//
// So a rename records where it went, and a request for a name nothing answers
// to any more is redirected to wherever that name ended up. This is the
// behaviour GitHub has, and the important half of it is the limit: the
// redirect is consulted only when the old name is free. A repository created
// later under the old name owns it outright, and the redirect for it goes
// quiet from that moment, with nothing to undo and no state to clear. The same
// holds for a collection.
//
// The map is keyed by name and not by any identity a repository carries, which
// is the honest limit of this approach. A repository deleted and re-created
// under the same name is a different repository wearing an answered-for name,
// so deleteRepo drops the entries that point at what it removed rather than
// letting them land somewhere unrelated.

export const REDIRECTS_FILE = 'redirects.json';

export interface RedirectMap {
  /** `<collection>/<repo>` a repository moved away from, to where it is now. */
  repos: Record<string, string>;
  /** A collection's former name, to its current one. */
  collections: Record<string, string>;
}

/**
 * How far a lookup will follow the map before giving up. A name renamed, and
 * then renamed again, is two hops, and a vault where something has been
 * renamed a dozen times in sequence is real; a cycle is not reachable through
 * the recording path, but a hand-edited file can hold one, and this is what
 * keeps that from being a hang.
 */
const MAX_HOPS = 16;

export function redirectsFilePath(root: string): string {
  return path.join(root, REDIRECTS_FILE);
}

function stringMap(raw: unknown, field: string): Record<string, string> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null) throw new Error(`redirects.json: "${field}" must be an object`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new Error(`redirects.json: "${field}.${k}" must be a string`);
    out[k] = v;
  }
  return out;
}

function normalize(parsed: unknown): RedirectMap {
  if (typeof parsed !== 'object' || parsed === null) throw new Error('redirects.json must be a JSON object');
  const raw = parsed as Record<string, unknown>;
  return { repos: stringMap(raw.repos, 'repos'), collections: stringMap(raw.collections, 'collections') };
}

const EMPTY: RedirectMap = { repos: {}, collections: {} };

let cache: { file: string; mtimeMs: number; size: number; map: RedirectMap } | null = null;

/**
 * The map as it is on disk, or an empty one if there is no file yet.
 *
 * Stat-cached like the runner registry and for the same reason: this is read
 * on the way in to every request, and a vault that has never renamed anything
 * should pay one stat for the feature and nothing else.
 */
export function loadRedirects(root: string): RedirectMap {
  const file = redirectsFilePath(root);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    cache = null;
    return EMPTY;
  }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.map;
  let map: RedirectMap;
  try {
    map = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    console.error(`redirects.json could not be read: ${e instanceof Error ? e.message : e}`);
    map = EMPTY;
  }
  cache = { file, mtimeMs: st.mtimeMs, size: st.size, map };
  return map;
}

/** Whether the vault has any redirect at all, which is the fast path's question. */
export function hasRedirects(root: string): boolean {
  const map = loadRedirects(root);
  return Object.keys(map.repos).length > 0 || Object.keys(map.collections).length > 0;
}

function collectionExists(root: string, collection: string): boolean {
  if (!isValidName(collection)) return false;
  try {
    return fs.statSync(collectionDir(root, collection)).isDirectory();
  } catch {
    return false;
  }
}

function splitFull(full: string): { collection: string; repo: string } | null {
  const i = full.indexOf('/');
  if (i <= 0) return null;
  const collection = full.slice(0, i);
  const repo = full.slice(i + 1);
  if (!isValidName(collection) || !isValidName(repo)) return null;
  return { collection, repo };
}

/**
 * Where a repository asked for by an address it no longer has can be found, or
 * null if that address needs no redirect.
 *
 * Null covers two cases deliberately, since neither is a redirect: the name is
 * a repository that exists, and the name leads nowhere. A caller that gets
 * null carries on and answers the request, or 404s it, exactly as it did
 * before this existed.
 *
 * A repository entry is preferred over a collection one at each hop, being the
 * more specific of the two: a repository moved out of a collection that was
 * then renamed should follow the repository.
 */
export function resolveRepoRedirect(
  root: string,
  collection: string,
  repo: string,
  map: RedirectMap = loadRedirects(root)
): { collection: string; repo: string } | null {
  let c = collection;
  let r = repo;
  let moved = false;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (findRepo(root, c, r)) return moved ? { collection: c, repo: r } : null;
    const target = map.repos[`${c}/${r}`];
    if (target !== undefined) {
      const next = splitFull(target);
      if (!next) return null;
      c = next.collection;
      r = next.repo;
      moved = true;
      continue;
    }
    const renamed = map.collections[c];
    if (renamed !== undefined && isValidName(renamed)) {
      c = renamed;
      moved = true;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * The collection a former collection name now points at, or null if that name
 * needs no redirect. As above, null means both "it is there" and "it leads
 * nowhere".
 */
export function resolveCollectionRedirect(
  root: string,
  collection: string,
  map: RedirectMap = loadRedirects(root)
): string | null {
  let c = collection;
  let moved = false;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (collectionExists(root, c)) return moved ? c : null;
    const renamed = map.collections[c];
    if (renamed === undefined || !isValidName(renamed)) return null;
    c = renamed;
    moved = true;
  }
  return null;
}

function write(root: string, map: RedirectMap): void {
  const empty = Object.keys(map.repos).length === 0 && Object.keys(map.collections).length === 0;
  if (empty) {
    // Nothing to remember, so nothing on disk. A vault whose only rename was
    // undone looks like one that never renamed anything, which is what it is.
    fs.rmSync(redirectsFilePath(root), { force: true });
  } else {
    writeFileAtomic(redirectsFilePath(root), JSON.stringify(map, null, 2) + '\n');
  }
  cache = null;
}

/**
 * Drop every entry that no longer redirects anything: one whose own name is a
 * repository or collection that exists again, and one whose chain leads
 * nowhere. Both are entries a lookup already ignores, so this changes no
 * answer; it keeps the file from accumulating a line per rename forever, and
 * keeps it readable as a statement of what is actually being redirected.
 *
 * Run on the way out of every edit, under the lock, since that is the only
 * time the file is written and the map is small enough for the pass to cost
 * nothing worth measuring.
 */
function prune(root: string, map: RedirectMap): void {
  for (const key of Object.keys(map.repos)) {
    const from = splitFull(key);
    if (!from || !resolveRepoRedirect(root, from.collection, from.repo, map)) delete map.repos[key];
  }
  for (const key of Object.keys(map.collections)) {
    if (!resolveCollectionRedirect(root, key, map)) delete map.collections[key];
  }
}

/**
 * Hold the lock across a read, an edit, and the write back, as the runner
 * registry does: two renames at once through two processes would otherwise
 * lose one of the two redirects. The cache is dropped on the way in because
 * the copy about to be edited has to be the one on disk.
 */
function edit(root: string, fn: (map: RedirectMap) => void): void {
  withFileLock(`${redirectsFilePath(root)}.lock`, () => {
    cache = null;
    const current = loadRedirects(root);
    const map: RedirectMap = { repos: { ...current.repos }, collections: { ...current.collections } };
    fn(map);
    prune(root, map);
    write(root, map);
  });
}

/**
 * Remember that a repository moved. Called after the directories have moved,
 * so that a rename which failed halfway leaves no redirect claiming otherwise.
 *
 * An entry for the destination name is dropped: the name now belongs to this
 * repository, so whatever it used to redirect to is not where a request for it
 * should go.
 */
export function recordRepoRename(
  root: string,
  collection: string,
  name: string,
  toCollection: string,
  toName: string
): void {
  edit(root, (map) => {
    delete map.repos[`${toCollection}/${toName}`];
    map.repos[`${collection}/${name}`] = `${toCollection}/${toName}`;
  });
}

/** Remember that a collection was renamed, as above. */
export function recordCollectionRename(root: string, name: string, toName: string): void {
  edit(root, (map) => {
    delete map.collections[toName];
    map.collections[name] = toName;
  });
}

/**
 * Forget a repository that has been deleted: both the redirect out of its own
 * name and every redirect that pointed at it.
 *
 * The second half is the one that matters. Without it, a repository deleted
 * and a new one created under the same name would inherit the old one's
 * redirects, so an address that used to reach the deleted repository would
 * quietly start reaching someone else's.
 */
export function forgetRepoRedirects(root: string, collection: string, name: string): void {
  const full = `${collection}/${name}`;
  const map = loadRedirects(root);
  if (map.repos[full] === undefined && !Object.values(map.repos).includes(full)) return;
  edit(root, (m) => {
    delete m.repos[full];
    for (const [key, target] of Object.entries(m.repos)) {
      if (target === full) delete m.repos[key];
    }
  });
}

/**
 * Forget a collection that has been removed, on the same terms: both the
 * redirect out of its own name and every redirect that led to it, so that a
 * collection created later under that name does not inherit traffic meant for
 * the one that is gone.
 */
export function forgetCollectionRedirects(root: string, name: string): void {
  const map = loadRedirects(root);
  if (map.collections[name] === undefined && !Object.values(map.collections).includes(name)) return;
  edit(root, (m) => {
    delete m.collections[name];
    for (const [key, target] of Object.entries(m.collections)) {
      if (target === name) delete m.collections[key];
    }
  });
}

// ---- serving the redirect ----

function decodeSegment(segment: string): string | null {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * The path a request should be sent to instead, or null if it should be
 * answered where it is.
 *
 * Three shapes of address name a collection or a repository, and all three are
 * rewritten the same way, since a redirect covering only the web pages would
 * leave a clone, an LFS fetch, and a program using the API failing on an
 * address a browser follows happily:
 *
 *   /<collection>[/<repo>][/...]                the web, git over HTTP, LFS
 *   /api/repos/<collection>/<repo>[/...]        the repository API
 *   /api/collections/<collection>[/...]         the collection API
 *
 * The tail of the path is carried across untouched. It names something inside
 * the repository - a branch, a file, an issue number, a git service - and a
 * rename changes none of that.
 */
export function redirectTargetPath(root: string, pathname: string): string | null {
  const segs = pathname.split('/');
  let offset = 1;
  let repoSegment = true;
  if (segs[1] === 'api') {
    if (segs[2] === 'repos') offset = 3;
    else if (segs[2] === 'collections') {
      offset = 3;
      repoSegment = false;
    } else return null;
  }
  const rawCollection = segs[offset];
  if (!rawCollection) return null;
  const collection = decodeSegment(rawCollection);
  if (collection === null || !isValidName(collection)) return null;
  const rawRepo = repoSegment ? segs[offset + 1] : undefined;
  if (rawRepo) {
    const repo = decodeSegment(rawRepo);
    if (repo !== null && isValidName(repo)) {
      // `.git` is optional in a git URL and is kept as the request wrote it, so
      // a clone that follows a redirect keeps asking for the same spelling it
      // started with.
      const base = displayName(repo);
      const suffix = repo === base ? '' : '.git';
      const to = resolveRepoRedirect(root, collection, base);
      if (to) {
        segs[offset] = encodeURIComponent(to.collection);
        segs[offset + 1] = encodeURIComponent(to.repo) + suffix;
        return segs.join('/');
      }
    }
  }
  // No repository answered for it, so the collection may still have moved.
  // Every address under a renamed collection follows it, including one naming
  // a repository that is not in it, which then 404s at the address the
  // collection has now rather than the one it used to have.
  const toCollection = resolveCollectionRedirect(root, collection);
  if (toCollection === null) return null;
  segs[offset] = encodeURIComponent(toCollection);
  return segs.join('/');
}

/**
 * Send a request to where the thing it names now lives.
 *
 * Registered ahead of every route that resolves a collection or a repository,
 * which is safe because a redirect is only ever found for a name nothing
 * answers to: a request for something that is there passes straight through,
 * having cost the stat that found it, and a vault that has never renamed
 * anything costs one stat of a file that is not there.
 *
 * 301 for a GET or a HEAD, and 308 for anything else. The difference is the
 * method: a client following a 301 may turn a POST into a GET, which would
 * turn an API call or a git push into a request for a page, while a 308 keeps
 * the method and the body. Both say the move is permanent, which is what has
 * git record the new address rather than following a redirect on every fetch.
 *
 * Permanent, but not cacheable. A redirect here is conditional on the old name
 * being free, so a browser holding a 301 for a year would keep following it
 * past the day someone creates a repository under that name, which is the one
 * case where the redirect has to stop. no-store costs a round trip that the
 * rename made necessary anyway.
 */
export function registerRedirects(app: Express, root: string): void {
  app.use((req, res, next) => {
    if (!hasRedirects(root)) return next();
    const to = redirectTargetPath(root, req.path);
    if (to === null) return next();
    const q = req.originalUrl.indexOf('?');
    const query = q === -1 ? '' : req.originalUrl.slice(q);
    const permanent = req.method === 'GET' || req.method === 'HEAD' ? 301 : 308;
    res.set('Cache-Control', 'no-store').redirect(permanent, to + query);
  });
}
