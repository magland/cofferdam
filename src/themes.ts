// The theme collection. A theme is a set of semantic color (and typography)
// tokens emitted as CSS custom properties, plus the highlight.js stylesheet
// whose token colors suit it. The structural CSS in style.ts never names a
// color directly, so adding a theme means adding an entry here and nothing
// else.
//
// A theme is a property of the vault, not of the visitor: one vault is one
// interface, and the operator chooses how it looks. See config.ts for storage.

export interface ThemeVars {
  /** Page background and primary text. */
  bg: string;
  fg: string;
  fgMuted: string;
  fgSubtle: string;
  /** Raised areas: the top bar, table headers, buttons, box headers. */
  surface: string;
  surfaceHover: string;
  border: string;
  borderSoft: string;
  /** Links and other interactive text. */
  accent: string;
  /** Folder icons and similar decorative accents. */
  accentSoft: string;
  focus: string;
  /** The underline under the active repository tab. */
  tabMarker: string;
  chipBg: string;
  /** Affirmative buttons (create, commit, save). */
  primary: string;
  primaryHover: string;
  onPrimary: string;
  danger: string;
  dangerHover: string;
  onDanger: string;
  /** Markdown alert callouts; note uses accent and caution uses danger. */
  alertTip: string;
  alertImportant: string;
  alertWarning: string;
  diffAdd: string;
  diffDel: string;
  diffHunk: string;
  diffMeta: string;
  okBg: string;
  okBorder: string;
  errBg: string;
  errBorder: string;
  /** The drop shadow under a popover menu. */
  shadow: string;
  /** The background of a file line someone linked to (#L12). */
  lineMark: string;
  /** Backgrounds for file content, text inputs, and inline code. */
  codeBg: string;
  inputBg: string;
  inlineCodeBg: string;
  radius: string;
  fontUi: string;
  fontHead: string;
  fontMono: string;
}

export interface Theme {
  name: string;
  label: string;
  blurb: string;
  dark: boolean;
  /** A stylesheet name under highlight.js/styles (without the extension). */
  hljs: string;
  vars: ThemeVars;
}

const SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';
const MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
const SERIF = 'ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif';

