import { Html, raw } from './html';

// The icon set: drawn here, in the same language as the logo.
//
// feorge ships no static files, so an icon is a string of SVG markup rather
// than a sprite sheet or a font. Each entry below is the interior of one glyph
// on a 24-unit grid. The wrapper is added by icon() so every icon carries the
// same box, the same class, and the same accessibility treatment.
//
// The drawings are monoline: a constant stroke of 2 units with round caps and
// joins, no fills except where a shape has to read as solid at 16 pixels (the
// dot in an open issue, the three dots of a menu). This is the construction
// the mark and the logotype use, so the interface and the brand are one
// drawing rather than two. It is also why the shapes are built from circles,
// arcs, and straight runs, and why nothing here is an outline of a filled
// form: an outline would need a second weight, and there is only one.
//
// The grid is 24 while the box is 16, which gives half-unit positions at the
// rendered size without fractional coordinates in the source. Strokes are kept
// two units clear of the edges so a round cap is never cut by the viewBox.
//
// Icons take their colour from the surrounding text (stroke="currentColor"),
// which is what lets them sit inside links, buttons, and muted labels without
// a per-theme variant. Where a different colour is wanted, pass a class and
// give that class a colour token in style.ts.

const DOT = (cx: number, cy: number, r = 1.6) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;

