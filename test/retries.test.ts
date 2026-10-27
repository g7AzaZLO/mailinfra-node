/**
 * Повторы, backoff и `Retry-After`.
 *
 * HTTP подменяется своим `fetch` — так тест видит ровно то, что уходит в
 * сеть (включая заголовки), и не зависит от перехватчиков рантайма.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APIConnectionError,
  APITimeoutError,
  MailInfra,
  RateLimitError,
  ServerError,
} from "../src/index.js";

const BASE_URL = "https://api.mailinfra.test/v1";
const API_KEY = "mi_test_0123456789abcdef0123456789abcdef";

const SEND_BODY = {
  data: { id: "018e1b7a-1111-7000-aaaa-111111111111", status: "QUEUED", skipped_recipients: [] },
};

interface Call {
  url: string;
  init: RequestInit;
}

/** Собирает fake fetch, отдающий заготовленные ответы по очереди. */
function fakeFetch(responses: Response[] | (() => Response)): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const queue = Array.isArray(responses) ? [...responses] : null;

  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (queue) {
      const next = queue.shift();
      if (!next) {
        throw new Error("fake fetch: закончились заготовленные ответы");
      }
      return next;
    }
    return (responses as () => Response)();
  }) as unknown as typeof globalThis.fetch;

  return { fetch: fetchImpl, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/**
 * Ответ, у которого заголовки уже пришли, а тело оборвалось: `fetch` такой
 * Response возвращает, а `text()` на нём отклоняется — как при обрыве
 * соединения посреди передачи.
 */
function brokenBody(status: number, error: Error = new TypeError("terminated")): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.error(error);
    },
  });
  return new Response(stream, { status, headers: { "Content-Type": "application/json" } });
}

function client(fetchImpl: typeof globalThis.fetch, overrides = {}): MailInfra {
  return new MailInfra({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    retryPolicy: { initialBackoffMs: 0 },
    ...overrides,
  });
}

const MINIMAL = {
  from: "hello@mail.example.ru",
  to: "user@example.com",
  subject: "Тема",
  text: "Текст",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("повторы", () => {
  it("повторяет 503 и возвращает результат", async () => {
    const { fetch, calls } = fakeFetch([json(503, {}), json(202, SEND_BODY)]);

    const result = await client(fetch).emails.send(MINIMAL);

    expect(calls).toHaveLength(2);
    expect(result.id).toBe(SEND_BODY.data.id);
  });

  it("переиспользует один ключ идемпотентности на все попытки", async () => {
    const { fetch, calls } = fakeFetch([json(500, {}), json(500, {}), json(202, SEND_BODY)]);

    const result = await client(fetch).emails.send(MINIMAL);

    const keys = new Set(
      calls.map((call) => (call.init.headers as Record<string, string>)["Idempotency-Key"]),
    );
    expect(keys.size).toBe(1);
    expect(result.idempotencyKey).toBe([...keys][0]);
  });

  it("не повторяет 422", async () => {
    const { fetch, calls } = fakeFetch([
      json(422, {
        error: { code: "request_validation_failed", message: "Проверьте поля.", details: {} },
      }),
    ]);

    await expect(client(fetch).emails.send(MINIMAL)).rejects.toThrow(/Проверьте поля/);
    expect(calls).toHaveLength(1);
  });

  it("не повторяет батч после 5xx", async () => {
    const { fetch, calls } = fakeFetch([json(500, {})]);

    await expect(client(fetch).emails.sendBatch([MINIMAL])).rejects.toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(1);
  });

  it("повторяет батч после 429 — письма не были приняты", async () => {
    const batch = { data: { results: [], accepted_count: 0, failed_count: 0 } };
    const { fetch, calls } = fakeFetch([
      json(429, {}, { "Retry-After": "0" }),
      json(202, batch),
    ]);

    await client(fetch).emails.sendBatch([MINIMAL]);

    expect(calls).toHaveLength(2);
  });

  it("ждёт ровно столько, сколько просит Retry-After", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fakeFetch([
      json(429, {}, { "Retry-After": "3" }),
      json(202, SEND_BODY),
    ]);

    const promise = client(fetch).emails.send(MINIMAL);

    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(1); // ещё рано

    await vi.advanceTimersByTimeAsync(1500);
    await promise;
    expect(calls).toHaveLength(2);
  });

  it("не ждёт слишком долгий Retry-After, а отдаёт ошибку", async () => {
    const { fetch, calls } = fakeFetch([
      json(
        429,
        { error: { code: "rate_limit_exceeded", message: "Превышен лимит.", details: {} } },
        { "Retry-After": "600" },
      ),
    ]);

    const error = await client(fetch)
      .emails.send(MINIMAL)
      .catch((exc: unknown) => exc);

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(600);
    expect(calls).toHaveLength(1);
  });

  it("повторяет сетевые сбои и в итоге поднимает APIConnectionError", async () => {
    const calls: string[] = [];
    const fetchImpl = (async () => {
      calls.push("attempt");
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    await expect(client(fetchImpl).emails.send(MINIMAL)).rejects.toBeInstanceOf(
      APIConnectionError,
    );
    expect(calls).toHaveLength(3); // первая попытка + два повтора
  });

  it("не повторяет при maxRetries=0", async () => {
    const { fetch, calls } = fakeFetch(() => json(503, {}));

    await expect(client(fetch, { maxRetries: 0 }).emails.send(MINIMAL)).rejects.toBeInstanceOf(
      ServerError,
    );
    expect(calls).toHaveLength(1);
  });

  it("повторяет обрыв при чтении тела с тем же ключом идемпотентности", async () => {
    // Заголовки 202 пришли, письмо на бэкенде уже принято, а тело не дочиталось.
    // Повтор снаружи взял бы новый ключ и создал второе письмо — поэтому SDK
    // повторяет сам, с прежним ключом.
    const { fetch, calls } = fakeFetch([brokenBody(202), json(202, SEND_BODY)]);

    const result = await client(fetch).emails.send(MINIMAL);

    expect(calls).toHaveLength(2);
    expect(result.id).toBe(SEND_BODY.data.id);
    const keys = calls.map((call) => (call.init.headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys[0]).toBe(keys[1]);
  });

  it("обрыв при чтении тела, если повторы исчерпаны, — APIConnectionError, а не сырая ошибка", async () => {
    const { fetch, calls } = fakeFetch(() => brokenBody(202));

    const error = await client(fetch)
      .emails.send(MINIMAL)
      .catch((exc: unknown) => exc);

    expect(error).toBeInstanceOf(APIConnectionError);
    expect((error as APIConnectionError).cause).toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(3);
  });

  it("таймаут при чтении тела — APITimeoutError", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const { fetch } = fakeFetch(() => brokenBody(202, timeout));

    await expect(client(fetch, { maxRetries: 0 }).emails.send(MINIMAL)).rejects.toBeInstanceOf(
      APITimeoutError,
    );
  });

  it("ответ не по контракту не считается сетевым сбоем и не повторяется", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, { items: [] }));

    await expect(client(fetch).emails.list()).rejects.toThrow(/не по контракту/);
    expect(calls).toHaveLength(1);
  });
});

