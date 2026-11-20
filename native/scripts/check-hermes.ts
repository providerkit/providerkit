/**
 * Bundles a small React Native fixture that imports `@providerkit/native` (all three entries) and
 * `@providerkit/react` (root and `/protocol`) through Metro, then compiles the production bundle
 * with `hermes-compiler`'s `hermesc`.
 *
 * This catches syntax Hermes refuses (such as unlowered async generators or unsupported regex
 * flags) and Metro resolution problems before publish, without needing Xcode or Gradle. Missing
 * runtime APIs still require a device or simulator.
 *
 * Ported from `@gusnips/native`'s `hermes.ts` and `metro.ts` rules, without importing anything
 * from `@gusnips/*`: providerkit never depends on the kit.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire, SourceMap } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type HermesPlatform = "ios" | "android";

export interface HermesError {
  message: string;
  line: number;
  column: number;
}

export interface HermesProblem extends HermesError {
  platform: HermesPlatform;
  file: string;
}

/** Metro's minimal public API read from `@react-native/metro-config`'s bundled `metro` copy. */
interface MetroApi {
  loadConfig(
    argv: { cwd: string; maxWorkers?: number; resetCache?: boolean },
    defaultConfigOverrides?: Record<string, unknown>,
  ): Promise<unknown>;
  runBuild(
    config: unknown,
    options: {
      entry: string;
      out: string;
      platform: HermesPlatform;
      dev: boolean;
      minify: boolean;
      sourceMap: boolean;
      sourceMapUrl?: string;
    },
  ): Promise<unknown>;
}

type MetroResolution = { type: string; filePath?: string };

interface MetroResolveContext {
  resolveRequest: MetroResolveRequest;
}

type MetroResolveRequest = (
  context: MetroResolveContext,
  moduleName: string,
  platform: string | null,
) => MetroResolution;

interface MetroConfigModule {
  getDefaultConfig(projectRoot: string): {
    projectRoot?: string;
    watchFolders?: readonly string[];
    resolver?: {
      nodeModulesPaths?: readonly string[];
      resolveRequest?: MetroResolveRequest;
    };
  };
}

/** Fixture source importing every public entry a React Native app loads from both packages. */
const FIXTURE_ENTRY = `import { createChatClient, useAgentRun, useChat, useComposer } from "@providerkit/react";
import { emptyChatView, parseChatEvent, reduceChat } from "@providerkit/react/protocol";
import {
  createDraftStorage,
  createPendingSendStorage,
  createSseTransport,
  removeExpired,
  watchDevice,
} from "@providerkit/native";
import { allowedLink, continueMarkdown, parseMarkdown } from "@providerkit/native/markdown";
import {
  ChatClasses,
  Composer,
  ErrorNotice,
  Markdown,
  MessageList,
  MessageText,
  QueuedMessages,
  RequestCard,
  RunBand,
  ThinkingRow,
  ToolGroup,
  ToolRow,
  defaultChatLabels,
  toolView,
} from "@providerkit/native/ui";

globalThis.__providerkitNativeFixture = {
  createChatClient,
  useAgentRun,
  useChat,
  useComposer,
  emptyChatView,
  parseChatEvent,
  reduceChat,
  createDraftStorage,
  createPendingSendStorage,
  createSseTransport,
  removeExpired,
  watchDevice,
  allowedLink,
  continueMarkdown,
  parseMarkdown,
  ChatClasses,
  Composer,
  ErrorNotice,
  Markdown,
  MessageList,
  MessageText,
  QueuedMessages,
  RequestCard,
  RunBand,
  ThinkingRow,
  ToolGroup,
  ToolRow,
  defaultChatLabels,
  toolView,
};
`;

/** hermesc writes `<file>:<line>:<column>: error: <message>`, then the line and a caret. */
export function parseHermesErrors(stderr: string): HermesError[] {
  const errors: HermesError[] = [];
  for (const [, line, column, message] of stderr.matchAll(/^.*?:(\d+):(\d+): error: (.*)$/gm)) {
    if (line !== undefined && column !== undefined && message !== undefined) {
      errors.push({ message, line: Number(line), column: Number(column) });
    }
  }
  return errors;
}

/** Points a bundle error back at its source file using the Metro source map. */
export function toSource(
  error: HermesError,
  sourceMap: Pick<SourceMap, "findEntry">,
  root: string,
  bundle: string,
): Omit<HermesProblem, "platform"> {
  const found = sourceMap.findEntry(error.line - 1, error.column - 1);
  // `findEntry` returns the nearest preceding mapping even on an earlier line, and Metro-generated
  // lines have no originalSource. Keep the bundle location in both cases.
  if (
    !("originalSource" in found) ||
    typeof found.originalSource !== "string" ||
    found.generatedLine !== error.line - 1
  ) {
    return { message: error.message, file: bundle, line: error.line, column: error.column };
  }
  const source = found.originalSource;
  return {
    message: error.message,
    file: isAbsolute(source) ? relative(root, source) : source,
    line: found.originalLine + 1,
    column: found.originalColumn + 1,
  };
}

