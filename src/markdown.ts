// Markdown rendering for repository documents.
//
// The target is what GitHub renders, since that is what people write their
// READMEs against: fenced code with syntax highlighting, LaTeX math, tables,
// task lists, footnotes, alert callouts, emoji shortcodes, autolinks, heading
// anchors, and a conservative subset of inline HTML.
//
// Two properties are load-bearing and should survive any later rewrite. First,
// nothing a document author writes may become active markup on this origin: the
// rendered output passes through an allowlist sanitizer, and the allowlist has
// no `style` attribute, no scripts, no frames. Second, everything is rendered
// on the server; no page needs client-side JavaScript to read.
//
// Trusted fragments we generate ourselves (highlighted code, KaTeX output)
// would not survive that allowlist intact, so they are parked in slots: the
// renderer emits an opaque marker, the sanitizer sees plain text, and the
// fragments are substituted back afterwards. The marker is random per render,
// so a document cannot forge one.

import * as crypto from 'crypto';
import hljs from 'highlight.js';
import katex from 'katex';
import MarkdownIt from 'markdown-it';
import katexPlugin from '@vscode/markdown-it-katex';
import { full as emojiPlugin } from 'markdown-it-emoji';
import footnotePlugin from 'markdown-it-footnote';
import sanitizeHtml from 'sanitize-html';
import { esc } from './render';

export interface MarkdownOpts {
  /** Base URL for relative image sources (the raw endpoint). */
  rawBase: string;
  /** Base URL for relative links (the blob endpoint). */
  blobBase: string;
}

export function isMarkdownFile(filename: string): boolean {
  const base = filename.split('/').pop() ?? filename;
  return /\.(md|markdown)$/i.test(base);
}

const ALERTS: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
};

// GitHub-style heading anchors: lowercase, punctuation dropped, spaces to hyphens.
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/[\s_]+/g, '-');
}

function isRelative(url: string): boolean {
  return !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(url);
}

// Resolve a relative reference against the file's directory, collapsing the
// dot segments ourselves so the emitted URL is the path a reader would type.
function resolveRef(url: string, base: string): string {
  const cut = url.search(/[#?]/);
  const rel = cut === -1 ? url : url.slice(0, cut);
  const suffix = cut === -1 ? '' : url.slice(cut);
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
}

const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'div', 'span', 'section',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'samp', 'kbd', 'var',
  'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'a', 'img', 'picture',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'details', 'summary', 'figure', 'figcaption',
  'abbr', 'cite', 'q', 'input',
];

// No `style` anywhere: an inline style on document content could cover the
// rest of the page, which is a phishing surface even without scripting.
const ALLOWED_ATTRS: Record<string, string[]> = {
  '*': ['id', 'class', 'title', 'align', 'dir', 'lang', 'role', 'aria-label', 'aria-hidden'],
  a: ['href', 'name', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'loading'],
  th: ['colspan', 'rowspan', 'scope', 'valign'],
  td: ['colspan', 'rowspan', 'valign'],
  col: ['span', 'width'],
  colgroup: ['span'],
  ol: ['start', 'type', 'reversed'],
  li: ['value'],
  details: ['open'],
  input: ['type', 'checked', 'disabled'],
};

function sanitizeOptions(opts: MarkdownOpts): sanitizeHtml.IOptions {
  return {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS,
    allowedSchemes: ['http', 'https', 'mailto', 'ftp'],
    allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
    allowProtocolRelative: false,
    transformTags: {
      // Rewriting here rather than in a renderer rule covers links written as
      // markdown and links written as HTML with one implementation.
      a: (tagName, attribs) => {
        const href = attribs.href;
        if (href && isRelative(href)) {
          attribs.href = resolveRef(href, opts.blobBase);
        } else if (href && /^https?:/i.test(href)) {
          attribs.rel = 'nofollow noopener noreferrer';
        }
        return { tagName, attribs };
      },
      img: (tagName, attribs) => {
        const src = attribs.src;
        if (src && isRelative(src)) attribs.src = resolveRef(src, opts.rawBase);
        attribs.loading = 'lazy';
        return { tagName, attribs };
      },
    },
  };
}

function highlight(code: string, lang: string | null): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // fall through to plain escaping
    }
  }
  return esc(code);
}

function mathHtml(src: string, display: boolean): string {
  try {
    return katex.renderToString(src, {
      displayMode: display,
      throwOnError: false,
      // trust:false keeps \href, \htmlClass and friends from emitting markup;
      // maxSize bounds \rule and similar from blowing up the page.
      trust: false,
      maxSize: 500,
      strict: false,
    });
  } catch {
    return `<code class="math-error">${esc(src)}</code>`;
  }
}

