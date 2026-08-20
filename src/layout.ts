import * as path from 'path';

/**
 * Where a vault keeps the things a user named.
 *
 * Collections do not sit directly in the vault directory, and repositories do
 * not sit directly in a collection's: each is held one level down, in a fixed
 * directory. The reason is the same at both levels. A vault has files of its
 * own (vault.json, config.json, .secret, runners.json) and will have more of
 * them, and a collection will want its own metadata too; with user-chosen
 * names in the same directory, every such file is a name a collection or a
 * repository may then never be called, and adding one later takes a name away
 * from vaults that already exist. Holding the named things apart keeps the two
 * namespaces from ever meeting, so `collections/` may gain neighbours and a
 * collection may gain files without any of it constraining what a user may
 * name a thing.
 *
 * ```
 * <vault>/
 *   vault.json
 *   config.json
 *   .secret
 *   runners.json
 *   collections/
 *     alice/
 *       repos/
 *         webapp.git/
 *         webapp.issues/
 *         ...
 * ```
 *
 * Every path into a vault is built here rather than joined at its use, so the
 * layout is one file's business. A vault written under the older layout, with
 * collections directly in the root, is moved to this one on startup; see
 * src/migrate.ts.
 */
export const COLLECTIONS_DIR = 'collections';
export const REPOS_DIR = 'repos';

/** The directory holding every collection in the vault. */
export function collectionsDir(root: string): string {
  return path.join(root, COLLECTIONS_DIR);
}

/** One collection's directory, whether or not it exists. */
export function collectionDir(root: string, collection: string): string {
  return path.join(root, COLLECTIONS_DIR, collection);
}

/**
 * Where a collection's repositories live, along with the directories each one
 * keeps beside it (`<repo>.issues`, `<repo>.site`, and the rest).
 */
export function reposDir(root: string, collection: string): string {
  return path.join(root, COLLECTIONS_DIR, collection, REPOS_DIR);
}

/**
 * A named directory inside a collection's repos directory: a bare repository,
 * or one of the directories a repository keeps beside it. The name is used as
 * given, so callers pass `webapp.git` or `webapp.issues` rather than `webapp`.
 */
export function repoPath(root: string, collection: string, dirName: string): string {
  return path.join(root, COLLECTIONS_DIR, collection, REPOS_DIR, dirName);
}
