/**
 * Verifies that `nativewind/babel` rewrites every React Native component import in `dist/` to
 * `react-native-css/components/*`.
 *
 * No React Native or NativeWind doc promises that the Babel plugin rewrites packages inside
 * `node_modules` cleanly, or that every primitive our UI imports has a wrapper in
 * `react-native-css/components/*`. Running the real preset over the built ESM files before publish
 * catches a broken import (or a newly added primitive without a wrapper, like `SafeAreaView` or a
 * namespace import) while it is still easy to fix.
 */
import { transformFileSync } from "@babel/core";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Non-component APIs from `react-native` that never receive `className` and therefore have no
 * `react-native-css/components/*` wrapper. Any other specifier left on `"react-native"` after
 * `nativewind/babel` runs is a failure.
 */
const NON_COMPONENT_APIS = new Set(["AccessibilityInfo"]);

export interface BabelCheckProblem {
  file: string;
  specifier: string;
  reason: string;
}

export interface BabelCheckResult {
  filesChecked: number;
  rewrittenCount: number;
  problems: BabelCheckProblem[];
}

/** Reads every `.js` file under `dir` recursively, sorted for stable output. */
function collectJsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
  }
  return files.sort();
}

/**
 * Inspects one built file by running `nativewind/babel` and walking the resulting AST, which
 * avoids regex false matches on comments or strings.
 */
function inspectFile(
  file: string,
  cwd: string,
  baseDir: string,
  preset: string,
): { rewritten: number; problems: BabelCheckProblem[] } {
  const result = transformFileSync(file, {
    cwd,
    babelrc: false,
    configFile: false,
    ast: true,
    code: false,
    presets: [preset],
  });
  const rel = relative(baseDir, file);
  if (!result?.ast) {
    return {
      rewritten: 0,
      problems: [{ file: rel, specifier: "*", reason: "Babel produced no AST." }],
    };
  }

  let rewritten = 0;
  const problems: BabelCheckProblem[] = [];

  for (const node of result.ast.program.body) {
    if (node.type !== "ImportDeclaration") continue;
    const source = node.source.value;

    if (source.startsWith("react-native-css/components/")) {
      rewritten += node.specifiers.length;
      continue;
    }

    if (source === "react-native-css/components") {
      // A namespace or default import rewrites to the barrel, not a per-component module.
      problems.push({
        file: rel,
        specifier: source,
        reason:
          'Imported react-native as default or namespace; use named imports so react-native-css rewrites each one to "react-native-css/components/*".',
      });
      continue;
    }

    if (source !== "react-native" && !source.startsWith("react-native/")) continue;

    if (node.specifiers.length === 0) {
      problems.push({
        file: rel,
        specifier: source,
        reason: `Side-effect import "${source}" was not rewritten.`,
      });
      continue;
    }

    for (const spec of node.specifiers) {
      if (spec.type !== "ImportSpecifier") {
        problems.push({
          file: rel,
          specifier: spec.local.name,
          reason: `Non-named import "${spec.local.name}" from "${source}" was not rewritten.`,
        });
        continue;
      }
      const imported =
        spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
      if (source === "react-native" && NON_COMPONENT_APIS.has(imported)) continue;
      problems.push({
        file: rel,
        specifier: imported,
        reason: `"${imported}" from "${source}" was not rewritten to "react-native-css/components/${imported}".`,
      });
    }
  }

  return { rewritten, problems };
}

export function checkBabel(packageRoot: string, targetDir?: string): BabelCheckResult {
  const root = resolve(packageRoot);
  const distDir = targetDir ? resolve(targetDir) : join(root, "dist");
  const baseDir = targetDir ? distDir : root;
  const fromPkg = createRequire(join(root, "package.json"));
  const preset = fromPkg.resolve("nativewind/babel");
  const files = collectJsFiles(distDir);
  if (files.length === 0) {
    throw new Error(`No built .js files found under ${distDir}. Run "bun run build" first.`);
  }

  let rewrittenCount = 0;
  const problems: BabelCheckProblem[] = [];

  for (const file of files) {
    const { rewritten, problems: fileProblems } = inspectFile(file, root, baseDir, preset);
    rewrittenCount += rewritten;
    problems.push(...fileProblems);
  }

  if (rewrittenCount === 0 && problems.length === 0) {
    problems.push({
      file: relative(baseDir, distDir) || ".",
      specifier: "*",
      reason: "Expected at least one react-native component import to be rewritten, found 0.",
    });
  }

  return { filesChecked: files.length, rewrittenCount, problems };
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { filesChecked, rewrittenCount, problems } = checkBabel(packageRoot);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`${problem.file}: ${problem.reason}`);
    }
    console.error(`babel check: ${problems.length} problem(s) across ${filesChecked} dist files.`);
    process.exitCode = 1;
  } else {
    console.log(
      `babel check: ${rewrittenCount} react-native component imports rewritten across ${filesChecked} dist files.`,
    );
  }
}
