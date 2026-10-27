// Аудит: S1-17 — у require-потребителей свои типы (.d.cts): один `types`
// (ESM) на оба условия давал TS1479 в CJS-проектах с node16/nodenext.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface ConditionalExport {
  types?: string;
  default?: string;
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  exports: { ".": { import: ConditionalExport | string; require: ConditionalExport | string } };
};

describe("package.json exports", () => {
  it("import и require — со своими types", () => {
    const { import: esm, require: cjs } = pkg.exports["."];

    expect(esm).toEqual({ types: "./dist/index.d.ts", default: "./dist/index.js" });
    expect(cjs).toEqual({ types: "./dist/index.d.cts", default: "./dist/index.cjs" });
  });
});

// Ревью блока 11, п. 6: после сборки check:dist сверяет файлы с package.json —
// он должен видеть каждый путь из exports, включая .d.cts.
describe("check:dist", () => {
  it("собирает все пути из main, module, types и exports", async () => {
    const { packagePaths } = await import("../scripts/package-paths.mjs");
    expect(packagePaths(pkg).sort()).toEqual(
      ["./dist/index.cjs", "./dist/index.d.cts", "./dist/index.d.ts", "./dist/index.js"].sort(),
    );
  });
});
