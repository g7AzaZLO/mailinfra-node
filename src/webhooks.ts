/**
 * Проверка подписи вебхуков MailInfra.
 *
 * MailInfra подписывает каждый POST заголовком
 *
 * ```
 * X-MailInfra-Signature: t=1715461200,v1=3d4f2e1a…
 * ```
 *
 * где `v1` — HMAC-SHA256 от `` `${t}.` `` + сырое тело запроса, ключ — secret
 * вебхука (вместе с префиксом `whsec_`). Алгоритм повторяет
 * `app.services.webhook_service.sign_payload`; вектора общие для бэкенда и
 * всех SDK — `webhook-signatures.json` (в репозитории SDK — `resources/`).
 *
 * Во время ротации secret подписей две — новым secret и прежним, последней:
 *
 * ```
 * X-MailInfra-Signature: t=1715461200,v1=<новым>,v1=<прежним>
 * ```
 *
 * Подпись верна, если с вашим secret совпала любая из них: обработчик со
 * старым secret продолжает работать, пока вы не обновите конфиг.
 *
 * Реализация на WebCrypto, без node-only API: работает в Node >= 20 (глобальный
 * `crypto` без флага появился в 19), Cloudflare Workers, Deno и Bun.
 *
 * Пример (Express):
 *
 * ```ts
 * import express from "express";
 * import { constructEvent } from "mailinfra";
 *
 * app.post("/mailinfra/events", express.raw({ type: "application/json" }), async (req, res) => {
 *   const event = await constructEvent({
 *     body: req.body,                       // сырые байты, не req.body как JSON
 *     secret: process.env.MAILINFRA_WEBHOOK_SECRET!,
 *     signatureHeader: req.header("X-MailInfra-Signature")!,
 *   });
 *   res.json({ status: "ok" });
 * });
 * ```
 *
 * Тело обязательно передавать сырым: пересериализованный JSON даст другие
 * байты и подпись не сойдётся.
 */

/** Имя заголовка с подписью. */
export const SIGNATURE_HEADER = "X-MailInfra-Signature";

/** Имя заголовка с идентификатором события. */
export const EVENT_ID_HEADER = "X-MailInfra-Event-Id";

/**
 * Окно допустимого возраста подписи.
 *
 * Бэкенд отклоняет подписи старше 5 минут (`SIGNATURE_MAX_AGE_SEC`), держим
 * то же окно, чтобы поведение получателя совпадало с ожиданиями отправителя.
 */
export const DEFAULT_MAX_AGE_SECONDS = 300;

/** Машинная причина отказа в проверке подписи. */
export type SignatureFailureReason =
  | "malformed_header"
  | "too_old"
  | "signature_mismatch"
  | "invalid_json"
  | "invalid_payload"
  | "invalid_secret";

/** Подпись не прошла проверку. */
export class WebhookSignatureError extends Error {
  readonly reason: SignatureFailureReason;

  constructor(message: string, reason: SignatureFailureReason) {
    super(message);
    this.name = "WebhookSignatureError";
    this.reason = reason;
  }
}

/** Разобранное событие вебхука. */
export interface WebhookEvent {
  /**
   * Идентификатор события: `evt_<uuid>` у событий письма,
   * `evt_deliverability_<hex>` у `deliverability.*`, `evt_test_ping` у теста.
   */
  id: string;
  /**
   * Тип: `email.<событие>` у событий письма (например `email.bounced`,
   * `email.scheduled` при отложенной отправке, `email.canceled` при её
   * отмене), `deliverability.<инцидент>` как есть (например
   * `deliverability.dns_degraded`), `test.ping` у тестовой отправки из
   * дашборда.
   */
  type: string;
  /** Момент события на стороне MailInfra, ISO-8601. */
  created_at: string;
  /**
   * Полезная нагрузка. У событий письма `data.email` — письмо, `data.event` —
   * специфика события (MX, IP, bounce-детали, URL клика). У `deliverability.*`
   * письма нет: `domain_id`, `domain`, `severity`, `title`, `details` инцидента.
   */
  data: {
    email?: {
      id: string;
      from: string;
      to: string[];
      subject: string;
      tags: string[];
      /**
       * `metadata`, переданный при отправке; пустой объект, если его не было.
       * Необязателен в типе: доставки, собранные до появления поля, его не несут.
       */
      metadata?: Record<string, string>;
      status: string;
    };
    event?: Record<string, unknown>;
    message?: string;
  } & Record<string, unknown>;
}

