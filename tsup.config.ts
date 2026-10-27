import { defineConfig } from "tsup";

// Двойная сборка ESM + CJS: SDK ставят и в современные ESM-проекты, и в
// legacy-бэкенды на require(). Внешних зависимостей у пакета нет — только
// глобальные fetch и WebCrypto, поэтому bundle получается самодостаточным и
// работает в edge-рантаймах. Нижняя граница — Node 20: глобальный `crypto`
// без флага появился лишь в 19, на 18 он требует
// `--experimental-global-webcrypto`.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  treeshake: true,
});
