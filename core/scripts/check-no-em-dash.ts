// ESLint checks strings, templates and JSX in ts/tsx. This checks the remaining
// published copy, including the TSDoc that TypeDoc turns into the API reference.
// Run from the repo root: `bun run core/scripts/check-no-em-dash.ts`.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const EM_DASH = /—|&mdash;|&#0*8212;?|&#[xX]0*2014;?/;
const DOCS = "site/src/content/docs";
const docs = readdirSync(DOCS, { recursive: true, encoding: "utf8" })
  .filter((file) => /\.mdx?$/.test(file) && !file.startsWith("reference/"))
  .map((file) => join(DOCS, file));
const components = readdirSync("site/src/components", { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".astro"))
  .map((file) => join("site/src/components", file));
const sources = readdirSync("core/src", { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => join("core/src", file));
const files = [
  "README.md",
  "CHANGELOG.md",
  "brand/README.md",
  "package.json",
  "core/package.json",
  "site/package.json",
  "site/astro.config.mjs",
  ...docs,
  ...components,
  ...sources,
];
const problems = new Set<string>();

function report(file: string, text: string, position: number, value: string): void {
  if (!EM_DASH.test(value)) return;
  const line = text.slice(0, position).split("\n").length;
  problems.add(`${file}:${line}: ${text.split("\n")[line - 1]!.trim()}`);
}

function checkText(file: string, text: string, value = text, offset = 0): void {
  for (const match of value.matchAll(new RegExp(EM_DASH, "g"))) {
    report(file, text, offset + match.index, match[0]);
  }
}

function checkCode(
  file: string,
  text: string,
  mode: "strings" | "docs" | "expressions" | "markup" = "strings",
): void {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    mode === "markup" || mode === "expressions" ? ts.ScriptKind.TSX : undefined,
  );
  const seen = new Set<number>();
  function visit(node: ts.Node): void {
    if (mode === "docs") {
      for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
        if (!seen.has(range.pos) && text.startsWith("/**", range.pos)) {
          seen.add(range.pos);
          checkText(file, text, text.slice(range.pos, range.end), range.pos);
        }
      }
    } else if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateLiteralToken(node) ||
      (mode === "markup" && ts.isJsxText(node))
    ) {
      // The compiler decodes Unicode escapes in JSON and JavaScript strings.
      report(file, text, node.getStart(source), node.text);
    }
    // Include tokens: JSDoc on a union member can precede its `|`, not its type.
    for (const child of node.getChildren(source)) visit(child);
  }
  visit(source);
}

// Keep newlines so frontmatter and script errors retain the component's line numbers.
const blank = (match: string) => match.replace(/[^\n]/g, " ");
function checkAstro(file: string, text: string): void {
  let markup = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, (frontmatter) => {
    checkCode(file, frontmatter.replace(/^---\r?$/gm, blank));
    return blank(frontmatter);
  });
  // These components use JSX-compatible markup. Check strings before hiding script
  // blocks or HTML comments, since an expression can display literal HTML syntax.
  checkCode(file, "<>" + markup + "</>", "expressions");
  markup = markup.replace(
    /<script\b[^>]*>([\s\S]*?)<\/script>/g,
    (match, code: string, offset: number) => {
      const before = markup.slice(0, offset).split("\n").length - 1;
      checkCode(file, "\n".repeat(before) + code);
      return blank(match);
    },
  );
  checkCode(file, "<>" + markup.replace(/<!--[\s\S]*?-->/g, blank) + "</>", "markup");
}

for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (sources.includes(file)) checkCode(file, text, "docs");
  else if (/\.(json|mjs)$/.test(file)) checkCode(file, text);
  else if (file.endsWith(".astro")) checkAstro(file, text);
  // Markdown code examples and their comments are visible documentation.
  else checkText(file, text);
}

if (problems.size > 0) {
  console.error(
    `Em dash found in ${problems.size} user-facing line(s). Use a period, comma, colon or parentheses:\n` +
      [...problems].join("\n"),
  );
  process.exit(1);
}
console.log(`no em dash in ${files.length} user-facing files`);
