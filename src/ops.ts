import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitRepo, execGit, execGitStatus, isValidRefName, isValidRepoPath, isValidSha } from './git';
import type { LfsStore } from './lfsstore';
import { displayName, findRepo, isValidName } from './scan';

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

/**
 * Create an empty collection: a directory in the vault with no repositories in
 * it yet. Pushing to a new path creates its collection on the way (see
 * createRepo), so this exists for the other order, where a collection is made
 * first and filled afterwards, by an import or a push.
 */
export function createCollection(root: string, name: string): string {
  if (!isValidName(name)) throw new OpError('invalid collection name');
  const dir = path.join(root, name);
  if (fs.existsSync(dir)) throw new OpError(`collection ${name} already exists`, 'exists');
  fs.mkdirSync(dir);
  return dir;
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

/**
 * Fork a repository inside the vault: a bare clone of one repository into
 * another collection, with the parent recorded so both ends can say where the
 * fork came from.
 *
 * A local clone hardlinks its objects, so a fork of a large repository costs
 * almost nothing on disk until one side or the other gains new objects. The
 * `origin` remote git writes points at a filesystem path, which means nothing
 * to anyone reading the fork, so it is removed and replaced by a `cofferdam
 * .forkedFrom` entry naming `<collection>/<repo>`. Nothing else comes across:
 * issues, releases, runs, and the site belong to the repository that has
 * them, and a fork starts with none.
 */
export async function forkRepo(
  root: string,
  collection: string,
  name: string,
  toCollection: string,
  toName: string
): Promise<GitRepo> {
  const source = findRepo(root, collection, name);
  if (!source) throw new OpError(`repository ${collection}/${name} not found`, 'notfound');
  if (!isValidName(toCollection) || !isValidName(toName)) {
    throw new OpError('invalid collection or repository name');
  }
  if (toCollection === collection && toName === name) {
    throw new OpError('a repository cannot be forked onto itself');
  }
  if (findRepo(root, toCollection, toName)) {
    throw new OpError(`${toCollection}/${toName} already exists`, 'exists');
  }
  fs.mkdirSync(path.join(root, toCollection), { recursive: true });
  const dir = path.join(root, toCollection, `${toName}.git`);
  await execGit(root, ['clone', '--bare', source.dir, dir]);
  await execGit(dir, ['remote', 'remove', 'origin']).catch(() => undefined);
  await execGit(dir, ['config', 'cofferdam.forkedFrom', `${collection}/${name}`]);
  await execGit(dir, ['config', 'receive.denyNonFastForwards', 'true']);
  await execGit(dir, ['config', 'receive.denyDeletes', 'true']);
  await execGit(dir, ['config', 'receive.maxInputSize', String(2 * 1024 * 1024 * 1024)]);
  const description = fs.existsSync(path.join(source.dir, 'description'))
    ? fs.readFileSync(path.join(source.dir, 'description'), 'utf8')
    : '';
  if (description.trim() !== '' && !description.startsWith('Unnamed repository')) {
    fs.writeFileSync(path.join(dir, 'description'), description);
  }
  return new GitRepo(dir, toCollection, toName);
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
  action:
    | { kind: 'create'; content: Buffer }
    // toPath renames the file in the same commit: the old path is removed and
    // the content written at the new one, so a rename is one commit and not a
    // delete followed by a create.
    | { kind: 'edit'; content: Buffer; toPath?: string }
    | { kind: 'delete' };
}

export interface UploadedFile {
  path: string;
  content: Buffer;
}

/**
 * Commit several files at once, which is what an upload is. Same index dance
 * as commitFileChange and the same optimistic guard on the branch tip; the
 * difference is only that a batch of paths goes in before the tree is
 * written, so an upload of twenty files is one commit and not twenty.
 *
 * A path that already exists is replaced and keeps its mode, so re-uploading
 * a script does not quietly drop its executable bit.
 */
export async function commitFiles(
  repoDir: string,
  args: { branch: string; files: UploadedFile[]; message: string; author: CommitAuthor; expectedHead: string | null }
): Promise<string> {
  const { branch, files, message, author, expectedHead } = args;
  if (!isValidRefName(branch) || branch.startsWith('-')) throw new OpError('invalid branch name');
  if (files.length === 0) throw new OpError('no files to commit');
  for (const file of files) {
    if (!isValidRepoPath(file.path) || file.path === '') throw new OpError(`invalid file path: ${file.path}`);
  }
  if (expectedHead !== null && !isValidSha(expectedHead)) throw new OpError('invalid expected commit');

  const indexFile = tmpFile('cofferdam-index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    let baseTree: string | null = null;
    if (expectedHead !== null) {
      baseTree = (await execGit(repoDir, ['rev-parse', `${expectedHead}^{tree}`])).toString('utf8').trim();
      await execGit(repoDir, ['read-tree', expectedHead], { env });
    } else {
      await execGit(repoDir, ['read-tree', '--empty'], { env });
    }

    for (const file of files) {
      const mode =
        expectedHead !== null && (await entryExists(repoDir, expectedHead, file.path))
          ? await entryMode(repoDir, expectedHead, file.path)
          : '100644';
      const contentFile = tmpFile('cofferdam-blob');
      let blobSha: string;
      try {
        fs.writeFileSync(contentFile, file.content, { mode: 0o600 });
        blobSha = (await execGit(repoDir, ['hash-object', '-w', '--', contentFile])).toString('utf8').trim();
      } finally {
        fs.rmSync(contentFile, { force: true });
      }
      await execGit(repoDir, ['update-index', '--add', '--cacheinfo', `${mode},${blobSha},${file.path}`], { env });
    }

    const newTree = (await execGit(repoDir, ['write-tree'], { env })).toString('utf8').trim();
    if (newTree === baseTree) throw new OpError('those files are already in the repository, unchanged', 'nochange');
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

export async function commitFileChange(repoDir: string, args: FileCommitArgs): Promise<string> {
  const { branch, filePath, message, author, expectedHead, action } = args;
  if (!isValidRefName(branch) || branch.startsWith('-')) throw new OpError('invalid branch name');
  if (!isValidRepoPath(filePath) || filePath === '') throw new OpError('invalid file path');
  if (expectedHead !== null && !isValidSha(expectedHead)) throw new OpError('invalid expected commit');

  const toPath = action.kind === 'edit' && action.toPath && action.toPath !== filePath ? action.toPath : null;
  if (toPath !== null && !isValidRepoPath(toPath)) throw new OpError('invalid file path');

  if (expectedHead !== null) {
    if (action.kind === 'create') {
      if (await entryExists(repoDir, expectedHead, filePath)) {
        throw new OpError(`${filePath} already exists on ${branch}`, 'exists');
      }
    } else if (!(await entryExists(repoDir, expectedHead, filePath))) {
      throw new OpError(`${filePath} does not exist on ${branch}`, 'notfound');
    }
    if (toPath !== null && (await entryExists(repoDir, expectedHead, toPath))) {
      throw new OpError(`${toPath} already exists on ${branch}`, 'exists');
    }
  } else if (action.kind !== 'create') {
    throw new OpError('cannot edit or delete a file on a branch that does not exist');
  }

  const indexFile = tmpFile('cofferdam-index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    let baseTree: string | null = null;
    if (expectedHead !== null) {
      baseTree = (await execGit(repoDir, ['rev-parse', `${expectedHead}^{tree}`])).toString('utf8').trim();
      await execGit(repoDir, ['read-tree', expectedHead], { env });
    } else {
      await execGit(repoDir, ['read-tree', '--empty'], { env });
    }

    // update-index --force-remove insists on a work tree; feeding a zero-mode
    // entry to --index-info removes a path without one.
    const removePath = async (target: string) => {
      await execGit(repoDir, ['update-index', '--index-info'], {
        env,
        input: `0 ${'0'.repeat(40)}\t${target}\n`,
      });
    };
    if (action.kind === 'delete') {
      await removePath(filePath);
    } else {
      if (toPath !== null) await removePath(filePath);
      const mode =
        action.kind === 'edit' && expectedHead !== null
          ? await entryMode(repoDir, expectedHead, filePath)
          : '100644';
      const contentFile = tmpFile('cofferdam-blob');
      let blobSha: string;
      try {
        fs.writeFileSync(contentFile, action.content, { mode: 0o600 });
        blobSha = (await execGit(repoDir, ['hash-object', '-w', '--', contentFile])).toString('utf8').trim();
      } finally {
        fs.rmSync(contentFile, { force: true });
      }
      await execGit(repoDir, ['update-index', '--add', '--cacheinfo', `${mode},${blobSha},${toPath ?? filePath}`], {
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

/** How a merge is recorded: both parents, or one commit on the base. */
export type MergeMethod = 'merge' | 'squash';

/** What a merge would do, without doing it. */
export type MergePreview =
  | { status: 'clean'; fastForward: boolean; base: string; head: string }
  | { status: 'up-to-date' }
  | { status: 'conflict'; paths: string[] };

/**
 * Work out what merging `head` into branch `base` would come to, in a bare
 * repository and without a work tree.
 *
 * `git merge-tree --write-tree` computes the merged tree in the object
 * database and names the paths that conflict. The tree it writes when the
 * merge is clean is not thrown away: the caller commits exactly that tree, so
 * the merge a reader was shown is the merge that happens. An unreferenced
 * tree left behind by a preview is ordinary garbage that git collects.
 */
async function planMerge(
  repoDir: string,
  base: string,
  head: string
): Promise<
  | { status: 'up-to-date' }
  | { status: 'conflict'; paths: string[] }
  | { status: 'clean'; tree: string | null; fastForward: boolean; baseSha: string; headSha: string }
> {
  if (!isValidRefName(base) || base.startsWith('-')) throw new OpError('invalid base branch');
  if (!isValidRefName(head) || head.startsWith('-')) throw new OpError('invalid head ref');
  const baseSha = await refTip(repoDir, `refs/heads/${base}`);
  if (!baseSha) throw new OpError(`branch ${base} not found`, 'notfound');
  const headSha = await refTip(repoDir, head);
  if (!headSha) throw new OpError(`ref ${head} not found`, 'notfound');

  // Nothing to merge: the head is already in the base's history.
  if ((await execGitStatus(repoDir, ['merge-base', '--is-ancestor', headSha, baseSha])).code === 0) {
    return { status: 'up-to-date' };
  }
  // The base has not moved since the head left it, so the merged tree is the
  // head's own. A merge commit is still made rather than fast-forwarding:
  // that commit is the record of the merge, and a history where a proposal
  // simply appears says nothing about why it was taken. This is what GitHub's
  // merge button does too.
  if ((await execGitStatus(repoDir, ['merge-base', '--is-ancestor', baseSha, headSha])).code === 0) {
    const tree = (await execGit(repoDir, ['rev-parse', `${headSha}^{tree}`])).toString('utf8').trim();
    return { status: 'clean', tree, fastForward: true, baseSha, headSha };
  }

  const merged = await execGitStatus(repoDir, ['merge-tree', '--write-tree', '--name-only', baseSha, headSha]);
  const lines = merged.stdout.split('\n');
  const tree = (lines[0] ?? '').trim();
  if (merged.code === 1 && isValidSha(tree)) {
    // The conflicting paths follow the tree, one per line, and a blank line
    // ends them before git's own narration of the merge.
    const paths: string[] = [];
    for (const line of lines.slice(1)) {
      if (line.trim() === '') break;
      paths.push(line);
    }
    return { status: 'conflict', paths };
  }
  if (merged.code !== 0 || !isValidSha(tree)) {
    throw new OpError(merged.stderr.trim() || 'the merge could not be computed');
  }
  return { status: 'clean', tree, fastForward: false, baseSha, headSha };
}

/** Whether a merge would apply cleanly, without changing anything. */
export async function previewMerge(repoDir: string, base: string, head: string): Promise<MergePreview> {
  const plan = await planMerge(repoDir, base, head);
  if (plan.status === 'clean') {
    return { status: 'clean', fastForward: plan.fastForward, base: plan.baseSha, head: plan.headSha };
  }
  return plan;
}

/**
 * Merge one ref into a branch and move the branch to the result.
 *
 * The branch moves with a guarded update-ref, so a branch that moved while
 * the reader was deciding fails rather than losing the commit that moved it.
 * Conflicts are reported, never committed: resolving them needs a work tree
 * and a person, and the vault has neither.
 */
export async function mergeBranch(
  repoDir: string,
  base: string,
  head: string,
  message: string,
  author: CommitAuthor,
  method: MergeMethod = 'merge'
): Promise<MergeOutcome> {
  const plan = await planMerge(repoDir, base, head);
  if (plan.status !== 'clean') return plan;
  // A squash keeps the merged tree and drops the branch's shape: one commit
  // on the base, with the base as its only parent, which is what makes the
  // head's history disappear from the base and the head branch look unmerged
  // afterwards. A merge keeps both parents, and with them the record of where
  // the work came from.
  const parents = method === 'squash' ? ['-p', plan.baseSha] : ['-p', plan.baseSha, '-p', plan.headSha];
  const sha = (
    await execGit(repoDir, ['commit-tree', plan.tree!, ...parents, '-m', message], {
      env: authorEnv(author),
    })
  )
    .toString('utf8')
    .trim();
  await moveBranch(repoDir, base, sha, plan.baseSha);
  return { status: 'merged', sha, before: plan.baseSha, fastForward: plan.fastForward };
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

// The directories a repository accumulates beside its bare repository, by the
// suffix each one carries. Every feature has its own helper for the directory
// it owns (siteDir, runsDir, issuesDir, pullsDir, releasesDir), but rename and
// delete are the two places that need the whole set, and a set spelled out in
// two places is a set one of them falls behind on. The list therefore lives
// here, where both read it, so a sibling added later is added once.
//
// LFS objects are not in the list. Without a bucket they do sit in a sibling
// <repo>.lfs, but with one they do not sit on disk at all, so the store is
// asked to move or drop them rather than having its path assumed.
export const repoSiblingSuffixes = ['.site', '.runs', '.issues', '.pulls', '.releases'];

function siblingDir(root: string, collection: string, name: string, suffix: string): string {
  return path.join(root, collection, `${displayName(name)}${suffix}`);
}

/**
 * Rename a repository, or move it to another collection - the two are one
 * operation, since both are a directory rename.
 *
 * Everything that belongs to the repository moves with it: the bare
 * repository, its static site, its workflow runs, its issues, its pull
 * requests, its releases, and its LFS objects. Leaving any of them behind
 * would strand state that only that repository can reach, and worse, a
 * repository later created under the old name would inherit it.
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
  // containedIn resolves the path first, so a sibling that was never created
  // fails the same check as one pointing out of the vault, and is skipped.
  const move = (from: string, to: string) => {
    if (!containedIn(rootReal, from)) return;
    if (fs.existsSync(to)) {
      throw new OpError(`${path.basename(to)} already exists next to ${toCollection}/${toName}`, 'exists');
    }
    fs.renameSync(from, to);
  };
  for (const suffix of repoSiblingSuffixes) {
    move(siblingDir(root, collection, name, suffix), path.join(destCollection, `${toName}${suffix}`));
  }
  // LFS objects carry the repository in their key or their path, so the store
  // moves them itself. Unlike deletion this is not best-effort: an object left
  // behind is one a clone of the moved repository cannot fetch.
  if (lfs) await lfs.renameRepo(collection, name, toCollection, toName);
}

/**
 * Delete a repository and everything it accumulated: the bare repository, its
 * static site, its workflow runs, its issues, its pull requests, its
 * releases, and its LFS objects.
 */
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
  // The siblings go too: the site, the workflow runs, the issues, the pull
  // requests, and the releases. Leaving any of them would orphan a history
  // nothing can reach, and worse, a repository later created under the same
  // name would inherit it, with run, issue, and pull numbers continuing from
  // someone else's.
  for (const suffix of repoSiblingSuffixes) {
    const dir = siblingDir(root, collection, name, suffix);
    if (containedIn(rootReal, dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
