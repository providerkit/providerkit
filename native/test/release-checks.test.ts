import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { SourceMap } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkBabel } from "../scripts/check-babel.ts";
import { parseHermesErrors, toSource } from "../scripts/check-hermes.ts";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");

const HERMES_STDERR = `/tmp/w/index.bundle.js:3:9: error: async generators are unsupported
async function* walk() {}
        ^
/tmp/w/index.bundle.js:7:11: error: Invalid regular expression: Invalid flags
Emitted 2 errors. exiting.
`;

// Bundle line 3, column 9 maps to src/walk.ts line 12, column 9.
const MAP = new SourceMap({
  version: 3,
  file: "index.bundle.js",
  sources: ["/app/src/walk.ts"],
  sourcesContent: [],
  sourceRoot: "",
  names: [],
  mappings: ";;AAWI,QAAI",
});

// Metro-generated prelude lines carry no originalSource.
const GENERATED = new SourceMap({
  version: 3,
  file: "index.bundle.js",
  sources: [],
  sourcesContent: [],
  sourceRoot: "",
  names: [],
  mappings: "A",
});

describe("checkBabel", () => {
  it("passes over the built dist/ with every component import rewritten", () => {
    const result = checkBabel(PACKAGE_ROOT);
    expect(result.problems).toEqual([]);
    expect(result.filesChecked).toBeGreaterThan(0);
    expect(result.rewrittenCount).toBeGreaterThan(0);
  });

  it("reports a react-native component that react-native-css does not rewrite", async () => {
    const work = await mkdtemp(join(tmpdir(), "providerkit-babel-check-"));
    try {
      await mkdir(join(work, "dist"), { recursive: true });
      await writeFile(
        join(work, "dist", "sample.js"),
        'import { View, SafeAreaView } from "react-native";\nexport { View, SafeAreaView };\n',
        "utf-8",
      );
      const result = checkBabel(PACKAGE_ROOT, join(work, "dist"));
      expect(result.rewrittenCount).toBe(1);
      expect(result.problems).toEqual([
        expect.objectContaining({
          specifier: "SafeAreaView",
        }),
      ]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("rejects namespace imports of react-native", async () => {
    const work = await mkdtemp(join(tmpdir(), "providerkit-babel-check-"));
    try {
      await mkdir(join(work, "dist"), { recursive: true });
      await writeFile(
        join(work, "dist", "ns.js"),
        'import * as RN from "react-native";\nexport { RN };\n',
        "utf-8",
      );
      const result = checkBabel(PACKAGE_ROOT, join(work, "dist"));
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]?.specifier).toBe("react-native-css/components");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("parseHermesErrors", () => {
  it("reads every error line and skips source and caret lines", () => {
    expect(parseHermesErrors(HERMES_STDERR)).toEqual([
      { message: "async generators are unsupported", line: 3, column: 9 },
      { message: "Invalid regular expression: Invalid flags", line: 7, column: 11 },
    ]);
  });

  it("returns empty on clean stderr", () => {
    expect(parseHermesErrors("")).toEqual([]);
  });
});

describe("toSource", () => {
  it("maps a bundle error back to its 1-based source file position", () => {
    expect(
      toSource(
        { message: "async generators are unsupported", line: 3, column: 9 },
        MAP,
        "/app",
        "/tmp/w/index.bundle.js",
      ),
    ).toEqual({
      message: "async generators are unsupported",
      file: "src/walk.ts",
      line: 12,
      column: 9,
    });
  });

  it("keeps the bundle position for Metro-generated lines", () => {
    expect(
      toSource({ message: "x", line: 1, column: 1 }, GENERATED, "/app", "/tmp/w/index.bundle.js"),
    ).toEqual({
      message: "x",
      file: "/tmp/w/index.bundle.js",
      line: 1,
      column: 1,
    });
  });

  it("keeps the bundle position when the source map does not cover the line", () => {
    expect(
      toSource({ message: "x", line: 40, column: 1 }, MAP, "/app", "/tmp/w/index.bundle.js"),
    ).toEqual({
      message: "x",
      file: "/tmp/w/index.bundle.js",
      line: 40,
      column: 1,
    });
  });
});
