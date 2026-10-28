/**
 * Типизированные ошибки поверх конверта ошибок MailInfra.
 *
 * API отдаёт любую ошибку одной формой (см. https://docs.mailinfra.ru/errors):
 *
 * ```json
 * {"error": {"code": "domain_not_verified", "message": "…", "details": {}},
 *  "request_id": "3d6f0dce…"}
 * ```
 *
 * `code` — стабильный машинный код, ветвить логику надо по нему, а не по
 * тексту сообщения. Классы подобраны так, чтобы ловить можно было на трёх
 * уровнях: всё (`MailInfraError`), категория статуса (`NotFoundError`) или
 * конкретная причина (`DomainNotVerifiedError`). Неизвестный код деградирует
 * до класса по статусу — новый код на бэкенде не ломает старый SDK.
 */

/** Безопасные структурированные детали ошибки (`error.details`). */
export type ErrorDetails = Record<string, unknown>;

/** Пер-полевая причина отказа валидации из `details.fields`. */
export interface ValidationField {
  field: string;
  message: string;
  code?: string;
}

export interface MailInfraErrorOptions {
  statusCode?: number | undefined;
  code?: string;
  details?: ErrorDetails;
  requestId?: string | undefined;
}

/** Базовая ошибка SDK. Ловите её, если детали не важны. */
export class MailInfraError extends Error {
  /** HTTP-статус ответа; `undefined` для сетевых ошибок. */
  readonly statusCode: number | undefined;
  /** Машинный код ошибки (`error.code`). */
  readonly code: string;
  /** Безопасные детали (`error.details`). */
  readonly details: ErrorDetails;
  /** Идентификатор запроса для поддержки (он же заголовок `X-Request-ID`). */
  readonly requestId: string | undefined;

  constructor(message: string, options: MailInfraErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.statusCode = options.statusCode;
    this.code = options.code ?? "unknown_error";
    this.details = options.details ?? {};
    this.requestId = options.requestId;
  }
}

// ---------- Транспортные ошибки (ответа от API не было) ----------