/** Тело запроса в любом виде, в котором его отдают веб-фреймворки. */
export type WebhookBody = string | Uint8Array | ArrayBuffer;

export interface VerifyInput {
  /** Сырое тело запроса (до разбора JSON). */
  body: WebhookBody;
  /** Secret вебхука вместе с префиксом `whsec_`. */
  secret: string;
  /** Значение заголовка `X-MailInfra-Signature`. */
  signatureHeader: string;
  /** Допустимый возраст подписи; `0` отключает проверку времени. */
  maxAgeSeconds?: number;
}

const encoder = new TextEncoder();

function toBytes(body: WebhookBody): Uint8Array {
  if (typeof body === "string") {
    return encoder.encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  return new Uint8Array(body);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Сравнение за постоянное время.
 *
 * Разницу длин не скрываем — она и так видна по формату подписи, а вот
 * ранний выход на первом несовпавшем символе позволял бы подбирать подпись
 * побайтово.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Совпала ли ожидаемая подпись хотя бы с одной из присланных.
 *
 * Сравниваются все, без выхода на первом совпадении: иначе по времени ответа
 * было бы видно, какая из подписей ротации подошла.
 */
function matchesAny(expected: string, candidates: readonly string[]): boolean {
  let matched = false;
  for (const candidate of candidates) {
    matched = timingSafeEqualHex(expected, candidate) || matched;
  }
  return matched;
}

/**
 * Отвергает пустой secret.
 *
 * WebCrypto отвергает ключ нулевой длины DOMException'ом. Типовой источник —
 * `process.env.MAILINFRA_WEBHOOK_SECRET ?? ""`: без этой проверки обработчик
 * отвечал 500 на каждую доставку, и MailInfra ретраила её бесконечно.
 *
 * Вызывается первой проверкой и в `verify`, и в `constructEvent`: иначе пустой
 * secret маскируется любой другой проблемой — битым заголовком или устаревшей
 * подписью — и `reason` показывает на отправителя вместо конфига. Python, Go и
 * PHP проверяют secret в том же порядке.
 */
function requireSecret(secret: string): void {
  if (secret === "") {
    throw new WebhookSignatureError(
      "Пустой secret вебхука: проверьте MAILINFRA_WEBHOOK_SECRET — значение вида 'whsec_…' " +
        "берётся в дашборде при создании вебхука",
      "invalid_secret",
    );
  }
}

/**
 * Считает hex-подпись тела — та же функция, что на бэкенде.
 *
 * Нужна тестам и локальной отладке обработчика: позволяет собрать корректный
 * `X-MailInfra-Signature` без реального вебхука.
 */
export async function sign(input: {
  body: WebhookBody;
  secret: string;
  timestamp: number;
}): Promise<string> {
  requireSecret(input.secret);

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const prefix = encoder.encode(`${input.timestamp}.`);
  const body = toBytes(input.body);
  const signingString = new Uint8Array(prefix.length + body.length);
  signingString.set(prefix, 0);
  signingString.set(body, prefix.length);

  return toHex(await crypto.subtle.sign("HMAC", key, signingString));
}

/**
 * Разбирает `t=<unix>,v1=<hex>[,v1=<hex>…]`.
 *
 * Подписи `v1` собираются все: раньше каждая следующая затирала предыдущую,
 * и в окне ротации проходила только последняя — подпись прежним secret, —
 * а обработчик с новым secret отвергал каждую доставку.
 */
function parseHeader(signatureHeader: string): { timestamp: number; signatures: string[] } {
  let rawTimestamp: string | undefined;
  const signatures: string[] = [];
  for (const chunk of signatureHeader.split(",")) {
    const index = chunk.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = chunk.slice(0, index).trim();
    const value = chunk.slice(index + 1).trim();
    if (key === "t") {
      rawTimestamp = value;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }

  if (rawTimestamp === undefined || signatures.length === 0) {
    throw new WebhookSignatureError(
      `Заголовок ${SIGNATURE_HEADER} не разобран: ожидается 't=<unix>,v1=<hex>[,v1=<hex>]'`,
      "malformed_header",
    );
  }

  // `Number.parseInt` съедает хвост: из `t=1715461200abc` получалось бы
  // валидное число, и подделанный заголовок проходил бы разбор. Бэкенд
  // (`webhook_service.verify_signature`) и Python SDK требуют целое целиком —
  // требуем и мы, иначе один и тот же заголовок принимается не везде.
  if (!/^-?\d+$/.test(rawTimestamp)) {
    throw new WebhookSignatureError(
      `Заголовок ${SIGNATURE_HEADER} содержит нечисловой t`,
      "malformed_header",
    );
  }
  const timestamp = Number(rawTimestamp);
  if (!Number.isSafeInteger(timestamp)) {
    throw new WebhookSignatureError(
      `Заголовок ${SIGNATURE_HEADER} содержит нечисловой t`,
      "malformed_header",
    );
  }

  return { timestamp, signatures };
}

/**
 * Проверяет secret, заголовок, возраст и подпись — в этом порядке.
 *
 * Общая часть `verify` и `constructEvent`: порядок проверок у них обязан
 * совпадать, иначе один и тот же запрос отвергался бы по разным причинам.
 *
 * @throws {WebhookSignatureError} Первая же не прошедшая проверка.
 */
async function checkSignature(input: VerifyInput): Promise<void> {
  requireSecret(input.secret);
  const { timestamp, signatures } = parseHeader(input.signatureHeader);

  const maxAge = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  if (maxAge && Math.abs(Math.floor(Date.now() / 1000) - timestamp) > maxAge) {
    throw new WebhookSignatureError(`Подпись старше ${maxAge} с — возможен replay`, "too_old");
  }

  const expected = await sign({ body: input.body, secret: input.secret, timestamp });
  if (!matchesAny(expected, signatures)) {
    throw new WebhookSignatureError("Подпись не совпала", "signature_mismatch");
  }
}

/**
 * Проверяет подпись, не бросая исключений.
 *
 * Любая причина отказа — нечитаемый заголовок, пустой или битый secret,
 * устаревшая подпись — это `false`. В окне ротации secret достаточно, чтобы
 * совпала любая из подписей `v1`. Нужна причина отказа — берите
 * `constructEvent`, он кидает `WebhookSignatureError` с полем `reason`.
 */
export async function verify(input: VerifyInput): Promise<boolean> {
  try {
    await checkSignature(input);
    return true;
  } catch {
    // Сюда попадают и ошибки WebCrypto (например, `importKey` на пустом
    // секрете): контракт функции — не бросать, а отвечать false.
    return false;
  }
}

/**
 * Проверяет подпись и возвращает типизированное событие.
 *
 * Это рекомендуемый способ: тело нельзя разбирать раньше, чем проверена
 * подпись, иначе обработчик доверяет неаутентифицированным данным. Как и
 * `verify`, принимает заголовок с двумя подписями `v1` из окна ротации.
 *
 * @throws {WebhookSignatureError} Подпись не сошлась, устарела, secret пуст,
 * тело не является JSON-объектом или событие пришло не по контракту
 * (`reason` говорит, что именно).
 */
export async function constructEvent(input: VerifyInput): Promise<WebhookEvent> {
  await checkSignature(input);

  const text = typeof input.body === "string" ? input.body : new TextDecoder().decode(toBytes(input.body));

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new WebhookSignatureError("Тело вебхука не является JSON", "invalid_json");
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new WebhookSignatureError("Тело вебхука не является JSON-объектом", "invalid_json");
  }

  // Конверт проверяем полями, а не схемой: без этого `event.type` молча
  // приходил `undefined`, тогда как Python SDK на том же теле падал
  // ValidationError'ом. Оба теперь отвечают одинаково — `invalid_payload`.
  const envelope = payload as Record<string, unknown>;
  const missing = ["id", "type", "created_at"].filter(
    (field) => typeof envelope[field] !== "string",
  );
  if (typeof envelope["data"] !== "object" || envelope["data"] === null) {
    missing.push("data");
  }
  if (missing.length > 0) {
    throw new WebhookSignatureError(
      `Событие вебхука не по контракту: нет полей ${missing.join(", ")}`,
      "invalid_payload",
    );
  }

  return payload as WebhookEvent;
}
