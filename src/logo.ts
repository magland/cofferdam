// The Mochi Forge logo.
//
// The mark is a strike at the anvil: the workpiece square resting on the
// anvil's face, with three sparks flying off the point of the blow. The
// logotype sets the short name in letters built from the same two parts, a
// monoline stroke and a piece of a circle, so mark and word read as one
// drawing. The letters are strokes rather than outlines, so there is no font
// dependency and no text-to-path step.
//
// The mark sits on a 64 x 64 box, stroke 6, round caps. The workpiece is a
// 14 x 14 square with corner radius 3, resting half a stroke above the anvil
// face, a 36-unit horizontal at the bottom. The sparks are stroke segments
// radiating from the square's top centre at -140, -90, and -40 degrees, from
// radius 11 out to radius 19, so they cannot help but point back at where the
// hammer lands. The square's height is solved so the ink margins above and
// below come out equal: ink runs 9.5 to 54.5 vertically and 11 to 53 across
// the anvil, which centres the glyph with about 10 units of clear space.
//
// The logotype sits on a 232 x 60 box: ascender at 0, x-height top at 20,
// baseline at 60, stroke 10, round caps and joins. Radius 15 is the only
// curve in the word, centred on y = 40 throughout: o is a full circle of it,
// c is the same circle cut open 50 degrees either side of due east, and the
// arches of m and h are its top half, springing from one stem and landing on
// the next. Letters carry 8 units of air between outer edges. h's stem and
// i's tittle are the only ink above the x-height, and no letter descends, so
// the box stops half a stroke below the baseline. Scaling is uniform only,
// since the stroke weight is constant by construction and stretching one
// axis would break it.
//
// Both carry stroke="currentColor" so they take the surrounding text colour
// and need no per-theme variants. The favicon is the exception: nothing there
// inherits a colour, so it is filled from the active theme (see faviconSvg).
//
// The same drawings are checked in as standalone files under logo/assets, for
// use outside the server; they are inline here because the server ships no static
// files. Both come from scripts/make-logo.sh, which computes the coordinates
// from the construction rather than taking them by hand, and which fails if
// the geometry below has drifted from the files there. Edit the script.

import { activeTheme, type Theme } from './themes';

/** The logotype: five letters as monoline strokes and radius-15 curves. 232 x 60. */
export const WORDMARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 232 60" fill="none" role="img" aria-label="mochi"><g stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"><path d="M5 25V55"/><path d="M5 40A15 15 0 0 1 35 40"/><path d="M35 40V55"/><path d="M35 40A15 15 0 0 1 65 40"/><path d="M65 40V55"/><circle cx="98" cy="40" r="15"/><path d="M155.64 28.51A15 15 0 1 0 155.64 51.49"/><path d="M179 5V55"/><path d="M179 40A15 15 0 0 1 209 40"/><path d="M209 40V55"/><path d="M227 25V55"/><circle cx="227" cy="5" r="5" stroke="none" fill="currentColor"/></g></svg>`;

/** The mark: three sparks over the workpiece square on the anvil face. 64 x 64. */
export const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" role="img" aria-label="mochi"><path d="M23.57 24.43L17.45 19.29" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><path d="M32 20.5L32 12.5" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><path d="M40.43 24.43L46.55 19.29" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><rect x="25" y="31.5" width="14" height="14" rx="3" fill="currentColor"/><path d="M14 51.5H50" stroke="currentColor" stroke-width="6" stroke-linecap="round"/></svg>`;

/**
 * The mark on a rounded tile, for the favicon and any other icon slot. This
 * is logo/assets/mochi-icon.svg with its two fixed colours replaced: a
 * favicon inherits nothing from the page, so they are taken from the vault's
 * theme instead, the tile in the accent and the glyph in the page background.
 * Every shipped theme pairs those with enough contrast. The glyph is scaled to
 * 0.7 about the tile's centre, which is what holds its shape down at favicon
 * sizes, where the sparks close up against the square.
 */
export function faviconSvg(theme: Theme = activeTheme()): string {
  const bg = theme.vars.accent;
  const fg = theme.vars.bg;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="mochi"><rect width="64" height="64" rx="14" fill="${bg}"/><g transform="translate(9.6 9.6) scale(0.7)" fill="none"><path d="M23.57 24.43L17.45 19.29" stroke="${fg}" stroke-width="6" stroke-linecap="round"/><path d="M32 20.5L32 12.5" stroke="${fg}" stroke-width="6" stroke-linecap="round"/><path d="M40.43 24.43L46.55 19.29" stroke="${fg}" stroke-width="6" stroke-linecap="round"/><rect x="25" y="31.5" width="14" height="14" rx="3" fill="${fg}"/><path d="M14 51.5H50" stroke="${fg}" stroke-width="6" stroke-linecap="round"/></g></svg>`;
}
