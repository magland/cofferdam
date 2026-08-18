import MarkdownIt from 'markdown-it';
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

export function isMarkdownFile(filename: string): boolean {
  const base = filename.split('/').pop() ?? filename;
  return /\.(md|markdown)$/i.test(base);
}

// GitHub-style heading anchors: lowercase, punctuation dropped, spaces to hyphens.
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/[\s_]+/g, '-');
}

export function renderMarkdown(text: string, opts: { rawBase: string; blobBase: string }): string {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } catch {
          // fall through: an empty return makes markdown-it escape the code itself
        }
      }
      return '';
    },
  });
  const isRelative = (u: string) => !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(u);
  // Resolve a relative reference against the file's directory, collapsing the
  // dot segments ourselves so the emitted href is the path a reader would type.
  const rewrite = (u: string, base: string) => {
    const cut = u.search(/[#?]/);
    const rel = cut === -1 ? u : u.slice(0, cut);
    const suffix = cut === -1 ? '' : u.slice(cut);
    const out: string[] = [];
    for (const seg of `${base}/${rel}`.split('/')) {
      if (seg === '.') continue;
      if (seg === '..') {
        if (out.length > 1) out.pop();
        continue;
      }
      out.push(seg);
    }
    return out.join('/') + suffix;
  };
  const defaultImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const src = tokens[idx].attrGet('src');
    if (src && isRelative(src)) tokens[idx].attrSet('src', rewrite(src, opts.rawBase));
    return defaultImage(tokens, idx, options, env, self);
  };
  const defaultLink =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = tokens[idx].attrGet('href');
    if (href && isRelative(href)) tokens[idx].attrSet('href', rewrite(href, opts.blobBase));
    return defaultLink(tokens, idx, options, env, self);
  };
  const used = new Map<string, number>();
  md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
    const inline = tokens[idx + 1];
    const slug = slugify(inline && inline.type === 'inline' ? inline.content : '');
    if (slug) {
      const seen = used.get(slug) ?? 0;
      used.set(slug, seen + 1);
      tokens[idx].attrSet('id', seen === 0 ? slug : `${slug}-${seen}`);
    }
    return self.renderToken(tokens, idx, options);
  };
  return md.render(text);
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
