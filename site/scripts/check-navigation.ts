import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Run after the site build: bun site/scripts/check-navigation.ts.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const pages = [
  "",
  "start",
  "core",
  "agents",
  "agents/getting-started",
  "agents/conversations",
  "agents/tools",
  "agents/requests",
  "agents/recovery",
  "agents/specialists",
  "agents/workflows",
  "agents/memory",
  "agents/code-mode",
  "agents/a2a",
  "agents/mcp",
  "agents/evals",
  "agents/tracing",
  "agents/background-runs",
  "react",
  "react/getting-started",
  "react/transport",
  "react/requests",
  "react/components",
  "react/styles",
  "react/recovery",
  "react/ag-ui",
  "examples",
  "demos",
  "demos/errors",
  "demos/agent",
  "demos/chat",
  "reference",
  "reference/core",
  "reference/agents",
  "reference/react",
  "concepts/package-boundaries",
  "concepts/messages-and-events",
  "concepts/tools-and-permissions",
  "concepts/retry-resume-reconnect",
  "guides/getting-started",
  "guides/errors",
  "guides/resume",
];
const targets = new Set<string>();
for (const page of pages) {
  const html = readFileSync(`${dist}${page ? `${page}/` : ""}index.html`, "utf8");
  if (["", "guides/getting-started", "demos/errors"].includes(page))
    assert.doesNotMatch(
      html,
      /<link\b[^>]*href="[^"]*\/chat-demo\.[^"]*\.css"/,
      `${page || "/"} loads chat styles before a demo is selected`,
    );
  for (const [, href] of html.matchAll(/href="(\/[^"\s]*)"/g)) {
    const path = href!.split(/[?#]/)[0]!;
    targets.add(path);
    const file = path.endsWith("/") ? `${path}index.html` : path;
    assert(existsSync(`${dist}${file.slice(1)}`), `${page || "/"} links to missing ${path}`);
  }
  if (page) assert(existsSync(`${dist}${page}.md`), `Missing Markdown for ${page}`);
}
for (const bundle of [
  "llms.txt",
  "llms-small.txt",
  "llms-full.txt",
  "kinds.json",
  "_llms-txt/guides.txt",
  "_llms-txt/api-reference.txt",
  "_llms-txt/core.txt",
  "_llms-txt/agents.txt",
  "_llms-txt/react.txt",
  "_llms-txt/concepts.txt",
]) {
  assert(existsSync(`${dist}${bundle}`), `Missing machine-readable endpoint ${bundle}`);
}
console.log(`Checked ${pages.length} authored pages and ${targets.size} navigation targets.`);
