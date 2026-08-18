// The hubbit logo.
//
// The logo is drawn rather than set in a typeface. Every letter of "hubbit"
// is one or two straight stems plus a piece of a single circle, and the
// pieces shrink as the word goes on: each b takes the circle whole as its
// bowl, h and u take it halved (the arch over h, the arc under u), t takes a
// quarter as its tail, and i reduces it to a point, a dot the width of the
// stroke. The word has no descenders, so every feature rises. The name also
// divides evenly as hub | bit; the two-tone variant under logo/ colours the
// halves, though the server renders only the plain form.
//
// One construction grid produces both pieces. The x-height, and so the outer
// diameter of every bowl and arch, is 100 units; the monoline stroke is 18;
// ascenders overshoot the x-height by 60; t's stem and i's dot stop at the
// half-line, 30 above the x-height; and letters advance with 20 units of air
// between outer edges. The baseline is the bottom of a 598 x 160 box. Bowls
// and arches are stroked at radius 41 (= (100 - 18) / 2), so a stem tangent
// at a bowl's side shares the bowl's outer edge exactly. The arches of h and
// u spring from the mid-height of the body, each the top or bottom half of
// the same circle the b's carry whole.
//
// The mark is the word's own h, drawn heavier: stroke 24, radius 38
// (= (100 - 24) / 2), in a 100 x 124 box. Read as a letter it is the
// initial; read as a picture it is a hut, the arch its roof, the stems its
// walls, and the ascender a chimney: it clears the roofline by exactly the
// stroke's own width, a square stub.
//
// Both carry stroke="currentColor" so they take the surrounding text colour
// and need no per-theme variants. The favicon is the exception: nothing there
// inherits a colour, so it is filled from the active theme (see faviconSvg).
//
// The same drawings are checked in as standalone files under logo/, for use
// outside the server.

import { activeTheme, type Theme } from './themes';

/** The logotype: stems and one circle, whole, halved, quartered, and a point. 598 x 160. */
export const WORDMARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 598 160" role="img" aria-label="hubbit"><g fill="none" stroke="currentColor" stroke-width="18" stroke-linecap="round"><path d="M9 9V151"/><path d="M9 110A41 41 0 0 1 91 110V151"/><path d="M129 69V110A41 41 0 0 0 211 110V69"/><path d="M249 9V151"/><circle cx="290" cy="110" r="41"/><path d="M369 9V151"/><circle cx="410" cy="110" r="41"/><path d="M489 69V151"/><path d="M548 39V110A41 41 0 0 0 589 151"/><path d="M527 69H569"/></g><circle cx="489" cy="30" r="9" fill="currentColor"/></svg>`;

/** The mark: the word's h drawn heavier, a hut with a chimney. 100 x 124. */
export const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 124" role="img" aria-label="hubbit"><g fill="none" stroke="currentColor" stroke-width="24" stroke-linecap="round"><path d="M12 12V112"/><path d="M12 74A38 38 0 0 1 88 74V112"/></g></svg>`;

/**
 * The mark on a rounded tile, for the favicon and any other icon slot. A
 * favicon inherits nothing from the page, so the two colours are taken from
 * the vault's theme: the tile in the accent, the glyph in the page
 * background. Every shipped theme pairs those with enough contrast.
 */
export function faviconSvg(theme: Theme = activeTheme()): string {
  const bg = theme.vars.accent;
  const fg = theme.vars.bg;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="hubbit"><rect width="512" height="512" rx="112" fill="${bg}"/><g fill="none" stroke="${fg}" stroke-width="72" stroke-linecap="round"><path d="M142 106V406"/><path d="M142 292A114 114 0 0 1 370 292V406"/></g></svg>`;
}
