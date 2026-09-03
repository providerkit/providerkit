#!/usr/bin/env bash
# Rasterize the brand SVGs. rsvg-convert (librsvg) does the vector work and
# ImageMagick only re-encodes PNG to JPEG — magick's own SVG delegate IS
# rsvg-convert, so going straight to it skips a layer that adds nothing.
#   brew install librsvg imagemagick
set -euo pipefail
cd "$(dirname "$0")"

for bin in rsvg-convert magick; do
  command -v "$bin" >/dev/null || { echo "missing $bin — brew install librsvg imagemagick" >&2; exit 1; }
done

echo "avatar (GitHub org — ink tile, full bleed):"
for size in 1024 512 256; do
  rsvg-convert -w "$size" -h "$size" providerkit-avatar.svg -o "providerkit-avatar-$size.png"
  echo "  providerkit-avatar-$size.png"
done
# JPEG carries no alpha; the tile is opaque, so nothing is lost.
magick providerkit-avatar-1024.png -quality 95 providerkit-avatar-1024.jpg
echo "  providerkit-avatar-1024.jpg"

echo "mark (transparent — docs, site, favicon):"
for size in 512 256 128; do
  rsvg-convert -w "$size" -h "$size" providerkit-mark.svg -o "providerkit-mark-$size.png"
  echo "  providerkit-mark-$size.png"
done

# The site's icons are generated from the same two SVGs, never hand-copied, so
# brand/ stays the only place the artwork lives. Committed so `bun run build`
# works without librsvg installed.
echo "site icons:"
mkdir -p ../site/public
cp providerkit-mark.svg ../site/public/favicon.svg
echo "  site/public/favicon.svg"
# apple-touch-icon sits on whatever colour the OS puts behind it — the opaque
# tile, not the transparent mark.
rsvg-convert -w 180 -h 180 providerkit-avatar.svg -o ../site/public/apple-touch-icon.png
echo "  site/public/apple-touch-icon.png"
