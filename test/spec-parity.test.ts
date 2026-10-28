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
 * 4. Каждая операция спеки вызывается методом SDK, и запрос этого метода —
 *    метод, путь, query, заголовки и тело — сверяется с описанием операции.
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
  BATCH_IDEMPOTENCY_KEY_MAX_LENGTH,
  buildSendPayload,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  MailInfra,
  MailInfraError,
  MAX_ATTACHMENT_BASE64_LENGTH,
  MAX_ATTACHMENTS,
  MAX_BATCH_SIZE,
  MAX_CONTENT_ID_LENGTH,
  MAX_CONTENT_TYPE_LENGTH,
  MAX_FILENAME_LENGTH,
  MAX_FROM_NAME_LENGTH,
  MAX_METADATA_KEYS,
  MAX_METADATA_VALUE_LENGTH,
  MAX_RECIPIENTS,
  MAX_REPLY_TO,
  MAX_SUBJECT_LENGTH,
  MAX_TAGS,
  MAX_TEMPLATE_LENGTH,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
} from "../src/index.js";
import { sharedFile } from "./sharedFile.js";

interface SpecParameter {
  in?: string;
  name?: string;
  schema?: { maxLength?: number };
}

interface SpecOperation {
  operationId?: string;
  parameters?: SpecParameter[];
  requestBody?: { content: Record<string, { schema: { $ref?: string } }> };
}

const specPath = sharedFile("mailinfra-public.json", "openapi");
const generatedPath = fileURLToPath(new URL("../src/generated/openapi.d.ts", import.meta.url));

const spec = JSON.parse(readFileSync(specPath, "utf-8")) as {
  paths: Record<string, Record<string, SpecOperation>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  servers: { url: string }[];
};
const generated = readFileSync(generatedPath, "utf-8");

let ajv: InstanceType<typeof Ajv2020>;
let validateSendRequest: (data: unknown) => boolean;
let sendRequestErrors: () => string;

beforeAll(() => {
  ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(spec, "spec");

  const validator = ajv.compile({ $ref: "spec#/components/schemas/EmailSendRequest" });
  validateSendRequest = validator as unknown as (data: unknown) => boolean;
  sendRequestErrors = () => ajv.errorsText(validator.errors);
});

