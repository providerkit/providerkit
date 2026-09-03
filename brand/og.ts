/**
 * The providerkit Open Graph card (1200×630) as an SVG string.
 *
 * Called bare it renders the brand card behind `site/public/og.png`; called
 * with copy it renders a per-page card. The layout is fixed — mark + wordmark,
 * one bold tagline, one muted subtitle, one meta strip — only the copy changes.
 *
 * Rasterized by brand/generate.ts.
 */
import { readFileSync } from "node:fs";

/** The mark's paths with the <svg> wrapper and its opaque tile stripped, so it
 *  nests in the card without a nested document root or a second background. */
const MARK_INNER = readFileSync(`${import.meta.dir}/providerkit-avatar.svg`, "utf8")
  .replace(/<svg[\s\S]*?>/, "")
  .replace(/<\/svg>\s*$/, "")
  .replace(/<rect[^>]*\/>/, "")
  .trim();

const MARK_VIEWBOX = 64; // matches the mark's viewBox

const W = 1200;
const H = 630;
const MARGIN = 80;
const TEXT_W = W - MARGIN * 2;

// Values from site/src/styles.css — the card is the site's dark theme.
const BG = "#0b0d10";
const TEXT = "#e8ebef";
const DIM = "#99a1ac";
const FAINT = "#6b7481";
const ACCENT = "#4fd1c5";

// Inter is the brand face but isn't installed system-wide, so resvg falls back
// to the first stack entry it can resolve. Only the card text is affected —
// the mark is pure vector.
const SANS = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";

/** Average advance as a share of em, for bold and regular. Turns a pixel width
 *  into a character budget without measuring glyphs. */
const BOLD_ADVANCE = 0.48;
const BODY_ADVANCE = 0.48;

export interface OgCardInput {
  title?: string;
  subtitle?: string;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Greedy word wrap to a character budget. The subtitle genuinely needs two
 *  lines, so wrapping beats clipping here. */
function wrap(text: string, size: number, advance: number, maxLines: number): string[] {
  const max = Math.floor(TEXT_W / (size * advance));
  const lines: string[] = [];
  let line = "";
  for (const word of text.replace(/\s+/g, " ").trim().split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= max) {
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  // Anything past the last line is dropped, so mark the cut.
  if (lines.length === maxLines && lines.join(" ").length < text.length - 1) {
    lines[maxLines - 1] = `${lines[maxLines - 1]!.replace(/[,;:]$/, "")}…`;
  }
  return lines;
}

export function ogCardSvg(input: OgCardInput = {}): string {
  const title = input.title ?? "The layer under your agent loop.";
  const subtitle =
    input.subtitle ??
    "One seam for every LLM provider — plus the failure handling you only learn in production.";

  const titleSize = title.length <= 34 ? 64 : 54;
  const titleLines = wrap(title, titleSize, BOLD_ADVANCE, 2);
  const subLines = wrap(subtitle, 30, BODY_ADVANCE, 2);

  const mark = 104;
  const scale = mark / MARK_VIEWBOX;
  // Title block is bottom-anchored so a one- or two-line title keeps the
  // subtitle and meta strip where they are. 320 centres the message band
  // between the header and the rule; higher leaves a hollow middle.
  const titleBottom = 320;
  const titleTop = titleBottom - (titleLines.length - 1) * (titleSize + 12);
  const subTop = titleBottom + 66;

  const text = (
    x: number,
    y: number,
    size: number,
    weight: number,
    fill: string,
    body: string,
    spacing = "0",
  ) =>
    `<text x="${x}" y="${y}" font-family="${SANS}" font-size="${size}" ` +
    `font-weight="${weight}" letter-spacing="${spacing}" fill="${fill}">${body}</text>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="${BG}"/>` +
    `<g transform="translate(${MARGIN} 74) scale(${scale})">${MARK_INNER}</g>` +
    text(
      MARGIN + mark + 26,
      145,
      46,
      600,
      TEXT,
      `provider<tspan fill="${ACCENT}">kit</tspan>`,
      "-1.2",
    ) +
    titleLines
      .map((line, i) =>
        text(
          MARGIN,
          titleTop + i * (titleSize + 12),
          titleSize,
          700,
          TEXT,
          escapeXml(line),
          "-1.8",
        ),
      )
      .join("") +
    subLines
      .map((line, i) => text(MARGIN, subTop + i * 42, 30, 400, DIM, escapeXml(line)))
      .join("") +
    `<rect x="${MARGIN}" y="546" width="${TEXT_W}" height="1" fill="#232830"/>` +
    text(
      MARGIN,
      592,
      24,
      500,
      FAINT,
      `@providerkit/core${" ".repeat(3)}·${" ".repeat(3)}zero dependencies` +
        `${" ".repeat(3)}·${" ".repeat(3)}fetch only${" ".repeat(3)}·${" ".repeat(3)}MIT`,
    ) +
    `</svg>\n`
  );
}
