import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { OpError } from './ops';
import { displayName, isValidName } from './scan';

// Issues, stored in the vault like everything else.
//
// A repository's issues live in a sibling directory, `<repo>.issues`, beside
// the `<repo>.git`, `<repo>.site`, and `<repo>.runs` directories that are
// already there. One directory per issue, holding the issue as markdown with
// a frontmatter header and its comments as further markdown files:
//
//   <repo>.issues/
//     1/
//       issue.md
//       comments/
//         1.md
//
// The alternative considered in the specification was a hidden git ref inside
// the repository, which travels with a clone. This shape was chosen for the
// same reason the rest of the vault has it: what is on disk is legible
// without the server, greppable, editable in an editor, and backed up by
// copying a directory. Nothing here needs a database, and a vault where the
// issues have gone missing is one where someone deleted a directory.
//
// Numbers are per repository and never reused. Allocation is a mkdir, which
// the filesystem makes atomic: a second writer racing for the same number
// gets EEXIST and tries the next one.

export interface IssueSummary {
  number: number;
  title: string;
  state: 'open' | 'closed';
  author: string;
  created: string;
  updated: string;
  labels: string[];
  comments: number;
  closedBy?: string;
  closedAt?: string;
}

export interface IssueComment {
  id: number;
  author: string;
  created: string;
  body: string;
}

export interface Issue extends IssueSummary {
  body: string;
  commentList: IssueComment[];
}

export const MAX_TITLE = 200;
export const MAX_BODY = 64 * 1024;
export const MAX_LABELS = 10;

/** The issues directory for a repository, whether or not it exists yet. */
export function issuesDir(root: string, collection: string, repo: string): string | null {
  if (!isValidName(collection) || !isValidName(repo)) return null;
  return path.join(root, collection, `${displayName(repo)}.issues`);
}

function issueDir(root: string, collection: string, repo: string, n: number): string | null {
  const dir = issuesDir(root, collection, repo);
  if (!dir || !Number.isInteger(n) || n < 1) return null;
  return path.join(dir, String(n));
}

function numericDirs(dir: string): number[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && /^[1-9][0-9]*$/.test(e.name))
    .map((e) => parseInt(e.name, 10))
    .sort((a, b) => a - b);
}

/**
 * A markdown file with a YAML frontmatter header, which is the shape of every
 * file here. A file without a header is not one of ours and is skipped rather
 * than guessed at.
 */
function readDoc(file: string): { meta: Record<string, unknown>; body: string } | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  let meta: unknown;
  try {
    meta = YAML.parse(m[1]);
  } catch {
    return null;
  }
  if (typeof meta !== 'object' || meta === null) return null;
  return { meta: meta as Record<string, unknown>, body: m[2] };
}

function writeDoc(file: string, meta: Record<string, unknown>, body: string): void {
  const text = `---\n${YAML.stringify(meta).trimEnd()}\n---\n${body.replace(/\s+$/, '')}\n`;
  // Written beside the target and renamed, so a reader never sees half a file.
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function labelsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter((s) => s !== '');
  return [];
}

function countComments(dir: string): number {
  try {
    return fs.readdirSync(path.join(dir, 'comments')).filter((f) => /^[1-9][0-9]*\.md$/.test(f)).length;
  } catch {
    return 0;
  }
}

function summaryFrom(n: number, dir: string, doc: { meta: Record<string, unknown>; body: string }): IssueSummary {
  const created = str(doc.meta.created);
  return {
    number: n,
    title: str(doc.meta.title, `Issue ${n}`),
    state: doc.meta.state === 'closed' ? 'closed' : 'open',
    author: str(doc.meta.author, 'unknown'),
    created,
    updated: str(doc.meta.updated, created),
    labels: labelsOf(doc.meta.labels),
    comments: countComments(dir),
    closedBy: doc.meta.closedBy === undefined ? undefined : str(doc.meta.closedBy),
    closedAt: doc.meta.closedAt === undefined ? undefined : str(doc.meta.closedAt),
  };
}

