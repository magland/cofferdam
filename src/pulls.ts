import * as fs from 'fs';
import * as path from 'path';
import {
  DiscussionKind,
  addComment as addDiscussionComment,
  allocate,
  checkBody as checkDiscussionBody,
  checkTitle as checkDiscussionTitle,
  countComments,
  itemDir,
  numericDirs,
  openFor as openDiscussion,
  readComments,
  readDoc,
  str,
  touch,
  writeDoc,
} from './discussion';
import { MergeMethod, OpError, deleteBranch, mergeBranch } from './ops';
import { repoPath } from './layout';
import { displayName, isValidName } from './scan';

export { MAX_BODY, MAX_TITLE } from './discussion';

// Pull requests, stored in the vault beside the issues.
//
//   <repo>.pulls/
//     1/
//       pull.md
//       comments/
//         1.md
//
// The shape is deliberately the one issues.ts uses, down to the frontmatter
// and the mkdir-as-allocator: a pull request is a discussion with a branch
// pair attached, and the two should stay legible in the same way. What it
// adds is that pair (base and head), and what happened to it: merged carries
// the merge commit and who made it, closed carries who closed it.
//
// A pull request never stores a diff or a commit list. Those are questions
// for git, which can answer them at any moment from base and head, and a
// stored copy would only ever be a stale one.

export interface PullSummary {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author: string;
  created: string;
  updated: string;
  /** The branch being merged into, and the ref being merged from. */
  base: string;
  head: string;
  comments: number;
  closedBy?: string;
  closedAt?: string;
  mergedBy?: string;
  mergedAt?: string;
  mergeSha?: string;
}

export interface PullComment {
  id: number;
  author: string;
  created: string;
  body: string;
}

export interface Pull extends PullSummary {
  body: string;
  commentList: PullComment[];
}

/** The pulls directory for a repository, whether or not it exists yet. */
export function pullsDir(root: string, collection: string, repo: string): string | null {
  if (!isValidName(collection) || !isValidName(repo)) return null;
  return repoPath(root, collection, `${displayName(repo)}.pulls`);
}

const PULL: DiscussionKind = {
  doc: 'pull.md',
  indefinite: 'a pull request',
  Indefinite: 'A pull request',
  Bare: 'Pull request',
  dirFor: pullsDir,
};

function pullDir(root: string, collection: string, repo: string, n: number): string | null {
  return itemDir(PULL, root, collection, repo, n);
}

function stateOf(v: unknown): 'open' | 'closed' | 'merged' {
  return v === 'closed' || v === 'merged' ? v : 'open';
}

function summaryFrom(n: number, dir: string, doc: { meta: Record<string, unknown>; body: string }): PullSummary {
  const created = str(doc.meta.created);
  const summary: PullSummary = {
    number: n,
    title: str(doc.meta.title, `Pull request ${n}`),
    state: stateOf(doc.meta.state),
    author: str(doc.meta.author, 'unknown'),
    created,
    updated: str(doc.meta.updated, created),
    base: str(doc.meta.base),
    head: str(doc.meta.head),
    comments: countComments(dir),
  };
  for (const key of ['closedBy', 'closedAt', 'mergedBy', 'mergedAt', 'mergeSha'] as const) {
    const value = str(doc.meta[key]);
    if (value) summary[key] = value;
  }
  return summary;
}

export function listPulls(root: string, collection: string, repo: string): PullSummary[] {
  const dir = pullsDir(root, collection, repo);
  if (!dir) return [];
  const out: PullSummary[] = [];
  for (const n of numericDirs(dir)) {
    const sub = path.join(dir, String(n));
    const doc = readDoc(path.join(sub, 'pull.md'));
    if (doc) out.push(summaryFrom(n, sub, doc));
  }
  return out.sort((a, b) => b.number - a.number);
}

// The tab counts open pull requests on every repository page, so the count is
// memoized against the directory's mtime: every write here touches it.
const countMemo = new Map<string, { mtimeMs: number; counts: { open: number; closed: number } }>();

export function pullCounts(root: string, collection: string, repo: string): { open: number; closed: number } {
  const dir = pullsDir(root, collection, repo);
  if (!dir) return { open: 0, closed: 0 };
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(dir).mtimeMs;
  } catch {
    return { open: 0, closed: 0 };
  }
  const hit = countMemo.get(dir);
  if (hit && hit.mtimeMs === mtimeMs) return hit.counts;
  const counts = { open: 0, closed: 0 };
  for (const pull of listPulls(root, collection, repo)) {
    if (pull.state === 'open') counts.open++;
    else counts.closed++;
  }
  countMemo.set(dir, { mtimeMs, counts });
  return counts;
}