/** Проверяет значение по схеме из спеки; ошибки ajv — в тексте провала. */
function expectValid(ref: string, data: unknown): void {
  const validator = ajv.compile({ $ref: `spec${ref}` });
  expect(validator(data), ajv.errorsText(validator.errors)).toBe(true);
}

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
      metadata: { order_id: "4242", "user.id": "u-1" },
      send_at: new Date("2026-11-01T06:00:00Z"),
      ttl: MAX_TTL_SECONDS,
      attachments: [
        { filename: "bill.pdf", content: new Uint8Array([1, 2, 3]), content_type: "application/pdf" },
        {
          filename: "logo.png",
          content: new Uint8Array([137, 80, 78, 71]),
          content_type: "image/png",
          content_id: "logo@mail.example.ru",
        },
      ],
    });

    expect(validateSendRequest(payload), sendRequestErrors()).toBe(true);
  });

  it("send_at строкой со смещением валиден", () => {
    const payload = buildSendPayload({
      from: "hello@mail.example.ru",
      to: "user@example.com",
      subject: "Тема",
      text: "Текст",
      send_at: "2026-11-01T09:00:00+03:00",
      ttl: MIN_TTL_SECONDS,
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
  it("Idempotency-Key объявлен только у POST /emails и POST /emails/batch", () => {
    // SDK ставит ключ ровно на эти два вызова: появится заголовок у другой
    // операции — тест покраснеет и напомнит, что SDK его не шлёт.
    const withKey = new Set(["post /emails", "post /emails/batch"]);
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const headers = (operation.parameters ?? [])
          .filter((parameter) => parameter.in === "header")
          .map((parameter) => parameter.name);
        const expected = withKey.has(`${method} ${path}`) ? ["Idempotency-Key"] : [];
        expect(headers, `${method} ${path}`).toEqual(expected);
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
    {
      properties?: Record<
        string,
        {
          maxItems?: number;
          maxLength?: number;
          minimum?: number;
          maximum?: number;
          description?: string;
        }
      >;
    }
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
    [
      "EmailAttachmentInput.content_id",
      "EmailAttachmentInput",
      "content_id",
      "maxLength",
      MAX_CONTENT_ID_LENGTH,
    ],
    ["EmailSendRequest.ttl minimum", "EmailSendRequest", "ttl", "minimum", MIN_TTL_SECONDS],
    ["EmailSendRequest.ttl maximum", "EmailSendRequest", "ttl", "maximum", MAX_TTL_SECONDS],
    ["BatchSendRequest.emails", "BatchSendRequest", "emails", "maxItems", MAX_BATCH_SIZE],
  ] as const)("%s", (_label, schema, field, key, expected) => {
    expect(schemas[schema]?.properties?.[field]?.[key]).toBe(expected);
  });

  it.each([
    ["POST /emails", "/emails", IDEMPOTENCY_KEY_MAX_LENGTH],
    ["POST /emails/batch", "/emails/batch", BATCH_IDEMPOTENCY_KEY_MAX_LENGTH],
  ])("Idempotency-Key у %s ограничен тем же числом", (_label, path, expected) => {
    const header = spec.paths[path]?.post?.parameters?.find(
      (item) => item.name === "Idempotency-Key",
    );

    expect(header?.schema?.maxLength).toBe(expected);
  });

  it("лимиты metadata — те же, что в описании поля", () => {
    // Схема `metadata` — просто объект строк, без maxProperties и maxLength:
    // число ключей и длину значения спека называет только словами.
    const description = schemas["EmailSendRequest"]?.properties?.["metadata"]?.description ?? "";

    expect(description).toContain(`До ${MAX_METADATA_KEYS} ключей`);
    expect(description).toContain(`до ${MAX_METADATA_VALUE_LENGTH} символов`);
  });
});

describe("каждая операция спеки покрыта методом SDK", () => {
  const BASE_URL = "https://api.mailinfra.test/v1";
  const API_KEY = "mi_test_0123456789abcdef0123456789abcdef";
  const EMAIL_ID = "018e1b7a-1111-7000-aaaa-111111111111";
  const MINIMAL = {
    from: "hello@mail.example.ru",
    to: "user@example.com",
    subject: "Тема",
    text: "Текст",
    metadata: { order_id: "4242" },
  };

  interface Sent {
    method: string;
    url: URL;
    headers: Record<string, string>;
    body: unknown;
  }

  /** Клиент, который записывает запрос и отвечает тем, что годится любому методу. */
  function recordingClient(): { client: MailInfra; sent: Sent[] } {
    const sent: Sent[] = [];
    const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
      sent.push({
        method: init.method ?? "GET",
        url: new URL(String(url)),
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      // `data` есть, а страница списка последняя — разбор любого ответа пройдёт.
      return new Response(JSON.stringify({ data: [], has_more: false, next_cursor: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    return { client: new MailInfra({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fetchImpl }), sent };
  }

  const SDK_CALLS: Record<string, (client: MailInfra) => Promise<unknown>> = {
    send_email: (client) => client.emails.send({ ...MINIMAL, send_at: new Date(), ttl: 600 }),
    send_batch: (client) => client.emails.sendBatch([MINIMAL, MINIMAL]),
    list_emails: (client) =>
      client.emails.list({ status: "SCHEDULED", limit: 10, cursor: "c2VlZA", from: new Date() }),
    get_email: (client) => client.emails.get(EMAIL_ID),
    list_email_events: (client) => client.emails.events(EMAIL_ID),
    cancel_email: (client) => client.emails.cancel(EMAIL_ID),
    reschedule_email: (client) =>
      client.emails.reschedule(EMAIL_ID, { send_at: "2026-11-01T09:00:00+03:00" }),
  };

  /** Операция спеки, в которую попадает запрос с таким методом и путём. */
  function findOperation(method: string, path: string): SpecOperation | undefined {
    for (const [template, item] of Object.entries(spec.paths)) {
      const pattern = new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`);
      const operation = item[method.toLowerCase()];
      if (operation !== undefined && pattern.test(path)) {
        return operation;
      }
    }
    return undefined;
  }

  it("у каждой операции спеки есть метод SDK, и наоборот", () => {
    const operationIds = Object.values(spec.paths).flatMap((item) =>
      Object.values(item).map((operation) => operation.operationId),
    );

    expect(Object.keys(SDK_CALLS).sort()).toEqual(operationIds.sort());
  });

  it.each(Object.entries(SDK_CALLS))("%s: метод, путь, query, заголовки и тело — по спеке", async (
    operationId,
    call,
  ) => {
    const { client, sent } = recordingClient();
    await call(client);

    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    const path = request.url.pathname.slice(new URL(BASE_URL).pathname.length);
    const operation = findOperation(request.method, path);
    expect(operation?.operationId, `${request.method} ${path}`).toBe(operationId);

    const declared = (kind: string): (string | undefined)[] =>
      (operation?.parameters ?? []).filter((item) => item.in === kind).map((item) => item.name);
    for (const name of request.url.searchParams.keys()) {
      expect(declared("query")).toContain(name);
    }
    if ("Idempotency-Key" in request.headers) {
      expect(declared("header")).toContain("Idempotency-Key");
    }

    const bodyRef = operation?.requestBody?.content["application/json"]?.schema.$ref;
    if (bodyRef === undefined) {
      expect(request.body).toBeUndefined();
    } else {
      expectValid(bodyRef, request.body);
    }
  });
});
