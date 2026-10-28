/**
 * Клиент MailInfra для Node.js и edge-рантаймов.
 *
 * Поверх глобального `fetch` и WebCrypto, без внешних зависимостей: работает
 * в Node >= 20, Cloudflare Workers, Deno и Bun. Поведение совпадает с Python SDK —
 * автоматический `Idempotency-Key`, повторы с backoff, уважение `Retry-After`,
 * типизированные ошибки.
 */

import { APIConnectionError, APITimeoutError, MailInfraError, errorFromResponse } from "./errors.js";
import { EmailsResource } from "./resources/emails.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_RETRY_POLICY,
  DEFAULT_TIMEOUT_MS,
  nextDelay,
  parseRetryAfter,
  shouldRetryStatus,
  sleep,
  type RetryPolicy,
} from "./transport.js";

export const API_KEY_ENV_VAR = "MAILINFRA_API_KEY";
export const BASE_URL_ENV_VAR = "MAILINFRA_BASE_URL";

const REQUEST_ID_HEADER = "X-Request-ID";

/** Версия пакета; уезжает в `User-Agent`. Синхронна с package.json. */
export const VERSION = "0.2.0";

/** Окружение API-ключа. */
export type Environment = "live" | "test";

// Регистр префикса важен только для распознавания окружения: ключи, выданные
// до фикса генератора, имеют вид `mi_LIVE_…` (см. legacy-ветку в
// `app.api.api_auth.get_api_context`), и такой ключ обязан работать.
const LIVE_PREFIXES = ["mi_live_", "mi_LIVE_"];
const TEST_PREFIXES = ["mi_test_", "mi_TEST_"];

export interface MailInfraOptions {
  /** API-ключ проекта; по умолчанию из `MAILINFRA_API_KEY`. */
  apiKey?: string;
  /** База API; по умолчанию из `MAILINFRA_BASE_URL` либо продакшен. */
  baseUrl?: string;
  /**
   * Таймаут одного запроса, мс. По умолчанию 30 000.
   *
   * `null` — не ставить свой `AbortSignal` вообще: таймауты остаются на
   * вашем `fetch` (например, `headersTimeout`/`bodyTimeout` у undici
   * `Agent`). Без этого SDK обрывал бы запрос на 30-й секунде раньше, чем
   * сработает ваша настройка.
   */
  timeoutMs?: number | null;
  /**
   * Сколько раз повторять сверх первой попытки: целое число >= 0.
   * `NaN`, дробное или отрицательное значение — `RangeError`, строка — `TypeError`
   * при создании клиента.
   */
  maxRetries?: number;
  /**
   * Полная политика повторов; переопределяет `maxRetries`. Поле со значением
   * `undefined` считается не заданным. `NaN`, отрицательные числа, `backoffFactor`
   * меньше 1 и `Infinity` где-либо, кроме `maxBackoffMs`/`maxRetryAfterMs`, —
   * `RangeError`, не число (например, строка) — `TypeError` при создании клиента.
   */
  retryPolicy?: Partial<RetryPolicy>;
  /** Ставить ли `Idempotency-Key` автоматически (по умолчанию да). */
  autoIdempotency?: boolean;
  /** Требуемое окружение ключа: клиент не создастся при несовпадении. */
  requireEnvironment?: Environment;
  /** Своя реализация fetch (прокси, моки, undici Agent). */
  fetch?: typeof globalThis.fetch;
  /** Дополнение к `User-Agent`. */
  userAgentSuffix?: string;
}

export interface RequestOptions {
  method: string;
  /** Путь относительно базы, например `/emails`. */
  path: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  /**
   * Можно ли безопасно повторить запрос. Для `POST /emails` и батча — да,
   * если SDK поставил `Idempotency-Key` и переиспользует его; без ключа — нет.
   */
  idempotent?: boolean;
  /** Сигнал отмены вызывающего; складывается с таймаутом SDK. */
  signal?: AbortSignal;
}

/**
 * Складывает таймаут SDK и сигнал вызывающего: срабатывает тот, что раньше.
 *
 * `AbortSignal.any` есть в Node >= 20 и в edge-рантаймах; там, где его нет,
 * склеиваем вручную — иначе один из двух сигналов просто потерялся бы.
 */
