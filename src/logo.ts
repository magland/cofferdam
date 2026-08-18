// The hubbit logo.
//
// The mark is a ring drawn as a rotation arrow with a square at its centre:
// spin up a hub, and the square is the bit. The logotype sets the name in
// letters built from the same two parts, a monoline stroke and a piece of a
// circle, so mark and word read as one drawing. The letters are strokes
// rather than outlines, so there is no font dependency and no text-to-path
// step. The name also divides evenly as hub | bit; the two-tone variant under
// logo/assets colours the halves, though the server renders only the plain
// form.
//
// The mark sits on a 64 x 64 box, its ring centred at (32, 32) with radius
// 20, stroke 6, round caps, and the bit a 14 x 14 square of corner radius 3
// on that same centre. An equilateral arrowhead of side 13.5, which is 2.25
// times the stroke, carries its centroid on the ring at -122 degrees and
// points along the tangent. The arc runs clockwise from -55 degrees and stops
// one inradius short of that centroid, so its round cap lands under the
// arrowhead's base rather than beside it. Ring and arrowhead together span 9
// to 55 on both axes, which centres the glyph in its box and leaves 9 units
// of clear space, more than the half square-width the brand notes ask for.
//
// The logotype sits on a 243 x 60 box: ascender at 0, x-height top at 20,
// baseline at 60, stroke 10, round caps and joins. Every bowl and arch is a
// radius-15 circle centred on y = 40, and letters carry 8 units of air
// between outer edges. Two features sit off that grid: t's stem stops 3 units
// short of the ascender, and i's dot is a filled disc of radius 5 whose top
// meets the ascender line. Scaling is uniform only, since the stroke weight
// is constant by construction and stretching one axis would break it.
//
// Both carry stroke="currentColor" so they take the surrounding text colour
// and need no per-theme variants. The favicon is the exception: nothing there
// inherits a colour, so it is filled from the active theme (see faviconSvg).
//
// The same drawings are checked in as standalone files under logo/assets, for
// use outside the server; they are inline here because hubbit ships no static
// files. Both come from scripts/make-logo.sh, which computes the coordinates
// from the construction rather than taking them by hand, and which fails if
// the geometry below has drifted from the files there. Edit the script.

import { activeTheme, type Theme } from './themes';

/** The logotype: six letters as monoline strokes and radius-15 bowls. 243 x 60. */
export const WORDMARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 243 60" fill="none" role="img" aria-label="hubbit"><g stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5V55M5 40A15 15 0 0 1 35 40V55"/><path d="M53 25V40A15 15 0 0 0 83 40M83 25V55"/><path d="M101 5V55"/><circle cx="116" cy="40" r="15"/><path d="M149 5V55"/><circle cx="164" cy="40" r="15"/><path d="M197 25V55"/><path d="M225 8V55M215 25H238"/></g><circle cx="197" cy="10" r="5" fill="currentColor"/></svg>`;

/** The mark: a ring as a rotation arrow, with the bit square at its centre. 64 x 64. */
export const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" role="img" aria-label="hubbit"><path d="M43.47 15.62A20 20 0 1 1 18.32 17.41" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><path d="M28.01 10.91 14.52 11.38 21.67 22.83Z" fill="currentColor"/><rect x="25" y="25" width="14" height="14" rx="3" fill="currentColor"/></svg>`;

/**
 * The mark on a rounded tile, for the favicon and any other icon slot. This
 * is logo/assets/hubbit-icon.svg with its two fixed colours replaced: a
 * favicon inherits nothing from the page, so they are taken from the vault's
 * theme instead, the tile in the accent and the glyph in the page background.
 * Every shipped theme pairs those with enough contrast. The glyph is scaled to
 * 0.7 about the tile's centre, which is what holds its shape down at favicon
 * sizes, where the bare ring closes up against the square.
 */
export function faviconSvg(theme: Theme = activeTheme()): string {
  const bg = theme.vars.accent;
  const fg = theme.vars.bg;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="hubbit"><rect width="64" height="64" rx="14" fill="${bg}"/><g transform="translate(9.6 9.6) scale(0.7)" fill="none"><path d="M43.47 15.62A20 20 0 1 1 18.32 17.41" stroke="${fg}" stroke-width="6" stroke-linecap="round"/><path d="M28.01 10.91 14.52 11.38 21.67 22.83Z" fill="${fg}"/><rect x="25" y="25" width="14" height="14" rx="3" fill="${fg}"/></g></svg>`;
}
