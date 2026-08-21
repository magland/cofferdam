#!/usr/bin/env bash
# Regenerate the brand assets under logo/assets from their construction
# parameters. Every coordinate is computed here rather than typed, which is
# what keeps the sparks radiating from one point and the glyph centred in its
# box; an earlier mark's hand-placed arc had drifted about 6.6 units off
# centre, which is the mistake this file exists to make impossible.
#
#   bash scripts/make-logo.sh          rewrite logo/assets/*.svg
#   bash scripts/make-logo.sh --check  report differences, write nothing
#
# src/logo.ts carries inline copies of the mark and the wordmark, because
# feorge ships no static files. This script does not edit that file, but it
# does check that the geometry there still matches and prints the constants to
# paste when it does not.
set -euo pipefail

cd "$(dirname "$0")/.."

node - "$@" <<'JS'
const fs = require('fs');

const check = process.argv.includes('--check');

// The palette. Only the icon, the lockup, and the two-tone wordmark carry
// fixed colours; the rest paint with currentColor.
const INK = '#14201f';
const TEAL = '#0e7c74';
const PAPER = '#fbf8f3';

// Shortest decimal that survives rounding to two places.
const n = (v) => String(Math.round(v * 100) / 100);
const rad = (d) => (d * Math.PI) / 180;

// ---------------------------------------------------------------- the mark
//
// A strike at the anvil: the workpiece square resting on the anvil's face,
// with three sparks flying off the point of the blow. The sparks are stroke
// segments placed by angle about one point, the square's top centre, so they
// cannot help but radiate from where the hammer lands. The square is the same
// square the interface borrows for tab markers and language bullets.
const M = {
  box: 64,
  cx: 32,
  w: 6, // stroke
  sq: 14, // the workpiece
  sqR: 3,
  gap: 3, // air between the square and the anvil face, half a stroke
  anvil: 18, // anvil face half-length
  sparkIn: 11, // sparks run from this radius about the strike point...
  sparkOut: 19, // ...out to this one
  sparkDeg: [-140, -90, -40], // up-left, up, up-right
};

// The square's centre height is not chosen but solved for: ink runs from the
// top spark's cap down to the anvil face's lower edge, and the two margins
// are set equal. With the numbers above that puts cy at 38.5 and the ink on
// 9.5 to 54.5 vertically and 11 to 53 across the anvil, so the glyph is
// centred in its box with about 10 units of clear space built in.
// inkTop = cy - sq/2 - sparkOut - w/2, inkBottom = cy + sq/2 + gap + w.
// Setting inkTop = box - inkBottom and solving for cy:
const M_CY = (M.box + M.sq / 2 + M.sparkOut + M.w / 2 - (M.sq / 2 + M.gap + M.w)) / 2;

function markParts(colour) {
  const cy = M_CY;
  const strike = [M.cx, cy - M.sq / 2]; // where the hammer lands
  const sparks = M.sparkDeg.map((deg) => {
    const [dx, dy] = [Math.cos(rad(deg)), Math.sin(rad(deg))];
    const a = [strike[0] + M.sparkIn * dx, strike[1] + M.sparkIn * dy];
    const b = [strike[0] + M.sparkOut * dx, strike[1] + M.sparkOut * dy];
    return `<path d="M${n(a[0])} ${n(a[1])}L${n(b[0])} ${n(b[1])}" stroke="${colour}" stroke-width="${n(M.w)}" stroke-linecap="round"/>`;
  });
  const faceY = cy + M.sq / 2 + M.gap + M.w / 2;
  return [
    ...sparks,
    `<rect x="${n(M.cx - M.sq / 2)}" y="${n(cy - M.sq / 2)}" width="${n(M.sq)}" height="${n(M.sq)}" rx="${n(M.sqR)}" fill="${colour}"/>`,
    `<path d="M${n(M.cx - M.anvil)} ${n(faceY)}H${n(M.cx + M.anvil)}" stroke="${colour}" stroke-width="${n(M.w)}" stroke-linecap="round"/>`,
  ];
}

// Ink extents, used to centre the mark in the lockup and to keep the claim
// above honest.
const M_INK = {
  top: M_CY - M.sq / 2 - M.sparkOut - M.w / 2,
  bottom: M_CY + M.sq / 2 + M.gap + M.w,
};
if (n(M_INK.top) !== n(M.box - M_INK.bottom)) throw new Error('the mark is off centre');