export function listIssues(root: string, collection: string, repo: string): IssueSummary[] {
  const dir = issuesDir(root, collection, repo);
  if (!dir) return [];
  const out: IssueSummary[] = [];
  for (const n of numericDirs(dir)) {
    const sub = path.join(dir, String(n));
    const doc = readDoc(path.join(sub, 'issue.md'));
    if (doc) out.push(summaryFrom(n, sub, doc));
  }
  // Newest first, which is how a list of issues is read.
  return out.sort((a, b) => b.number - a.number);
}

// Counting open issues means reading every issue's header, and the Issues tab
// asks for that count on every page of a repository. So the answer is
// memoized against the issues directory's modification time, and every write
// below touches that directory - including a state change inside a
// subdirectory, which would not otherwise move it. One read per change rather
// than one per page view, and a vault with no issues never pays anything.
const countMemo = new Map<string, { mtimeMs: number; counts: { open: number; closed: number } }>();

function touch(dir: string): void {
  try {
    const now = new Date();
    fs.utimesSync(dir, now, now);
  } catch {
    // A directory we just wrote into; if this fails the cache simply misses.
  }
}

/** Open and closed counts, for the tab and the list's filter. */
export function issueCounts(root: string, collection: string, repo: string): { open: number; closed: number } {
  const dir = issuesDir(root, collection, repo);
  if (!dir) return { open: 0, closed: 0 };
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(dir).mtimeMs;
  } catch {
    return { open: 0, closed: 0 };
  }
  const cached = countMemo.get(dir);
  if (cached && cached.mtimeMs === mtimeMs) return cached.counts;
  const counts = { open: 0, closed: 0 };
  for (const issue of listIssues(root, collection, repo)) {
    if (issue.state === 'open') counts.open++;
    else counts.closed++;
  }
  if (countMemo.size > 2000) countMemo.clear();
  countMemo.set(dir, { mtimeMs, counts });
  return counts;
}

export function readIssue(root: string, collection: string, repo: string, n: number): Issue | null {
  const dir = issueDir(root, collection, repo, n);
  if (!dir) return null;
  const doc = readDoc(path.join(dir, 'issue.md'));
  if (!doc) return null;
  const commentList: IssueComment[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(path.join(dir, 'comments'));
  } catch {
    files = [];
  }
  for (const f of files.filter((x) => /^[1-9][0-9]*\.md$/.test(x)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const c = readDoc(path.join(dir, 'comments', f));
    if (!c) continue;
    commentList.push({
      id: parseInt(f, 10),
      author: str(c.meta.author, 'unknown'),
      created: str(c.meta.created),
      body: c.body,
    });
  }
  return { ...summaryFrom(n, dir, doc), body: doc.body, commentList };
}

function checkTitle(title: string): string {
  const t = title.trim().replace(/\s+/g, ' ');
  if (t === '') throw new OpError('An issue needs a title.');
  if (t.length > MAX_TITLE) throw new OpError(`A title may be at most ${MAX_TITLE} characters.`);
  return t;
}

function checkBody(body: string): string {
  const b = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (b.length > MAX_BODY) throw new OpError('That is longer than an issue may be.');
  return b;
}

export function checkLabels(labels: string[]): string[] {
  const out: string[] = [];
  for (const raw of labels) {
    const label = raw.trim();
    if (label === '') continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,29}$/.test(label)) throw new OpError(`"${label}" is not a usable label.`);
    if (!out.includes(label)) out.push(label);
  }
  if (out.length > MAX_LABELS) throw new OpError(`An issue may carry at most ${MAX_LABELS} labels.`);
  return out;
}

