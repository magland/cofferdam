import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitRepo, execGit, isValidRefName, isValidRepoPath, isValidSha } from './git';
import { findRepo, isValidName, pagesDir } from './scan';

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

  const indexFile = tmpFile('doqpod-index');
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
      const contentFile = tmpFile('doqpod-blob');
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

function containedIn(rootReal: string, target: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    return false;
  }
  return real.startsWith(rootReal + path.sep);
}

export function deleteRepo(root: string, collection: string, name: string): void {
  const repo = findRepo(root, collection, name);
  if (!repo) throw new OpError(`repository ${collection}/${name} not found`, 'notfound');
  const rootReal = fs.realpathSync(root);
  if (!containedIn(rootReal, repo.dir)) {
    throw new OpError('repository directory is outside the vault; refusing to delete');
  }
  fs.rmSync(repo.dir, { recursive: true, force: true });
  const pages = pagesDir(root, collection, name);
  if (pages && containedIn(rootReal, pages)) {
    fs.rmSync(pages, { recursive: true, force: true });
  }
}
