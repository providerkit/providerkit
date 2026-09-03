# Brand

A collimator. Rays arrive at whatever angle they arrive at, the lens is the seam, and what
leaves is parallel and evenly spaced — every provider's shape goes in, one shape comes out.
That's the package, so that's the mark.

Pure geometry: no text, no gradients, no filters. It rasterizes identically in every
renderer, and there's no font to embed.

## The two sources

| File                     | Use                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `providerkit-mark.svg`   | transparent. Values chosen to hold on **both** light and dark grounds, so there is one file, not two. Docs, site, favicon. |
| `providerkit-avatar.svg` | the same geometry on a full-bleed ink tile, values lifted for the dark ground. GitHub org avatar, app icons.               |

Full bleed is deliberate — GitHub rounds org avatars itself, and a self-rounded tile inside
that reads as a doubled corner.

Geometry is duplicated across the two files on purpose. A build step for twenty lines would
cost more than it saves, so **edit one, edit the other.**

## Palette

| Token           | Mark (either ground) | Avatar (on ink) |
| --------------- | -------------------- | --------------- |
| Rays in         | `#8A94A3`            | `#9AA4B2`       |
| Lens + rays out | `#0FA398`            | `#4FD1C5`       |
| Tile            | —                    | `#101418`       |

The two teals are the site's `--accent` in light and dark (`site/src/styles.css`); the mark's
`#0FA398` sits between them so one file survives both.

## The OG card

`og.ts` builds the 1200×630 card as an SVG string — mark + wordmark, one bold tagline, one
muted subtitle, one meta strip. Copy is the only thing that varies; call `ogCardSvg({ title,
subtitle })` for a per-page card. It nests the avatar's paths directly, so the mark on the
card can never drift from the mark everywhere else.

Inter isn't installed system-wide, so resvg falls back to the next face in the stack. That
only affects the card's text — the mark is pure vector. The card is rendered once and
committed, so what ships is what you see here, not whatever the CI runner had installed.

## Regenerating

```bash
bun run brand:assets   # ~1s
```

Emits the PNG/JPEG exports, plus `site/public/{favicon.svg,apple-touch-icon.png,og.png}` —
the site's icons are generated from these SVGs, never hand-copied. All outputs are committed
so the site builds without running it.

The rasterizer is `@resvg/resvg-js`, a devDependency, rather than a system binary: this repo
is open source and `brew install` is a barrier for a contributor on Linux or Windows. The
one exception is the `.jpg`, which resvg can't emit — that step shells out to ImageMagick
and skips with a note when it isn't installed. The `.png` works everywhere the `.jpg` does.

Upload `providerkit-avatar-1024.png` (or the `.jpg`) as the GitHub org avatar — it wants at
least 400×400.
