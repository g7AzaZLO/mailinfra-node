/**
 * Ресурс писем: тело запроса, идемпотентность, чтение, батч.
 *
 * Собранное тело дополнительно валидируется по JSON Schema из спеки
 * (`spec-parity.test.ts`), поэтому здесь проверяется семантика, а не форма.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSendPayload,
  MailInfra,
  MailInfraError,
  MAX_ATTACHMENT_BASE64_LENGTH,
  MAX_BATCH_SIZE,
  MAX_RECIPIENTS,
  MAX_REPLY_TO,
  MAX_SUBJECT_LENGTH,
  MAX_TAGS,
} from "../src/index.js";

const BASE_URL = "https://api.mailinfra.test/v1";
const API_KEY = "mi_test_0123456789abcdef0123456789abcdef";
const EMAIL_ID = "018e1b7a-1111-7000-aaaa-111111111111";

const SEND_BODY = {
  data: { id: EMAIL_ID, status: "QUEUED", skipped_recipients: [] },
};

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function recordingClient(
  response: Response,
  overrides: Record<string, unknown> = {},
): { client: MailInfra; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    recorded.push({
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return response.clone();
  }) as unknown as typeof globalThis.fetch;

  return {
    client: new MailInfra({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fetchImpl, ...overrides }),
    recorded,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("сборка тела", () => {
  it("принимает получателя строкой и не отправляет пустые поля", () => {
    const payload = buildSendPayload({
      from: "hello@mail.example.ru",
      to: "user@example.com",
      subject: "Тема",
      html: "<p>Привет</p>",
    });

    expect(payload.to).toEqual(["user@example.com"]);
    expect(payload).not.toHaveProperty("cc");
    expect(payload).not.toHaveProperty("text");
  });

  it("нормализует cc, bcc и reply_to", () => {
    const payload = buildSendPayload({
      from: "hello@mail.example.ru",
      to: ["a@example.com", "b@example.com"],
      cc: "c@example.com",
      bcc: ["d@example.com"],
      reply_to: "support@mail.example.ru",
      template: "welcome",
      variables: { user_name: "Анна" },
    });

    expect(payload.to).toHaveLength(2);
    expect(payload.cc).toEqual(["c@example.com"]);
    expect(payload.bcc).toEqual(["d@example.com"]);
    expect(payload.reply_to).toEqual(["support@mail.example.ru"]);
    expect(payload.variables).toEqual({ user_name: "Анна" });
  });

  it("кодирует байты вложения в base64", () => {
    const payload = buildSendPayload({
      from: "hello@mail.example.ru",
      to: "user@example.com",
      subject: "Счёт",
      text: "во вложении",
      attachments: [
        {
          filename: "bill.pdf",
          content: new TextEncoder().encode("%PDF-1.4"),
          content_type: "application/pdf",
        },
      ],
    });

    const attachment = payload.attachments?.[0];
    expect(attachment?.filename).toBe("bill.pdf");
    expect(atob(attachment?.content_base64 ?? "")).toBe("%PDF-1.4");
  });

  it("пропускает готовый base64 без перекодирования", () => {
    const payload = buildSendPayload({
      from: "hello@mail.example.ru",
      to: "user@example.com",
      subject: "Счёт",
      text: "во вложении",
      attachments: [{ filename: "bill.pdf", content_base64: "JVBERi0xLjQ=" }],
    });

    expect(payload.attachments?.[0]?.content_base64).toBe("JVBERi0xLjQ=");
  });
});

describe("отправка", () => {
  const minimal = {
    from: "hello@mail.example.ru",
    to: "user@example.com",
    subject: "Тема",
    text: "Текст",
  };

  it("ставит Idempotency-Key автоматически", async () => {
    const { client, recorded } = recordingClient(json(202, SEND_BODY));

    const result = await client.emails.send(minimal);

    expect(recorded[0]?.headers["Idempotency-Key"]).toBe(result.idempotencyKey);
    expect(result.replayed).toBe(false);
    expect(result.status).toBe("QUEUED");
  });

  it("уважает переданный ключ", async () => {
    const { client, recorded } = recordingClient(json(202, SEND_BODY));

    await client.emails.send(minimal, { idempotencyKey: "order_123_welcome" });

    expect(recorded[0]?.headers["Idempotency-Key"]).toBe("order_123_welcome");
  });

  it("позволяет отключить ключ на один вызов", async () => {
    const { client, recorded } = recordingClient(json(202, SEND_BODY));

    const result = await client.emails.send(minimal, { idempotencyKey: null });

    expect(recorded[0]?.headers).not.toHaveProperty("Idempotency-Key");
    expect(result.idempotencyKey).toBeUndefined();
  });

  it("не ставит ключ при autoIdempotency: false", async () => {
    const { client, recorded } = recordingClient(json(202, SEND_BODY), {
      autoIdempotency: false,
    });

    await client.emails.send(minimal);

    expect(recorded[0]?.headers).not.toHaveProperty("Idempotency-Key");
  });

  it("отклоняет пустой ключ — бэкенд его игнорирует", async () => {
    // `""` выглядел бы идемпотентным запросом, повторялся после 5xx и
    // создавал второе письмо: дедупликация на бэкенде стоит под
    // `if payload.idempotency_key:`, куда пустая строка не проходит.
    const { client, recorded } = recordingClient(json(202, SEND_BODY));

    const error = await client.emails
      .send(minimal, { idempotencyKey: "   " })
      .catch((exc: unknown) => exc);

    expect(error).toBeInstanceOf(MailInfraError);
    expect((error as MailInfraError).code).toBe("invalid_idempotency_key");
    expect(recorded).toHaveLength(0);
  });

  it("отклоняет слишком длинный ключ до запроса", async () => {
    const { client, recorded } = recordingClient(json(202, SEND_BODY));

    const error = await client.emails
      .send(minimal, { idempotencyKey: "x".repeat(256) })
      .catch((exc: unknown) => exc);

    // Именно MailInfraError: README учит ловить его, и голый Error пролетал
    // бы мимо такого catch, роняя обработчик целиком.
    expect(error).toBeInstanceOf(MailInfraError);
    expect((error as MailInfraError).code).toBe("invalid_idempotency_key");
    expect(recorded).toHaveLength(0);
  });

  it("распознаёт идемпотентный повтор", async () => {
    const { client } = recordingClient(
      json(200, SEND_BODY, { "Idempotent-Replayed": "true", "X-Request-ID": "req-42" }),
    );

    const result = await client.emails.send(minimal, { idempotencyKey: "order_123" });

    expect(result.replayed).toBe(true);
    expect(result.requestId).toBe("req-42");
  });

  it("отдаёт пропущенных получателей", async () => {
    const { client } = recordingClient(
      json(202, {
        data: {
          id: EMAIL_ID,
          status: "QUEUED",
          skipped_recipients: [{ email: "blocked@example.com", reason: "suppressed" }],
        },
      }),
    );

    const result = await client.emails.send(minimal);

    expect(result.skipped_recipients).toEqual([
      { email: "blocked@example.com", reason: "suppressed" },
    ]);
  });
});

describe("батч", () => {
  it("отдаёт ошибки по каждому письму и не ставит ключ идемпотентности", async () => {
    const { client, recorded } = recordingClient(
      json(202, {
        data: {
          results: [
            { index: 0, id: EMAIL_ID, status: "QUEUED", skipped_recipients: [] },
            {
              index: 1,
              error: {
                status_code: 400,
                code: "domain_not_verified",
                message: "Домен ещё не подтверждён.",
                details: {},
              },
            },
          ],
          accepted_count: 1,
          failed_count: 1,
        },
      }),
    );

    const result = await client.emails.sendBatch([
      { from: "hello@mail.example.ru", to: "a@example.com", subject: "Тема", text: "Текст" },
      { from: "hello@bad.example.ru", to: "b@example.com", subject: "Тема", text: "Текст" },
    ]);

    expect(result.failed_count).toBe(1);
    expect(result.results[1]?.error?.code).toBe("domain_not_verified");
    expect(recorded[0]?.headers).not.toHaveProperty("Idempotency-Key");
  });

  it("не отправляет батч длиннее лимита API", async () => {
    const { client, recorded } = recordingClient(json(202, SEND_BODY));

    const error = await client.emails
      .sendBatch(
        Array.from({ length: MAX_BATCH_SIZE + 1 }, () => ({
          from: "hello@mail.example.ru",
          to: "user@example.com",
          subject: "Тема",
          text: "Текст",
        })),
      )
      .catch((exc: unknown) => exc);

    expect(error).toBeInstanceOf(MailInfraError);
    expect((error as MailInfraError).code).toBe("batch_too_large");
    expect(recorded).toHaveLength(0);
  });

  it("не отправляет пустой батч", async () => {
    const { client, recorded } = recordingClient(json(202, {}));

    await expect(client.emails.sendBatch([])).rejects.toBeInstanceOf(MailInfraError);
    expect(recorded).toHaveLength(0);
  });
});

describe("чтение", () => {
  it("передаёт фильтры в query", async () => {
    const { client, recorded } = recordingClient(json(200, { data: [] }));

    await client.emails.list({
      status: "DELIVERED",
      tag: "order",
      limit: 10,
      from: new Date("2026-05-11T20:00:00Z"),
    });

    const url = new URL(recorded[0]?.url ?? "");
    expect(url.searchParams.get("status")).toBe("DELIVERED");
    expect(url.searchParams.get("tag")).toBe("order");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("from")).toBe("2026-05-11T20:00:00.000Z");
  });

  it("читает письмо и его события", async () => {
    const { client, recorded } = recordingClient(
      json(200, {
        data: [
          {
            id: "018e1b7a-3333-7000-cccc-333333333333",
            type: "delivered",
            data: { mx: "gmail-smtp-in.l.google.com" },
            timestamp: "2026-05-11T20:00:05Z",
          },
        ],
      }),
    );

    const events = await client.emails.events(EMAIL_ID);

    expect(recorded[0]?.url).toContain(`/emails/${EMAIL_ID}/events`);
    expect(events[0]?.type).toBe("delivered");
  });
});

describe("конфигурация", () => {
  it("распознаёт окружение по префиксу ключа", () => {
    expect(new MailInfra({ apiKey: API_KEY }).environment).toBe("test");
    expect(
      new MailInfra({ apiKey: "mi_live_0123456789abcdef0123456789abcdef" }).environment,
    ).toBe("live");
    expect(new MailInfra({ apiKey: "mi_LIVE_legacy0123456789" }).environment).toBe("live");
  });

  it("отклоняет чужой префикс ключа", () => {
    expect(() => new MailInfra({ apiKey: "sk_live_whatever" })).toThrow(/mi_live_/);
  });

  it("проверяет требуемое окружение", () => {
    expect(() => new MailInfra({ apiKey: API_KEY, requireEnvironment: "live" })).toThrow(
      /live/,
    );
  });

  it("сообщает об отсутствии ключа", () => {
    expect(() => new MailInfra({})).toThrow(/MAILINFRA_API_KEY/);
  });

  describe("без WebCrypto", () => {
    // Node 18 без `--experimental-global-webcrypto`: глобального `crypto` нет,
    // и без проверки первая же отправка падала бы с ReferenceError.
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("объясняет, что автоматическому Idempotency-Key нужен Node >= 20", () => {
      vi.stubGlobal("crypto", undefined);

      expect(() => new MailInfra({ apiKey: API_KEY })).toThrow(/Node >= 20/);
    });

    it("при autoIdempotency: false клиент создаётся", () => {
      vi.stubGlobal("crypto", undefined);

      expect(() => new MailInfra({ apiKey: API_KEY, autoIdempotency: false })).not.toThrow();
    });
  });

  it("падает на ответе не по контракту", async () => {
    const { client } = recordingClient(json(200, { items: [] }));

    await expect(client.emails.list()).rejects.toThrow(/не по контракту/);
  });
});

describe("вложения", () => {
  it("отказывается собирать вложение без содержимого", () => {
    // Из TypeScript это не соберётся, но из JS прилетает, а
    // `new Uint8Array(undefined)` молча даёт пустой файл.
    const broken = { filename: "bill.pdf" } as unknown as {
      filename: string;
      content: Uint8Array;
    };

    expect(() =>
      buildSendPayload({
        from: "hello@mail.example.ru",
        to: "user@example.com",
        subject: "Счёт",
        text: "во вложении",
        attachments: [broken],
      }),
    ).toThrow(MailInfraError);
  });
});

describe("клиентская валидация лимитов", () => {
  // До этих проверок Node был единственным SDK без них: письмо на 51
  // получателя или вложение на 20 МиБ уезжали в сеть только чтобы
  // вернуться с 422.
  const base = {
    from: "hello@mail.example.ru",
    to: "user@example.com",
    subject: "Тема",
    text: "Текст",
  };

  const failsWith = (code: string, params: Record<string, unknown>): void => {
    let error: unknown;
    try {
      buildSendPayload(params as never);
    } catch (exc) {
      error = exc;
    }

    expect(error).toBeInstanceOf(MailInfraError);
    expect((error as MailInfraError).code).toBe(code);
  };

  it("не собирает письмо без from и без to", () => {
    failsWith("invalid_request", { ...base, from: "" });
    failsWith("invalid_request", { ...base, to: [] });
  });

  it("отбивает перебор по получателям, reply_to и тегам", () => {
    failsWith("invalid_request", {
      ...base,
      to: Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `user${i}@example.com`),
    });
    failsWith("invalid_request", {
      ...base,
      reply_to: Array.from({ length: MAX_REPLY_TO + 1 }, (_, i) => `r${i}@example.com`),
    });
    failsWith("invalid_request", {
      ...base,
      tags: Array.from({ length: MAX_TAGS + 1 }, (_, i) => `tag${i}`),
    });
  });

  it("длину темы считает в символах, а не в единицах UTF-16", () => {
    // Эмодзи занимает две единицы UTF-16, но одну кодовую точку. По `.length`
    // тема ровно в лимит отбраковывалась бы вдвое раньше срока, хотя тело
    // уезжает JSON-ом и лимит спеки символьный.
    expect(() =>
      buildSendPayload({ ...base, subject: "🎉".repeat(MAX_SUBJECT_LENGTH) } as never),
    ).not.toThrow();
    failsWith("invalid_request", { ...base, subject: "🎉".repeat(MAX_SUBJECT_LENGTH + 1) });
  });

  it("не отправляет вложение больше лимита", () => {
    // Ради этого проверка и нужна: письмо с вложениями весит до ~25 МиБ.
    failsWith("invalid_attachment", {
      ...base,
      attachments: [
        { filename: "big.bin", content_base64: "A".repeat(MAX_ATTACHMENT_BASE64_LENGTH + 1) },
      ],
    });
  });

  it("требует ровно одно из content и content_base64", () => {
    failsWith("invalid_attachment", {
      ...base,
      attachments: [{ filename: "bill.pdf", content: "%PDF", content_base64: "JVBERg==" }],
    });
    failsWith("invalid_attachment", { ...base, attachments: [{ filename: "bill.pdf" }] });
  });

  it("требует имя файла у вложения", () => {
    failsWith("invalid_attachment", {
      ...base,
      attachments: [{ filename: "", content: "%PDF" }],
    });
  });
});

describe("валидация элементов батча", () => {
  const item = {
    from: "hello@mail.example.ru",
    to: "user@example.com",
    subject: "Тема",
    text: "Текст",
  };

  it("отбивает элемент с ключом идемпотентности", async () => {
    // Бэкенд лишние поля молча игнорирует (pydantic `extra="ignore"`), так
    // что без этой проверки письмо ушло бы без защиты от дублей и без
    // единой ошибки. Python, Go и PHP отбивают этот случай давно.
    const { client, recorded } = recordingClient(json(202, SEND_BODY));

    const error = await client.emails
      .sendBatch([{ ...item, idempotencyKey: "k1" } as never])
      .catch((exc: unknown) => exc);

    expect(error).toBeInstanceOf(MailInfraError);
    expect((error as MailInfraError).code).toBe("invalid_batch_item");
    expect(recorded).toHaveLength(0);
  });

  it("отбивает элемент с неизвестным параметром", async () => {
    const { client, recorded } = recordingClient(json(202, SEND_BODY));

    const error = await client.emails
      .sendBatch([{ ...item, subjekt: "опечатка" } as never])
      .catch((exc: unknown) => exc);

    expect(error).toBeInstanceOf(MailInfraError);
    expect((error as MailInfraError).code).toBe("invalid_batch_item");
    expect(recorded).toHaveLength(0);
  });
});

describe("Idempotency-Key должен быть печатаемым ASCII", () => {
  const minimal = {
    from: "hello@mail.example.ru",
    to: "user@example.com",
    subject: "Тема",
    text: "Текст",
  };

  it.each(["заказ-42", "order-🎉", "order-42\r\nX-Injected: 1"])(
    "отбивает %j до запроса",
    async (key) => {
      // Значение заголовка уходит байтами, а бэкенд читает их как latin-1.
      // `Headers.set` на таком значении бросает TypeError — голое исключение
      // мимо catch на MailInfraError.
      const { client, recorded } = recordingClient(json(202, SEND_BODY));

      const error = await client.emails
        .send(minimal, { idempotencyKey: key })
        .catch((exc: unknown) => exc);

      expect(error).toBeInstanceOf(MailInfraError);
      expect((error as MailInfraError).code).toBe("invalid_idempotency_key");
      expect(recorded).toHaveLength(0);
    },
  );
});

describe("отмена вызова", () => {
  const minimal = {
    from: "hello@mail.example.ru",
    to: "user@example.com",
    subject: "Тема",
    text: "Текст",
  };

  it("сигнал доезжает до fetch, не повторяется и не подменяется", async () => {
    // Go отдаёт вызывающему context.Canceled как есть; здесь то же самое с
    // AbortError. Подменить его на APIConnectionError и уйти в повтор —
    // значит проигнорировать отмену.
    const controller = new AbortController();
    controller.abort();

    const seen: (AbortSignal | undefined)[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit = {}) => {
      seen.push(init.signal ?? undefined);
      if (init.signal?.aborted === true) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return json(202, SEND_BODY);
    }) as unknown as typeof globalThis.fetch;

    const client = new MailInfra({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fetchImpl });
    const error = await client.emails
      .send(minimal, { signal: controller.signal })
      .catch((exc: unknown) => exc);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(true);
    expect(error).not.toBeInstanceOf(MailInfraError);
    expect((error as Error).name).toBe("AbortError");
  });
});

// Аудит: S1-25 — send() отбивает неизвестные поля так же, как sendBatch:
// бэкенд лишнее молча игнорирует, и idempotencyKey в params (а не в опциях)
// уходил в никуда — письмо без защиты от дублей и без единой ошибки.
describe("валидация параметров send()", () => {
  const params = {
    from: "hello@mail.example.ru",
    to: "user@example.com",
    subject: "Тема",
    text: "Текст",
  };

  it("отбивает ключ идемпотентности в params", async () => {
    const { client, recorded } = recordingClient(json(202, SEND_BODY));

    const error = await client.emails
      .send({ ...params, idempotencyKey: "k1" } as never)
      .catch((exc: unknown) => exc);

    expect(error).toBeInstanceOf(MailInfraError);
    expect((error as MailInfraError).code).toBe("invalid_request");
    expect(recorded).toHaveLength(0);
  });

  it("отбивает неизвестный параметр", async () => {
    const { client, recorded } = recordingClient(json(202, SEND_BODY));

    const error = await client.emails
      .send({ ...params, subjekt: "опечатка" } as never)
      .catch((exc: unknown) => exc);

    expect(error).toBeInstanceOf(MailInfraError);
    expect((error as MailInfraError).code).toBe("invalid_request");
    expect(recorded).toHaveLength(0);
  });
});
