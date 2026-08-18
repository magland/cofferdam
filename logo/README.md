# The doqpod logo

The logo is drawn rather than set in a typeface. Every letter of *doqpod* is a circle with an optional straight stem tangent to it: the two d's carry an ascender on the right, q a descender on the right, p a descender on the left, and the two o's are bare. Read left to right the steps go up, none, down, down, none, up, which is symmetric about the middle of the word.

## The grid

| | |
|---|---|
| x-height, and the outer diameter of every bowl | 100 |
| monoline stroke | 18 |
| bowl radius, stroke-centred | 41 = (100 − 18) / 2 |
| step overshoot beyond the bowl | 60 |
| advance, centre to centre | 120 (leaving 20 of air between neighbours) |
| baseline | y = 160, in a 700 × 220 box |

The radius is what makes the stems sit flush: a stroke of the same weight centred 41 from a bowl's centre shares that bowl's outer edge exactly, rather than merely approaching it.

## The files

| File | What it is |
|---|---|
| `doqpod-wordmark.svg` | The logotype, 700 × 220. The primary form. |
| `doqpod-wordmark-two-tone.svg` | Same drawing with the steps on `--logo-accent`, falling back to `currentColor`. |
| `doqpod-mark.svg` | The word folded onto one bowl, 100 × 192. |
| `doqpod-icon.svg` | The mark on a rounded tile, 512 × 512, in the paper theme's colours. |
| `doqpod-lockup.svg` | Tile plus logotype, for places that want both. |

The wordmark and mark are stroked in `currentColor`, so they need no per-theme variants. The icon is the exception, since nothing in a favicon inherits a colour.

The mark carries d's ascender on the right and p's descender on the left, and so is unchanged by a 180-degree rotation. It is drawn heavier (stroke 24) with shorter steps (overshoot 46) than the wordmark, because the wordmark's proportions do not survive a 16-pixel favicon. It reads as a letterform on its own, so it should not be set beside the logotype bare; use `doqpod-lockup.svg`, where the tile separates the two.

## In the server

`src/logo.ts` carries the same two drawings inline, since doqpod ships no static files. The topbar renders `WORDMARK`, and `/favicon.svg` renders the tile filled from the active theme, the tile in the accent and the glyph in the page background. Editing a drawing means editing it in both places.
