import hljs from 'highlight.js';

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const EXT_LANG: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  java: 'java',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  sql: 'sql',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  m: 'objectivec',
  r: 'r',
  jl: 'julia',
  pl: 'perl',
  lua: 'lua',
  diff: 'diff',
  patch: 'diff',
  txt: 'plaintext',
};

const NAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  cmakelists_txt: 'cmake',
};

export function languageFor(filename: string): string | null {
  const base = filename.split('/').pop() ?? filename;
  const byName = NAME_LANG[base.toLowerCase().replace(/\./g, '_')];
  if (byName) return byName;
  const dot = base.lastIndexOf('.');
  if (dot === -1) return null;
  return EXT_LANG[base.slice(dot + 1).toLowerCase()] ?? null;
}

export function highlightCode(text: string, filename: string): string {
  const lang = languageFor(filename);
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // fall through to plain
    }
  }
  return esc(text);
}

/**
 * Highlighted code split into one HTML string per line, so each line can be
 * its own element and so carry an anchor. highlight.js emits spans that cross
 * line boundaries (a block comment, a multi-line string), which is why this
 * cannot be a split on newline: open spans are closed at the end of a line and
 * reopened at the start of the next. The input is highlight.js output, whose
 * only tags are <span class="..."> and </span> and whose text is escaped, so
 * tokenizing on angle brackets is sound here and nowhere else.
 */
export function highlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = '';
  for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith('</')) {
      open.pop();
      current += token;
    } else if (token.startsWith('<')) {
      open.push(token);
      current += token;
    } else {
      const parts = token.split('\n');
      parts.forEach((part, i) => {
        if (i > 0) {
          current += '</span>'.repeat(open.length);
          lines.push(current);
          current = open.join('');
        }
        current += part;
      });
    }
  }
  lines.push(current);
  // A file that ends in a newline has no line after it, matching how the line
  // count is taken elsewhere.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "19 Aug 2026, 01:04" - the exact time, shown as the tooltip on a relative one. */
export function formatDateFull(iso: string): string {
  const d = new Date(iso);
  if (!iso || isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Thresholds for timeAgo, coarsest last: below `limit` seconds, divide by
// `secs` (rounding down, so an age never reads older than it is) and name the
// unit. A dedicated "yesterday" sits between hours and days because that is
// what the reader would say.
const AGO_UNITS: { limit: number; secs: number; unit: string }[] = [
  { limit: 3600, secs: 60, unit: 'minute' },
  { limit: 24 * 3600, secs: 3600, unit: 'hour' },
  { limit: 30 * 86400, secs: 86400, unit: 'day' },
  { limit: 365 * 86400, secs: 30 * 86400, unit: 'month' },
  { limit: Infinity, secs: 365 * 86400, unit: 'year' },
];

/**
 * A relative time in words: "now", "3 minutes ago", "yesterday", "2 years
 * ago". Dates the clock puts in the future (skew, or a rewritten commit) read
 * as "in 3 minutes" rather than as an absurd age. The exact time is never
 * lost: timeTag() keeps it in the tooltip and in the datetime attribute.
 */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (!iso || isNaN(d.getTime())) return iso;
  const delta = (now.getTime() - d.getTime()) / 1000;
  const secs = Math.abs(delta);
  const future = delta < 0;
  if (secs < 60) return 'now';
  if (!future && secs >= 24 * 3600 && secs < 48 * 3600) return 'yesterday';
  const step = AGO_UNITS.find((u) => secs < u.limit)!;
  const n = Math.floor(secs / step.secs);
  const phrase = `${n} ${step.unit}${n === 1 ? '' : 's'}`;
  return future ? `in ${phrase}` : `${phrase} ago`;
}

/**
 * A relative time as a <time> element, with the exact time in its tooltip.
 * Rendering is server-side and so is the "now" it counts from, which is why
 * the datetime attribute carries the original timestamp: a reader who wants
 * precision hovers, and a machine reading the page gets ISO 8601.
 */
export function timeTag(iso: string, cls = 'muted'): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return esc(iso);
  return `<time class="${cls}" datetime="${esc(d.toISOString())}" title="${esc(formatDateFull(iso))}">${esc(
    timeAgo(iso)
  )}</time>`;
}
