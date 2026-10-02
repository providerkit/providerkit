// No em dash in the text readers see. ESLint covers every string in the ts/tsx sources
// (eslint.config.js, NO_EM_DASH); this covers what it cannot parse: the README, the
// changelog, the docs guides, the Astro components, the site config and the package
// descriptions. Comments are blanked first, so they stay free. An em dash gives away
// AI-written text. Run from the repo root: `bun run core/scripts/check-no-em-dash.ts`.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const EM_DASH = "—";
const DOCS = "site/src/content/docs";

const docs = readdirSync(DOCS, { recursive: true, encoding: "utf8" })
  .filter((file) => /\.mdx?$/.test(file) && !file.startsWith("reference"))
  .map((file) => join(DOCS, file));
const components = readdirSync("site/src/components")
  .filter((file) => file.endsWith(".astro"))
  .map((file) => join("site/src/components", file));
const files = [
  "README.md",
  "CHANGELOG.md",
  "package.json",
  "core/package.json",
  "site/package.json",
  "site/astro.config.mjs",
  ...docs,
  ...components,
];

// Blank comments but keep every newline, so reported line numbers stay right.
const blank = (match: string) => match.replace(/[^\n]/g, " ");
const withoutComments = (text: string) =>
  text
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^\s*\/\/.*$/gm, blank);

const problems = files.flatMap((file) =>
  withoutComments(readFileSync(file, "utf8"))
    .split("\n")
    .flatMap((line, i) => (line.includes(EM_DASH) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
);

if (problems.length > 0) {
  console.error(
    `Em dash found in ${problems.length} user-facing line(s). Use a period, comma, colon or parentheses:\n` +
      problems.join("\n"),
  );
  process.exit(1);
}
console.log(`no em dash in ${files.length} user-facing files`);
