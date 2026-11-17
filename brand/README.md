# Brand

A collimator. Rays arrive at whatever angle they arrive at, the lens is the seam, and what
leaves is parallel and evenly spaced. Every provider's shape goes in, one shape comes out.
That's the package, so that's the mark.

Pure geometry: no text, no gradients, no filters. It rasterizes identically in every
renderer, and there's no font to embed.

## The two sources

| File                     | Use                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `providerkit-mark.svg`   | transparent. Values chosen to hold on **both** light and dark grounds, so there is one file, not two. Docs, site, favicon. |
| `providerkit-avatar.svg` | the same geometry on a full-bleed ink tile, values lifted for the dark ground. GitHub org avatar, app icons.               |

Full bleed is deliberate: GitHub rounds org avatars itself, and a self-rounded tile inside
that reads as a doubled corner.

Geometry is duplicated across the two files on purpose. A build step for twenty lines would
cost more than it saves, so **edit one, edit the other.**

## Palette

| Token           | Mark (either ground) | Avatar (on ink) |
| --------------- | -------------------- | --------------- |
| Rays in         | `#8A94A3`            | `#9AA4B2`       |
| Lens + rays out | `#0FA398`            | `#4FD1C5`       |
| Tile            | -                    | `#101418`       |

The mark keeps a middle teal so the same file holds on both site grounds. The site's reading
palette lives in `site/src/styles/bench.css`; `site/DESIGN.md` defines its roles.

## The OG card

`og.ts` builds the 1200×630 card from the mark, the landing's purpose and each package's release
state. It uses the site's dark palette and Archivo. No Core-only dependency claim applies to the
whole toolkit.

The rasterizer loads `fonts/Archivo.ttf` directly, never a system fallback. This OFL font comes
from Google Fonts commit `6c70c829f09ea345d3590406693220ea35c6553f`,
`ofl/archivo/Archivo[wdth,wght].ttf`. Its license is beside it. The site continues to self-host
its web fonts through Fontsource; this TTF is only the reproducible rasterizer input.

## Regenerating

```bash
bun run brand:assets   # ~1s
```

Emits the PNG/JPEG exports, plus `site/public/{favicon.svg,apple-touch-icon.png,og.png}`.
The site's icons are generated from these SVGs, never hand-copied. All outputs are committed
so the site builds without running it.

The rasterizer is `@resvg/resvg-js`, a devDependency, rather than a system binary: this repo
is open source and `brew install` is a barrier for a contributor on Linux or Windows. The
one exception is the `.jpg`, which resvg can't emit. That step shells out to ImageMagick
and skips with a note when it isn't installed. The `.png` works everywhere the `.jpg` does.

Upload `providerkit-avatar-1024.png` (or the `.jpg`) as the GitHub org avatar. It wants at
least 400×400.
