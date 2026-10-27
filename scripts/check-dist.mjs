// Проверка после `npm run build`: каждый файл, на который указывает
// package.json (main, module, types, exports), действительно лежит в dist.
//
// Ревью блока 11, п. 6 (S1-17): `.d.cts` для require-потребителей tsup
// кладёт только по своему умолчанию для dts. Сменится версия tsup или
// конфиг — `exports.require.types` молча укажет на несуществующий файл, и
// TypeScript в CJS-проектах откатится к TS7016/TS1479.
//
// Список путей — в package-paths.mjs: сам скрипт проверяет без условий, иначе
// при несовпадении «запущен ли я напрямую» он молча выходил бы с кодом 0.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { packagePaths } from "./package-paths.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const paths = packagePaths(pkg);
const missing = paths.filter((path) => !existsSync(join(root, path)));
if (missing.length > 0) {
  console.error(`[check-dist] сборка не положила файлы из package.json: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`[check-dist] OK — ${paths.length} путей из package.json на месте`);