export function createIssue(
  root: string,
  collection: string,
  repo: string,
  input: { title: string; body: string; author: string; labels?: string[] }
): IssueSummary {
  const dir = issuesDir(root, collection, repo);
  if (!dir) throw new OpError('invalid collection or repository name');
  const title = checkTitle(input.title);
  const body = checkBody(input.body);
  const labels = checkLabels(input.labels ?? []);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  // mkdir is the allocation: whoever creates the directory owns the number,
  // and a loser of the race simply tries the next one.
  let n = (numericDirs(dir).pop() ?? 0) + 1;
  for (let attempt = 0; attempt < 50; attempt++, n++) {
    const sub = path.join(dir, String(n));
    try {
      fs.mkdirSync(sub);
    } catch {
      continue;
    }
    fs.mkdirSync(path.join(sub, 'comments'), { recursive: true });
    writeDoc(
      path.join(sub, 'issue.md'),
      { title, state: 'open', author: input.author, created: now, updated: now, labels },
      body
    );
    touch(dir);
    return {
      number: n,
      title,
      state: 'open',
      author: input.author,
      created: now,
      updated: now,
      labels,
      comments: 0,
    };
  }
  throw new OpError('Could not allocate an issue number; try again.', 'conflict');
}

/** Read an issue's header for a write, refusing if it is not there. */
function openFor(root: string, collection: string, repo: string, n: number) {
  const dir = issueDir(root, collection, repo, n);
  const doc = dir ? readDoc(path.join(dir, 'issue.md')) : null;
  if (!dir || !doc) throw new OpError(`Issue ${n} does not exist.`, 'notfound');
  return { dir, doc };
}

export function addComment(
  root: string,
  collection: string,
  repo: string,
  n: number,
  input: { author: string; body: string }
): IssueComment {
  const { dir, doc } = openFor(root, collection, repo, n);
  const body = checkBody(input.body);
  if (body.trim() === '') throw new OpError('A comment needs something in it.');
  const commentsDir = path.join(dir, 'comments');
  fs.mkdirSync(commentsDir, { recursive: true });
  const used = fs
    .readdirSync(commentsDir)
    .filter((f) => /^[1-9][0-9]*\.md$/.test(f))
    .map((f) => parseInt(f, 10));
  const now = new Date().toISOString();
  let id = (used.length ? Math.max(...used) : 0) + 1;
  for (let attempt = 0; attempt < 50; attempt++, id++) {
    const file = path.join(commentsDir, `${id}.md`);
    if (fs.existsSync(file)) continue;
    writeDoc(file, { author: input.author, created: now }, body);
    writeDoc(path.join(dir, 'issue.md'), { ...doc.meta, updated: now }, doc.body);
    touchIssues(root, collection, repo);
    return { id, author: input.author, created: now, body };
  }
  throw new OpError('Could not add the comment; try again.', 'conflict');
}

export function setIssueState(
  root: string,
  collection: string,
  repo: string,
  n: number,
  state: 'open' | 'closed',
  actor: string
): void {
  const { dir, doc } = openFor(root, collection, repo, n);
  const now = new Date().toISOString();
  const meta: Record<string, unknown> = { ...doc.meta, state, updated: now };
  if (state === 'closed') {
    meta.closedBy = actor;
    meta.closedAt = now;
  } else {
    delete meta.closedBy;
    delete meta.closedAt;
  }
  writeDoc(path.join(dir, 'issue.md'), meta, doc.body);
  touchIssues(root, collection, repo);
}

export function editIssue(
  root: string,
  collection: string,
  repo: string,
  n: number,
  input: { title?: string; body?: string; labels?: string[] }
): void {
  const { dir, doc } = openFor(root, collection, repo, n);
  const meta: Record<string, unknown> = { ...doc.meta, updated: new Date().toISOString() };
  if (input.title !== undefined) meta.title = checkTitle(input.title);
  if (input.labels !== undefined) meta.labels = checkLabels(input.labels);
  const body = input.body === undefined ? doc.body : checkBody(input.body);
  writeDoc(path.join(dir, 'issue.md'), meta, body);
  touchIssues(root, collection, repo);
}

/** Move the issues directory's timestamp, invalidating the count cache. */
function touchIssues(root: string, collection: string, repo: string): void {
  const dir = issuesDir(root, collection, repo);
  if (dir) touch(dir);
}
