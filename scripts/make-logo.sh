#!/usr/bin/env bash
# Regenerate the brand assets under logo/assets from their construction
# parameters. Every coordinate is computed here rather than typed, which is
# what keeps the ring concentric with the square and the arrowhead sitting on
# the ring; an earlier hand-placed arc had drifted about 6.6 units off centre.
#
#   bash scripts/make-logo.sh          rewrite logo/assets/*.svg
#   bash scripts/make-logo.sh --check  report differences, write nothing
#
# src/logo.ts carries inline copies of the mark and the wordmark, because
# hubbit ships no static files. This script does not edit that file, but it
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
// A ring drawn as a rotation arrow with the bit square at its centre. The arc
// and the arrowhead are both placed by angle on one circle about (cx, cy), so
// neither can drift off the square.
const M = {
  box: 64,
  cx: 32,
  cy: 32,
  r: 20, // ring centreline radius
  w: 6, // stroke
  head: 13.5, // arrowhead side, 2.25 x the stroke
  tailDeg: -55, // where the arc begins
  headDeg: -122, // where the arrowhead's centroid sits
  sq: 14, // the bit
  sqR: 3,
};

const onRing = (deg) => [M.cx + M.r * Math.cos(rad(deg)), M.cy + M.r * Math.sin(rad(deg))];

function markParts(colour) {
  const h = (M.head * Math.sqrt(3)) / 2; // triangle height
  const t = rad(M.headDeg);
  const [gx, gy] = onRing(M.headDeg);
  // Unit tangent in the direction of travel, and the outward radial.
  const [tx, ty] = [-Math.sin(t), Math.cos(t)];
  const [rx, ry] = [Math.cos(t), Math.sin(t)];
  const at = (along, across) => [gx + along * tx + across * rx, gy + along * ty + across * ry];
  const tip = at((2 * h) / 3, 0);
  const outer = at(-h / 3, M.head / 2);
  const inner = at(-h / 3, -M.head / 2);

  // The arc stops one inradius short of the centroid, so its round cap lands
  // under the arrowhead's base rather than poking out beside it.
  const endDeg = M.headDeg - ((h / 3 / M.r) * 180) / Math.PI;
  const [sx, sy] = onRing(M.tailDeg);
  const [ex, ey] = onRing(endDeg);
  const sweep = ((((endDeg - M.tailDeg) % 360) + 360) % 360);
  const largeArc = sweep > 180 ? 1 : 0;
  if (sweep < 200) throw new Error(`the ring is barely broken: sweep is ${n(sweep)} degrees`);

  return [
    `<path d="M${n(sx)} ${n(sy)}A${n(M.r)} ${n(M.r)} 0 ${largeArc} 1 ${n(ex)} ${n(ey)}" stroke="${colour}" stroke-width="${n(M.w)}" stroke-linecap="round"/>`,
    `<path d="M${n(tip[0])} ${n(tip[1])} ${n(outer[0])} ${n(outer[1])} ${n(inner[0])} ${n(inner[1])}Z" fill="${colour}"/>`,
    `<rect x="${n(M.cx - M.sq / 2)}" y="${n(M.cy - M.sq / 2)}" width="${n(M.sq)}" height="${n(M.sq)}" rx="${n(M.sqR)}" fill="${colour}"/>`,
  ];
}

// ------------------------------------------------------------ the logotype
//
// Six letters on one grid, each a monoline stroke and a piece of a circle.
// Letters are strokes rather than outlines, so there is no font dependency
// and no text-to-path step.
const W = {
  width: 243,
  height: 60,
  stroke: 10,
  asc: 5, // stem top centreline; the box edge is half a stroke above
  xt: 25, // x-height top centreline
  base: 55, // baseline centreline
  bowl: 15, // bowl and arch radius
  dot: 5, // radius of i's dot
  gap: 8, // air between the outer edges of adjacent letters
  tDrop: 3, // how far t's stem stops short of the ascender
  tStem: 15, // t's stem, from the letter's left edge
};

const HALF = W.stroke / 2;
const BY = W.base - W.bowl; // 40, the centre line of every bowl and arch
const WIDE = 2 * W.bowl + W.stroke; // 40, the width of h, u and b

// Each letter is drawn from its left ink edge. Bowls come back as circles so
// they stay exact; everything else is a path.
const LETTERS = {
  h: (x) => ({
    paths: [`M${x + HALF} ${W.asc}V${W.base}M${x + HALF} ${BY}A${W.bowl} ${W.bowl} 0 0 1 ${x + HALF + 2 * W.bowl} ${BY}V${W.base}`],
    width: WIDE,
  }),
  u: (x) => ({
    paths: [`M${x + HALF} ${W.xt}V${BY}A${W.bowl} ${W.bowl} 0 0 0 ${x + HALF + 2 * W.bowl} ${BY}M${x + HALF + 2 * W.bowl} ${W.xt}V${W.base}`],
    width: WIDE,
  }),
  b: (x) => ({
    paths: [`M${x + HALF} ${W.asc}V${W.base}`],
    bowls: [[x + HALF + W.bowl, BY, W.bowl]],
    width: WIDE,
  }),
  i: (x) => ({
    paths: [`M${x + HALF} ${W.xt}V${W.base}`],
    dot: [x + HALF, W.asc + W.dot, W.dot],
    width: W.stroke,
  }),
  t: (x) => ({
    paths: [`M${x + W.tStem} ${W.asc + W.tDrop}V${W.base}M${x + HALF} ${W.xt}H${x + 33 - HALF}`],
    width: 33,
  }),
};

