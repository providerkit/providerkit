/** The 1200×630 site share card. Rasterized by brand/generate.ts. */
import { readFileSync } from "node:fs";

// Keep the mark's geometry in its SVG source, not another hand-drawn copy.
const mark = readFileSync(`${import.meta.dir}/providerkit-avatar.svg`, "utf8")
  .replace(/<svg[\s\S]*?>/, "")
  .replace(/<\/svg>\s*$/, "")
  .replace(/<rect[^>]*\/>/, "")
  .trim();

export function ogCardSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#16191d"/>
  <g transform="translate(80 60) scale(1.5)">${mark}</g>
  <g font-family="Archivo" fill="#e4e9ee">
    <text x="200" y="126" font-size="46" font-weight="600" letter-spacing="-1">providerkit</text>
    <text x="80" y="278" font-size="64" font-weight="600" letter-spacing="-1.5">Call models. Run agents.</text>
    <text x="80" y="358" font-size="64" font-weight="600" letter-spacing="-1.5">Build chat screens.</text>
    <text x="80" y="436" font-size="30" fill="#b4bdc7">TypeScript packages for your app's AI.</text>
    <text x="80" y="550" font-size="24" fill="#b4bdc7">Core 0.33</text>
    <text x="310" y="550" font-size="24" fill="#b4bdc7">Agents 0.1</text>
    <text x="560" y="550" font-size="24" fill="#b4bdc7">React in development</text>
    <text x="80" y="592" font-size="22" fill="#7f8a96">providerkit.dev</text>
  </g>
</svg>\n`;
}