const PATHS: Record<string, string> = {
  // Marks and arrows.
  check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
  x: '<path d="M6 6 18 18M18 6 6 18"/>',
  plus: '<path d="M12 4.5V19.5M4.5 12H19.5"/>',
  'chevron-down': '<path d="M6 9.5 12 15.5 18 9.5"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
  dot: `<circle cx="12" cy="12" r="9"/>${DOT(12, 12, 3.2)}`,
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M7.5 12.2 10.6 15.3 16.5 9.2"/>',
  'x-circle': '<circle cx="12" cy="12" r="9"/><path d="M8.8 8.8 15.2 15.2M15.2 8.8 8.8 15.2"/>',
  alert:
    `<path d="M10.3 3.9a2 2 0 0 1 3.4 0l7.5 13a2 2 0 0 1-1.7 3H4.5a2 2 0 0 1-1.7-3Z"/><path d="M12 9.5V14"/>${DOT(12, 17.3, 1.2)}`,
  skip: '<circle cx="12" cy="12" r="9"/><path d="M8 12H16"/>',
  stop: '<circle cx="12" cy="12" r="9"/><path d="M5.6 18.4 18.4 5.6"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="M10 8.4 16 12 10 15.6Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6.8V12L15.6 14.1"/>',
  sync: '<path d="M12 3.5a8.5 8.5 0 1 1-8.5 8.5"/><path d="M1.9 14.6 3.5 12 5.1 14.6"/>',
  kebab: `${DOT(5, 12)}${DOT(12, 12)}${DOT(19, 12)}`,

  // Repositories and their contents.
  repo: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8.5 3V21"/>',
  'repo-forked':
    '<circle cx="6" cy="5" r="2.5"/><circle cx="18" cy="5" r="2.5"/><circle cx="12" cy="19" r="2.5"/><path d="M6 7.5v1.5a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7.5M12 12v4.5"/>',
  book: '<path d="M2.5 4.5h5.5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5.5v12H16a4 4 0 0 0-4 4 4 4 0 0 0-4-4H2.5Z"/><path d="M12 8.5v12"/>',
  file: '<path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5Z"/><path d="M13.5 3v5.5H19"/>',
  'file-zip':
    '<path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5Z"/><path d="M13.5 3v5.5H19"/><path d="M9 6.5h1.5M9 10h1.5M9 13.5h1.5"/>',
  folder:
    '<path d="M3 19.5V6.5A1.5 1.5 0 0 1 4.5 5h4.1a1.5 1.5 0 0 1 1.2.6l1.3 1.8a1.5 1.5 0 0 0 1.2.6h7.2A1.5 1.5 0 0 1 21 9.5v10A1.5 1.5 0 0 1 19.5 21h-15A1.5 1.5 0 0 1 3 19.5Z"/>',
  code: '<path d="M8.5 6 3.5 12 8.5 18M15.5 6 20.5 12 15.5 18"/>',
  versions: '<rect x="9" y="3" width="12" height="18" rx="2"/><path d="M6 5.5V18.5M3 8V16"/>',
  package:
    '<path d="M3.2 7.2 12 2.4l8.8 4.8v9.6L12 21.6l-8.8-4.8Z"/><path d="M3.2 7.2 12 12l8.8-4.8M12 12v9.6"/>',
  tag: '<path d="M13.6 3.6A2 2 0 0 0 12.2 3H5a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l7.2 7.2a2 2 0 0 0 2.8 0l7.2-7.2a2 2 0 0 0 0-2.8Z"/><circle cx="7.6" cy="7.6" r="1.4"/>',
  law: '<path d="M12 4V21M8 21h8M4.5 7.5 12 6l7.5 1.5"/><path d="M4.5 7.5 2 13a2.5 2.5 0 0 0 5 0Z"/><path d="M19.5 7.5 17 13a2.5 2.5 0 0 0 5 0Z"/>',

  // The git graph.
  'git-commit': '<circle cx="12" cy="12" r="3.6"/><path d="M2.5 12h5.9M15.6 12h5.9"/>',
  'git-branch':
    '<circle cx="6" cy="18.5" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M6 16V3M18 8.5a9.5 9.5 0 0 1-9.5 9.5H8"/>',
  'git-merge':
    '<circle cx="6" cy="5.5" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M6 8v13.5M6 10a8.5 8.5 0 0 0 8.5 8.5h1"/>',
  'git-pull-request':
    '<circle cx="6" cy="5.5" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M6 8v13.5"/><path d="M13 5.5h2.5A2.5 2.5 0 0 1 18 8v8"/><path d="M15.5 3 13 5.5 15.5 8"/>',
  'git-pull-request-closed':
    '<circle cx="6" cy="5.5" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M6 8v13.5"/><path d="M18 16v-4.5"/><path d="M15 4 21 10M21 4 15 10"/>',
  'git-compare':
    '<path d="M4 19.5V8.5A2.5 2.5 0 0 1 6.5 6H14"/><path d="M11.5 3.5 14 6 11.5 8.5"/><path d="M20 4.5v11a2.5 2.5 0 0 1-2.5 2.5H10"/><path d="M12.5 15.5 10 18 12.5 20.5"/>',
  history: `<path d="M5.5 7.5v3M5.5 13.5v3"/>${DOT(5.5, 5.5, 2)}${DOT(5.5, 12, 2)}${DOT(5.5, 18.5, 2)}<path d="M11 5.5h9.5M11 12h9.5M11 18.5h6"/>`,

  // Issues, pulls, and talk.
  'issue-opened': `<circle cx="12" cy="12" r="9"/>${DOT(12, 12, 2.2)}`,
  'issue-closed': '<circle cx="12" cy="12" r="9"/><path d="M7.5 12.2 10.6 15.3 16.5 9.2"/>',
  comment:
    '<path d="M4.5 21V6.5A2.5 2.5 0 0 1 7 4h10A2.5 2.5 0 0 1 19.5 6.5v8A2.5 2.5 0 0 1 17 17H8.5Z"/>',
  filter: '<path d="M3.5 6.5h17M6.5 12h11M10 17.5h4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.2 15.2 20.5 20.5"/>',
  link: '<path d="M9.5 14.5 14.5 9.5"/><path d="M10.5 6.6 12.3 4.8a4.5 4.5 0 0 1 6.4 6.4l-1.8 1.8"/><path d="M13.5 17.4 11.7 19.2a4.5 4.5 0 0 1-6.4-6.4l1.8-1.8"/>',

  // People.
  person: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  people:
    '<circle cx="8.6" cy="8" r="3.2"/><circle cx="17" cy="8.8" r="2.4"/><path d="M2.6 19.5a6 6 0 0 1 12 0"/><path d="M16.2 14.2a5.6 5.6 0 0 1 5.2 5.3"/>',

  // Actions and places.
  pencil: '<path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16Z"/><path d="M14.5 6.5 17.5 9.5"/>',
  trash:
    '<path d="M4 6.5h16"/><path d="M9.5 6.5V4.8A1.8 1.8 0 0 1 11.3 3h1.4a1.8 1.8 0 0 1 1.8 1.8V6.5"/><path d="M6.5 6.5 7.4 19.1A2 2 0 0 0 9.4 21h5.2a2 2 0 0 0 2-1.9L17.5 6.5"/><path d="M10 10.5V17M14 10.5V17"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M16 5.5A2.5 2.5 0 0 0 13.5 3h-8A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16"/>',
  download: '<path d="M12 3.5V15.5M7 10.5 12 15.5 17 10.5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  upload: '<path d="M12 15.5V3.5M7 8.5 12 3.5 17 8.5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  'sign-out': '<path d="M15 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H15"/><path d="M11 12h10M17.5 8.5 21 12 17.5 15.5"/>',
  sliders:
    '<path d="M3.5 6.5h9M16.5 6.5h4M3.5 12h3M10.5 12h10M3.5 17.5h9M16.5 17.5h4"/><circle cx="14.5" cy="6.5" r="2"/><circle cx="8.5" cy="12" r="2"/><circle cx="14.5" cy="17.5" r="2"/>',
  appearance: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3.3 9h17.4M3.3 15h17.4"/><path d="M12 3c2.4 2.5 3.7 5.6 3.7 9s-1.3 6.5-3.7 9c-2.4-2.5-3.7-5.6-3.7-9S9.6 5.5 12 3Z"/>',
  server:
    `<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/>${DOT(7, 7.5, 1.2)}${DOT(7, 16.5, 1.2)}`,
  workflow:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M6.5 10v4.5a3 3 0 0 0 3 3H14"/>',
  rocket:
    '<path d="M12 2.5c2.6 2.6 4 5.9 4 9.5v3.5H8V12c0-3.6 1.4-6.9 4-9.5Z"/><circle cx="12" cy="9.8" r="1.7"/><path d="M8 12.6 5.2 15.4a2 2 0 0 0-.6 1.4V19l3.4-2M16 12.6l2.8 2.8a2 2 0 0 1 .6 1.4V19l-3.4-2"/><path d="M10.3 19c.3 1.1.9 2.1 1.7 2.9.8-.8 1.4-1.8 1.7-2.9"/>',
  rss: `<path d="M4 11.5a8.5 8.5 0 0 1 8.5 8.5M4 4.5A15.5 15.5 0 0 1 19.5 20"/>${DOT(5, 19, 1.7)}`,
};

export type IconName = keyof typeof PATHS;

/**
 * One icon as inline SVG. Icons are decorative next to a label, so they are
 * hidden from assistive technology; where an icon stands alone (an icon-only
 * button, say) the caller labels the control instead.
 */
export function icon(name: IconName, cls = ''): Html {
  const body = PATHS[name];
  if (!body) throw new Error(`unknown icon: ${name}`);
  return raw(
    `<svg class="glyph${cls ? ` ${cls}` : ''}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
  );
}
