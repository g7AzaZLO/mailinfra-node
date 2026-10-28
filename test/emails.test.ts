/**
 * Ресурс писем: тело запроса, идемпотентность, чтение, батч, отложенная
 * отправка, страницы списка.
 *
 * Собранное тело дополнительно валидируется по JSON Schema из спеки
 * (`spec-parity.test.ts`), поэтому здесь проверяется семантика, а не форма.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BATCH_IDEMPOTENCY_KEY_MAX_LENGTH,
  buildSendPayload,
  EmailNotScheduledError,
  MailInfra,
  MailInfraError,
  MAX_ATTACHMENT_BASE64_LENGTH,
  MAX_BATCH_SIZE,
  MAX_CONTENT_ID_LENGTH,
  MAX_METADATA_BYTES,
  MAX_METADATA_KEY_LENGTH,
  MAX_METADATA_KEYS,
  MAX_METADATA_VALUE_LENGTH,
  MAX_RECIPIENTS,
  MAX_REPLY_TO,
  MAX_SUBJECT_LENGTH,
  MAX_TAGS,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  SendAtTooFarError,
} from "../src/index.js";

const BASE_URL = "https://api.mailinfra.test/v1";
const API_KEY = "mi_test_0123456789abcdef0123456789abcdef";
const EMAIL_ID = "018e1b7a-1111-7000-aaaa-111111111111";

const SEND_BODY = {
  data: { id: EMAIL_ID, status: "QUEUED", skipped_recipients: [] },
};

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Клиент с подменённым fetch, который записывает запросы.
 *
 * Один ответ отдаётся на каждый запрос, массив — по очереди, по одному.
 */
