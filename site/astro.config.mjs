// @ts-check
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
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
