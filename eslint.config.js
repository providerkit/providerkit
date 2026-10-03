import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/** Check runtime strings and JSX in shipped sources. TSDoc, Markdown, Astro,
 *  config and package descriptions are covered by core/scripts/check-no-em-dash.ts.
 *  Internal implementation comments and tests are exempt. Unicode escapes keep
 *  the prohibited character out of this config. */
const NO_EM_DASH = [
  "Literal[value=/\\u2014/]",
  "TemplateElement[value.raw=/\\u2014/]",
  "TemplateElement[value.cooked=/\\u2014/]",
  "JSXText[value=/\\u2014/]",
].map((selector) => ({
  selector,
  message: "No em dash in user-facing text. Use a period, comma, colon or parentheses.",
}));

// One config for the whole repo — eslint walks up from each workspace, so
// `eslint src` in core/ or site/ resolves to this file.
export default tseslint.config(
  {
    // Generated: TypeDoc output and Astro's type shims. Also brand/generate.ts
    // is a build script — it is Node, not the MV3-safe library code.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "site/.astro/**",
      "site/src/content/docs/reference/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["core/src/**/*.ts", "core/scripts/**/*.ts", "site/src/**/*.{ts,tsx}", "brand/**/*.ts"],
    // The guard script names the character, so the rule would flag its own constant.
    ignores: ["core/scripts/check-no-em-dash.ts"],
    rules: { "no-restricted-syntax": ["error", ...NO_EM_DASH] },
  },
  {
    // The site only. exhaustive-deps is the rule that catches real React bugs.
    files: ["site/**/*.tsx"],
    extends: [reactHooks.configs.flat.recommended],
  },
);
