// The feorge logo.
//
// The mark is a strike at the anvil: the workpiece square resting on the
// anvil's face, with three sparks flying off the point of the blow. The
// logotype sets the name in letters built from the same two parts, a monoline
// stroke and a piece of a circle, so mark and word read as one drawing. The
// letters are strokes rather than outlines, so there is no font dependency
// and no text-to-path step. The name also divides as fe | orge, iron and the
// forge; the two-tone variant under logo/assets colours the two words, though
// the server renders only the plain form.
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
// The logotype sits on a 250 x 75 box: ascender at 0, x-height top at 20,
// baseline at 60, descender at 75, stroke 10, round caps and joins. Every
// bowl is a radius-15 circle centred on y = 40, and letters carry 8 units of
// air between outer edges. f is a 27-wide stem with a radius-10 head, r
// carries a radius-13 shoulder, and g answers f with a radius-10 tail at the
// other end of the word's height, the one descender in the name. The bowls
// of the two e's are cut 50 degrees off due east. Scaling is uniform only,
// since the stroke weight is constant by construction and stretching one
// axis would break it.
//
// Both carry stroke="currentColor" so they take the surrounding text colour
// and need no per-theme variants. The favicon is the exception: nothing there
// inherits a colour, so it is filled from the active theme (see faviconSvg).
//
// The same drawings are checked in as standalone files under logo/assets, for
// use outside the server; they are inline here because feorge ships no static
// files. Both come from scripts/make-logo.sh, which computes the coordinates
// from the construction rather than taking them by hand, and which fails if
// the geometry below has drifted from the files there. Edit the script.

import { activeTheme, type Theme } from './themes';

/** The logotype: six letters as monoline strokes and radius-15 bowls. 250 x 75. */
export const WORDMARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 75" fill="none" role="img" aria-label="feorge"><g stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"><path d="M12 55V15A10 10 0 0 1 22 5"/><path d="M5 25H22"/><path d="M40 40H70"/><path d="M70 40A15 15 0 1 0 64.64 51.49"/><circle cx="103" cy="40" r="15"/><path d="M136 25V55"/><path d="M136 38A13 13 0 0 1 149 25"/><path d="M197 25V60A10 10 0 0 1 187 70"/><circle cx="182" cy="40" r="15"/><path d="M215 40H245"/><path d="M245 40A15 15 0 1 0 239.64 51.49"/></g></svg>`;

/** The mark: three sparks over the workpiece square on the anvil face. 64 x 64. */
export const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" role="img" aria-label="feorge"><path d="M23.57 24.43L17.45 19.29" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><path d="M32 20.5L32 12.5" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><path d="M40.43 24.43L46.55 19.29" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><rect x="25" y="31.5" width="14" height="14" rx="3" fill="currentColor"/><path d="M14 51.5H50" stroke="currentColor" stroke-width="6" stroke-linecap="round"/></svg>`;

/**
 * The mark on a rounded tile, for the favicon and any other icon slot. This
 * is logo/assets/feorge-icon.svg with its two fixed colours replaced: a
 * favicon inherits nothing from the page, so they are taken from the vault's
 * theme instead, the tile in the accent and the glyph in the page background.
 * Every shipped theme pairs those with enough contrast. The glyph is scaled to
 * 0.7 about the tile's centre, which is what holds its shape down at favicon
 * sizes, where the sparks close up against the square.
 */
export function faviconSvg(theme: Theme = activeTheme()): string {
  const bg = theme.vars.accent;
  const fg = theme.vars.bg;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="feorge"><rect width="64" height="64" rx="14" fill="${bg}"/><g transform="translate(9.6 9.6) scale(0.7)" fill="none"><path d="M23.57 24.43L17.45 19.29" stroke="${fg}" stroke-width="6" stroke-linecap="round"/><path d="M32 20.5L32 12.5" stroke="${fg}" stroke-width="6" stroke-linecap="round"/><path d="M40.43 24.43L46.55 19.29" stroke="${fg}" stroke-width="6" stroke-linecap="round"/><rect x="25" y="31.5" width="14" height="14" rx="3" fill="${fg}"/><path d="M14 51.5H50" stroke="${fg}" stroke-width="6" stroke-linecap="round"/></g></svg>`;
}