/** Resolves the platform binary shipped inside `hermes-compiler`. */
function hermescPath(manifestPath: string): string {
  const folder = join(dirname(manifestPath), "hermesc");
  switch (process.platform) {
    case "darwin":
      return join(folder, "osx-bin", "hermesc");
    case "linux":
      return join(folder, "linux64-bin", "hermesc");
    case "win32":
      return join(folder, "win64-bin", "hermesc.exe");
    default:
      throw new Error(`hermes-compiler has no hermesc binary for ${process.platform}.`);
  }
}

function tail(output: string): string {
  return output.trim().split("\n").slice(-30).join("\n");
}

function isReact(moduleName: string): boolean {
  return moduleName === "react" || moduleName.startsWith("react/");
}

export async function checkHermes(
  packageRoot: string,
  platforms: readonly HermesPlatform[] = ["ios", "android"],
): Promise<{ problems: HermesProblem[] }> {
  const nativeRoot = resolve(packageRoot);
  const repoRoot = resolve(nativeRoot, "..");
  const fromNative = createRequire(join(nativeRoot, "package.json"));

  // Resolve tools upfront so a missing devDependency fails immediately.
  const metroConfigPath = fromNative.resolve("@react-native/metro-config");
  const metroPath = fromNative.resolve("metro", { paths: [metroConfigPath] });
  const babelPresetPath = fromNative.resolve("@react-native/babel-preset");
  const hermesc = hermescPath(fromNative.resolve("hermes-compiler/package.json"));

  const Metro: MetroApi = fromNative(metroPath);
  const { getDefaultConfig }: MetroConfigModule = fromNative(metroConfigPath);

  const work = await mkdtemp(join(tmpdir(), "providerkit-native-hermes-"));
  try {
    // Prepare the scratch fixture app outside the repository so nothing dirties the worktree.
    const entry = join(work, "entry.js");
    await writeFile(entry, FIXTURE_ENTRY, "utf-8");
    await writeFile(
      join(work, "babel.config.js"),
      `module.exports = { presets: [${JSON.stringify(babelPresetPath)}] };\n`,
      "utf-8",
    );
    // Expose `@providerkit/native` to Metro inside the fixture's own node_modules, the same way a
    // consuming app resolves it, while `@providerkit/react` resolves from native/node_modules.
    const scopeDir = join(work, "node_modules", "@providerkit");
    await mkdir(scopeDir, { recursive: true });
    await symlink(nativeRoot, join(scopeDir, "native"), "dir");

    const base = getDefaultConfig(work);
    const next = base.resolver?.resolveRequest ?? null;
    const config = await Metro.loadConfig(
      { cwd: work, maxWorkers: 2, resetCache: true },
      {
        ...base,
        projectRoot: work,
        // Watch only the workspace packages and root node_modules, never the repo root itself, so
        // Metro's crawler does not walk sibling git worktrees.
        watchFolders: [
          join(repoRoot, "node_modules"),
          join(repoRoot, "react"),
          join(repoRoot, "native"),
        ],
        resolver: {
          ...base.resolver,
          nodeModulesPaths: [join(nativeRoot, "node_modules"), join(repoRoot, "node_modules")],
          resolveRequest(
            context: MetroResolveContext,
            moduleName: string,
            platform: string | null,
          ): MetroResolution {
            // Pin every react import to one copy, matching how real apps avoid dual-React bundles.
            if (isReact(moduleName)) {
              return { type: "sourceFile", filePath: fromNative.resolve(moduleName) };
            }
            return (next ?? context.resolveRequest)(context, moduleName, platform);
          },
        },
      },
    );

    const problems: HermesProblem[] = [];
    for (const platform of platforms) {
      // Metro appends `.js` when the output path does not already end in `.js`.
      const bundle = join(work, `index.${platform}.bundle.js`);
      const map = join(work, `index.${platform}.bundle.map`);
      await Metro.runBuild(config, {
        entry,
        out: bundle,
        platform,
        dev: false,
        minify: false,
        sourceMap: true,
        sourceMapUrl: map,
      });

      const compiled = spawnSync(
        hermesc,
        ["-emit-binary", `-out=${join(work, `index.${platform}.hbc`)}`, "-w", bundle],
        { encoding: "utf-8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
      );
      if (compiled.error !== undefined) {
        throw new Error(`hermesc did not finish for ${platform}: ${compiled.error.message}`);
      }
      if (compiled.status !== 0) {
        const found = parseHermesErrors(compiled.stderr);
        if (found.length === 0) {
          throw new Error(`hermesc failed for ${platform}:\n${tail(compiled.stderr)}`);
        }
        const sourceMap = new SourceMap(JSON.parse(await readFile(map, "utf-8")));
        for (const error of found) {
          problems.push({ platform, ...toSource(error, sourceMap, repoRoot, bundle) });
        }
      }
    }

    return { problems };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  checkHermes(packageRoot).then(
    ({ problems }) => {
      if (problems.length === 0) {
        console.log("hermes check: ios and android bundles compile.");
        return;
      }
      for (const problem of problems) {
        console.error(
          `${problem.file}:${problem.line}:${problem.column}: ${problem.message} (${problem.platform})`,
        );
      }
      console.error(`hermes check: ${problems.length} problem(s). Hermes refused the bundle.`);
      process.exitCode = 1;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
