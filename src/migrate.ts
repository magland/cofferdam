import * as fs from 'fs';
import * as path from 'path';
import { COLLECTIONS_DIR, REPOS_DIR, collectionsDir } from './layout';
import { isBareRepo, isValidName, repoSiblingSuffixes } from './scan';

/**
 * Moving a vault from the older layout, where collections sat directly in the
 * vault directory and repositories directly in a collection, to the current
 * one, where both sit one level down (see src/layout.ts).
 *
 * This runs on startup, before anything is served, and is renames only: no
 * file is read, written, or copied, so the cost does not depend on how large
 * the repositories are, and a vault on a full disk migrates as well as one on
 * an empty disk. The server refuses to serve a vault it could not migrate,
 * rather than serving what would look like an empty vault.
 */

/** Where a collection is parked while its own contents are being rearranged. */
const STAGING_DIR = '.collections-migrating';

export interface Migration {
  /** The collections moved, in the order they were moved. */
  collections: string[];
}

/**
 * Whether a directory is a collection under the old layout: it holds a bare
 * repository, or one of the directories a repository keeps beside it. An empty
 * collection matches neither, and is decided by its company - see oldCollections.
 */
function looksLikeOldCollection(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => {
    if (!e.isDirectory()) return false;
    const lower = e.name.toLowerCase();
    if (repoSiblingSuffixes.some((s) => lower.endsWith(s)) || lower.endsWith('.lfs')) return true;
    return isBareRepo(path.join(dir, e.name));
  });
}

/**
 * Whether a `collections` directory in the vault root is this layout's
 * container rather than a collection that happens to be named that. It is the
 * container when it is empty, or when something in it has a `repos` directory,
 * which is the shape only the current layout produces.
 */
function isCollectionsContainer(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.length === 0) return true;
  return entries.some((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, REPOS_DIR)));
}

/**
 * The collections to move, or an empty list if the vault is already laid out
 * the current way.
 *
 * A directory in the vault root is a collection to move when it holds
 * something a repository would put there. An empty directory holds nothing to
 * judge by, so it is taken as a collection only when some other directory
 * proves the vault is on the old layout; in a vault already migrated, an empty
 * stray directory is left where it is rather than being adopted as a
 * collection nobody made.
 *
 * `collections` is the one ambiguous name, since a vault on the old layout may
 * have a collection called that. Asked of it is the narrower question above:
 * a `collections` directory holding this layout is the container and is left
 * alone, and one holding repositories is an ordinary collection and is moved,
 * ending up at `collections/collections`.
 */
function oldCollections(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && isValidName(e.name))
    .map((e) => e.name)
    .filter((name) => name !== COLLECTIONS_DIR || !isCollectionsContainer(path.join(root, name)))
    .sort();
  const definite = candidates.filter((name) => looksLikeOldCollection(path.join(root, name)));
  if (definite.length === 0) return [];
  return candidates;
}

/** Move everything in a collection's directory into its `repos` subdirectory. */
function nestRepos(dir: string): void {
  const repos = path.join(dir, REPOS_DIR);
  const entries = fs.readdirSync(dir);
  // Already nested, by an earlier run that was interrupted after this
  // collection and before the last step. A collection may hold a repository
  // named `repos`, so this asks what the directory is rather than assuming
  // from its name: a bare repository there is a repository to move, not a
  // collection already done.
  if (entries.length === 1 && entries[0] === REPOS_DIR && !isBareRepo(repos)) return;
  // Everything moves into a directory under a temporary name, which is renamed
  // into place at the end. A collection is therefore never left holding a
  // half-filled repos directory beside the repositories still to go, and a
  // repository that is itself called `repos` moves like any other.
  //
  // A scratch directory from an interrupted run is filled the rest of the way
  // rather than cleared: what is in it are repositories that were moved and
  // not yet renamed into place, and nothing in this file deletes those.
  const scratchName = `.${REPOS_DIR}-incoming`;
  const scratch = path.join(dir, scratchName);
  if (!fs.existsSync(scratch)) fs.mkdirSync(scratch);
  for (const name of entries) {
    if (name === scratchName) continue;
    fs.renameSync(path.join(dir, name), path.join(scratch, name));
  }
  fs.renameSync(scratch, repos);
}

/** Move each entry of `from` into `to`, refusing rather than overwriting. */
function drain(from: string, to: string): string[] {
  const moved: string[] = [];
  for (const name of fs.readdirSync(from).sort()) {
    const dest = path.join(to, name);
    if (fs.existsSync(dest)) {
      throw new Error(
        `cannot move ${name} into ${COLLECTIONS_DIR}/: a collection of that name is already there`
      );
    }
    fs.renameSync(path.join(from, name), dest);
    moved.push(name);
  }
  return moved;
}

/**
 * Bring a vault up to the current layout, returning what was moved, or null if
 * there was nothing to move. Safe to call on every start: a vault already laid
 * out this way is read once and left alone.
 *
 * The order is what makes an interrupted run recoverable. Each collection is
 * moved into a staging directory and rearranged there, so a collection is
 * either where it was or finished, never half-nested in place; the staging
 * directory then becomes `collections/` in a single rename, or is drained into
 * it if one already exists. A run interrupted before that last step leaves the
 * staging directory behind, and the next start finds it and finishes.
 */
export function migrateLayout(root: string): Migration | null {
  const staging = path.join(root, STAGING_DIR);
  const collections = collectionsDir(root);
  const stale = fs.existsSync(staging);
  const names = oldCollections(root);
  if (names.length === 0 && !stale) return null;

  try {
    if (!stale) fs.mkdirSync(staging);
    for (const name of names) {
      fs.renameSync(path.join(root, name), path.join(staging, name));
    }
    for (const name of fs.readdirSync(staging)) {
      nestRepos(path.join(staging, name));
    }
    let moved: string[];
    if (fs.existsSync(collections)) {
      moved = drain(staging, collections);
      fs.rmdirSync(staging);
    } else {
      moved = fs.readdirSync(staging).sort();
      fs.renameSync(staging, collections);
    }
    return { collections: moved };
  } catch (e) {
    // Said in full, because this is printed instead of a vault starting, and
    // the next thing the reader does depends on which of its parts is true.
    throw new Error(
      `This vault is laid out the older way, with its collections in ${root} rather than ` +
        `in ${COLLECTIONS_DIR}/, and moving them failed: ${e instanceof Error ? e.message : String(e)}. ` +
        'Nothing was deleted, and what was moved is under ' +
        `${STAGING_DIR}/ or ${COLLECTIONS_DIR}/; starting again finishes the move once the ` +
        'cause is fixed. The vault is not served meanwhile, since serving it would show an ' +
        'empty vault while every repository is still on disk.'
    );
  }
}
