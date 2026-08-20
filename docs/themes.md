# Themes

The look of a vault is a property of the vault, chosen by its operator.

The interface ships with a small set of themes, chosen under **Admin > Appearance**:

| Theme | Look |
|---|---|
| `paper` | Warm off-white with teal links and serif headings. The default. |
| `github` | The familiar light gray and blue, for people who want no surprises. |
| `slate` | Cool gray surfaces with an indigo accent. |
| `midnight` | A dark theme with azure links, for low light. |
| `terminal` | Near-black, phosphor green, monospace throughout. |

A theme is a property of the vault rather than of the visitor: one vault is one interface, and the operator picks how it looks. The choice lives in `<vault>/config.json`, so it can equally be set by hand before the first start, and the server picks up an edit without a restart:

```json
{ "theme": "midnight" }
```

Changing it in the UI takes a site admin; a collection owner administers their collection but cannot restyle the site. An unknown theme name falls back to the default rather than failing requests, so a typo in `config.json` cannot take the vault down.

Each theme is a set of semantic CSS custom properties (background, surface, border, accent, diff colors, fonts, corner radius) plus the highlight.js palette that suits it. The structural stylesheet in `src/style.ts` names no colors of its own, so adding a theme means adding one entry to `src/themes.ts`.