// ------------------------------------------------------------ the logotype
//
// Six letters on one grid, each a monoline stroke and a piece of a circle.
// Letters are strokes rather than outlines, so there is no font dependency
// and no text-to-path step. The g is the one letter with a descender, so the
// box is taller below the baseline than the old nine-letter mark's was.
const W = {
  width: 250,
  height: 75,
  stroke: 10,
  asc: 5, // stem top centreline; the box edge is half a stroke above
  xt: 25, // x-height top centreline
  base: 55, // baseline centreline
  desc: 70, // descender bottom centreline; the box edge is half a stroke below
  bowl: 15, // bowl radius, and the radius of o, e and g
  gap: 8, // air between the outer edges of adjacent letters
  aperture: 50, // degrees off the bowl's east point where c and e are cut
  fHead: 10, // radius of f's head curve, and of g's tail, its mirror
  fStem: 12, // f's stem, from the letter's left edge
  fWidth: 27, // f is narrow: a stem, a head, and a crossbar
  shoulder: 13, // r's shoulder radius; less than a bowl, so r stays narrow
};

const HALF = W.stroke / 2;
const BY = W.base - W.bowl; // 40, the centre line of every bowl
const WIDE = 2 * W.bowl + W.stroke; // 40, the width of every round letter

// A point on a bowl of radius W.bowl centred at (cx, BY), by angle, with 0
// degrees due east and positive angles running downwards as in SVG.
const onBowl = (cx, deg) => [cx + W.bowl * Math.cos(rad(deg)), BY + W.bowl * Math.sin(rad(deg))];

// Each letter is drawn from its left ink edge. Bowls come back as circles so
// they stay exact; everything else is a path.
const LETTERS = {
  o: (x) => ({
    paths: [],
    bowls: [[x + HALF + W.bowl, BY, W.bowl]],
    width: WIDE,
  }),
  // The curve leaves the east end of the crossbar and comes back round to an
  // aperture cut either side of due east.
  e: (x) => {
    const cx = x + HALF + W.bowl;
    const [ex, ey] = onBowl(cx, W.aperture);
    return {
      paths: [
        `M${x + HALF} ${BY}H${x + HALF + 2 * W.bowl}`,
        `M${cx + W.bowl} ${BY}A${W.bowl} ${W.bowl} 0 1 0 ${n(ex)} ${n(ey)}`,
      ],
      width: WIDE,
    };
  },
  f: (x) => ({
    paths: [
      `M${x + W.fStem} ${W.base}V${W.asc + W.fHead}A${W.fHead} ${W.fHead} 0 0 1 ${x + W.fStem + W.fHead} ${W.asc}`,
      `M${x + HALF} ${W.xt}H${x + W.fWidth - HALF}`,
    ],
    width: W.fWidth,
  }),
  r: (x) => ({
    paths: [
      `M${x + HALF} ${W.xt}V${W.base}`,
      `M${x + HALF} ${W.xt + W.shoulder}A${W.shoulder} ${W.shoulder} 0 0 1 ${x + HALF + W.shoulder} ${W.xt}`,
    ],
    width: W.stroke + W.shoulder,
  }),
  // Single-storey: the bowl of an o, a stem down the right, and a tail that
  // mirrors f's head, the same radius turned the other way at the other end
  // of the word's height. f opens the word reaching up and right; g answers
  // it reaching down and left.
  g: (x) => {
    const xs = x + HALF + 2 * W.bowl;
    return {
      paths: [
        `M${xs} ${W.xt}V${W.desc - W.fHead}A${W.fHead} ${W.fHead} 0 0 1 ${xs - W.fHead} ${W.desc}`,
      ],
      bowls: [[x + HALF + W.bowl, BY, W.bowl]],
      width: WIDE,
    };
  },
};

// "fe" and "orge": iron and the forge, which is what the two-tone variant
// colours.
const NAME = [...'feorge'];
const SPLIT = 2;

function layoutWord() {
  const out = [];
  let x = 0;
  for (const ch of NAME) {
    const letter = LETTERS[ch](x);
    out.push({ ch, ...letter });
    x += letter.width + W.gap;
  }
  const width = x - W.gap;
  if (width !== W.width) throw new Error(`the letters measure ${width}, but the box is ${W.width}`);
  return out;
}

