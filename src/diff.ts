import { icon } from './icons';
import { esc } from './render';

// Unified diff to HTML. Two things a patch carries that a plain rendering
// throws away are recovered here: the line numbers each side of a hunk, and
// the shape of the change (how many lines each file gained and lost, and
// whether it was added, deleted, or renamed). Both are what a reader uses to
// orient in a diff, so both are rendered.

const META_PREFIXES = [
  '+++',
  '---',
  'index ',
  'new file',
  'deleted file',
  'similarity',
  'dissimilarity',
  'rename',
  'copy',
  'old mode',
  'new mode',
  'Binary files',
  '\\',
];

/** How many lines of one file's diff we render before offering the file instead. */
const MAX_FILE_LINES = 2000;

type FileStatus = 'added' | 'deleted' | 'renamed' | 'modified';

interface DiffFile {
  path: string;
  oldPath: string;
  status: FileStatus;
  binary: boolean;
  added: number;
  removed: number;
  lines: string[];
}

export interface DiffOpts {
  /** Base for "View file" links: a blob URL missing only `/<path>`. */
  blobBase?: string;
}

function parse(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  for (const line of patch.split('\n')) {
    const start = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (line.startsWith('diff --git ')) {
      cur = {
        path: start ? start[2] : line.slice('diff --git '.length),
        oldPath: start ? start[1] : '',
        status: 'modified',
        binary: false,
        added: 0,
        removed: 0,
        lines: [],
      };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file')) cur.status = 'added';
    else if (line.startsWith('deleted file')) cur.status = 'deleted';
    else if (line.startsWith('rename to ')) cur.status = 'renamed';
    else if (line.startsWith('Binary files')) cur.binary = true;
    else if (line.startsWith('+') && !line.startsWith('+++')) cur.added++;
    else if (line.startsWith('-') && !line.startsWith('---')) cur.removed++;
    cur.lines.push(line);
  }
  return files;
}

/**
 * The five-square bar GitHub puts beside a file's counts: green for the
 * share of the change that was additions, red for deletions, and grey for
 * the rest, so a glance separates a rewrite from a one-line fix.
 */
function statBar(added: number, removed: number): string {
  const total = added + removed;
  const green = total === 0 ? 0 : Math.max(added > 0 ? 1 : 0, Math.round((added / total) * 5));
  const red = total === 0 ? 0 : Math.min(5 - green, Math.max(removed > 0 ? 1 : 0, 5 - green));
  const square = (cls: string, n: number) => `<span class="sq ${cls}"></span>`.repeat(n);
  return `<span class="statbar" aria-hidden="true">${square('add', green)}${square('del', red)}${square(
    'none',
    Math.max(0, 5 - green - red)
  )}</span>`;
}

function counts(added: number, removed: number): string {
  return `<span class="stat-add">+${added}</span><span class="stat-del">&minus;${removed}</span>${statBar(
    added,
    removed
  )}`;
}

const STATUS_LABEL: Record<FileStatus, string> = {
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  modified: 'modified',
};

function renderBody(file: DiffFile): string {
  if (file.binary) return `<div class="diff-none muted">Binary file not shown.</div>`;
  if (file.lines.length > MAX_FILE_LINES) {
    return `<div class="diff-none muted">This diff is ${file.lines.length.toLocaleString(
      'en-US'
    )} lines long and is not shown.</div>`;
  }
  // Line numbers come from the hunk headers: a context line advances both
  // sides, an addition only the new one, a removal only the old one.
  let oldNo = 0;
  let newNo = 0;
  const rows = file.lines.map((l) => {
    let cls = 'ctx';
    let left = '';
    let right = '';
    const hunk = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldNo = parseInt(hunk[1], 10);
      newNo = parseInt(hunk[2], 10);
      cls = 'hunk';
    } else if (META_PREFIXES.some((p) => l.startsWith(p))) {
      cls = 'meta';
    } else if (l.startsWith('+')) {
      cls = 'add';
      right = String(newNo++);
    } else if (l.startsWith('-')) {
      cls = 'del';
      left = String(oldNo++);
    } else if (l !== '') {
      left = String(oldNo++);
      right = String(newNo++);
    }
    return `<div class="dline ${cls}"><span class="dnum">${left}</span><span class="dnum">${right}</span><span class="dtext">${
      esc(l) || '&nbsp;'
    }</span></div>`;
  });
  return `<div class="diff-body">${rows.join('')}</div>`;
}

export function renderDiff(patch: string, opts: DiffOpts = {}): string {
  const files = parse(patch);
  if (files.length === 0) return '<p class="muted">No changes.</p>';
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const summary = `<div class="diff-summary"><b>${files.length} changed file${
    files.length === 1 ? '' : 's'
  }</b>${counts(added, removed)}</div>`;
  const boxes = files
    .map((f, i) => {
      const view = opts.blobBase
        ? `<a class="btn" href="${opts.blobBase}/${f.path
            .split('/')
            .map(encodeURIComponent)
            .join('/')}" title="View the whole file at this revision">View file</a>`
        : '';
      const renamed = f.status === 'renamed' && f.oldPath ? `<span class="muted small">${esc(f.oldPath)} &rarr;</span>` : '';
      // Each file is a <details>, so a reader can fold away what they have
      // read; the summary keeps the name, the counts, and the way to the file.
      return `<details class="diff-file" id="diff-${i}" open>
<summary class="diff-file-header">${icon('chevron-down', 'fold')}${renamed}<span class="diff-path mono">${esc(
        f.path
      )}</span><span class="chip">${STATUS_LABEL[f.status]}</span><span class="diff-file-stat">${counts(
        f.added,
        f.removed
      )}</span>${view}</summary>
${renderBody(f)}
</details>`;
    })
    .join('');
  return `${summary}${boxes}`;
}
