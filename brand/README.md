# Brand

The mark is the initial of **providerkit**. One flat path draws the stem and open bowl of the p.
The diagonal cut leaves a gap you can still see on a browser tab. Beside it, the lowercase name
uses Archivo in the same ink as the page title. Only the mark carries the brand color.

## The two sources

| File                     | Use                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `providerkit-mark.svg`   | transparent. Values chosen to hold on **both** light and dark grounds, so there is one file, not two. Docs, site, favicon. |
| `providerkit-avatar.svg` | the same geometry on a full-bleed ink tile, values lifted for the dark ground. GitHub org avatar, app icons.               |

Full bleed is deliberate: GitHub rounds org avatars itself, and a self-rounded tile inside
that reads as a doubled corner.

Both SVGs use the same path. If its shape changes, copy the `d` value to both sources before
regenerating the other assets.

## Palette

| Token       | Mark on either ground | Avatar on graphite |
| ----------- | --------------------- | ------------------ |
| Ultramarine | `#666ed7`             | `#a8b1ff`          |
| Background  | Transparent           | `#16191d`          |

The transparent mark works on both site backgrounds. Links and focus indicators use a darker
ultramarine on light pages and a lighter one on dark pages. The error colors still name remedies.
See `site/DESIGN.md` and `site/src/styles/bench.css`.

## Share card

`og.ts` places the avatar next to the name on a 1200×630 card. It names the three TypeScript
packages without listing versions, so a release does not date the image.

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

## GitHub organization profile

Edit the [English](profile/README.md), [Portuguese](profile/README.pt-BR.md) and
[Spanish](profile/README.es.md) pages here. They link directly to the generated `providerkit-mark-128.png`.
GitHub only displays the organization profile from `providerkit/.github`, so that repository holds
published copies, not another set of brand sources.

After the text changes merge into `providerkit/providerkit`'s `main`, run:

```sh
bun run profile:pr
```

The command opens a draft PR in `providerkit/.github` with just the three pages. Review and merge it
to publish. Use `bun run profile:pr --check` to list unpublished changes without pushing anything.
You need Git and `gh` signed in with write access to the profile repository. You do not need to keep
a second checkout. An image-only change needs no profile PR.

The **organization avatar** is a separate upload under Organization settings → General → Profile picture.
Use `brand/providerkit-avatar-1024.png`. If you set a **repository social preview**, use `site/public/og.png`
under Repository settings → General → Social preview. Neither setting changes when you push a README.
