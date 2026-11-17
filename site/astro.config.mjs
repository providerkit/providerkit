// @ts-check
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";
import { createStarlightTypeDocPlugin } from "starlight-typedoc";
import { defineConfig, passthroughImageService } from "astro/config";

const REPO = "https://github.com/providerkit/providerkit";
const DESCRIPTION =
  "Call models, run agents and build chat screens in TypeScript. Start with Core or Agents, and follow React as it develops.";
const [coreTypeDoc, coreSidebar] = createStarlightTypeDocPlugin();
const [agentsTypeDoc, agentsSidebar] = createStarlightTypeDocPlugin();
/** @satisfies {import("starlight-typedoc").StarlightTypeDocOptions["typeDoc"]} */
const typeDoc = { excludeInternal: true, useCodeBlocks: true, parametersFormat: "table" };

export default defineConfig({
  site: "https://providerkit.dev",
  // The mark is a vector. No native image optimizer is needed.
  image: { service: passthroughImageService() },
  integrations: [
    react(),
    starlight({
      title: "providerkit",
      description: DESCRIPTION,
      logo: { src: "./src/assets/mark.svg", alt: "" },
      favicon: "/favicon.svg",
      customCss: [
        "@fontsource-variable/archivo/wght.css",
        "@fontsource-variable/archivo/wght-italic.css",
        "@fontsource/commit-mono/latin-400.css",
        "@fontsource/commit-mono/latin-600.css",
        "./src/styles/bench.css",
      ],
      components: {
        Header: "./src/components/Header.astro",
        PageTitle: "./src/components/PageTitle.astro",
      },
      social: [{ icon: "github", label: "GitHub", href: REPO }],
      plugins: [
        starlightLlmsTxt({
          projectName: "providerkit",
          description: DESCRIPTION,
          details: [
            "- Core 0.33 calls providers and handles their failures. Its main entry is fetch-only with no runtime dependencies.",
            "- Agents 0.1 runs a model/tool loop using Core. The host owns authorization, storage and retention.",
            "- React is in development, not a published installation or browser demo in these docs.",
            "- Start at https://providerkit.dev/start/ to choose a package.",
            "- Error remedies and flags are data at https://providerkit.dev/kinds.json.",
            "- Every page serves Markdown: /guides/errors.md matches /guides/errors/.",
          ].join("\n"),
          optionalLinks: [
            { label: "Source", url: REPO },
            { label: "Error kinds as JSON", url: "https://providerkit.dev/kinds.json" },
          ],
          rawContent: true,
          exclude: ["reference/**"],
          customSets: [
            {
              label: "Guides",
              paths: ["guides/**"],
              description: "Core guides, at their existing URLs",
            },
            {
              label: "API reference",
              paths: ["reference/**"],
              description: "Released Core and Agents exports",
            },
            {
              label: "Core",
              paths: ["core", "guides/**", "reference/core", "reference/core/**"],
              description: "Provider calls, failures, tools and media",
            },
            {
              label: "Agents",
              paths: ["agents", "agents/**", "reference/agents", "reference/agents/**"],
              description: "The released 0.1 agent loop and host-run binding",
            },
            {
              label: "React",
              paths: ["react"],
              description: "Development overview and public implementation work",
            },
            {
              label: "Concepts",
              paths: ["start", "concepts/**", "examples/**", "demos/**"],
              description: "Package boundaries and runnable examples",
            },
          ],
        }),
        coreTypeDoc({
          entryPoints: [
            "../core/src/index.ts",
            "../core/src/hosted.ts",
            "../core/src/otel.ts",
            "../core/src/zod.ts",
            "../core/src/decisions.ts",
            "../core/src/speech.ts",
            "../core/src/transcription.ts",
            "../core/src/auth/index.ts",
          ],
          tsconfig: "../core/tsconfig.json",
          output: "reference/core",
          sidebar: { label: "Core API", collapsed: true },
          typeDoc,
        }),
        agentsTypeDoc({
          entryPoints: ["../agents/src/index.ts", "../agents/src/runs.ts"],
          tsconfig: "../agents/tsconfig.json",
          output: "reference/agents",
          sidebar: { label: "Agents API", collapsed: true },
          typeDoc,
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
        { label: "Start here", slug: "start" },
        {
          label: "Core",
          collapsed: true,
          items: [
            { label: "Overview", slug: "core" },
            { label: "Quickstart", slug: "guides/getting-started" },
            { label: "Providers", slug: "guides/providers" },
            { label: "Provider registry", slug: "guides/registry" },
            { label: "Errors", slug: "guides/errors" },
            { label: "Retries and fallback", slug: "guides/retries" },
            { label: "Limits and key pools", slug: "guides/limits" },
            { label: "Streaming", slug: "guides/streaming" },
            { label: "Subscription sign-in", slug: "guides/auth" },
            { label: "Tools", slug: "guides/tools" },
            { label: "Context and compaction", slug: "guides/context" },
            { label: "Restore provider history", slug: "guides/resume" },
            { label: "Usage and cost", slug: "guides/usage" },
            { label: "Decision models", slug: "guides/decisions" },
            { label: "Speech", slug: "guides/speech" },
            { label: "Transcription", slug: "guides/transcription" },
          ],
        },
        {
          label: "Agents",
          collapsed: true,
          items: [
            { label: "Overview", slug: "agents" },
            { label: "Quickstart", slug: "agents/getting-started" },
          ],
        },
        { label: "React", slug: "react" },
        {
          label: "Concepts",
          collapsed: true,
          items: [
            { label: "Package boundaries", slug: "concepts/package-boundaries" },
            { label: "Messages and events", slug: "concepts/messages-and-events" },
            { label: "Tools and permissions", slug: "concepts/tools-and-permissions" },
            { label: "Retry, resume and reconnect", slug: "concepts/retry-resume-reconnect" },
          ],
        },
        { label: "Examples", slug: "examples" },
        { label: "Demos", slug: "demos" },
        { label: "Error classifier", slug: "demos/errors" },
        { label: "API reference", slug: "reference" },
        coreSidebar,
        agentsSidebar,
      ],
    }),
  ],
});
