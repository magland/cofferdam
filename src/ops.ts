import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitRepo, execGit, execGitStatus, isValidRefName, isValidRepoPath, isValidSha } from './git';
import type { LfsStore } from './lfsstore';
import { runsDir } from './ci/runs';
import { findRepo, isValidName, siteDir } from './scan';

// The shared write-operations layer. Every function takes explicit arguments
// and enforces no authorization: the route layer knows the actor and decides.
// The HTML handlers call these today; the JSON API can expose the same
// operations later without duplicating logic.

export type OpErrorKind = 'invalid' | 'notfound' | 'exists' | 'conflict' | 'nochange';

export class OpError extends Error {
  constructor(message: string, public kind: OpErrorKind = 'invalid') {
    super(message);
  }
}

export interface CommitAuthor {
  name: string;
  email: string;
}

function authorEnv(author: CommitAuthor): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
}

function tmpFile(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${crypto.randomBytes(8).toString('hex')}`);
}

export async function createRepo(root: string, collection: string, name: string): Promise<GitRepo> {
  if (!isValidName(collection) || !isValidName(name)) throw new OpError('invalid collection or repository name');
  fs.mkdirSync(path.join(root, collection), { recursive: true });
  const dir = path.join(root, collection, `${name}.git`);
  await execGit(root, ['init', '--bare', '--initial-branch=main', dir]);
  await execGit(dir, ['config', 'receive.denyNonFastForwards', 'true']);
  await execGit(dir, ['config', 'receive.denyDeletes', 'true']);
  await execGit(dir, ['config', 'receive.maxInputSize', String(2 * 1024 * 1024 * 1024)]);
  return new GitRepo(dir, collection, name);
}

async function refTip(repoDir: string, ref: string): Promise<string | null> {
  try {
    return (await execGit(repoDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))
      .toString('utf8')
      .trim();
  } catch {
    return null;
  }
}

async function entryExists(repoDir: string, commit: string, filePath: string): Promise<boolean> {
  try {
    await execGit(repoDir, ['cat-file', '-e', `${commit}:${filePath}`]);
    return true;
  } catch {
    return false;
  }
}

async function entryMode(repoDir: string, commit: string, filePath: string): Promise<string> {
  const out = (await execGit(repoDir, ['ls-tree', commit, '--', filePath])).toString('utf8');
  const m = out.match(/^(\d{6}) blob /);
  if (!m) throw new OpError(`${filePath} is not a file at this commit`, 'notfound');
  return m[1];
}

interface FileCommitArgs {
  branch: string;
  filePath: string;
  message: string;
  author: CommitAuthor;
  // The commit sha the actor last saw at the branch tip, or null when
  // creating the branch itself (first commit in an empty repository). Gives
  // optimistic concurrency: if the branch has moved, the update fails with a
  // 'conflict' OpError instead of clobbering.
  expectedHead: string | null;
  action: { kind: 'create'; content: Buffer } | { kind: 'edit'; content: Buffer } | { kind: 'delete' };
}

export async function commitFileChange(repoDir: string, args: FileCommitArgs): Promise<string> {
  const { branch, filePath, message, author, expectedHead, action } = args;
  if (!isValidRefName(branch) || branch.startsWith('-')) throw new OpError('invalid branch name');
  if (!isValidRepoPath(filePath) || filePath === '') throw new OpError('invalid file path');
  if (expectedHead !== null && !isValidSha(expectedHead)) throw new OpError('invalid expected commit');

  if (expectedHead !== null) {
    if (action.kind === 'create') {
      if (await entryExists(repoDir, expectedHead, filePath)) {
        throw new OpError(`${filePath} already exists on ${branch}`, 'exists');
      }
    } else if (!(await entryExists(repoDir, expectedHead, filePath))) {
      throw new OpError(`${filePath} does not exist on ${branch}`, 'notfound');
    }
  } else if (action.kind !== 'create') {
    throw new OpError('cannot edit or delete a file on a branch that does not exist');
  }

  const indexFile = tmpFile('hubbit-index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    let baseTree: string | null = null;
    if (expectedHead !== null) {
      baseTree = (await execGit(repoDir, ['rev-parse', `${expectedHead}^{tree}`])).toString('utf8').trim();
      await execGit(repoDir, ['read-tree', expectedHead], { env });
    } else {
      await execGit(repoDir, ['read-tree', '--empty'], { env });
    }

    if (action.kind === 'delete') {
      // update-index --force-remove insists on a work tree; feeding a
      // zero-mode entry to --index-info removes the path without one.
      await execGit(repoDir, ['update-index', '--index-info'], {
        env,
        input: `0 ${'0'.repeat(40)}\t${filePath}\n`,
      });
    } else {
      const mode =
        action.kind === 'edit' && expectedHead !== null
          ? await entryMode(repoDir, expectedHead, filePath)
          : '100644';
      const contentFile = tmpFile('hubbit-blob');
      let blobSha: string;
      try {
        fs.writeFileSync(contentFile, action.content, { mode: 0o600 });
        blobSha = (await execGit(repoDir, ['hash-object', '-w', '--', contentFile])).toString('utf8').trim();
      } finally {
        fs.rmSync(contentFile, { force: true });
      }
      await execGit(repoDir, ['update-index', '--add', '--cacheinfo', `${mode},${blobSha},${filePath}`], {
        env,
      });
    }

    const newTree = (await execGit(repoDir, ['write-tree'], { env })).toString('utf8').trim();
    if (newTree === baseTree) throw new OpError('no changes to commit', 'nochange');

    const commitArgs = ['commit-tree', newTree, '-m', message];
    if (expectedHead !== null) commitArgs.push('-p', expectedHead);
    const newCommit = (await execGit(repoDir, commitArgs, { env: authorEnv(author) })).toString('utf8').trim();

    try {
      await execGit(repoDir, ['update-ref', `refs/heads/${branch}`, newCommit, expectedHead ?? '']);
    } catch (e) {
      const tip = await refTip(repoDir, `refs/heads/${branch}`);
      if (tip !== expectedHead) {
        throw new OpError(`branch ${branch} has moved since you loaded this page`, 'conflict');
      }
      throw e;
    }
    return newCommit;
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

/**
 * What merging a head into a base did, or why it could not.
 * `before` is the base tip the merge was made against, which the caller needs
 * to report the push to anything watching the branch.
 */
export type MergeOutcome =
  | { status: 'merged'; sha: string; before: string; fastForward: boolean }
  | { status: 'up-to-date' }
  | { status: 'conflict'; paths: string[] };

/**
 * Merge one ref into a branch, in a bare repository and without a work tree.
 *
 * `git merge-tree --write-tree` computes the merged tree in the object
 * database and says which paths conflict; a clean result becomes a commit
 * with two parents through commit-tree, and the branch moves with a guarded
 * update-ref, so a branch that moved while the reader was deciding fails
 * rather than losing the commit that moved it. Where the base is already an
 * ancestor of the head there is nothing to merge and the branch simply moves
 * forward, which is what git would do at the terminal.
 *
 * Conflicts are reported, never committed: resolving them needs a work tree
 * and a person, and the vault has neither.
 */
export async function mergeBranch(
  repoDir: string,
  base: string,
  head: string,
  message: string,
  author: CommitAuthor
): Promise<MergeOutcome> {
  if (!isValidRefName(base) || base.startsWith('-')) throw new OpError('invalid base branch');
  if (!isValidRefName(head) || head.startsWith('-')) throw new OpError('invalid head ref');
  const baseSha = await refTip(repoDir, `refs/heads/${base}`);
  if (!baseSha) throw new OpError(`branch ${base} not found`, 'notfound');
  const headSha = await refTip(repoDir, head);
  if (!headSha) throw new OpError(`ref ${head} not found`, 'notfound');

  const ancestor = await execGitStatus(repoDir, ['merge-base', '--is-ancestor', headSha, baseSha]);
  if (ancestor.code === 0) return { status: 'up-to-date' };

  const canFastForward = await execGitStatus(repoDir, ['merge-base', '--is-ancestor', baseSha, headSha]);
  if (canFastForward.code === 0) {
    await moveBranch(repoDir, base, headSha, baseSha);
    return { status: 'merged', sha: headSha, before: baseSha, fastForward: true };
  }

  const merged = await execGitStatus(repoDir, ['merge-tree', '--write-tree', '--name-only', baseSha, headSha]);
  const lines = merged.stdout.split('\n');
  const tree = (lines[0] ?? '').trim();
  if (merged.code !== 0 || !isValidSha(tree)) {
    // Exit 1 with a tree means conflicts: the conflicting paths follow the
    // tree, one per line, and a blank line ends them before git's own
    // narration of the merge, which is not for this page.
    if (merged.code === 1 && isValidSha(tree)) {
      const paths: string[] = [];
      for (const line of lines.slice(1)) {
        if (line.trim() === '') break;
        paths.push(line);
      }
      return { status: 'conflict', paths };
    }
    throw new OpError(merged.stderr.trim() || 'the merge could not be computed');
  }
  const sha = (
    await execGit(repoDir, ['commit-tree', tree, '-p', baseSha, '-p', headSha, '-m', message], {
      env: authorEnv(author),
    })
  )
    .toString('utf8')
    .trim();
  await moveBranch(repoDir, base, sha, baseSha);
  return { status: 'merged', sha, before: baseSha, fastForward: false };
}

/** Move a branch, refusing if it is no longer where the caller last saw it. */
async function moveBranch(repoDir: string, branch: string, to: string, from: string): Promise<void> {
  try {
    await execGit(repoDir, ['update-ref', `refs/heads/${branch}`, to, from]);
  } catch {
    throw new OpError(`branch ${branch} has moved since this page was loaded`, 'conflict');
  }
}

export async function createBranch(repoDir: string, name: string, fromRef: string): Promise<void> {
  if (!isValidRefName(name) || name.startsWith('-')) throw new OpError('invalid branch name');
  if (!isValidRefName(fromRef) || fromRef.startsWith('-')) throw new OpError('invalid source ref');
  await execGit(repoDir, ['check-ref-format', `refs/heads/${name}`]);
  const sha = await refTip(repoDir, fromRef);
  if (!sha) throw new OpError(`ref ${fromRef} not found`, 'notfound');
  try {
    await execGit(repoDir, ['update-ref', `refs/heads/${name}`, sha, '']);
  } catch {
    throw new OpError(`branch ${name} already exists`, 'exists');
  }
}

export async function deleteBranch(repoDir: string, name: string): Promise<void> {
  if (!isValidRefName(name) || name.startsWith('-')) throw new OpError('invalid branch name');
  // update-ref -d bypasses receive.denyDeletes, deliberately: the receive
  // config guards against accidental `push --delete`, while deletion here is
  // explicit, confirmed intent.
  await execGit(repoDir, ['update-ref', '-d', `refs/heads/${name}`]);
}

export async function createTag(repoDir: string, name: string, atRef: string): Promise<void> {
  if (!isValidRefName(name) || name.startsWith('-')) throw new OpError('invalid tag name');
  if (!isValidRefName(atRef) || atRef.startsWith('-')) throw new OpError('invalid target ref');
  await execGit(repoDir, ['check-ref-format', `refs/tags/${name}`]);
  const sha = await refTip(repoDir, atRef);
  if (!sha) throw new OpError(`ref ${atRef} not found`, 'notfound');
  try {
    await execGit(repoDir, ['update-ref', `refs/tags/${name}`, sha, '']);
  } catch {
    throw new OpError(`tag ${name} already exists`, 'exists');
  }
}

export async function deleteTag(repoDir: string, name: string): Promise<void> {
  if (!isValidRefName(name) || name.startsWith('-')) throw new OpError('invalid tag name');
  await execGit(repoDir, ['update-ref', '-d', `refs/tags/${name}`]);
}

export async function setDefaultBranch(repoDir: string, branch: string): Promise<void> {
  if (!isValidRefName(branch) || branch.startsWith('-')) throw new OpError('invalid branch name');
  const sha = await refTip(repoDir, `refs/heads/${branch}`);
  if (!sha) throw new OpError(`branch ${branch} not found`, 'notfound');
  await execGit(repoDir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
}

export function setDescription(repoDir: string, text: string): void {
  const line = text.replace(/\s+/g, ' ').trim();
  fs.writeFileSync(path.join(repoDir, 'description'), line === '' ? '' : line + '\n');
}

export function containedIn(rootReal: string, target: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    return false;
  }
  return real.startsWith(rootReal + path.sep);
}

/**
 * Rename a repository, or move it to another collection - the two are one
 * operation, since both are a directory rename.
 *
 * Everything that belongs to the repository moves with it: the bare
 * repository, its static site, its workflow runs, its issues, its releases,
 * and its LFS objects. Leaving any of them behind would strand state that
 * only that repository can reach, and worse, a repository later created under
 * the old name would inherit it.
 *
 * The move is a sequence of renames rather than one atomic act, which is the
 * honest limit of a filesystem-backed store. The repository itself moves
 * first: if a later sibling fails, what is left behind is a directory beside
 * the old name rather than a repository nobody can find.
 */
export async function renameRepo(
  root: string,
  collection: string,
  name: string,
  toCollection: string,
  toName: string,
  lfs?: LfsStore | null
): Promise<void> {
  const repo = findRepo(root, collection, name);
  if (!repo) throw new OpError(`repository ${collection}/${name} not found`, 'notfound');
  if (!isValidName(toCollection) || !isValidName(toName)) {
    throw new OpError('invalid collection or repository name');
  }
  if (toCollection === collection && toName === name) throw new OpError('that is already its name', 'nochange');
  if (findRepo(root, toCollection, toName)) {
    throw new OpError(`${toCollection}/${toName} already exists`, 'exists');
  }
  const rootReal = fs.realpathSync(root);
  if (!containedIn(rootReal, repo.dir)) {
    throw new OpError('repository directory is outside the vault; refusing to move it');
  }
  // The .git suffix is optional on disk and is kept as it was found, so a
  // move never changes how git-lfs derives its endpoint for this repository.
  const suffix = path.basename(repo.dir).endsWith('.git') ? '.git' : '';
  const destCollection = path.join(root, toCollection);
  fs.mkdirSync(destCollection, { recursive: true });
  const destRepo = path.join(destCollection, `${toName}${suffix}`);
  if (fs.existsSync(destRepo)) throw new OpError(`${toCollection}/${toName} already exists`, 'exists');
  fs.renameSync(repo.dir, destRepo);

  // The siblings, each moved only if it is there and inside the vault.
  const move = (from: string | null, to: string) => {
    if (!from || !containedIn(rootReal, from)) return;
    if (fs.existsSync(to)) {
      throw new OpError(`${path.basename(to)} already exists next to ${toCollection}/${toName}`, 'exists');
    }
    fs.renameSync(from, to);
  };
  move(siteDir(root, collection, name), path.join(destCollection, `${toName}.site`));
  move(runsDir(root, collection, name), path.join(destCollection, `${toName}.runs`));
  for (const kind of ['issues', 'releases']) {
    const from = path.join(root, collection, `${name}.${kind}`);
    move(fs.existsSync(from) ? from : null, path.join(destCollection, `${toName}.${kind}`));
  }
  // LFS objects carry the repository in their key or their path, so the store
  // moves them itself. Unlike deletion this is not best-effort: an object left
  // behind is one a clone of the moved repository cannot fetch.
  if (lfs) await lfs.renameRepo(collection, name, toCollection, toName);
}

export async function deleteRepo(
  root: string,
  collection: string,
  name: string,
  lfs?: LfsStore | null
): Promise<void> {
  const repo = findRepo(root, collection, name);
  if (!repo) throw new OpError(`repository ${collection}/${name} not found`, 'notfound');
  const rootReal = fs.realpathSync(root);
  if (!containedIn(rootReal, repo.dir)) {
    throw new OpError('repository directory is outside the vault; refusing to delete');
  }
  fs.rmSync(repo.dir, { recursive: true, force: true });
  const site = siteDir(root, collection, name);
  if (site && containedIn(rootReal, site)) {
    fs.rmSync(site, { recursive: true, force: true });
  }
  // Workflow runs go too. Leaving them would orphan the history, and worse,
  // a repository later created under the same name would inherit it, with
  // run numbers continuing from someone else's runs.
  const runs = runsDir(root, collection, name);
  if (runs && containedIn(rootReal, runs)) {
    fs.rmSync(runs, { recursive: true, force: true });
  }
  // Stored LFS objects go too, best-effort: by this point the repository is
  // gone and the objects are unreachable garbage, so a storage failure is
  // logged rather than allowed to fail the deletion.
  if (lfs) {
    try {
      await lfs.deleteRepo(collection, name);
    } catch (e) {
      console.error(
        `LFS cleanup for ${collection}/${name} failed: ${e instanceof Error ? e.message : e}`
      );
    }
  }
}