function combineSignals(
  timeout: AbortSignal | undefined,
  external: AbortSignal | undefined,
): AbortSignal | undefined {
  if (timeout === undefined) {
    return external;
  }
  if (external === undefined) {
    return timeout;
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([timeout, external]);
  }
  const controller = new AbortController();
  for (const signal of [timeout, external]) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener(
      "abort",
      () => {
        controller.abort(signal.reason);
      },
      { once: true },
    );
  }
  return controller.signal;
}

/** Ответ API вместе с метаданными, которые нужны ресурсам. */
export interface ApiResponse<T> {
  data: T;
  /**
   * Тело ответа целиком. У страницы списка рядом с `data` лежат `has_more`
   * и `next_cursor`, и без конверта ресурсу их не достать.
   */
  envelope: Record<string, unknown>;
  status: number;
  headers: Headers;
  requestId?: string;
}

function detectEnvironment(apiKey: string): Environment {
  if (LIVE_PREFIXES.some((prefix) => apiKey.startsWith(prefix))) {
    return "live";
  }
  if (TEST_PREFIXES.some((prefix) => apiKey.startsWith(prefix))) {
    return "test";
  }
  throw new Error(
    "API-ключ MailInfra должен начинаться с 'mi_live_' или 'mi_test_'. " +
      "Ключ создаётся в дашборде и показывается один раз.",
  );
}

function readEnv(name: string): string | undefined {
  // `process` есть не во всех рантаймах (Workers), поэтому обращение защищено.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.[name];
}

function buildUserAgent(suffix: string | undefined): string {
  const runtime = (globalThis as { process?: { version?: string } }).process?.version;
  const base = `mailinfra-node/${VERSION}${runtime ? ` (node/${runtime})` : ""}`;
  return suffix ? `${base} ${suffix}` : base;
}

/** Допустимые значения числа в политике повторов. */
interface RetryLimit {
  min: number;
  /** Только целое: число попыток. */
  integer?: boolean;
  /** `Infinity` допустим: у потолков он значит «без потолка». */
  unbounded?: boolean;
}

const RETRY_POLICY_LIMITS: Record<keyof RetryPolicy, RetryLimit> = {
  maxRetries: { min: 0, integer: true },
  initialBackoffMs: { min: 0 },
  backoffFactor: { min: 1 },
  maxBackoffMs: { min: 0, unbounded: true },
  maxRetryAfterMs: { min: 0, unbounded: true },
};

/**
 * Проверяет одно число политики повторов.
 *
 * @throws {TypeError} Значение не число — например, строка из `process.env`.
 * @throws {RangeError} Число вне допустимого диапазона, в том числе `NaN`.
 */
function checkRetryValue(name: string, value: unknown, limit: RetryLimit): void {
  if (typeof value !== "number") {
    const shown = typeof value === "string" ? `строка ${JSON.stringify(value)}` : typeof value;
    throw new TypeError(
      `${name} должен быть числом, а передана ${shown}. ` +
        "Значение из окружения приведите явно: Number(process.env.…).",
    );
  }
  const { min, integer = false, unbounded = false } = limit;
  const valid =
    value >= min &&
    (Number.isFinite(value) || (unbounded && value === Number.POSITIVE_INFINITY)) &&
    (!integer || Number.isInteger(value));
  if (!valid) {
    const kind = integer ? "целым числом" : unbounded ? "числом или Infinity" : "конечным числом";
    throw new RangeError(`${name} должен быть ${kind} не меньше ${min}, а передано ${String(value)}.`);
  }
}

/**
 * Собирает политику повторов из опций клиента и проверяет её.
 *
 * `undefined` в `retryPolicy` значит «не задано», как и `maxRetries: undefined`:
 * раньше `{ maxRetries: undefined }` затирал и дефолт, и явный `maxRetries`.
 * Нечисловое значение — ошибка конфигурации: с `NaN` (типичное
 * `Number(process.env.X)` без переменной) обе проверки `attempt` против
 * `maxRetries` ложны, и сетевой сбой повторялся вечно, а 5xx не повторялся
 * вовсе (аудит H11-04). Нижние пределы `maxRetries`, `initialBackoffMs` и
 * `backoffFactor` — как у Python SDK; потолки, как и там, могут быть
 * бесконечными. Строки не приводятся: в Python они тоже ошибка.
 *
 * @throws {TypeError} Значение не число.
 * @throws {RangeError} Число вне допустимого диапазона.
 */