export function renderMarkdown(text: string, opts: MarkdownOpts): string {
  const slots: string[] = [];
  const marker = `md${crypto.randomBytes(9).toString('hex')}`;
  const slot = (html: string): string => {
    slots.push(html);
    return `${marker}_${slots.length - 1}_`;
  };

  const md = new MarkdownIt({ html: true, linkify: true });
  md.use(footnotePlugin);
  md.use(emojiPlugin);

  const codeBlock = (code: string, lang: string | null): string => {
    const cls = lang ? ` class="language-${esc(lang)}"` : '';
    // The button sits after the <pre> because the page's copyCmd() copies its
    // previous sibling.
    return `${slot(
      `<div class="code-block"><pre><code${cls}>${highlight(
        code,
        lang
      )}</code></pre><button class="copy-btn" type="button" onclick="copyCmd(this)">Copy</button></div>`
    )}\n`;
  };
  const mathBlock = (src: string): string => `<div class="math-block">${slot(mathHtml(src, true))}</div>\n`;

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const info = token.info.trim().split(/\s+/)[0].toLowerCase();
    if (info === 'math') return mathBlock(token.content);
    return codeBlock(token.content, info || null);
  };
  md.renderer.rules.code_block = (tokens, idx) => codeBlock(tokens[idx].content, null);

  // The plugin renders math itself; we route it through a slot instead so the
  // sanitizer never has to allow KaTeX's own markup.
  md.use(katexPlugin, {});
  md.renderer.rules.math_inline = (tokens, idx) => slot(mathHtml(tokens[idx].content, false));
  md.renderer.rules.math_block = (tokens, idx) => mathBlock(tokens[idx].content);
  md.renderer.rules.math_inline_block = (tokens, idx) => mathBlock(tokens[idx].content);

  // markdown-it expresses column alignment as an inline style, which the
  // sanitizer strips; carry it in the align attribute instead, as GitHub does.
  const alignRule: MarkdownIt.Renderer.RenderRule = (tokens, idx, options, _env, self) => {
    const token = tokens[idx];
    const style = token.attrGet('style');
    const m = style ? /text-align:\s*(left|center|right)/.exec(style) : null;
    if (m && token.attrs) {
      token.attrs = token.attrs.filter((a) => a[0] !== 'style');
      token.attrSet('align', m[1]);
    }
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.th_open = alignRule;
  md.renderer.rules.td_open = alignRule;

  const used = new Map<string, number>();
  let pendingSlug = '';
  md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
    const inline = tokens[idx + 1];
    const slug = slugify(inline && inline.type === 'inline' ? inline.content : '');
    pendingSlug = '';
    if (slug) {
      const seen = used.get(slug) ?? 0;
      used.set(slug, seen + 1);
      pendingSlug = seen === 0 ? slug : `${slug}-${seen}`;
      tokens[idx].attrSet('id', pendingSlug);
    }
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.heading_close = (tokens, idx, options, _env, self) => {
    const anchor = pendingSlug
      ? `<a class="heading-anchor" href="#${pendingSlug}" aria-label="Permalink to this heading">#</a>`
      : '';
    pendingSlug = '';
    return anchor + self.renderToken(tokens, idx, options);
  };

  // Alert callouts and task lists are both a marker at the head of a
  // paragraph, so both are handled before inline parsing turns that paragraph
  // into children: rewriting `content` here is all it takes.
  md.core.ruler.before('inline', 'github_extras', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (
        token.type === 'blockquote_open' &&
        tokens[i + 1]?.type === 'paragraph_open' &&
        tokens[i + 2]?.type === 'inline'
      ) {
        const m = /^\[!(note|tip|important|warning|caution)\][ \t]*(\r?\n|$)/i.exec(tokens[i + 2].content);
        if (m) {
          const kind = m[1].toLowerCase();
          token.attrJoin('class', `alert alert-${kind}`);
          const rest = tokens[i + 2].content.slice(m[0].length);
          tokens[i + 2].content = rest;
          if (rest.trim() === '') {
            tokens[i + 1].hidden = true;
            tokens[i + 3].hidden = true;
          }
          const title = new state.Token('html_block', '', 0);
          title.content = `<p class="alert-title">${ALERTS[kind]}</p>\n`;
          tokens.splice(i + 1, 0, title);
          i += 1;
        }
        continue;
      }
      if (
        token.type === 'inline' &&
        tokens[i - 1]?.type === 'paragraph_open' &&
        tokens[i - 2]?.type === 'list_item_open'
      ) {
        const m = /^\[([ xX])\][ \t]+/.exec(token.content);
        if (m) {
          const checked = m[1].toLowerCase() === 'x' ? ' checked' : '';
          token.content = `<input type="checkbox" disabled${checked}> ${token.content.slice(m[0].length)}`;
          tokens[i - 2].attrJoin('class', 'task-item');
        }
      }
    }
  });

  const html = sanitizeHtml(md.render(text), sanitizeOptions(opts));
  return html.replace(new RegExp(`${marker}_(\\d+)_`, 'g'), (_all, n: string) => slots[Number(n)] ?? '');
}
