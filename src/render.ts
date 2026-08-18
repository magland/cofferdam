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