function resolveRetryPolicy(options: MailInfraOptions): RetryPolicy {
  const overrides = Object.fromEntries(
    Object.entries(options.retryPolicy ?? {}).filter(([, value]) => value !== undefined),
  ) as Partial<RetryPolicy>;
  const policy: RetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...overrides,
  };
  for (const [name, limit] of Object.entries(RETRY_POLICY_LIMITS)) {
    checkRetryValue(name, policy[name as keyof RetryPolicy], limit);
  }
  return policy;
}

/**
 * Клиент MailInfra.
 *
 * ```ts
 * import { MailInfra } from "mailinfra";
 *
 * const client = new MailInfra(); // ключ из MAILINFRA_API_KEY
 * const result = await client.emails.send({
 *   from: "hello@mail.example.ru",
 *   to: "user@example.com",
 *   subject: "Привет",
 *   html: "<p>Привет!</p>",
 * });
 * ```
 */
export class MailInfra {
  /**
   * Письма: `send`, `sendBatch`, `get`, `list`, `listAll`, `events`, `cancel`,
   * `reschedule`.
   */
  readonly emails: EmailsResource;
  /** Окружение ключа, распознанное по префиксу. */
  readonly environment: Environment;
  /** База API без завершающего слеша. */
  readonly baseUrl: string;
  /** Ставится ли `Idempotency-Key` автоматически. */
  readonly autoIdempotency: boolean;
  /** Действующая политика повторов. */
  readonly retryPolicy: RetryPolicy;

  private readonly apiKey: string;
  private readonly timeoutMs: number | null;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly userAgent: string;

