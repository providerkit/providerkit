# Brand

A collimator. Rays arrive at whatever angle they arrive at, the lens is the seam, and what
leaves is parallel and evenly spaced — every provider's shape goes in, one shape comes out.
That's the package, so that's the mark.

Pure geometry: no text, no gradients, no filters. It rasterizes identically in every
renderer, and there's no font to embed.

## The two sources

| File | Use |
|---|---|
| `providerkit-mark.svg` | transparent. Values chosen to hold on **both** light and dark grounds, so there is one file, not two. Docs, site, favicon. |
| `providerkit-avatar.svg` | the same geometry on a full-bleed ink tile, values lifted for the dark ground. GitHub org avatar, app icons. |

Full bleed is deliberate — GitHub rounds org avatars itself, and a self-rounded tile inside
that reads as a doubled corner.

Geometry is duplicated across the two files on purpose. A build step for twenty lines would
cost more than it saves, so **edit one, edit the other.**

## Palette

| Token | Mark (either ground) | Avatar (on ink) |
|---|---|---|
| Rays in | `#8A94A3` | `#9AA4B2` |
| Lens + rays out | `#0FA398` | `#4FD1C5` |
| Tile | — | `#101418` |

The two teals are the site's `--accent` in light and dark (`site/src/styles.css`); the mark's
`#0FA398` sits between them so one file survives both.

## Regenerating

```bash
brew install librsvg imagemagick   # once
./brand/render.sh                  # ~1s
```

Emits the PNG/JPEG exports, plus `site/public/favicon.svg` and `apple-touch-icon.png` — the
site's icons are generated from these SVGs, never hand-copied. All outputs are committed so
the site builds without librsvg.

Upload `providerkit-avatar-1024.png` (or the `.jpg`) as the GitHub org avatar — it wants at
least 400×400.