describe("повторы без гарантии идемпотентности", () => {
  /** fetch, который всегда падает сетевой ошибкой и считает попытки. */
  function failingFetch(error: Error): { fetch: typeof globalThis.fetch; calls: string[] } {
    const calls: string[] = [];
    const fetchImpl = (async () => {
      calls.push("attempt");
      throw error;
    }) as unknown as typeof globalThis.fetch;
    return { fetch: fetchImpl, calls };
  }

  function timeoutError(): Error {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    return error;
  }

  it("не повторяет батч после таймаута — часть писем могла уже уехать", async () => {
    const { fetch, calls } = failingFetch(timeoutError());

    await expect(client(fetch).emails.sendBatch([MINIMAL])).rejects.toBeInstanceOf(
      APITimeoutError,
    );
    expect(calls).toHaveLength(1);
  });

  it("не повторяет батч после обрыва соединения", async () => {
    const { fetch, calls } = failingFetch(new TypeError("fetch failed"));

    await expect(client(fetch).emails.sendBatch([MINIMAL])).rejects.toBeInstanceOf(
      APIConnectionError,
    );
    expect(calls).toHaveLength(1);
  });

  it("не повторяет батч после обрыва при чтении тела — 202 уже был", async () => {
    const { fetch, calls } = fakeFetch(() => brokenBody(202));

    await expect(client(fetch).emails.sendBatch([MINIMAL])).rejects.toBeInstanceOf(
      APIConnectionError,
    );
    expect(calls).toHaveLength(1);
  });

  it("не повторяет 5xx у отправки без ключа идемпотентности", async () => {
    const { fetch, calls } = fakeFetch(() => json(503, {}));

    await expect(
      client(fetch).emails.send(MINIMAL, { idempotencyKey: null }),
    ).rejects.toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(1);
  });

  it("не повторяет 5xx при autoIdempotency: false", async () => {
    const { fetch, calls } = fakeFetch(() => json(503, {}));

    await expect(
      client(fetch, { autoIdempotency: false }).emails.send(MINIMAL),
    ).rejects.toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(1);
  });

  it("но 429 повторяет и без ключа — лимитёр отказывает до приёма письма", async () => {
    const { fetch, calls } = fakeFetch([json(429, {}, { "Retry-After": "0" }), json(202, SEND_BODY)]);

    await client(fetch).emails.send(MINIMAL, { idempotencyKey: null });

    expect(calls).toHaveLength(2);
  });

  it("код таймаута совпадает с Python SDK", async () => {
    const { fetch } = failingFetch(timeoutError());

    const error = await client(fetch)
      .emails.send(MINIMAL)
      .catch((exc: unknown) => exc);

    expect(error).toBeInstanceOf(APITimeoutError);
    expect((error as APITimeoutError).code).toBe("api_timeout");
  });
});