/** Не удалось получить ответ: DNS, TCP, TLS, обрыв соединения. */
export class APIConnectionError extends MailInfraError {
  constructor(
    message = "Не удалось соединиться с API MailInfra",
    cause?: unknown,
    code = "api_connection_error",
  ) {
    super(message, { code });
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** Запрос не успел уложиться в таймаут. */
export class APITimeoutError extends APIConnectionError {
  constructor(message = "Истёк таймаут запроса к API MailInfra", cause?: unknown) {
    // Код совпадает с Python SDK: ветвление по `code` обязано давать один и
    // тот же результат в обоих клиентах.
    super(message, cause, "api_timeout");
  }
}

// ---------- Ошибки по HTTP-статусу ----------

/** `400` — запрос некорректен. */
export class BadRequestError extends MailInfraError {}

/** `401` — API-ключ отсутствует, невалиден или отозван. */
export class AuthenticationError extends MailInfraError {}

/**
 * `403` — у ключа нет прав на операцию.
 *
 * Типичная причина: ключ выпущен с правами `READ_ONLY` (запрещена отправка)
 * или `SENDING_ONLY` (запрещено чтение).
 */
export class PermissionDeniedError extends MailInfraError {}

/** `404` — ресурс не найден или принадлежит другому проекту. */
export class NotFoundError extends MailInfraError {}

/** `409` — конфликт состояния. */
export class ConflictError extends MailInfraError {}

/** `422` — не прошла валидация полей. */
export class UnprocessableError extends MailInfraError {
  /** Пер-полевые причины отказа; пустой массив, если детализации нет. */
  get fields(): ValidationField[] {
    const raw = this.details["fields"];
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter((item): item is ValidationField => {
      if (typeof item !== "object" || item === null) {
        return false;
      }
      const candidate = item as Record<string, unknown>;
      return typeof candidate["field"] === "string" && typeof candidate["message"] === "string";
    });
  }
}

/** `429` — исчерпан лимит отправки: месячный объём или дневной потолок. */
export class RateLimitError extends MailInfraError {
  /** Секунды до безопасного повтора из заголовка `Retry-After`. */
  readonly retryAfter: number | undefined;

  constructor(
    message: string,
    options: MailInfraErrorOptions & { retryAfter?: number | undefined } = {},
  ) {
    super(message, { code: "rate_limit_exceeded", ...options });
    this.retryAfter = options.retryAfter;
  }
}

/** `5xx` — ошибка на стороне MailInfra. Такие запросы SDK ретраит сам. */
export class ServerError extends MailInfraError {}

// ---------- Ошибки по конкретному `error.code` ----------
//
// Базовый класс каждой — класс того HTTP-статуса, с которым бэкенд реально
// отдаёт код (см. `app.services.email_service`): `catch (UnprocessableError)`
// обязан ловить и `DomainNotVerifiedError`, иначе документированный приём
// «ловить по категории» молча пропускает половину ошибок отправки.

/** `422` — домен отправителя ещё не подтверждён (DNS-записи не сошлись). */
export class DomainNotVerifiedError extends UnprocessableError {}

/** `422` — домен не привязан к проекту, которому принадлежит ключ. */
export class DomainNotAttachedError extends UnprocessableError {}

/** `422` — все получатели в списке подавления, отправлять некому. */
export class AllRecipientsSuppressedError extends UnprocessableError {}

/** `422` — пробное письмо с sandbox-домена (LIVE-ключ) уходит только владельцу ключа. */
export class SandboxRecipientNotAllowedError extends UnprocessableError {}

/** `403` — пробная sandbox-отправка уже израсходована; нужен свой домен. */
export class SandboxTrialExhaustedError extends PermissionDeniedError {}

/**
 * `403` — API-ключ использован с IP-адреса вне его белого списка.
 *
 * Список задаётся у ключа в дашборде. Повтор с того же адреса не поможет —
 * нужен другой ключ или правка списка.
 */
export class IPNotAllowedError extends PermissionDeniedError {}

/**
 * `409` — письмо уже не запланировано: отправлено, отправляется или
 * отменено, поэтому `cancel()` и `reschedule()` к нему неприменимы.
 * Текущий статус письма — в `details.status`.
 */
export class EmailNotScheduledError extends ConflictError {}

/** `400` — `send_at` дальше 7 дней от приёма письма (`details.max_days`). */
export class SendAtTooFarError extends BadRequestError {}

/** `400` — `send_at` без часового пояса. */
export class SendAtInvalidError extends BadRequestError {}

/** `422` — шаблон не отрендерился. */
export class TemplateRenderError extends UnprocessableError {}

/** `422` — в `variables` не хватает переменной, которую требует шаблон. */
export class TemplateVariableMissingError extends UnprocessableError {}

/** `422` — попытка переопределить системный заголовок письма. */
export class ReservedEmailHeaderError extends UnprocessableError {}

/** `409` — запрос с таким `Idempotency-Key` ещё выполняется, повторите позже. */
export class IdempotencyInFlightError extends ConflictError {}

/**
 * `422` — не приняты обязательные юридические документы (политика, оферта,
 * DPA), отправка заблокирована до согласия владельца организации.
 * В `details.pending` — список документов, которые нужно принять.
 */
export class LegalDocumentsNotAcceptedError extends UnprocessableError {}

type ErrorConstructor = new (message: string, options: MailInfraErrorOptions) => MailInfraError;

const STATUS_ERRORS = new Map<number, ErrorConstructor>([
  [400, BadRequestError],
  [401, AuthenticationError],
  [403, PermissionDeniedError],
  [404, NotFoundError],
  [409, ConflictError],
  [422, UnprocessableError],
  [429, RateLimitError],
]);

// Коды, которые бэкенд кладёт в `details.code` при отказе отправки.
// Источник истины — места `raise` в `app.services.{email_service,
// template_service, idempotency, rate_limit, scheduled_email_service}` и
// `app.api.api_auth`: только они говорят, какой код реально выбрасывается и
// с каким статусом.
//
// Именно `Map`, а не объектный литерал: ключ приходит из тела ответа, то есть
// снаружи. У литерала `"toString" in CODE_ERRORS` истинно по цепочке
// прототипов, и `CODE_ERRORS["toString"]` отдаёт `Function.prototype.toString`
// — `new ErrorClass(...)` роняет TypeError мимо всей обработки ошибок, а
// `"constructor"` вообще возвращает не-Error. У `Map` своё пространство
// ключей, наследованных имён в нём нет.
const CODE_ERRORS = new Map<string, ErrorConstructor>([
  ["all_recipients_suppressed", AllRecipientsSuppressedError],
  ["domain_not_attached", DomainNotAttachedError],
  ["domain_not_verified", DomainNotVerifiedError],
  ["email_not_scheduled", EmailNotScheduledError],
  ["idempotency_in_flight", IdempotencyInFlightError],
  ["ip_not_allowed", IPNotAllowedError],
  ["legal_documents_not_accepted", LegalDocumentsNotAcceptedError],
  ["reserved_email_header", ReservedEmailHeaderError],
  ["rps_exceeded", RateLimitError],
  ["sandbox_recipient_not_allowed", SandboxRecipientNotAllowedError],
  ["sandbox_trial_exhausted", SandboxTrialExhaustedError],
  ["send_at_invalid", SendAtInvalidError],
  ["send_at_too_far", SendAtTooFarError],
  ["template_render_error", TemplateRenderError],
  ["template_variable_missing", TemplateVariableMissingError],
]);

function statusErrorClass(statusCode: number): ErrorConstructor {
  const known = STATUS_ERRORS.get(statusCode);
  if (known) {
    return known;
  }
  return statusCode >= 500 ? ServerError : MailInfraError;
}

export interface ErrorFromResponseInput {
  statusCode: number;
  /** Разобранное тело ответа; может быть строкой, если это не JSON. */
  body: unknown;
  requestId?: string | undefined;
  retryAfter?: number | undefined;
}

/**
 * Собирает исключение из ответа API.
 *
 * Устойчиво к не-JSON телу и к ответу не по контракту: тогда берётся класс по
 * статусу и общее сообщение — прокси и балансировщики умеют возвращать HTML.
 */
export function errorFromResponse(input: ErrorFromResponseInput): MailInfraError {
  const { statusCode, body, retryAfter } = input;
  let requestId = input.requestId;
  let code = "unknown_error";
  let message = `Запрос завершился со статусом ${statusCode}`;
  let details: ErrorDetails = {};

  if (typeof body === "object" && body !== null) {
    const envelope = (body as Record<string, unknown>)["error"];
    if (typeof envelope === "object" && envelope !== null) {
      const raw = envelope as Record<string, unknown>;
      if (typeof raw["code"] === "string" && raw["code"]) {
        code = raw["code"];
      }
      if (typeof raw["message"] === "string" && raw["message"]) {
        message = raw["message"];
      }
      if (typeof raw["details"] === "object" && raw["details"] !== null) {
        details = raw["details"] as ErrorDetails;
      }
    }
    const rawRequestId = (body as Record<string, unknown>)["request_id"];
    if (requestId === undefined && typeof rawRequestId === "string") {
      requestId = rawRequestId;
    }
  }

  // `details.code` уточняет причину внутри статуса (например, 429 →
  // `rps_exceeded`), поэтому он приоритетнее верхнеуровневого кода.
  const detailCode = details["code"];
  if (typeof detailCode === "string" && CODE_ERRORS.has(detailCode)) {
    code = detailCode;
  }

  const ErrorClass = CODE_ERRORS.get(code) ?? statusErrorClass(statusCode);

  if (ErrorClass === RateLimitError) {
    return new RateLimitError(message, { statusCode, code, details, requestId, retryAfter });
  }

  return new ErrorClass(message, { statusCode, code, details, requestId });
}
