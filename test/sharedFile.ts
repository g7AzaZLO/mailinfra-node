/**
 * Общие для всех SDK файлы: OpenAPI-спека и вектора подписи вебхуков.
 *
 * В публичном репозитории SDK они лежат в `resources/`, в монорепозитории
 * MailInfra — в соседних каталогах `sdk/openapi/` и `sdk/testdata/`.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Путь к общему файлу в том раскладе, в котором запущены тесты.
 *
 * @param name Имя файла.
 * @param monorepoDir Каталог файла внутри `sdk/` монорепозитория.
 */
export function sharedFile(name: string, monorepoDir: "openapi" | "testdata"): string {
  const mirror = fileURLToPath(new URL(`../resources/${name}`, import.meta.url));
  return existsSync(mirror)
    ? mirror
    : fileURLToPath(new URL(`../../${monorepoDir}/${name}`, import.meta.url));
}