const drawLetter = (l) =>
  [
    ...l.paths.map((d) => `<path d="${d}"/>`),
    ...(l.bowls ?? []).map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`),
  ].join('');

const strokeAttrs = `stroke-width="${W.stroke}" stroke-linecap="round" stroke-linejoin="round"`;

function wordmarkBody(colour) {
  const letters = layoutWord();
  return `<g stroke="${colour}" ${strokeAttrs}>${letters.map(drawLetter).join('')}</g>`;
}

function wordmarkTwoToneBody() {
  const letters = layoutWord();
  return (
    `<g ${strokeAttrs}>` +
    `<g stroke="${TEAL}">${letters.slice(0, SPLIT).map(drawLetter).join('')}</g>` +
    `<g stroke="${INK}">${letters.slice(SPLIT).map(drawLetter).join('')}</g>` +
    `</g>`
  );
}

// ------------------------------------------------------------- the lockup
//
// The mark is scaled to 0.89, which takes its 45 ink units to 40.05, within a
// tenth of the wordmark's 40-unit x-height. It is set flush left by its box
// and centred on the ascender-to-baseline band rather than the whole box,
// since the descender below the baseline is one letter's tail and not part
// of the word's mass.
const LOCK = { scale: 0.89, clear: 20 };
const LOCK_BOX = M.box * LOCK.scale; // 56.96
const LOCK_X = LOCK_BOX + LOCK.clear; // 76.96, where the wordmark starts
const BAND_MID = (W.base + HALF) / 2; // 30, middle of ink from ascender to baseline
const LOCK_Y = BAND_MID - (M.box / 2) * LOCK.scale; // 1.52

// -------------------------------------------------------------- the icon
//
// The glyph on a rounded tile, scaled about the tile's centre. The tile is
// what holds its shape at favicon sizes, where the sparks close up against
// the square.
const ICON = { scale: 0.7, radius: 14 };
const ICON_OFFSET = M.cx * (1 - ICON.scale); // 9.6

const svg = (viewBox, w, h, body, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}"${extra} role="img" aria-label="feorge">\n  ${body}\n</svg>\n`;

const FILES = {
  'feorge-mark.svg': svg(
    `0 0 ${M.box} ${M.box}`,
    M.box,
    M.box,
    markParts('currentColor').join('\n  '),
    ' fill="none"'
  ),
  'feorge-icon.svg': svg(
    `0 0 ${M.box} ${M.box}`,
    M.box,
    M.box,
    `<rect width="${M.box}" height="${M.box}" rx="${ICON.radius}" fill="${TEAL}"/>\n` +
      `  <g transform="translate(${n(ICON_OFFSET)} ${n(ICON_OFFSET)}) scale(${ICON.scale})" fill="none">\n    ` +
      markParts(PAPER).join('\n    ') +
      `\n  </g>`
  ),
  'feorge-wordmark.svg': svg(
    `0 0 ${W.width} ${W.height}`,
    W.width,
    W.height,
    wordmarkBody('currentColor'),
    ' fill="none"'
  ),
  'feorge-wordmark-two-tone.svg': svg(
    `0 0 ${W.width} ${W.height}`,
    W.width,
    W.height,
    wordmarkTwoToneBody(),
    ' fill="none"'
  ),
  'feorge-lockup.svg': svg(
    `0 0 ${n(LOCK_X + W.width)} ${W.height}`,
    n(LOCK_X + W.width),
    W.height,
    `<g transform="translate(0 ${n(LOCK_Y)}) scale(${LOCK.scale})">\n    ` +
      markParts(TEAL).join('\n    ') +
      `\n  </g>\n` +
      `  <g transform="translate(${n(LOCK_X)} 0)">${wordmarkTwoToneBody()}</g>`,
    ' fill="none"'
  ),
};

// ------------------------------------------------------------------ output
let stale = 0;
for (const [name, body] of Object.entries(FILES)) {
  const file = `logo/assets/${name}`;
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (current === body) continue;
  stale++;
  if (check) {
    console.error(`stale: ${file}`);
  } else {
    fs.writeFileSync(file, body);
    console.log(`wrote ${file}`);
  }
}
if (!check && stale === 0) console.log('logo/assets is already up to date');

// src/logo.ts inlines the same drawings. Compare the geometry rather than the
// whole document, since the copies there are minified and take their colours
// from the theme.
// Colours differ between the two copies, so compare with them stripped out.
const bare = (s) => s.replace(/ (?:stroke|fill)="[^"]*"/g, '');
const inline = bare(fs.readFileSync('src/logo.ts', 'utf8'));
const geometry = [...markParts('currentColor'), ...FILES['feorge-wordmark.svg'].split('\n')]
  .flatMap((s) => [...s.matchAll(/ (?:d|cx|x)="[^"]*"[^/>]*/g)].map((m) => bare(m[0]).trim()))
  .concat(`transform="translate(${n(ICON_OFFSET)} ${n(ICON_OFFSET)}) scale(${ICON.scale})"`);

const missing = geometry.filter((g) => !inline.includes(g));
if (missing.length) {
  console.error(`\nsrc/logo.ts is out of sync with logo/assets; ${missing.length} of ${geometry.length} shapes differ:`);
  for (const m of missing) console.error(`  ${m}`);
  console.error('\nPaste these into src/logo.ts:\n');
  const oneLine = (s) => s.replace(/\n\s*/g, '');
  console.error(`export const WORDMARK = \`${oneLine(FILES['feorge-wordmark.svg']).replace(/ width="\d+" height="\d+"/, '')}\`;\n`);
  console.error(`export const MARK = \`${oneLine(FILES['feorge-mark.svg']).replace(/ width="\d+" height="\d+"/, '')}\`;\n`);
  const favicon = oneLine(FILES['feorge-icon.svg'])
    .replace(/ width="\d+" height="\d+"/, '')
    .replaceAll(TEAL, '${bg}')
    .replaceAll(PAPER, '${fg}');
  console.error(`  return \`${favicon}\`;\n`);
  process.exit(1);
}

if (check && stale) process.exit(1);
console.log('src/logo.ts matches');
JS