function recordingClient(
  response: Response | Response[],
  overrides: Record<string, unknown> = {},
): { client: MailInfra; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const queue = Array.isArray(response) ? [...response] : undefined;
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    recorded.push({
      method: init.method ?? "GET",
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    if (queue === undefined) {
      return (response as Response).clone();
    }
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("fake fetch: закончились заготовленные ответы");
    }
    return next;
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

  it("передаёт content_id inline-вложения и не шлёт пустой", () => {
    const payload = buildSendPayload({
      from: "hello@mail.example.ru",
      to: "user@example.com",
      subject: "Логотип",
      html: '<img src="cid:logo@mail.example.ru">',
      attachments: [
        { filename: "logo.png", content_base64: "iVBORw==", content_id: "logo@mail.example.ru" },
        { filename: "bill.pdf", content_base64: "JVBERg==", content_id: null },
      ],
    });

    expect(payload.attachments?.[0]?.content_id).toBe("logo@mail.example.ru");
    expect(payload.attachments?.[1]).not.toHaveProperty("content_id");
  });

  it("передаёт metadata и ttl как есть", () => {
    const payload = buildSendPayload({
      from: "hello@mail.example.ru",
      to: "user@example.com",
      subject: "Заказ",
      text: "Оплачен",
      metadata: { order_id: "4242", "user.id": "u-1" },
      ttl: 600,
    });

    expect(payload.metadata).toEqual({ order_id: "4242", "user.id": "u-1" });
    expect(payload.ttl).toBe(600);
  });

  it("send_at типа Date уходит строкой ISO, строка со смещением — как есть", () => {
    const base = { from: "hello@mail.example.ru", to: "user@example.com", subject: "Т", text: "Т" };

    expect(buildSendPayload({ ...base, send_at: new Date("2026-11-01T06:00:00Z") }).send_at).toBe(
      "2026-11-01T06:00:00.000Z",
    );
    expect(buildSendPayload({ ...base, send_at: "2026-11-01T09:00:00+03:00" }).send_at).toBe(
      "2026-11-01T09:00:00+03:00",
    );
    expect(buildSendPayload(base)).not.toHaveProperty("send_at");
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
  const BATCH_BODY = {
    data: {
      results: [{ index: 0, id: EMAIL_ID, status: "QUEUED", skipped_recipients: [] }],
      accepted_count: 1,
      failed_count: 0,
    },
  };
  const item = {
    from: "hello@mail.example.ru",
    to: "a@example.com",
    subject: "Тема",
    text: "Текст",
  };

  it("ставит один Idempotency-Key на весь батч", async () => {
    const { client, recorded } = recordingClient(json(202, BATCH_BODY));

    const result = await client.emails.sendBatch([item, item]);

    expect(recorded[0]?.headers["Idempotency-Key"]).toBe(result.idempotencyKey);
    expect(result.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.replayed).toBe(false);
    expect(result.accepted_count).toBe(1);
  });

  it("уважает свой ключ и распознаёт повтор батча", async () => {
    const { client, recorded } = recordingClient(
      json(200, BATCH_BODY, { "Idempotent-Replayed": "true", "X-Request-ID": "req-7" }),
    );

    const result = await client.emails.sendBatch([item], { idempotencyKey: "import_2026_10_28" });

    expect(recorded[0]?.headers["Idempotency-Key"]).toBe("import_2026_10_28");
    expect(result.replayed).toBe(true);
    expect(result.requestId).toBe("req-7");
  });

  it("idempotencyKey: null отправляет батч без ключа", async () => {
    const { client, recorded } = recordingClient(json(202, BATCH_BODY));

    const result = await client.emails.sendBatch([item], { idempotencyKey: null });

    expect(recorded[0]?.headers).not.toHaveProperty("Idempotency-Key");
    expect(result.idempotencyKey).toBeUndefined();
  });

  it("ключ батча длиннее 252 символов отбивается до запроса", async () => {
    // Бэкенд дописывает к ключу батча разделитель и номер письма — до трёх
    // символов из тех же 255, поэтому у батча лимит меньше, чем у send().
    const { client, recorded } = recordingClient(json(202, BATCH_BODY));

    await expect(
      client.emails.sendBatch([item], { idempotencyKey: "k".repeat(BATCH_IDEMPOTENCY_KEY_MAX_LENGTH) }),
    ).resolves.toMatchObject({ replayed: false });
    const error = await client.emails
      .sendBatch([item], { idempotencyKey: "k".repeat(BATCH_IDEMPOTENCY_KEY_MAX_LENGTH + 1) })
      .catch((exc: unknown) => exc);

    expect(error).toBeInstanceOf(MailInfraError);
    expect((error as MailInfraError).code).toBe("invalid_idempotency_key");
    expect(recorded).toHaveLength(1);
  });

  it("передаёт новые поля каждого письма", async () => {
    const { client, recorded } = recordingClient(json(202, BATCH_BODY));

    await client.emails.sendBatch([
      { ...item, metadata: { order_id: "1" }, send_at: new Date("2026-11-01T06:00:00Z"), ttl: 60 },
    ]);

    expect((recorded[0]?.body as { emails: unknown[] }).emails[0]).toMatchObject({
      metadata: { order_id: "1" },
      send_at: "2026-11-01T06:00:00.000Z",
      ttl: 60,
    });
  });

  it("отдаёт ошибки по каждому письму", async () => {
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
    expect(recorded).toHaveLength(1);
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

/** Письмо списка с заданным id — остальные поля тестам не важны. */
function listItem(id: string): Record<string, unknown> {
  return { id, status: "DELIVERED", metadata: { order_id: id } };
}

/** Ответ `GET /emails`: страница писем и курсор следующей. */
function listResponse(ids: string[], nextCursor: string | null): Response {
  return json(200, {
    data: ids.map(listItem),
    has_more: nextCursor !== null,
    next_cursor: nextCursor,
  });
}

describe("чтение", () => {
  it("передаёт фильтры и курсор в query", async () => {
    const { client, recorded } = recordingClient(json(200, { data: [], has_more: false }));

    await client.emails.list({
      status: "DELIVERED",
      tag: "order",
      limit: 10,
      from: new Date("2026-05-11T20:00:00Z"),
      cursor: "MjAyNi0xMC0yOA",
    });

    const url = new URL(recorded[0]?.url ?? "");
    expect(url.searchParams.get("status")).toBe("DELIVERED");
    expect(url.searchParams.get("tag")).toBe("order");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("from")).toBe("2026-05-11T20:00:00.000Z");
    expect(url.searchParams.get("cursor")).toBe("MjAyNi0xMC0yOA");
  });

  it("возвращает страницу: письма, has_more и next_cursor", async () => {
    const { client } = recordingClient(listResponse(["a", "b"], "cursor-2"));

    const page = await client.emails.list({ limit: 2 });

    expect(page.data.map((email) => email.id)).toEqual(["a", "b"]);
    expect(page.data[0]?.metadata).toEqual({ order_id: "a" });
    expect(page.has_more).toBe(true);
    expect(page.next_cursor).toBe("cursor-2");
  });

  it("у последней страницы next_cursor — null, даже если API его не прислал", async () => {
    const { client } = recordingClient(json(200, { data: [], has_more: false }));

    await expect(client.emails.list()).resolves.toEqual({
      data: [],
      has_more: false,
      next_cursor: null,
    });
  });

  it("has_more без next_cursor — ответ не по контракту, а не конец списка", async () => {
    // Иначе listAll() молча оборвал бы обход на этой странице.
    const { client } = recordingClient(json(200, { data: [], has_more: true, next_cursor: null }));

    const error = await client.emails.list().catch((exc: unknown) => exc);

    expect(error).toBeInstanceOf(MailInfraError);
    expect((error as MailInfraError).code).toBe("malformed_response");
  });

  it("listAll обходит все страницы, передавая курсор и фильтры", async () => {
    const { client, recorded } = recordingClient([
      listResponse(["a", "b"], "cursor-2"),
      listResponse(["c", "d"], "cursor-3"),
      listResponse(["e"], null),
    ]);

    const ids: string[] = [];
    for await (const email of client.emails.listAll({ status: "BOUNCED", limit: 2 })) {
      ids.push(email.id);
    }

    expect(ids).toEqual(["a", "b", "c", "d", "e"]);
    const urls = recorded.map((call) => new URL(call.url));
    expect(urls.map((url) => url.searchParams.get("cursor"))).toEqual([
      null,
      "cursor-2",
      "cursor-3",
    ]);
    expect(urls.every((url) => url.searchParams.get("status") === "BOUNCED")).toBe(true);
    expect(urls.every((url) => url.searchParams.get("limit") === "2")).toBe(true);
  });

  it("listAll грузит страницы лениво: break останавливает запросы", async () => {
    const { client, recorded } = recordingClient([
      listResponse(["a", "b"], "cursor-2"),
      listResponse(["c"], null),
    ]);

    for await (const email of client.emails.listAll()) {
      expect(email.id).toBe("a");
      break;
    }

    expect(recorded).toHaveLength(1);
  });

  it("listAll продолжает обход с переданного курсора", async () => {
    const { client, recorded } = recordingClient(listResponse(["c"], null));

    const ids: string[] = [];
    for await (const email of client.emails.listAll({ cursor: "cursor-2" })) {
      ids.push(email.id);
    }

    expect(ids).toEqual(["c"]);
    expect(new URL(recorded[0]?.url ?? "").searchParams.get("cursor")).toBe("cursor-2");
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

describe("отложенная отправка", () => {
  const SCHEDULE_BODY = {
    data: { id: EMAIL_ID, status: "SCHEDULED", scheduled_at: "2026-11-01T06:00:00Z" },
  };

  it("send с send_at возвращает статус SCHEDULED", async () => {
    const { client, recorded } = recordingClient(
      json(202, { data: { id: EMAIL_ID, status: "SCHEDULED", skipped_recipients: [] } }),
    );

    const result = await client.emails.send({
      from: "hello@mail.example.ru",
      to: "user@example.com",
      subject: "Напоминание",
      text: "Завтра вебинар",
      send_at: new Date("2026-11-01T06:00:00Z"),
    });

    expect(result.status).toBe("SCHEDULED");
    expect((recorded[0]?.body as { send_at: string }).send_at).toBe("2026-11-01T06:00:00.000Z");
  });

  it("cancel — POST /emails/{id}/cancel без тела", async () => {
    const { client, recorded } = recordingClient(
      json(200, { data: { ...SCHEDULE_BODY.data, status: "CANCELED" } }),
    );

    const result = await client.emails.cancel(EMAIL_ID);

    expect(recorded[0]?.method).toBe("POST");
    expect(recorded[0]?.url).toBe(`${BASE_URL}/emails/${EMAIL_ID}/cancel`);
    expect(recorded[0]?.body).toBeUndefined();
    expect(result.status).toBe("CANCELED");
  });

  it("cancel незапланированного письма — EmailNotScheduledError со статусом письма", async () => {
    const { client } = recordingClient(
      json(409, {
        error: {
          code: "email_not_scheduled",
          message: "Письмо уже не запланировано.",
          details: { code: "email_not_scheduled", status: "SENT" },
        },
      }),
    );

    const error = await client.emails.cancel(EMAIL_ID).catch((exc: unknown) => exc);

    expect(error).toBeInstanceOf(EmailNotScheduledError);
    expect((error as EmailNotScheduledError).details["status"]).toBe("SENT");
  });

  it("reschedule — PATCH /emails/{id} с send_at, Date уходит строкой ISO", async () => {
    const { client, recorded } = recordingClient(json(200, SCHEDULE_BODY));

    const result = await client.emails.reschedule(EMAIL_ID, {
      send_at: new Date("2026-11-01T06:00:00Z"),
    });

    expect(recorded[0]?.method).toBe("PATCH");
    expect(recorded[0]?.url).toBe(`${BASE_URL}/emails/${EMAIL_ID}`);
    expect(recorded[0]?.body).toEqual({ send_at: "2026-11-01T06:00:00.000Z" });
    expect(result.scheduled_at).toBe("2026-11-01T06:00:00Z");
  });

  it("reschedule дальше горизонта — SendAtTooFarError", async () => {
    const { client } = recordingClient(
      json(400, {
        error: {
          code: "send_at_too_far",
          message: "Письмо можно запланировать не дальше чем на 7 дней вперёд.",
          details: { code: "send_at_too_far", field: "send_at", max_days: 7 },
        },
      }),
    );

    const error = await client.emails
      .reschedule(EMAIL_ID, { send_at: "2026-12-31T00:00:00Z" })
      .catch((exc: unknown) => exc);

    expect(error).toBeInstanceOf(SendAtTooFarError);
    expect((error as SendAtTooFarError).details["max_days"]).toBe(7);
  });

  it.each([
    ["без часового пояса", { send_at: "2026-11-01T09:00:00" }],
    ["без send_at — опечатка в имени", { sendAt: new Date() }],
    ["Invalid Date", { send_at: new Date("не дата") }],
  ])("reschedule %s отбивается до запроса", async (_name, params) => {
    const { client, recorded } = recordingClient(json(200, SCHEDULE_BODY));

    const error = await client.emails
      .reschedule(EMAIL_ID, params as never)
      .catch((exc: unknown) => exc);

    expect(error).toBeInstanceOf(MailInfraError);
    expect((error as MailInfraError).code).toBe("invalid_request");
    expect(recorded).toHaveLength(0);
  });

  it("пустой id письма не уходит на /emails/", async () => {
    // `/emails/` — это уже не письмо, а список: cancel("") и get("") ушли бы
    // на другой эндпоинт.
    const { client, recorded } = recordingClient(json(200, SCHEDULE_BODY));

    await expect(client.emails.cancel("")).rejects.toBeInstanceOf(MailInfraError);
    await expect(client.emails.get("")).rejects.toBeInstanceOf(MailInfraError);
    expect(recorded).toHaveLength(0);
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

  it("не отправляет слишком длинный content_id", () => {
    failsWith("invalid_attachment", {
      ...base,
      attachments: [
        { filename: "logo.png", content: "png", content_id: "c".repeat(MAX_CONTENT_ID_LENGTH + 1) },
      ],
    });
  });

  it("ограничивает число ключей metadata", () => {
    const metadata = (count: number): Record<string, string> =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`key${i}`, "v"]));

    expect(() =>
      buildSendPayload({ ...base, metadata: metadata(MAX_METADATA_KEYS) } as never),
    ).not.toThrow();
    failsWith("invalid_request", { ...base, metadata: metadata(MAX_METADATA_KEYS + 1) });
  });

  it.each([
    ["пустой", ""],
    ["кириллица", "заказ"],
    ["пробел", "order id"],
    ["длиннее лимита", "k".repeat(MAX_METADATA_KEY_LENGTH + 1)],
  ])("отбивает ключ metadata: %s", (_name, key) => {
    failsWith("invalid_request", { ...base, metadata: { [key]: "v" } });
  });

  it("принимает ключ metadata из латиницы, цифр, «_», «-» и «.»", () => {
    const key = `Order_1-2.x${"k".repeat(MAX_METADATA_KEY_LENGTH - 11)}`;

    expect(() => buildSendPayload({ ...base, metadata: { [key]: "v" } } as never)).not.toThrow();
  });

  it.each([
    ["не строка", { order_id: 4242 }],
    ["NUL", { order_id: "42\u000042" }],
    ["длиннее лимита в символах", { order_id: "я".repeat(MAX_METADATA_VALUE_LENGTH + 1) }],
    ["не объект", ["order_id"]],
    ["null", null],
  ])("отбивает metadata: %s", (_name, metadata) => {
    failsWith("invalid_request", { ...base, metadata });
  });

  it("длину значения metadata считает в символах", () => {
    const metadata = { emoji: "🎉".repeat(MAX_METADATA_VALUE_LENGTH) };

    expect(() => buildSendPayload({ ...base, metadata } as never)).not.toThrow();
  });

  it("размер metadata меряет как бэкенд — JSON с пробелами после «:» и «,»", () => {
    // Девять ключей `k0`…`k8`: Python-овый `json.dumps` даёт
    // `{"k0": "…", "k1": "…"}` — по 8 байт на пару сверх значения, 2 на
    // скобки и 16 на восемь «, » между парами: сумма значений + 90. Восемь
    // значений по 500 и девятое в `exact` символов — ровно 4096 байт.
    // Компактный `JSON.stringify` на 17 байт короче и пропустил бы и 4097.
    const exact = MAX_METADATA_BYTES - 90 - 8 * 500;
    const metadata = (last: number): Record<string, string> => ({
      ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, "v".repeat(500)])),
      k8: "v".repeat(last),
    });

    expect(() => buildSendPayload({ ...base, metadata: metadata(exact) } as never)).not.toThrow();
    failsWith("invalid_request", { ...base, metadata: metadata(exact + 1) });
  });

  it("размер metadata считает в байтах UTF-8, а не в символах", () => {
    // Пять значений по 500 символов: латиницей ~2,5 КБ, кириллицей ~5 КБ.
    const metadata = (char: string): Record<string, string> =>
      Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, char.repeat(500)]));

    expect(() => buildSendPayload({ ...base, metadata: metadata("v") } as never)).not.toThrow();
    failsWith("invalid_request", { ...base, metadata: metadata("я") });
  });

  it("ttl — целое число секунд от минуты до суток", () => {
    for (const ttl of [MIN_TTL_SECONDS, MAX_TTL_SECONDS]) {
      expect(() => buildSendPayload({ ...base, ttl } as never)).not.toThrow();
    }
    for (const ttl of [MIN_TTL_SECONDS - 1, MAX_TTL_SECONDS + 1, 90.5, "600", Number.NaN]) {
      failsWith("invalid_request", { ...base, ttl });
    }
  });

  it.each([
    ["без часового пояса", "2026-11-01T09:00:00"],
    ["только дата", "2026-11-01"],
    ["Invalid Date", new Date("не дата")],
  ])("отбивает send_at: %s", (_name, sendAt) => {
    failsWith("invalid_request", { ...base, send_at: sendAt });
  });

  it.each(["2026-11-01T06:00:00Z", "2026-11-01T09:00:00+03:00", "2026-11-01T01:00:00.5-0500"])(
    "принимает send_at %s",
    (sendAt) => {
      expect(() => buildSendPayload({ ...base, send_at: sendAt } as never)).not.toThrow();
    },
  );
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
    // Ключ у батча один на весь запрос — ошибка подсказывает, куда его деть.
    expect((error as MailInfraError).message).toContain("sendBatch(emails, { idempotencyKey })");
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