export const THEMES: Theme[] = [
  {
    name: 'paper',
    label: 'Paper',
    blurb: 'Warm off-white with teal links and serif headings. The default.',
    dark: false,
    hljs: 'rose-pine-dawn',
    vars: {
      bg: '#fbf9f5',
      fg: '#2b2621',
      fgMuted: '#6c6157',
      fgSubtle: '#8a7f73',
      surface: '#f3ede4',
      surfaceHover: '#eae2d6',
      border: '#ddd3c4',
      borderSoft: '#e7dfd2',
      accent: '#0f6466',
      accentSoft: '#3f9295',
      focus: '#0f646633',
      tabMarker: '#c96442',
      chipBg: 'rgba(140,127,110,0.18)',
      primary: '#2f7d5d',
      primaryHover: '#276b4f',
      onPrimary: '#ffffff',
      danger: '#b3261e',
      dangerHover: '#961c16',
      onDanger: '#ffffff',
      alertTip: '#2f7d5d',
      alertImportant: '#7a4fa3',
      alertWarning: '#b5730f',
      diffAdd: '#e4f2e6',
      diffDel: '#fbe6e2',
      diffHunk: '#e2eef0',
      diffMeta: '#f5f0e8',
      okBg: '#e4f2e6',
      okBorder: '#2f7d5d55',
      errBg: '#fbe6e2',
      errBorder: '#b3261e55',
      shadow: 'rgba(43,38,33,0.16)',
      lineMark: '#f6ecd0',
      codeBg: '#fffdf9',
      inputBg: '#fffdf9',
      inlineCodeBg: 'rgba(140,127,110,0.18)',
      radius: '8px',
      fontUi: SANS,
      fontHead: SERIF,
      fontMono: MONO,
    },
  },
  {
    name: 'github',
    label: 'GitHub',
    blurb: 'The familiar light gray and blue, for people who want no surprises.',
    dark: false,
    hljs: 'github',
    vars: {
      bg: '#ffffff',
      fg: '#1f2328',
      fgMuted: '#57606a',
      fgSubtle: '#6e7781',
      surface: '#f6f8fa',
      surfaceHover: '#eef1f4',
      border: '#d0d7de',
      borderSoft: '#d8dee4',
      accent: '#0969da',
      accentSoft: '#54aeff',
      focus: '#0969da33',
      tabMarker: '#fd8c73',
      chipBg: 'rgba(175,184,193,0.2)',
      primary: '#1f883d',
      primaryHover: '#1a7f37',
      onPrimary: '#ffffff',
      danger: '#cf222e',
      dangerHover: '#a40e26',
      onDanger: '#ffffff',
      alertTip: '#1a7f37',
      alertImportant: '#8250df',
      alertWarning: '#9a6700',
      diffAdd: '#e6ffec',
      diffDel: '#ffebe9',
      diffHunk: '#ddf4ff',
      diffMeta: '#fafbfc',
      okBg: '#dafbe1',
      okBorder: '#1f883d55',
      errBg: '#ffebe9',
      errBorder: '#cf222e55',
      shadow: 'rgba(31,35,40,0.15)',
      lineMark: '#fff8c5',
      codeBg: '#ffffff',
      inputBg: '#ffffff',
      inlineCodeBg: 'rgba(175,184,193,0.2)',
      radius: '6px',
      fontUi: SANS,
      fontHead: SANS,
      fontMono: MONO,
    },
  },
  {
    name: 'slate',
    label: 'Slate',
    blurb: 'Cool gray surfaces with an indigo accent.',
    dark: false,
    hljs: 'atom-one-light',
    vars: {
      bg: '#ffffff',
      fg: '#1c1e2b',
      fgMuted: '#5a5f72',
      fgSubtle: '#767c8f',
      surface: '#f4f5f9',
      surfaceHover: '#e9ebf3',
      border: '#d5d8e3',
      borderSoft: '#e0e3ec',
      accent: '#4b46b8',
      accentSoft: '#8b86e8',
      focus: '#4b46b833',
      tabMarker: '#7c5cff',
      chipBg: 'rgba(120,126,150,0.18)',
      primary: '#4b46b8',
      primaryHover: '#3e3a9c',
      onPrimary: '#ffffff',
      danger: '#c02a3f',
      dangerHover: '#a11f32',
      onDanger: '#ffffff',
      alertTip: '#2f8a5a',
      alertImportant: '#7c5cff',
      alertWarning: '#a56b0a',
      diffAdd: '#e8f5ec',
      diffDel: '#fdeaed',
      diffHunk: '#ebeafb',
      diffMeta: '#f7f8fb',
      okBg: '#e8f5ec',
      okBorder: '#2f8a5a55',
      errBg: '#fdeaed',
      errBorder: '#c02a3f55',
      shadow: 'rgba(28,30,43,0.16)',
      lineMark: '#eeecfb',
      codeBg: '#ffffff',
      inputBg: '#ffffff',
      inlineCodeBg: 'rgba(120,126,150,0.16)',
      radius: '6px',
      fontUi: SANS,
      fontHead: SANS,
      fontMono: MONO,
    },
  },
  {
    name: 'midnight',
    label: 'Midnight',
    blurb: 'A dark theme with azure links, for low light.',
    dark: true,
    hljs: 'github-dark',
    vars: {
      bg: '#0f1319',
      fg: '#e6edf3',
      fgMuted: '#9198a1',
      fgSubtle: '#7d848d',
      surface: '#171d26',
      surfaceHover: '#1f2731',
      border: '#2b333f',
      borderSoft: '#232b35',
      accent: '#58a6ff',
      accentSoft: '#4b8fd6',
      focus: '#58a6ff44',
      tabMarker: '#f78166',
      chipBg: 'rgba(110,118,129,0.4)',
      primary: '#238636',
      primaryHover: '#2ea043',
      onPrimary: '#ffffff',
      danger: '#da3633',
      dangerHover: '#f85149',
      onDanger: '#ffffff',
      alertTip: '#3fb950',
      alertImportant: '#a371f7',
      alertWarning: '#d29922',
      diffAdd: '#12261c',
      diffDel: '#2d1417',
      diffHunk: '#0d2740',
      diffMeta: '#171d26',
      okBg: '#12261c',
      okBorder: '#2ea04366',
      errBg: '#2d1417',
      errBorder: '#f8514966',
      shadow: 'rgba(1,4,9,0.85)',
      lineMark: '#2b2512',
      codeBg: '#0d1117',
      inputBg: '#0d1117',
      inlineCodeBg: 'rgba(110,118,129,0.4)',
      radius: '6px',
      fontUi: SANS,
      fontHead: SANS,
      fontMono: MONO,
    },
  },
  {
    name: 'terminal',
    label: 'Terminal',
    blurb: 'Near-black, phosphor green, monospace throughout.',
    dark: true,
    hljs: 'monokai',
    vars: {
      bg: '#08090b',
      fg: '#d5ded7',
      fgMuted: '#7f8c84',
      fgSubtle: '#6b776f',
      surface: '#101315',
      surfaceHover: '#171b1e',
      border: '#242a2d',
      borderSoft: '#1c2124',
      accent: '#4ade80',
      accentSoft: '#3fae67',
      focus: '#4ade8044',
      tabMarker: '#4ade80',
      chipBg: 'rgba(120,140,128,0.28)',
      primary: '#166534',
      primaryHover: '#1a7a3f',
      onPrimary: '#eafff1',
      danger: '#b91c1c',
      dangerHover: '#dc2626',
      onDanger: '#ffffff',
      alertTip: '#4ade80',
      alertImportant: '#c084fc',
      alertWarning: '#facc15',
      diffAdd: '#0c2415',
      diffDel: '#2a1113',
      diffHunk: '#0b2027',
      diffMeta: '#101315',
      okBg: '#0c2415',
      okBorder: '#4ade8055',
      errBg: '#2a1113',
      errBorder: '#dc262655',
      shadow: 'rgba(0,0,0,0.8)',
      lineMark: '#13251a',
      codeBg: '#0a0c0e',
      inputBg: '#0a0c0e',
      inlineCodeBg: 'rgba(120,140,128,0.24)',
      radius: '3px',
      fontUi: MONO,
      fontHead: MONO,
      fontMono: MONO,
    },
  },
];

export const DEFAULT_THEME = 'paper';

export function findTheme(name: string | undefined | null): Theme | null {
  if (!name) return null;
  return THEMES.find((t) => t.name === name) ?? null;
}

export function resolveTheme(name: string | undefined | null): Theme {
  return findTheme(name) ?? findTheme(DEFAULT_THEME)!;
}

export function themeNames(): string[] {
  return THEMES.map((t) => t.name);
}

// One process serves one vault, and the theme is a property of the vault, so
// the active theme is process state rather than something threaded through
// every view. A middleware re-syncs it from config.json on each request, so
// hand-edits take effect without a restart.
let active: Theme = resolveTheme(DEFAULT_THEME);

export function setActiveTheme(name: string | undefined | null): void {
  active = resolveTheme(name);
}

export function activeTheme(): Theme {
  return active;
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

export function themeVarsCss(theme: Theme): string {
  const decls = Object.entries(theme.vars)
    .map(([k, v]) => `  --${kebab(k)}: ${v};`)
    .join('\n');
  return `:root {\n  color-scheme: ${theme.dark ? 'dark' : 'light'};\n${decls}\n}\n`;
}