// "hub" and "bit": the name divides evenly, which is what the two-tone
// variant colours.
const NAME = [...'hubbit'];

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

// i's dot is solid, so it sits outside the stroked group with its own fill.
const drawDot = (l, colour) => `<circle cx="${l.dot[0]}" cy="${l.dot[1]}" r="${l.dot[2]}" fill="${colour}"/>`;

const strokeAttrs = `stroke-width="${W.stroke}" stroke-linecap="round" stroke-linejoin="round"`;

function wordmarkBody(colour) {
  const letters = layoutWord();
  const dot = letters.find((l) => l.dot);
  return (
    `<g stroke="${colour}" ${strokeAttrs}>${letters.map(drawLetter).join('')}</g>` +
    drawDot(dot, colour)
  );
}

function wordmarkTwoToneBody() {
  const letters = layoutWord();
  const hub = letters.slice(0, 3);
  const bit = letters.slice(3);
  const dot = letters.find((l) => l.dot);
  return (
    `<g ${strokeAttrs}>` +
    `<g stroke="${TEAL}">${hub.map(drawLetter).join('')}</g>` +
    `<g stroke="${INK}">${bit.map(drawLetter).join('')}</g>` +
    `</g>` +
    drawDot(dot, INK)
  );
}

// ------------------------------------------------------------- the lockup
//
// The mark's box is scaled so its ring matches the wordmark's x-height, then
// set flush left and centred on the wordmark's box. The wordmark follows a
// clear space of one gap-and-a-half after the mark's box.
const LOCK = { scale: 0.875, clear: 20 };
const LOCK_BOX = M.box * LOCK.scale; // 56
const LOCK_X = LOCK_BOX + LOCK.clear; // 76, where the wordmark starts
const LOCK_Y = (W.height - LOCK_BOX) / 2; // 2

// -------------------------------------------------------------- the icon
//
// The glyph on a rounded tile, scaled about the tile's centre. The tile is
// what holds its shape at favicon sizes, where the bare ring closes up.
const ICON = { scale: 0.7, radius: 14 };
const ICON_OFFSET = M.cx * (1 - ICON.scale); // 9.6

const svg = (viewBox, w, h, body, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}"${extra} role="img" aria-label="hubbit">\n  ${body}\n</svg>\n`;

const FILES = {
  'hubbit-mark.svg': svg(
    `0 0 ${M.box} ${M.box}`,
    M.box,
    M.box,
    markParts('currentColor').join('\n  '),
    ' fill="none"'
  ),
  'hubbit-icon.svg': svg(
    `0 0 ${M.box} ${M.box}`,
    M.box,
    M.box,
    `<rect width="${M.box}" height="${M.box}" rx="${ICON.radius}" fill="${TEAL}"/>\n` +
      `  <g transform="translate(${n(ICON_OFFSET)} ${n(ICON_OFFSET)}) scale(${ICON.scale})" fill="none">\n    ` +
      markParts(PAPER).join('\n    ') +
      `\n  </g>`
  ),
  'hubbit-wordmark.svg': svg(
    `0 0 ${W.width} ${W.height}`,
    W.width,
    W.height,
    wordmarkBody('currentColor'),
    ' fill="none"'
  ),
  'hubbit-wordmark-two-tone.svg': svg(
    `0 0 ${W.width} ${W.height}`,
    W.width,
    W.height,
    wordmarkTwoToneBody(),
    ' fill="none"'
  ),
  'hubbit-lockup.svg': svg(
    `0 0 ${LOCK_X + W.width} ${W.height}`,
    LOCK_X + W.width,
    W.height,
    `<g transform="translate(0 ${n(LOCK_Y)}) scale(${LOCK.scale})">\n    ` +
      markParts(TEAL).join('\n    ') +
      `\n  </g>\n` +
      `  <g transform="translate(${LOCK_X} 0)">${wordmarkTwoToneBody()}</g>`,
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
const geometry = [...markParts('currentColor'), ...FILES['hubbit-wordmark.svg'].split('\n')]
  .flatMap((s) => [...s.matchAll(/ (?:d|cx|x)="[^"]*"[^/>]*/g)].map((m) => bare(m[0]).trim()))
  .concat(`transform="translate(${n(ICON_OFFSET)} ${n(ICON_OFFSET)}) scale(${ICON.scale})"`);

const missing = geometry.filter((g) => !inline.includes(g));
if (missing.length) {
  console.error(`\nsrc/logo.ts is out of sync with logo/assets; ${missing.length} of ${geometry.length} shapes differ:`);
  for (const m of missing) console.error(`  ${m}`);
  console.error('\nPaste these into src/logo.ts:\n');
  const oneLine = (s) => s.replace(/\n\s*/g, '');
  console.error(`export const WORDMARK = \`${oneLine(FILES['hubbit-wordmark.svg']).replace(/ width="\d+" height="\d+"/, '')}\`;\n`);
  console.error(`export const MARK = \`${oneLine(FILES['hubbit-mark.svg']).replace(/ width="\d+" height="\d+"/, '')}\`;\n`);
  const favicon = oneLine(FILES['hubbit-icon.svg'])
    .replace(/ width="\d+" height="\d+"/, '')
    .replaceAll(TEAL, '${bg}')
    .replaceAll(PAPER, '${fg}');
  console.error(`  return \`${favicon}\`;\n`);
  process.exit(1);
}

if (check && stale) process.exit(1);
console.log('src/logo.ts matches');
JS
