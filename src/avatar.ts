// Identicons.
//
// GitHub puts a face beside every name, and a name without one reads as
// unfinished next to it. A vault has no uploaded pictures and no gravatar
// lookups (that would be a request to a third party on every page), so the
// picture is drawn from the name itself: the same name always draws the same
// mark, and two different names almost never draw the same one.
//
// The drawing is GitHub's own identicon construction. A 5 x 5 grid of cells
// is filled from the bits of a hash of the name, mirrored about the middle
// column so the result reads as a face rather than as noise, and painted in a
// single hue taken from the same hash. Lightness and saturation are fixed at
// values that hold their contrast against both a near-white and a near-black
// page, so one drawing serves every theme.

import * as crypto from 'crypto';
import { Html, raw } from './html';

/** The identicon for a name, as an inline SVG of the given pixel size. */
export function identicon(name: string, size = 20): Html {
  const hash = crypto.createHash('sha256').update(name.trim().toLowerCase()).digest();
  const hue = Math.round((hash[0] / 256) * 360);
  const fill = `hsl(${hue} 58% 46%)`;
  // Cells are addressed by the left three columns; bit i of the hash body
  // decides cell i, and columns 3 and 4 mirror columns 1 and 0.
  const cells: string[] = [];
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 5; row++) {
      if ((hash[1 + col * 5 + row] & 1) === 0) continue;
      for (const c of col === 2 ? [2] : [col, 4 - col]) {
        cells.push(`<rect x="${c}" y="${row}" width="1" height="1"/>`);
      }
    }
  }
  return raw(
    `<svg class="identicon" width="${size}" height="${size}" viewBox="0 0 5 5" role="img" aria-label="${escapeAttr(
      name
    )}" fill="${fill}">${cells.join('')}</svg>`
  );
}

/** The identicon in the frame the interface puts round it. */
export function avatar(name: string, size = 20, cls = ''): Html {
  return raw(
    `<span class="avatar${cls ? ` ${cls}` : ''}" style="width:${size}px;height:${size}px">${identicon(
      name,
      size
    )}</span>`
  );
}

// Local rather than imported from render.ts: this file is about drawing, and
// the only thing it interpolates is the name in a label.
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