export function readPull(root: string, collection: string, repo: string, n: number): Pull | null {
  const dir = pullDir(root, collection, repo, n);
  if (!dir) return null;
  const doc = readDoc(path.join(dir, 'pull.md'));
  if (!doc) return null;
  return { ...summaryFrom(n, dir, doc), body: doc.body, commentList: readComments(dir) };
}

export function createPull(
  root: string,
  collection: string,
  repo: string,
  input: { title: string; body: string; author: string; base: string; head: string }
): PullSummary {
  const dir = pullsDir(root, collection, repo);
  if (!dir) throw new OpError('invalid collection or repository name');
  const title = checkDiscussionTitle(PULL, input.title);
  const body = checkDiscussionBody(PULL, input.body);
  if (input.base === input.head) throw new OpError('A branch cannot be merged into itself.');
  const now = new Date().toISOString();
  const n = allocate(PULL, dir, (sub) =>
    writeDoc(
      path.join(sub, 'pull.md'),
      {
        title,
        state: 'open',
        author: input.author,
        created: now,
        updated: now,
        base: input.base,
        head: input.head,
      },
      body
    )
  );
  return {
    number: n,
    title,
    state: 'open',
    author: input.author,
    created: now,
    updated: now,
    base: input.base,
    head: input.head,
    comments: 0,
  };
}

export function addComment(
  root: string,
  collection: string,
  repo: string,
  n: number,
  input: { author: string; body: string }
): PullComment {
  return addDiscussionComment(PULL, root, collection, repo, n, input);
}

export function setPullState(
  root: string,
  collection: string,
  repo: string,
  n: number,
  state: 'open' | 'closed',
  actor: string
): void {
  const { dir, doc } = openDiscussion(PULL, root, collection, repo, n);
  if (stateOf(doc.meta.state) === 'merged') throw new OpError('A merged pull request cannot be reopened.');
  const now = new Date().toISOString();
  const meta: Record<string, unknown> = { ...doc.meta, state, updated: now };
  if (state === 'closed') {
    meta.closedBy = actor;
    meta.closedAt = now;
  } else {
    delete meta.closedBy;
    delete meta.closedAt;
  }
  writeDoc(path.join(dir, 'pull.md'), meta, doc.body);
  touchPulls(root, collection, repo);
}

/** Record that the merge happened; the merge itself is ops.mergeBranch. */
export function recordMerge(
  root: string,
  collection: string,
  repo: string,
  n: number,
  input: { actor: string; sha: string }
): void {
  const { dir, doc } = openDiscussion(PULL, root, collection, repo, n);
  const now = new Date().toISOString();
  writeDoc(
    path.join(dir, 'pull.md'),
    { ...doc.meta, state: 'merged', updated: now, mergedBy: input.actor, mergedAt: now, mergeSha: input.sha },
    doc.body
  );
  touchPulls(root, collection, repo);
}

export function editPull(
  root: string,
  collection: string,
  repo: string,
  n: number,
  input: { title?: string; body?: string }
): void {
  const { dir, doc } = openDiscussion(PULL, root, collection, repo, n);
  const meta: Record<string, unknown> = { ...doc.meta, updated: new Date().toISOString() };
  if (input.title !== undefined) meta.title = checkDiscussionTitle(PULL, input.title);
  const body = input.body === undefined ? doc.body : checkDiscussionBody(PULL, input.body);
  writeDoc(path.join(dir, 'pull.md'), meta, body);
  touchPulls(root, collection, repo);
}

/** Move the pulls directory's timestamp, invalidating the count cache. */
function touchPulls(root: string, collection: string, repo: string): void {
  const dir = pullsDir(root, collection, repo);
  if (dir) touch(dir);
}


// ---- the operations a transport performs, rather than the state it stores ----
//
// Opening and merging a pull request are each a sequence: validate against the
// branches the repository really has, write the record, move a branch, write the
// record again. Those sequences lived inside the web handlers, which made the web
// the only place that could perform them correctly. They take plain values and
// throw OpError, so the web handler and the API handler are transports over one
// implementation rather than two implementations that ought to agree.
//
// The actor is the one thing the two transports genuinely disagree about: a
// Viewer resolved from a session cookie on the web, an AuthResult from a bearer
// token on the API. Both carry a username, so that is all these take.

