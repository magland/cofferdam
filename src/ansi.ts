import { esc } from './render';

// Terminal escape sequences in job logs, rendered rather than shown.
//
// Build tools colour their output, and a runner captures those bytes as they
// are. Shown escaped, a log reads as `[36mvite[39m`, which is worst exactly
// when someone is reading it hardest: a failed build. So the step view renders
// SGR sequences -- colours, bold, dim -- as styled spans, and drops every
// other escape. The log file itself is untouched; this is presentation only.
//
// Two deliberate simplifications. Background colours are dropped rather than
// rendered, since a background chosen against someone else's terminal theme is
// unreadable against ours more often than not. And a carriage return is
// resolved the way a terminal would show it at rest: the text after the last
// one wins, which collapses a progress bar's thousand rewrites into its final
// state instead of a thousand duplicated lines.

/** One SGR-styled run of text. */
interface Style {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  /** A class name from the palette, or an inline CSS colour, or null for the default. */
  fgClass: string | null;
  fgColor: string | null;
}

const DEFAULT: Style = { bold: false, dim: false, italic: false, underline: false, fgClass: null, fgColor: null };

// Each class resolves to an --ansi-* token the active theme defines (see
// themes.ts), so a dark theme brightens the palette and a light one darkens
// it, like every other colour in the interface.
const FG_CLASS: Record<number, string> = {
  30: 'a-blk', 31: 'a-red', 32: 'a-grn', 33: 'a-yel',
  34: 'a-blu', 35: 'a-mag', 36: 'a-cyn', 37: 'a-wht',
  90: 'a-bblk', 91: 'a-bred', 92: 'a-bgrn', 93: 'a-byel',
  94: 'a-bblu', 95: 'a-bmag', 96: 'a-bcyn', 97: 'a-bwht',
};

/** The 6x6x6 cube's channel values, per xterm. */
const CUBE = [0, 95, 135, 175, 215, 255];

/**
 * A 256-colour or truecolour foreground as inline CSS, pulled towards the
 * middle when it sits at either extreme: near-white is invisible on a light
 * theme and near-black on a dark one, and a log has to be readable on both.
 */
function inlineColor(r: number, g: number, b: number): string {
  const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (l > 0.82 || l < 0.18) return 'var(--fg-muted, #6e7781)';
  return `rgb(${r},${g},${b})`;
}

function color256(n: number): string | null {
  if (n < 0 || n > 255) return null;
  if (n < 8) return null; // caller maps to the classed palette
  if (n < 16) return null;
  if (n < 232) {
    const c = n - 16;
    return inlineColor(CUBE[Math.floor(c / 36)], CUBE[Math.floor(c / 6) % 6], CUBE[c % 6]);
  }
  const v = 8 + (n - 232) * 10;
  return inlineColor(v, v, v);
}

/** Apply one SGR parameter list to a style, consuming extended-colour params. */
function applySgr(params: number[], style: Style): Style {
  const s = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) Object.assign(s, DEFAULT);
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 22) { s.bold = false; s.dim = false; }
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p === 39) { s.fgClass = null; s.fgColor = null; }
    else if (FG_CLASS[p]) { s.fgClass = FG_CLASS[p]; s.fgColor = null; }
    else if (p === 38 || p === 48) {
      // Extended colour; 48 (background) consumes its params and is dropped.
      const mode = params[i + 1];
      if (mode === 5) {
        const n = params[i + 2] ?? -1;
        if (p === 38) {
          if (n >= 0 && n < 8) { s.fgClass = FG_CLASS[30 + n]; s.fgColor = null; }
          else if (n >= 8 && n < 16) { s.fgClass = FG_CLASS[90 + (n - 8)]; s.fgColor = null; }
          else { const c = color256(n); if (c) { s.fgColor = c; s.fgClass = null; } }
        }
        i += 2;
      } else if (mode === 2) {
        if (p === 38) { s.fgColor = inlineColor(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0); s.fgClass = null; }
        i += 4;
      }
    }
    // 40-47, 100-107 backgrounds and everything else: dropped.
  }
  return s;
}

/**
 * A terminal shows a line with carriage returns in it as whatever was written
 * after the last one, so that is what the reader gets: `50%\r100%` is `100%`,
 * and a line that ends mid-rewrite falls back to its last non-empty state.
 */
function resolveCr(line: string): string {
  if (!line.includes('\r')) return line;
  const parts = line.split('\r');
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] !== '') return parts[i];
  }
  return '';
}

// SGR is captured; every other escape -- cursor movement, OSC titles, stray
// escapes -- matches an uncaptured alternative and is dropped.
const TOKEN = /\x1b\[([0-9;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-9;?]*[A-Za-z]|\x1b./g;

/** The line with every escape sequence removed and carriage returns resolved: what a live tail appends as text. */
export function stripAnsi(line: string): string {
  return resolveCr(line).replace(TOKEN, '');
}

/**
 * The line as HTML: text escaped, SGR styling as spans. The classes and the
 * clamped inline colours are the only markup that can come out of it, whatever
 * bytes a job wrote.
 */
export function ansiLineHtml(line: string): string {
  const resolved = resolveCr(line);
  if (!resolved.includes('\x1b')) return esc(resolved);
  let out = '';
  let style: Style = { ...DEFAULT };
  let last = 0;
  const emit = (text: string) => {
    if (text === '') return;
    const classes = [
      style.fgClass,
      style.bold ? 'a-b' : null,
      style.dim ? 'a-d' : null,
      style.italic ? 'a-i' : null,
      style.underline ? 'a-u' : null,
    ].filter((c): c is string => c !== null);
    const styled = classes.length > 0 || style.fgColor !== null;
    if (!styled) {
      out += esc(text);
      return;
    }
    const cls = classes.length ? ` class="${classes.join(' ')}"` : '';
    const inline = style.fgColor ? ` style="color:${style.fgColor}"` : '';
    out += `<span${cls}${inline}>${esc(text)}</span>`;
  };
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(resolved); m !== null; m = TOKEN.exec(resolved)) {
    emit(resolved.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      const params = m[1] === '' ? [0] : m[1].split(';').map((x) => (x === '' ? 0 : parseInt(x, 10)));
      style = applySgr(params, style);
    }
  }
  emit(resolved.slice(last));
  return out;
}
