#!/usr/bin/env bun
/**
 * Regenerate every raster brand asset from the two SVGs in this folder.
 *
 *   bun run brand:assets
 *
 * The SVGs and brand/og.ts are the only things a human edits; everything this
 * writes is a derived artifact, overwritten on each run and committed so the
 * site builds without running it.
 *
 * resvg rather than a system binary (rsvg-convert, ImageMagick): this repo is
 * open source, and `brew install` is a barrier for a contributor on Linux or
 * Windows. The one exception is the JPEG, which resvg can't emit — that step
 * is best-effort and skips with a note when ImageMagick isn't around.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { ogCardSvg } from "./og.ts";

const HERE = import.meta.dir;
const ROOT = resolve(HERE, ".."); // normalized, so log paths print relative
const SITE_PUBLIC = `${ROOT}/site/public`;

function png(svg: string, width: number, out: string): void {
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    // Only the OG card has text; the icons are pure vector.
    font: { loadSystemFonts: true, defaultFontFamily: "Inter, sans-serif" },
  });
  writeFileSync(out, r.render().asPng());
  console.log(`  ${out.replace(ROOT, ".")}`);
}

const avatar = readFileSync(`${HERE}/providerkit-avatar.svg`, "utf8");
const mark = readFileSync(`${HERE}/providerkit-mark.svg`, "utf8");

console.log("avatar (GitHub org — ink tile, full bleed):");
for (const size of [1024, 512, 256]) {
  png(avatar, size, `${HERE}/providerkit-avatar-${size}.png`);
}

// JPEG carries no alpha; the tile is opaque, so nothing is lost.
try {
  execFileSync("magick", [
    `${HERE}/providerkit-avatar-1024.png`,
    "-quality",
    "95",
    `${HERE}/providerkit-avatar-1024.jpg`,
  ]);
  console.log("  ./brand/providerkit-avatar-1024.jpg");
} catch {
  console.log("  (skipped .jpg — ImageMagick not installed; the .png works everywhere)");
}

console.log("mark (transparent — docs, site):");
for (const size of [512, 256, 128]) {
  png(mark, size, `${HERE}/providerkit-mark-${size}.png`);
}

console.log("site:");
mkdirSync(SITE_PUBLIC, { recursive: true });
copyFileSync(`${HERE}/providerkit-mark.svg`, `${SITE_PUBLIC}/favicon.svg`);
console.log("  ./site/public/favicon.svg");
// Starlight imports the logo from src/assets so Astro can process it.
mkdirSync(`${ROOT}/site/src/assets`, { recursive: true });
copyFileSync(`${HERE}/providerkit-mark.svg`, `${ROOT}/site/src/assets/mark.svg`);
console.log("  ./site/src/assets/mark.svg");
// apple-touch-icon sits on whatever colour the OS puts behind it — the opaque
// tile, not the transparent mark.
png(avatar, 180, `${SITE_PUBLIC}/apple-touch-icon.png`);
png(ogCardSvg(), 1200, `${SITE_PUBLIC}/og.png`);
