import { esc } from './render';

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

export function renderDiff(patch: string): string {
  const lines = patch.split('\n');
  const files: { name: string; lines: string[] }[] = [];
  let cur: { name: string; lines: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      cur = { name: m ? m[2] : line.slice('diff --git '.length), lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.lines.push(line);
  }
  if (files.length === 0) {
    return '<p class="muted">No changes.</p>';
  }
  return files
    .map((f) => {
      const body = f.lines
        .map((l) => {
          let cls = 'ctx';
          if (l.startsWith('@@')) cls = 'hunk';
          else if (META_PREFIXES.some((p) => l.startsWith(p))) cls = 'meta';
          else if (l.startsWith('+')) cls = 'add';
          else if (l.startsWith('-')) cls = 'del';
          return `<div class="dline ${cls}">${esc(l) || '&nbsp;'}</div>`;
        })
        .join('');
      return `<div class="diff-file"><div class="diff-file-header">${esc(f.name)}</div><div class="diff-body">${body}</div></div>`;
    })
    .join('');
}
