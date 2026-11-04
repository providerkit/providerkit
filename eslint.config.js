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
    // Each capability reaches the shared modules and never another capability's files, so a
    // capability can become its own package later without untangling anything (AGENTS.md,
    // "One package, many entry points").
    files: ["core/src/speech*.ts", "core/src/providers/*speech*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/decisions*", "**/zod*", "**/auth/**"],
              message: "Speech imports the shared modules only, never another capability.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["core/src/decisions*.ts", "core/src/zod*.ts", "core/src/auth/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/speech*", "**/providers/*speech*"],
              message: "A capability imports the shared modules only, never speech.",
            },
          ],
        },
      ],
    },
  },
  {
    // The site only. exhaustive-deps is the rule that catches real React bugs.
    files: ["site/**/*.tsx"],
    extends: [reactHooks.configs.flat.recommended],
  },
);
