/**
 * Сверка SDK с OpenAPI-спекой — автоматическая, а не «на глаз».
 *
 * Типы TypeScript в рантайме стёрты, поэтому проверять их сравнением нельзя.
 * Вместо этого:
 *
 * 1. Тело, которое собирает `buildSendPayload`, валидируется по JSON Schema
 *    из спеки через ajv. Если SDK начнёт слать лишнее или неправильное поле,
 *    тест покраснеет — это сильнее, чем сравнение имён.
 * 2. Проверяется, что сгенерированный `openapi.d.ts` собран из текущей спеки:
 *    в нём есть все пути и operationId.
 * 3. Проверяется, что спека описывает заголовки, на которые опирается
 *    клиент (`Retry-After`, `Idempotent-Replayed`, `Idempotency-Key`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import AjvModule from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { beforeAll, describe, expect, it } from "vitest";

// ajv и ajv-formats публикуются как CJS, поэтому под ESM-резолвером сюда
// приходит либо сам класс, либо обёртка с `default`. Разворачиваем вручную:
// иначе либо падает рантайм, либо не сходятся типы.
const Ajv2020 = ((AjvModule as unknown as { default?: typeof AjvModule }).default ??
  AjvModule) as typeof AjvModule;
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule })
  .default ?? addFormatsModule) as typeof addFormatsModule;

import {
  buildSendPayload,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  MailInfraError,
  MAX_ATTACHMENT_BASE64_LENGTH,
  MAX_ATTACHMENTS,
  MAX_BATCH_SIZE,
  MAX_CONTENT_TYPE_LENGTH,
  MAX_FILENAME_LENGTH,
  MAX_FROM_NAME_LENGTH,
  MAX_RECIPIENTS,
  MAX_REPLY_TO,
  MAX_SUBJECT_LENGTH,
  MAX_TAGS,
  MAX_TEMPLATE_LENGTH,
} from "../src/index.js";
import { sharedFile } from "./sharedFile.js";

const specPath = sharedFile("mailinfra-public.json", "openapi");
const generatedPath = fileURLToPath(new URL("../src/generated/openapi.d.ts", import.meta.url));

const spec = JSON.parse(readFileSync(specPath, "utf-8")) as {
  paths: Record<string, Record<string, { operationId?: string; parameters?: unknown[] }>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  servers: { url: string }[];
};
const generated = readFileSync(generatedPath, "utf-8");

let validateSendRequest: (data: unknown) => boolean;
let sendRequestErrors: () => string;

beforeAll(() => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(spec, "spec");

  const validator = ajv.compile({ $ref: "spec#/components/schemas/EmailSendRequest" });
  validateSendRequest = validator as unknown as (data: unknown) => boolean;
  sendRequestErrors = () => ajv.errorsText(validator.errors);
});

describe("тело запроса против схемы спеки", () => {
  it("минимальное письмо валидно", () => {
    const payload = buildSendPayload({
      from: "hello@mail.example.ru",
      to: "user@example.com",
      subject: "Тема",
      text: "Текст",
    });

    expect(validateSendRequest(payload), sendRequestErrors()).toBe(true);
  });

  it("письмо со всеми полями валидно", () => {
    const payload = buildSendPayload({
      from: "hello@mail.example.ru",
      from_name: "MailInfra",
      to: ["a@example.com", "b@example.com"],
      cc: "c@example.com",
      bcc: ["d@example.com"],
      reply_to: "support@mail.example.ru",
      subject: "Тема",
      html: "<p>Привет</p>",
      text: "Привет",
      headers: { "X-Campaign": "spring" },
      tags: ["order", "transactional"],
      variables: { user_name: "Анна" },
      attachments: [
        { filename: "bill.pdf", content: new Uint8Array([1, 2, 3]), content_type: "application/pdf" },
      ],
    });

    expect(validateSendRequest(payload), sendRequestErrors()).toBe(true);
  });

  it("письмо по шаблону валидно", () => {
    const payload = buildSendPayload({
      from: "hello@mail.example.ru",
      to: "user@example.com",
      template: "welcome",
      variables: { user_name: "Анна" },
    });

    expect(validateSendRequest(payload), sendRequestErrors()).toBe(true);
  });

  it("схема действительно ловит нарушения лимитов", () => {
    // Контроль самого теста: если бы ajv молча пропускал всё, проверки выше
    // ничего не значили.
    //
    // Собираем тело вручную, а не через `buildSendPayload`: он такое письмо
    // больше не отдаёт — 51 получатель отбивается на клиенте. Раньше этот
    // контроль строился как раз на нём и проходил именно потому, что
    // проверка жила в спеке, а не в SDK.
    const tooManyRecipients = {
      from: "hello@mail.example.ru",
      to: Array.from({ length: 51 }, (_, index) => `user${index}@example.com`),
      subject: "Тема",
      text: "Текст",
    };

    expect(validateSendRequest(tooManyRecipients)).toBe(false);
    expect(() => buildSendPayload(tooManyRecipients)).toThrow(MailInfraError);
  });
});

describe("сгенерированные типы соответствуют спеке", () => {
  it("содержат все пути", () => {
    for (const path of Object.keys(spec.paths)) {
      expect(generated).toContain(`"${path}"`);
    }
  });

  it("содержат все operationId", () => {
    for (const item of Object.values(spec.paths)) {
      for (const operation of Object.values(item)) {
        if (operation.operationId) {
          expect(generated).toContain(`${operation.operationId}: {`);
        }
      }
    }
  });

  it("содержат все схемы компонентов", () => {
    for (const name of Object.keys(spec.components.schemas)) {
      expect(generated).toContain(`${name}:`);
    }
  });
});

describe("спека описывает то, на что опирается клиент", () => {
  it("Idempotency-Key объявлен только у POST /emails", () => {
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const headers = ((operation.parameters ?? []) as { in?: string; name?: string }[])
          .filter((parameter) => parameter.in === "header")
          .map((parameter) => parameter.name);
        const expected = path === "/emails" && method === "post" ? ["Idempotency-Key"] : [];
        expect(headers).toEqual(expected);
      }
    }
  });

  it("описаны Retry-After, Idempotent-Replayed и X-Request-ID", () => {
    const responses = (
      spec.paths["/emails"]?.["post"] as unknown as {
        responses: Record<string, { headers?: Record<string, unknown> }>;
      }
    ).responses;

    expect(responses["429"]?.headers).toHaveProperty("Retry-After");
    expect(responses["200"]?.headers).toHaveProperty("Idempotent-Replayed");
    expect(responses["202"]?.headers).toHaveProperty("X-Request-ID");
  });

  it("аутентификация — bearer API-ключ, база заканчивается на /v1", () => {
    expect(spec.components.securitySchemes["ApiKeyBearer"]).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    expect(spec.servers[0]?.url.endsWith("/v1")).toBe(true);
  });
});

describe("таблица лимитов совпадает со спекой", () => {
  // `limits.ts` заполнен руками: генератор отдаёт только типы, а они в
  // рантайме стёрты и проверить по ним ничего нельзя. В согласии со спекой
  // их держит этот тест — такой же, как `spec_parity_test.go` в Go SDK и
  // `SpecParityTest.php` в PHP.
  const schemas = spec.components.schemas as Record<
    string,
    { properties?: Record<string, { maxItems?: number; maxLength?: number }> }
  >;

  it.each([
    ["EmailSendRequest.to", "EmailSendRequest", "to", "maxItems", MAX_RECIPIENTS],
    ["EmailSendRequest.cc", "EmailSendRequest", "cc", "maxItems", MAX_RECIPIENTS],
    ["EmailSendRequest.bcc", "EmailSendRequest", "bcc", "maxItems", MAX_RECIPIENTS],
    ["EmailSendRequest.reply_to", "EmailSendRequest", "reply_to", "maxItems", MAX_REPLY_TO],
    ["EmailSendRequest.tags", "EmailSendRequest", "tags", "maxItems", MAX_TAGS],
    [
      "EmailSendRequest.attachments",
      "EmailSendRequest",
      "attachments",
      "maxItems",
      MAX_ATTACHMENTS,
    ],
    ["EmailSendRequest.subject", "EmailSendRequest", "subject", "maxLength", MAX_SUBJECT_LENGTH],
    [
      "EmailSendRequest.from_name",
      "EmailSendRequest",
      "from_name",
      "maxLength",
      MAX_FROM_NAME_LENGTH,
    ],
    [
      "EmailSendRequest.template",
      "EmailSendRequest",
      "template",
      "maxLength",
      MAX_TEMPLATE_LENGTH,
    ],
    [
      "EmailAttachmentInput.filename",
      "EmailAttachmentInput",
      "filename",
      "maxLength",
      MAX_FILENAME_LENGTH,
    ],
    [
      "EmailAttachmentInput.content_type",
      "EmailAttachmentInput",
      "content_type",
      "maxLength",
      MAX_CONTENT_TYPE_LENGTH,
    ],
    [
      "EmailAttachmentInput.content_base64",
      "EmailAttachmentInput",
      "content_base64",
      "maxLength",
      MAX_ATTACHMENT_BASE64_LENGTH,
    ],
    ["BatchSendRequest.emails", "BatchSendRequest", "emails", "maxItems", MAX_BATCH_SIZE],
  ] as const)("%s", (_label, schema, field, key, expected) => {
    expect(schemas[schema]?.properties?.[field]?.[key]).toBe(expected);
  });

  it("Idempotency-Key ограничен тем же числом", () => {
    const parameters = spec.paths["/emails"]?.post?.parameters as
      | { name?: string; schema?: { maxLength?: number } }[]
      | undefined;
    const header = parameters?.find((item) => item.name === "Idempotency-Key");

    expect(header?.schema?.maxLength).toBe(IDEMPOTENCY_KEY_MAX_LENGTH);
  });
});
