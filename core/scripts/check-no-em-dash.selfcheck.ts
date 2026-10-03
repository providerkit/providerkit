// Run only this check: `bun run core/scripts/check-no-em-dash.selfcheck.ts`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(root, "core/scripts/check-no-em-dash.ts");
const dash = String.fromCodePoint(0x2014);
const fixture = mkdtempSync(join(tmpdir(), "providerkit-copy-"));
const baseline: Record<string, string> = {
  "README.md": "Read the docs.\n",
  "CHANGELOG.md": "Changes.\n",
  "brand/README.md": "Brand assets.\n",
  "package.json": "{}\n",
  "core/package.json": "{}\n",
  "site/package.json": "{}\n",
  "site/astro.config.mjs": "export default {};\n",
  "core/src/public.ts": "export const value = 1;\n",
  "site/src/content/docs/guides/example.md": "Read this guide.\n",
  "site/src/components/nested/Example.astro": "<p>Read the docs.</p>\n",
};
const failures: string[] = [];

function check(file: string, content: string, rejected: boolean): void {
  writeFileSync(join(fixture, file), content);
  try {
    const result = spawnSync(process.execPath, [script], { cwd: fixture, encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, rejected ? 1 : 0, `${file}: ${result.stdout}${result.stderr}`);
    if (rejected) assert.ok(result.stderr.includes(`${file}:`), result.stderr);
  } catch (error) {
    failures.push(String(error));
  } finally {
    writeFileSync(join(fixture, file), baseline[file]!);
  }
}

try {
  for (const [file, content] of Object.entries(baseline)) {
    mkdirSync(dirname(join(fixture, file)), { recursive: true });
    writeFileSync(join(fixture, file), content);
  }
  check("README.md", `Read ${dash} then act.\n`, true);
  check("brand/README.md", `Brand ${dash} assets.\n`, true);
  for (const content of [
    `\`\`\`ts\n// Read ${dash} then act.\n\`\`\`\n`,
    `\`\`\`ts\n/* Read ${dash} then act. */\n\`\`\`\n`,
    `\`\`\`html\n<!-- Read ${dash} then act. -->\n\`\`\`\n`,
    "Read &mdash; then act.\n",
    "Read &#8212; then act.\n",
    "Read &#x2014; then act.\n",
  ])
    check("site/src/content/docs/guides/example.md", content, true);
  check("core/package.json", '{"description":"Read \\u2014 then act."}\n', true);
  check("site/astro.config.mjs", "export const title = `Read \\u2014 then act.`;\n", true);
  check("site/astro.config.mjs", `// Internal ${dash} comment.\nexport default {};\n`, false);
  check("core/src/public.ts", `/** Read ${dash} then act. */\nexport const value = 1;\n`, true);
  check(
    "core/src/public.ts",
    `export interface Public {\n/** Field ${dash} detail. */\nname: string;\n}\n`,
    true,
  );
  check(
    "core/src/public.ts",
    `export type Public =\n/** First. */\n| "first"\n/** Second ${dash} detail. */\n| "second";\n`,
    true,
  );
  check(
    "core/src/public.ts",
    `// Internal ${dash} comment.\n/* Internal ${dash} block. */\nexport const value = 1;\n`,
    false,
  );
  check(
    "core/src/public.ts",
    `export const example = "/** Not documentation ${dash} */";\n`,
    false,
  );
  for (const content of [
    `<p>Read ${dash} then act.</p>\n`,
    "<p>Read &mdash; then act.</p>\n",
    '---\nconst title = "Read \\u2014 then act.";\n---\n<p>{title}</p>\n',
    '<p>{"Read \\u2014 then act."}</p>\n',
    `<p>{"<!-- Read ${dash} -->"}</p>\n`,
    `<p>{"<script>Read ${dash}</script>"}</p>\n`,
    '<script>console.log("Read \\u2014 then act.");</script>\n',
  ])
    check("site/src/components/nested/Example.astro", content, true);
  check(
    "site/src/components/nested/Example.astro",
    `<!-- Internal "quoted ${dash}" comment. -->\n<p>Read this.</p>\n`,
    false,
  );
  check(
    "site/src/components/nested/Example.astro",
    `---\n// Internal ${dash} comment.\n---\n{/* Internal ${dash} comment. */}\n<p>Read this.</p>\n<script>\n// Internal ${dash} comment.\n</script>\n`,
    false,
  );

  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/eslint/bin/eslint.js"),
      "--stdin",
      "--stdin-filename",
      "site/src/copy-probe.tsx",
    ],
    {
      cwd: root,
      encoding: "utf8",
      input: [
        `export const literal = "Read ${dash} then act.";`,
        'export const escapedLiteral = "Read \\u2014 then act.";',
        "export const template = `Read \\u2014 then act.`;",
        "export const codePointTemplate = `Read \\u{2014} then act.`;",
        `export const jsx = <p>Read ${dash} then act.</p>;`,
        "export const namedEntity = <p>&mdash;</p>;",
        "export const decimalEntity = <p>&#8212;</p>;",
        "export const hexEntity = <p>&#x2014;</p>;",
      ].join("\n"),
    },
  );
  try {
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal((result.stdout.match(/no-restricted-syntax/g) ?? []).length, 8, result.stdout);
  } catch (error) {
    failures.push(String(error));
  }
  assert.deepEqual(failures, []);
  console.log("copy guard assertions passed");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
