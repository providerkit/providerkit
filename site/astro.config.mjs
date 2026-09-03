// @ts-check
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";
import { defineConfig, passthroughImageService } from "astro/config";

const REPO = "https://github.com/providerkit/providerkit";
const DESCRIPTION =
  "One seam for every LLM provider, plus the failure handling you only learn in production. Zero dependencies, fetch-only, MIT.";

export default defineConfig({
  site: "https://providerkit.dev",
  // The only processed image is the SVG mark, and there is nothing to
  // optimize in a vector. Passthrough keeps sharp — a native binary — out of
  // the dependency tree and out of CI.
  image: { service: passthroughImageService() },
  integrations: [
    // React is here for one reason: the classifier on the landing page runs the
    // real package in the reader's browser. Everything else is static Astro.
    react(),
    starlight({
      title: "providerkit",
      description: DESCRIPTION,
      logo: { src: "./src/assets/mark.svg", alt: "" },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/brand.css"],
      social: [{ icon: "github", label: "GitHub", href: REPO }],
      // The reference is generated from the TSDoc already in core/src, so it
      // cannot drift from the code the way a hand-written one does.
      plugins: [
        // Agents read this site as much as people do, and they never render the
        // visual world — they want the markdown underneath. See the per-page
        // .md endpoint in src/pages for the other half of this.
        starlightLlmsTxt({
          projectName: "providerkit",
          description: DESCRIPTION,
          details: [
            "- Install: `bun add @providerkit/core` (npm/pnpm/yarn also fine). ESM only.",
            "- It is NOT an agent framework: no loop, no prompts, no memory, no graph.",
            "- Zero runtime dependencies, `fetch` only, so one build runs in Bun, Node,",
            "  Cloudflare Workers, Deno and a Chrome MV3 service worker.",
            "- Errors are classified into 13 kinds named by what FIXES them, not by vendor",
            "  or HTTP status. See the Errors guide before reasoning about a failure.",
          ].join("\n"),
          optionalLinks: [
            { label: "npm", url: "https://www.npmjs.com/package/@providerkit/core" },
            { label: "Source", url: REPO },
          ],
          // Serve the original markdown rather than markdown reconstructed from
          // rendered HTML: code fences and tables survive exactly, and it skips
          // rendering the landing page's React island, which has no meaning as text.
          rawContent: true,
          // llms-small.txt is the cheap one — guides only, no generated reference.
          exclude: ["reference/**"],
          // Split by cost: an agent answering "what does this error mean" wants the
          // guides, and one writing code against the package wants the signatures.
          // Concatenating all ~93 pages into one context file serves neither.
          customSets: [
            {
              label: "Guides",
              paths: ["guides/**"],
              description:
                "the hand-written guides only — errors, retries, streaming, tools, context, cost",
            },
            {
              label: "API reference",
              paths: ["reference/**"],
              description: "every exported symbol, generated from the TypeScript source",
            },
          ],
        }),
        starlightTypeDoc({
          entryPoints: ["../core/src/index.ts", "../core/src/zod.ts"],
          tsconfig: "../core/tsconfig.json",
          output: "reference",
          typeDoc: { excludeInternal: true, useCodeBlocks: true, parametersFormat: "table" },
        }),
      ],
      editLink: { baseUrl: `${REPO}/edit/main/site/` },
      lastUpdated: true,
      head: [
        { tag: "meta", attrs: { property: "og:image", content: "https://providerkit.dev/og.png" } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        {
          tag: "meta",
          attrs: { name: "twitter:image", content: "https://providerkit.dev/og.png" },
        },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" } },
      ],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Getting started", slug: "guides/getting-started" },
            { label: "The provider seam", slug: "guides/providers" },
          ],
        },
        {
          label: "Surviving production",
          items: [
            { label: "Errors", slug: "guides/errors" },
            { label: "Retries and fallback", slug: "guides/retries" },
            { label: "Streaming and the watchdog", slug: "guides/streaming" },
          ],
        },
        {
          label: "Building a loop",
          items: [
            { label: "Tools", slug: "guides/tools" },
            { label: "Context and compaction", slug: "guides/context" },
            { label: "Usage and cost", slug: "guides/usage" },
          ],
        },
        typeDocSidebarGroup,
      ],
    }),
  ],
});
