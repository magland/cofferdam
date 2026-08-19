// The cofferdam logo.
//
// The mark is a ring drawn as a rotation arrow with a square at its centre:
// the ring is the enclosure and the square is what it keeps. The logotype
// sets the name in letters built from the same two parts, a monoline stroke
// and a piece of a circle, so mark and word read as one drawing. The letters
// are strokes rather than outlines, so there is no font dependency and no
// text-to-path step. The name also divides as coffer | dam; the two-tone
// variant under logo/assets colours the two words, though the server renders
// only the plain form.
//
// The mark sits on a 64 x 64 box, its ring centred at (32, 32) with radius
// 20, stroke 6, round caps, and the square 14 x 14 with corner radius 3 on
// that same centre. An equilateral arrowhead of side 13.5, which is 2.25
// times the stroke, carries its centroid on the ring at -122 degrees and
// points along the tangent. The arc runs clockwise from -55 degrees and stops
// one inradius short of that centroid, so its round cap lands under the
// arrowhead's base rather than beside it. Ring and arrowhead together span 9
// to 55 on both axes, which centres the glyph in its box and leaves 9 units
// of clear space, more than the half square-width the brand notes ask for.
//
// The logotype sits on a 395 x 60 box: ascender at 0, x-height top at 20,
// baseline at 60, stroke 10, round caps and joins. Every bowl is a radius-15
// circle centred on y = 40, and letters carry 8 units of air between outer
// edges. Three letters are narrower than a bowl allows, and say so in their
// own radii: f is a 27-wide stem with a radius-10 head, r carries a radius-13
// shoulder, and m's two arches are radius 11 so the letter is not simply
// twice an n. The bowls of c and e are cut 50 degrees off due east. Scaling
// is uniform only, since the stroke weight is constant by construction and
// stretching one axis would break it.
//
// Both carry stroke="currentColor" so they take the surrounding text colour
// and need no per-theme variants. The favicon is the exception: nothing there
// inherits a colour, so it is filled from the active theme (see faviconSvg).
//
// The same drawings are checked in as standalone files under logo/assets, for
// use outside the server; they are inline here because cofferdam ships no static
// files. Both come from scripts/make-logo.sh, which computes the coordinates
// from the construction rather than taking them by hand, and which fails if
// the geometry below has drifted from the files there. Edit the script.

import { activeTheme, type Theme } from './themes';

/** The logotype: nine letters as monoline strokes and radius-15 bowls. 395 x 60. */
export const WORDMARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 395 60" fill="none" role="img" aria-label="cofferdam"><g stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"><path d="M29.64 28.51A15 15 0 1 0 29.64 51.49"/><circle cx="68" cy="40" r="15"/><path d="M108 55V15A10 10 0 0 1 118 5"/><path d="M101 25H118"/><path d="M143 55V15A10 10 0 0 1 153 5"/><path d="M136 25H153"/><path d="M171 40H201"/><path d="M201 40A15 15 0 1 0 195.64 51.49"/><path d="M219 25V55"/><path d="M219 38A13 13 0 0 1 232 25"/><path d="M280 5V55"/><circle cx="265" cy="40" r="15"/><path d="M328 25V55"/><circle cx="313" cy="40" r="15"/><path d="M346 25V55"/><path d="M346 36A11 11 0 0 1 368 36V55"/><path d="M368 36A11 11 0 0 1 390 36V55"/></g></svg>`;

/** The mark: a ring as a rotation arrow, with the square at its centre. 64 x 64. */
export const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" role="img" aria-label="cofferdam"><path d="M43.47 15.62A20 20 0 1 1 18.32 17.41" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><path d="M28.01 10.91 14.52 11.38 21.67 22.83Z" fill="currentColor"/><rect x="25" y="25" width="14" height="14" rx="3" fill="currentColor"/></svg>`;

/**
 * The mark on a rounded tile, for the favicon and any other icon slot. This
 * is logo/assets/cofferdam-icon.svg with its two fixed colours replaced: a
 * favicon inherits nothing from the page, so they are taken from the vault's
 * theme instead, the tile in the accent and the glyph in the page background.
 * Every shipped theme pairs those with enough contrast. The glyph is scaled to
 * 0.7 about the tile's centre, which is what holds its shape down at favicon
 * sizes, where the bare ring closes up against the square.
 */
export function faviconSvg(theme: Theme = activeTheme()): string {
  const bg = theme.vars.accent;
  const fg = theme.vars.bg;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="cofferdam"><rect width="64" height="64" rx="14" fill="${bg}"/><g transform="translate(9.6 9.6) scale(0.7)" fill="none"><path d="M43.47 15.62A20 20 0 1 1 18.32 17.41" stroke="${fg}" stroke-width="6" stroke-linecap="round"/><path d="M28.01 10.91 14.52 11.38 21.67 22.83Z" fill="${fg}"/><rect x="25" y="25" width="14" height="14" rx="3" fill="${fg}"/></g></svg>`;
}
