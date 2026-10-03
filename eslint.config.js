import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

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
    // The site only. exhaustive-deps is the rule that catches real React bugs.
    files: ["site/**/*.tsx"],
    extends: [reactHooks.configs.flat.recommended],
  },
);
