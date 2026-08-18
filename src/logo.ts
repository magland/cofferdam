// The doqpod logo, drawn rather than set in a typeface.
//
// Every letter of "doqpod" is a circle with an optional straight stem tangent
// to it, so the whole word is six bowls and four steps: the two d's carry an
// ascender on the right, q a descender on the right, p a descender on the
// left, and the two o's are bare. Read left to right the steps go up, none,
// down, down, none, up, which is symmetric about the middle of the word. That
// symmetry is the idea; there is nothing else to the mark.
//
// One construction grid produces both pieces. The x-height, and so the outer
// diameter of every bowl, is 100 units; the monoline stroke is 18; every step
// overshoots its bowl by 60; and bowls advance 120 apart, which leaves 20
// units of air between neighbours. The baseline therefore sits at y = 160 in
// a 700 x 220 box. Bowls are stroked circles of radius 41 (= (100 - 18) / 2),
// so a stem tangent at a bowl's side shares the bowl's outer edge exactly.
//
// The mark folds the word into a single glyph: one bowl carrying d's ascender
// on the right and p's descender on the left. It is unchanged by a 180-degree
// rotation. It is drawn a little heavier (stroke 24) with shorter steps
// (overshoot 46) than the wordmark, since a 16-pixel favicon cannot hold the
// wordmark's proportions.
//
// Both carry stroke="currentColor" so they take the surrounding text colour
// and need no per-theme variants. The favicon is the exception: nothing there
// inherits a colour, so it is filled from the active theme (see faviconSvg).
//
// The same drawings are checked in as standalone files under logo/, for use
// outside the server.

import { activeTheme, type Theme } from './themes';

/** The logotype: six bowls and four steps, 700 x 220. */
export const WORDMARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 220" role="img" aria-label="doqpod"><g fill="none" stroke="currentColor" stroke-width="18" stroke-linecap="round"><circle cx="50" cy="110" r="41"/><circle cx="170" cy="110" r="41"/><circle cx="290" cy="110" r="41"/><circle cx="410" cy="110" r="41"/><circle cx="530" cy="110" r="41"/><circle cx="650" cy="110" r="41"/><path d="M91 9V151"/><path d="M331 69V211"/><path d="M369 69V211"/><path d="M691 9V151"/></g></svg>`;

/** The mark: the word folded onto one bowl, 100 x 192. */
export const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 192" role="img" aria-label="doqpod"><g fill="none" stroke="currentColor" stroke-width="24" stroke-linecap="round"><circle cx="50" cy="96" r="38"/><path d="M88 12V134"/><path d="M12 58V180"/></g></svg>`;

/**
 * The mark on a rounded tile, for the favicon and any other icon slot. A
 * favicon inherits nothing from the page, so the two colours are taken from
 * the vault's theme: the tile in the accent, the glyph in the page
 * background. Every shipped theme pairs those with enough contrast.
 */
export function faviconSvg(theme: Theme = activeTheme()): string {
  const bg = theme.vars.accent;
  const fg = theme.vars.bg;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="doqpod"><rect width="512" height="512" rx="112" fill="${bg}"/><g fill="none" stroke="${fg}" stroke-width="48.64" stroke-linecap="round"><circle cx="256" cy="256" r="77.01"/><path d="M333.01 85.76V333.01"/><path d="M178.99 178.99V426.24"/></g></svg>`;
}