/**
 * A merge refused because it does not apply. Separate from a plain OpError
 * because the caller has something useful to say: which paths conflict.
 */
export class MergeConflict extends OpError {
  readonly paths: string[];
  constructor(paths: string[]) {
    super('This branch has conflicts that must be resolved before it can be merged.', 'conflict');
    this.paths = paths;
  }
}

/**
 * Open a pull request, having checked that both refs are branches this
 * repository actually has. The caller supplies the branch names because it has
 * already listed them; asking git again here would be a second answer to a
 * question already asked.
 */
export function openPull(
  root: string,
  collection: string,
  repo: string,
  input: { title: string; body: string; author: string; base: string; head: string },
  branches: string[]
): PullSummary {
  if (!branches.includes(input.base) || !branches.includes(input.head)) {
    throw new OpError('Both the base and the compare branch must exist.');
  }
  return createPull(root, collection, repo, input);
}

/** The commit message a merge gets when the caller does not supply one. */
export function defaultMergeMessage(pull: Pull | PullSummary, method: MergeMethod, body = ''): string {
  return method === 'squash'
    ? `${pull.title} (#${pull.number})\n\n${body.trim()}`.trimEnd()
    : `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
}

export interface MergeResult {
  sha: string;
  before: string;
  fastForward: boolean;
  branchDeleted: boolean;
}

/**
 * Merge a pull request: check it is open, merge its head into its base, record
 * the merge, and optionally delete the head branch.
 *
 * The caller fires the push event afterwards, since it holds the CI engine, and
 * moving a branch is a push whichever transport did it.
 */
export async function mergePull(
  root: string,
  repo: { dir: string; collection: string; name: string },
  n: number,
  actor: { username: string; email: string },
  request: { method: MergeMethod; message?: string; deleteBranch?: boolean },
  opts: { defaultBranch: string | null }
): Promise<MergeResult> {
  const pull = readPull(root, repo.collection, repo.name, n);
  if (!pull) throw new OpError(`Pull request ${n} does not exist.`, 'notfound');
  // 'conflict', because to a caller deciding whether to retry this is the same
  // answer as "someone got there first" rather than "your request was malformed".
  if (pull.state !== 'open') throw new OpError('This pull request is not open.', 'conflict');
  const message = request.message?.trim() || defaultMergeMessage(pull, request.method, pull.body);
  const outcome = await mergeBranch(repo.dir, pull.base, pull.head, message, {
    name: actor.username,
    email: actor.email,
  }, request.method);
  if (outcome.status === 'conflict') throw new MergeConflict(outcome.paths);
  if (outcome.status === 'up-to-date') {
    // 'conflict' rather than 'nochange': to a caller deciding whether to retry,
    // "someone already merged this" is the same answer as "someone got there
    // first", and a 200 saying nothing changed would read as success.
    throw new OpError(`${pull.base} already contains everything on ${pull.head}.`, 'conflict');
  }
  recordMerge(root, repo.collection, repo.name, n, { actor: actor.username, sha: outcome.sha });
  let branchDeleted = false;
  if (request.deleteBranch) {
    // A failure to delete the branch must not read as a failure to merge, which
    // has already happened and cannot be undone. It is reported as part of the
    // result instead.
    try {
      await deletePullBranch(root, repo, n, opts);
      branchDeleted = true;
    } catch (e) {
      console.error(`merged #${n} but could not delete ${pull.head}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { sha: outcome.sha, before: outcome.before, fastForward: outcome.fastForward, branchDeleted };
}

/**
 * Delete the branch a pull request proposed: only that branch, only once the
 * pull request is over, and never the branch it was merged into.
 */
export async function deletePullBranch(
  root: string,
  repo: { dir: string; collection: string; name: string },
  n: number,
  opts: { defaultBranch: string | null }
): Promise<string> {
  const pull = readPull(root, repo.collection, repo.name, n);
  if (!pull) throw new OpError(`Pull request ${n} does not exist.`, 'notfound');
  if (pull.state !== 'merged') {
    throw new OpError('The branch can be deleted once this pull request is merged.', 'conflict');
  }
  if (pull.head === opts.defaultBranch) throw new OpError('The default branch cannot be deleted.');
  await deleteBranch(repo.dir, pull.head);
  return pull.head;
}
