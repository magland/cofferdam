import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { writeFileAtomic } from './atomic';
import { OpError } from './ops';

// What issues and pull requests have in common.
//
// The two are stored the same way on purpose: a numbered directory holding a
// markdown file with a YAML frontmatter header, and a `comments/` directory of
// further markdown files beside it. A pull request is a discussion with a
// branch pair attached, so everything about the discussion half was written
// twice, and the copies had begun to drift in the small ways copies do. The
// bodies of `touch` differed only in a comment; `addComment` differed only in
// the noun in one message and the name of the header file.
//
// What is left in issues.ts and pulls.ts is what genuinely differs: labels and
// four sort orders on one side, base and head and merging on the other. What
// moved here is the storage shape, which neither owns.
//
// A `DiscussionKind` is how the caller says which of the two it is. It carries
// the header file's name, the directory the numbered ones sit in, and the noun
// to use in a message, because a person reading "That is longer than a
// discussion may be" would rightly wonder what a discussion is.

export const MAX_TITLE = 200;
export const MAX_BODY = 64 * 1024;

/** A markdown file's parsed frontmatter and the text after it. */
export interface Doc {
  meta: Record<string, unknown>;
  body: string;
}

export interface DiscussionComment {
  id: number;
  author: string;
  created: string;
  body: string;
}

export interface DiscussionKind {
  /** The header file inside a numbered directory: `issue.md` or `pull.md`. */
  doc: string;
  /** With its article, mid-sentence: "an issue" / "a pull request". */
  indefinite: string;
  /** The same, beginning a sentence: "An issue" / "A pull request". */
  Indefinite: string;
  /** Bare, beginning a sentence: "Issue" / "Pull request". */
  Bare: string;
  /** The directory holding the numbered ones, or null if the names are unusable. */
  dirFor(root: string, collection: string, repo: string): string | null;
}

/** The directory for one numbered issue or pull request. */
export function itemDir(
  kind: DiscussionKind,
  root: string,
  collection: string,
  repo: string,
  n: number
): string | null {
  const dir = kind.dirFor(root, collection, repo);
  if (!dir || !Number.isInteger(n) || n < 1) return null;
  return path.join(dir, String(n));
}

/** The numbered subdirectories of `dir`, in order. */
export function numericDirs(dir: string): number[] {
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
export function readDoc(file: string): Doc | null {
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

export function writeDoc(file: string, meta: Record<string, unknown>, body: string): void {
  const text = `---\n${YAML.stringify(meta).trimEnd()}\n---\n${body.replace(/\s+$/, '')}\n`;
  writeFileAtomic(file, text, { mode: 0o600 });
}

export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

export function countComments(dir: string): number {
  try {
    return fs.readdirSync(path.join(dir, 'comments')).filter((f) => /^[1-9][0-9]*\.md$/.test(f)).length;
  } catch {
    return 0;
  }
}

/**
 * Move a directory's timestamp, which is what invalidates the memoized open and
 * closed counts shown on every repository page. Every write calls it.
 */
export function touch(dir: string): void {
  const now = new Date();
  try {
    fs.utimesSync(dir, now, now);
  } catch {
    // The directory may not exist yet; the next read simply misses the cache.
  }
}

/** Every comment on one issue or pull request, oldest first. */
export function readComments(dir: string): DiscussionComment[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(path.join(dir, 'comments'));
  } catch {
    return [];
  }
  const out: DiscussionComment[] = [];
  for (const f of files.filter((x) => /^[1-9][0-9]*\.md$/.test(x)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const c = readDoc(path.join(dir, 'comments', f));
    if (!c) continue;
    out.push({
      id: parseInt(f, 10),
      author: str(c.meta.author, 'unknown'),
      created: str(c.meta.created),
      body: c.body,
    });
  }
  return out;
}

export function checkTitle(kind: DiscussionKind, title: string): string {
  const t = title.trim().replace(/\s+/g, ' ');
  if (t === '') throw new OpError(`${kind.Indefinite} needs a title.`);
  if (t.length > MAX_TITLE) throw new OpError(`A title may be at most ${MAX_TITLE} characters.`);
  return t;
}

export function checkBody(kind: DiscussionKind, body: string): string {
  const b = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (b.length > MAX_BODY) throw new OpError(`That is longer than ${kind.indefinite} may be.`);
  return b;
}

/** Read a header for a write, refusing if it is not there. */
export function openFor(
  kind: DiscussionKind,
  root: string,
  collection: string,
  repo: string,
  n: number
): { dir: string; doc: Doc } {
  const dir = itemDir(kind, root, collection, repo, n);
  const doc = dir ? readDoc(path.join(dir, kind.doc)) : null;
  if (!dir || !doc) throw new OpError(`${kind.Bare} ${n} does not exist.`, 'notfound');
  return { dir, doc };
}

export function addComment(
  kind: DiscussionKind,
  root: string,
  collection: string,
  repo: string,
  n: number,
  input: { author: string; body: string }
): DiscussionComment {
  const { dir, doc } = openFor(kind, root, collection, repo, n);
  const body = checkBody(kind, input.body);
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
    // Exclusive create is the allocation, as mkdir is for the numbers: an
    // existsSync test leaves a window in which two writers pick the same id,
    // and the second write would then replace the first comment outright.
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
    } catch {
      continue;
    }
    writeDoc(file, { author: input.author, created: now }, body);
    writeDoc(path.join(dir, kind.doc), { ...doc.meta, updated: now }, doc.body);
    const container = kind.dirFor(root, collection, repo);
    if (container) touch(container);
    return { id, author: input.author, created: now, body };
  }
  throw new OpError('Could not add the comment; try again.', 'conflict');
}

/**
 * Allocate the next free number and build the directory for it.
 *
 * mkdir is the allocation: whoever creates the directory owns the number, and
 * the filesystem decides that rather than a check that two writers could both
 * pass. A racing writer gets EEXIST and tries the next one.
 */
export function allocate(kind: DiscussionKind, dir: string, write: (sub: string, n: number) => void): number {
  fs.mkdirSync(dir, { recursive: true });
  let n = (numericDirs(dir).pop() ?? 0) + 1;
  for (let attempt = 0; attempt < 50; attempt++, n++) {
    const sub = path.join(dir, String(n));
    try {
      fs.mkdirSync(sub);
    } catch {
      continue;
    }
    fs.mkdirSync(path.join(sub, 'comments'), { recursive: true });
    write(sub, n);
    touch(dir);
    return n;
  }
  throw new OpError(`Could not allocate ${kind.indefinite} number; try again.`, 'conflict');
}