  constructor(options: MailInfraOptions = {}) {
    const apiKey = options.apiKey ?? readEnv(API_KEY_ENV_VAR);
    if (!apiKey) {
      throw new Error(
        `Не задан API-ключ: передайте apiKey или положите ключ в переменную окружения ${API_KEY_ENV_VAR}.`,
      );
    }

    this.apiKey = apiKey;
    this.environment = detectEnvironment(apiKey);

    if (options.requireEnvironment && this.environment !== options.requireEnvironment) {
      throw new Error(
        `Ожидался ключ окружения '${options.requireEnvironment}', а передан '${this.environment}'. ` +
          "Проверьте конфигурацию: тестовый ключ в проде не отправит ни одного письма, " +
          "а рабочий в тестах отправит настоящие.",
      );
    }

    this.baseUrl = (options.baseUrl ?? readEnv(BASE_URL_ENV_VAR) ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    // `??` тут нельзя: он схлопнул бы `null` («таймаут на моём fetch») в
    // дефолт, и отказаться от своего AbortSignal было бы невозможно.
    this.timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
    this.autoIdempotency = options.autoIdempotency ?? true;
    this.retryPolicy = resolveRetryPolicy(options);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.userAgent = buildUserAgent(options.userAgentSuffix);

    if (typeof this.fetchImpl !== "function") {
      throw new Error(
        "В этом рантайме нет глобального fetch. Нужен Node >= 20 или передайте свой fetch.",
      );
    }
    // Автоматический `Idempotency-Key` — это `crypto.randomUUID()`. Глобальный
    // WebCrypto без флага появился только в Node 19, поэтому на Node 18 каждая
    // отправка падала бы ещё до запроса с невнятным ReferenceError.
    if (this.autoIdempotency && typeof globalThis.crypto?.randomUUID !== "function") {
      throw new Error(
        "В этом рантайме нет WebCrypto (crypto.randomUUID) для автоматического Idempotency-Key. " +
          "Нужен Node >= 20, либо autoIdempotency: false и свой idempotencyKey на каждую отправку.",
      );
    }

    this.emails = new EmailsResource(this);
  }

  /**
   * Выполняет запрос к API с повторами и разбором ошибок.
   *
   * @returns Содержимое поля `data` вместе с конвертом, статусом и заголовками ответа.
   * @throws {MailInfraError} Любая ошибка API или транспорта.
   */
  async request<T>(options: RequestOptions): Promise<ApiResponse<T>> {
    const url = this.buildUrl(options.path, options.query);
    const idempotent = options.idempotent ?? true;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": this.userAgent,
      ...options.headers,
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const init: RequestInit = {
      method: options.method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    };

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      let body: unknown;
      try {
        response = await this.fetchWithTimeout(url, init, options.signal);
        // Соединение рвётся и после заголовков: `fetch` уже вернул Response,
        // а тело дочитать не удалось. Это тот же транспортный сбой, что и
        // до ответа, и повторяется по тем же правилам — с тем же
        // `Idempotency-Key`, иначе повтор снаружи создал бы второе письмо.
        body = await this.decode(response);
      } catch (cause) {
        // Отмена вызывающего — не транспортный сбой. Её нельзя повторять,
        // и подменять причину тоже: вызывающий ждёт свой AbortError, как в
        // Go до него доезжает context.Canceled.
        if (options.signal?.aborted === true) {
          throw cause;
        }
        const timedOut = cause instanceof Error && cause.name === "TimeoutError";
        // Отсутствие ответа не значит, что сервер ничего не принял: таймаут и
        // обрыв случаются и после того, как запрос дошёл и был выполнен.
        // Поэтому неидемпотентный запрос (отправка или батч без
        // `Idempotency-Key`) здесь не повторяется.
        const delay =
          !idempotent || attempt >= this.retryPolicy.maxRetries
            ? undefined
            : nextDelay({ attempt, policy: this.retryPolicy });
        if (delay === undefined) {
          throw timedOut ? new APITimeoutError(undefined, cause) : new APIConnectionError(undefined, cause);
        }
        await sleep(delay, options.signal);
        continue;
      }

      const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;

      if (response.ok) {
        return this.toApiResponse<T>(response, body, requestId);
      }

      const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
      const canRetry =
        attempt < this.retryPolicy.maxRetries && shouldRetryStatus(response.status, idempotent);
      const delay = canRetry
        ? nextDelay({ attempt, policy: this.retryPolicy, retryAfterMs })
        : undefined;

      if (delay === undefined) {
        throw errorFromResponse({
          statusCode: response.status,
          body,
          requestId,
          retryAfter: retryAfterMs === undefined ? undefined : Math.round(retryAfterMs / 1000),
        });
      }

      await sleep(delay, options.signal);
    }
  }

  /**
   * Собирает успешный ответ: `data`, конверт целиком, статус и заголовки.
   *
   * @throws {MailInfraError} Тело не по контракту — без поля `data`.
   */
  private toApiResponse<T>(
    response: Response,
    body: unknown,
    requestId: string | undefined,
  ): ApiResponse<T> {
    return {
      data: this.unwrap<T>(body, response.status, requestId),
      // Что это объект с `data`, уже проверил `unwrap` строкой выше.
      envelope: body as Record<string, unknown>,
      status: response.status,
      headers: response.headers,
      ...(requestId === undefined ? {} : { requestId }),
    };
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    external?: AbortSignal,
  ): Promise<Response> {
    // AbortSignal.timeout есть в Node >= 17.3 и во всех edge-рантаймах, но
    // подменённый fetch в тестах может его не поддерживать — тогда просто
    // идём без таймаута, а не падаем.
    const timeoutSignal =
      this.timeoutMs !== null &&
      typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(this.timeoutMs)
        : undefined;
    const signal = combineSignals(timeoutSignal, external);
    return this.fetchImpl(url, signal ? { ...init, signal } : init);
  }

  /** Читает тело целиком; отклоняется только если его не удалось дочитать. */
  private async decode(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      // Прокси и балансировщики умеют отвечать HTML — отдаём как есть,
      // маппинг ошибок это переживёт.
      return text;
    }
  }

  private unwrap<T>(body: unknown, statusCode: number, requestId: string | undefined): T {
    if (typeof body !== "object" || body === null || !("data" in body)) {
      throw new MailInfraError("Ответ API не по контракту: ожидался объект с полем 'data'", {
        statusCode,
        code: "malformed_response",
        requestId,
      });
    }
    return (body as { data: T }).data;
  }
}