describe("таймаут запроса", () => {
  /** fetch, запоминающий переданный signal. */
  function signalSpy(): { fetch: typeof globalThis.fetch; signals: (AbortSignal | undefined)[] } {
    const signals: (AbortSignal | undefined)[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init: RequestInit = {}) => {
      signals.push(init.signal ?? undefined);
      return json(202, SEND_BODY);
    }) as unknown as typeof globalThis.fetch;
    return { fetch: fetchImpl, signals };
  }

  it("по умолчанию ставит свой AbortSignal", async () => {
    const { fetch, signals } = signalSpy();

    await client(fetch).emails.send(MINIMAL);

    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("timeoutMs: null отдаёт таймаут вашему fetch", async () => {
    // undici Agent с headersTimeout 120s не дожил бы до срабатывания:
    // AbortSignal SDK рвал запрос на 30-й секунде.
    const { fetch, signals } = signalSpy();

    await client(fetch, { timeoutMs: null }).emails.send(MINIMAL);

    expect(signals[0]).toBeUndefined();
  });

  it("timeoutMs: 0 — это не то же самое, что null", async () => {
    const { fetch, signals } = signalSpy();

    await client(fetch, { timeoutMs: 0 }).emails.send(MINIMAL);

    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});

describe("проверка политики повторов (аудит H11-04)", () => {
  function build(options: Partial<ConstructorParameters<typeof MailInfra>[0]>): MailInfra {
    return new MailInfra({ apiKey: API_KEY, baseUrl: BASE_URL, ...options });
  }

  it.each([
    ["maxRetries: NaN — типичное Number(process.env.X) без переменной", { maxRetries: Number.NaN }],
    ["отрицательный maxRetries", { maxRetries: -1 }],
    ["дробный maxRetries", { maxRetries: 1.5 }],
    ["бесконечный maxRetries", { maxRetries: Number.POSITIVE_INFINITY }],
    ["maxRetries: NaN в retryPolicy", { retryPolicy: { maxRetries: Number.NaN } }],
    ["initialBackoffMs: NaN", { retryPolicy: { initialBackoffMs: Number.NaN } }],
    ["отрицательный initialBackoffMs", { retryPolicy: { initialBackoffMs: -10 } }],
    ["backoffFactor меньше 1", { retryPolicy: { backoffFactor: 0.5 } }],
    ["maxBackoffMs: NaN", { retryPolicy: { maxBackoffMs: Number.NaN } }],
    ["maxRetryAfterMs: NaN", { retryPolicy: { maxRetryAfterMs: Number.NaN } }],
  ])("%s — ошибка конфигурации при создании клиента", (_name, options) => {
    expect(() => build(options)).toThrow(RangeError);
  });

  it("Infinity у потолков — «без потолка», как раньше (ревью R-i-06)", () => {
    const policy = build({
      retryPolicy: {
        maxBackoffMs: Number.POSITIVE_INFINITY,
        maxRetryAfterMs: Number.POSITIVE_INFINITY,
      },
    }).retryPolicy;

    expect(policy.maxBackoffMs).toBe(Number.POSITIVE_INFINITY);
    expect(policy.maxRetryAfterMs).toBe(Number.POSITIVE_INFINITY);
  });

  it("строка вместо числа — TypeError с типом в сообщении (ревью R-i-06)", () => {
    // JS без типов: maxRetries: process.env.MAILINFRA_RETRIES.
    const options = { maxRetries: "3" as unknown as number };

    expect(() => build(options)).toThrow(TypeError);
    expect(() => build(options)).toThrow(/maxRetries.*строка "3"/);
  });

  it("undefined в retryPolicy значит «не задано» и не затирает maxRetries", () => {
    expect(build({ retryPolicy: { maxRetries: undefined } }).retryPolicy.maxRetries).toBe(2);
    expect(
      build({ maxRetries: 3, retryPolicy: { maxRetries: undefined } }).retryPolicy.maxRetries,
    ).toBe(3);
    expect(build({ maxRetries: 0 }).retryPolicy.maxRetries).toBe(0);
  });

  it("с { maxRetries: undefined } сетевой сбой повторяется по умолчанию, а не вечно", async () => {
    let calls = 0;
    // После десятого вызова сеть «оживает»: без проверки политики запрос
    // крутился бы до этого момента, а не падал после трёх попыток.
    const fetchImpl = (async () => {
      calls += 1;
      if (calls > 10) return json(202, SEND_BODY);
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const sdk = client(fetchImpl, { retryPolicy: { maxRetries: undefined, initialBackoffMs: 0 } });

    await expect(sdk.emails.send(MINIMAL)).rejects.toBeInstanceOf(APIConnectionError);
    expect(calls).toBe(3);
  });

  it("с { maxRetries: undefined } 5xx по-прежнему повторяется", async () => {
    const { fetch, calls } = fakeFetch(() => json(503, {}));
    const sdk = client(fetch, { retryPolicy: { maxRetries: undefined, initialBackoffMs: 0 } });

    await expect(sdk.emails.send(MINIMAL)).rejects.toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(3);
  });
});
