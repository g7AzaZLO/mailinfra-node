/**
 * Ресурс писем: отправка, батч, отложенная отправка, чтение статусов и событий.
 *
 * Об идемпотентности. `POST /emails` и `POST /emails/batch` принимают
 * `Idempotency-Key`, и SDK ставит его сам: ключ генерируется один раз на
 * вызов и переиспользуется всеми повторами внутри этого вызова, поэтому
 * сетевой сбой или `503` не превращаются в два письма. Повторный вызов
 * `send()` или `sendBatch()` — новый ключ и новые письма. У батча ключ один
 * на весь запрос: бэкенд выводит из него ключ каждого письма, и повтор
 * не дублирует уже принятые письма, а отклонённые пробует принять заново.
 * Если ключа нет (`idempotencyKey: null`, `autoIdempotency: false`), запрос
 * помечается неидемпотентным: дедуплицировать повтор бэкенду нечем, и батч
 * без ключа повторяется только на `429` — единственном отказе, который
 * случается до приёма писем.
 */

import type { ApiResponse, MailInfra } from "../client.js";
import { MailInfraError } from "../errors.js";
import {
  BATCH_IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  MAX_ATTACHMENT_BASE64_LENGTH,
  MAX_ATTACHMENTS,
  MAX_BATCH_SIZE,
  MAX_CONTENT_ID_LENGTH,
  MAX_CONTENT_TYPE_LENGTH,
  MAX_FILENAME_LENGTH,
  MAX_FROM_NAME_LENGTH,
  MAX_METADATA_BYTES,
  MAX_METADATA_KEY_LENGTH,
  MAX_METADATA_KEYS,
  MAX_METADATA_VALUE_LENGTH,
  MAX_RECIPIENTS,
  MAX_REPLY_TO,
  MAX_SUBJECT_LENGTH,
  MAX_TAGS,
  MAX_TEMPLATE_LENGTH,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
} from "../limits.js";
import type {
  AttachmentInput,
  BatchSendResponseData,
  CallOptions,
  EmailAttachmentInput,
  EmailDetail,
  EmailEvent,
  EmailListItem,
  EmailListPage,
  EmailRescheduleRequest,
  EmailScheduleData,
  EmailSendRequest,
  EmailSendResponseData,
  IdempotencyResult,
  ListEmailsParams,
  RescheduleEmailParams,
  SendBatchResult,
  SendEmailParams,
  SendEmailResult,
  SendOptions,
} from "../types.js";

const EMAILS_PATH = "/emails";
const BATCH_PATH = "/emails/batch";

const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
const IDEMPOTENT_REPLAYED_HEADER = "Idempotent-Replayed";

/**
 * Поля, которые принимает письмо — в `send()` и элементе батча.
 *
 * Набор тот же, что в `BATCH_ITEM_KEYS` у PHP SDK. Нужен потому, что
 * бэкенд лишние поля молча игнорирует (`APIModel` без `extra=`, то есть
 * pydantic по умолчанию `ignore`): опечатка в имени параметра не дала бы
 * ни ошибки, ни эффекта.
 */
const BATCH_ITEM_KEYS = new Set([
  "from",
  "from_name",
  "to",
  "cc",
  "bcc",
  "reply_to",
  "subject",
  "html",
  "text",
  "headers",
  "tags",
  "metadata",
  "template",
  "variables",
  "attachments",
  "send_at",
  "ttl",
]);

/** Ключ `metadata` — тот же формат, что `_KEY_RE` в `app.services.email_metadata`. */
const METADATA_KEY_RE = new RegExp(`^[A-Za-z0-9_.-]{1,${MAX_METADATA_KEY_LENGTH}}$`);

/**
 * Время с часовым поясом в конце: `Z` или смещение `±HH:MM` (`±HHMM`, `±HH`).
 *
 * Это не разбор ISO 8601 целиком — его делает бэкенд, — а ловушка для самой
 * частой ошибки: локального времени без пояса, которое API отклоняет.
 */
const ZONED_TIME_RE = /[Tt ]\d{2}:\d{2}.*(?:[Zz]|[+-]\d{2}(?::?\d{2})?)$/;

/** Ошибка клиентской валидации — того же класса, что и ответы API. */
function invalidRequest(message: string, code = "invalid_request"): MailInfraError {
  return new MailInfraError(message, { code });
}

/** Проверяет ограничение на число элементов. */
function checkCount(field: string, actual: number, limit: number): void {
  if (actual > limit) {
    throw invalidRequest(
      `В поле ${field} ${actual} значений при лимите ${limit} — API отклонит такой запрос с 422`,
    );
  }
}

/**
 * Проверяет ограничение на длину строки.
 *
 * Считаем кодовые точки, а не `.length`: тело запроса уезжает JSON-ом и
 * разбирается как Unicode, поэтому лимит спеки символьный. У `.length`
 * единицы UTF-16, и тема из эмодзи отбраковывалась бы вдвое раньше срока.
 */
function checkLength(field: string, value: unknown, limit: number, code?: string): void {
  if (typeof value !== "string") {
    return;
  }
  const length = [...value].length;
  if (length > limit) {
    throw invalidRequest(
      `Поле ${field} длиной ${length} символов при лимите ${limit} — API отклонит такой запрос с 422`,
      code,
    );
  }
}

/**
 * Размер `metadata` так, как его меряет бэкенд: `json.dumps(…, ensure_ascii=False)`
 * в UTF-8.
 *
 * Python ставит пробел после каждого `:` и `,`, а `JSON.stringify` — нет,
 * поэтому к компактной записи добавляется по байту на разделитель. Без этого
 * объект у самой границы проходил бы здесь и получал 422 на бэкенде.
 */
function metadataBytes(metadata: Record<string, string>): number {
  const keys = Object.keys(metadata).length;
  const separators = keys === 0 ? 0 : keys * 2 - 1;
  return new TextEncoder().encode(JSON.stringify(metadata)).length + separators;
}

/**
 * Проверяет `metadata` теми же правилами и в том же порядке, что
 * `normalize_metadata` бэкенда: число ключей, формат ключа, тип, длина и NUL
 * в значении, затем размер всего объекта.
 */
function checkMetadata(metadata: unknown): void {
  if (metadata === undefined) {
    return;
  }
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw invalidRequest("Поле metadata должно быть объектом «ключ — строка»");
  }
  const entries = Object.entries(metadata as Record<string, unknown>);
  checkCount("metadata", entries.length, MAX_METADATA_KEYS);

  for (const [key, value] of entries) {
    if (!METADATA_KEY_RE.test(key)) {
      throw invalidRequest(
        `Ключ metadata ${JSON.stringify(key)}: от 1 до ${MAX_METADATA_KEY_LENGTH} символов — ` +
          "латиница, цифры, «_», «-» и «.»",
      );
    }
    if (typeof value !== "string") {
      throw invalidRequest(`Значение metadata.${key} должно быть строкой, а передано ${typeof value}`);
    }
    checkLength(`metadata.${key}`, value, MAX_METADATA_VALUE_LENGTH);
    if (value.includes("\0")) {
      throw invalidRequest(`Значение metadata.${key} содержит символ NUL — API его не принимает`);
    }
  }

  const size = metadataBytes(metadata as Record<string, string>);
  if (size > MAX_METADATA_BYTES) {
    throw invalidRequest(
      `Поле metadata занимает ${size} байт JSON при лимите ${MAX_METADATA_BYTES} — ` +
        "API отклонит такой запрос с 422",
    );
  }
}

/** Проверяет `ttl`: целое число секунд от минуты до суток. */
function checkTtl(ttl: unknown): void {
  if (ttl === undefined || ttl === null) {
    return;
  }
  if (
    typeof ttl !== "number" ||
    !Number.isInteger(ttl) ||
    ttl < MIN_TTL_SECONDS ||
    ttl > MAX_TTL_SECONDS
  ) {
    throw invalidRequest(
      `Поле ttl — целое число секунд от ${MIN_TTL_SECONDS} до ${MAX_TTL_SECONDS}, а передано ` +
        `${String(ttl)} — API отклонит такой запрос с 422`,
    );
  }
}

/**
 * Время отправки в виде для API.
 *
 * `Date` уходит через `toISOString()` — в UTC, с `Z`, поэтому часовой пояс
 * у него есть всегда. Строка уходит как есть, но без пояса не уходит вовсе:
 * API такую отклоняет, а угадывать пояс за вызывающего SDK не берётся.
 */
function sendAtValue(value: string | Date): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw invalidRequest("Поле send_at — Invalid Date");
    }
    return value.toISOString();
  }
  if (!ZONED_TIME_RE.test(value)) {
    throw invalidRequest(
      `Поле send_at ${JSON.stringify(value)} без часового пояса: нужен ISO 8601 со смещением, ` +
        "например 2026-11-01T09:00:00+03:00, или Date",
    );
  }
  return value;
}

function asList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? [value] : value;
}

function toBase64(content: Uint8Array | ArrayBuffer | string): string {
  const bytes =
    typeof content === "string"
      ? new TextEncoder().encode(content)
      : content instanceof Uint8Array
        ? content
        : new Uint8Array(content);

  // btoa есть во всех целевых рантаймах (Node >= 16, Workers, Deno, Bun) и,
  // в отличие от Buffer, не тянет node-only API. Собираем строку чанками:
  // на вложении в 10 МиБ побайтовая конкатенация занимала ~720 мс, чанками —
  // ~380 мс (замер на Node 24). Это всё равно синхронный CPU, и всё это время
  // рантайм не обслуживает ничего другого, так что режем что можем.
  // Размер чанка держим ниже лимита аргументов `apply`/spread.
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + CHUNK)));
  }
  return btoa(parts.join(""));
}

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

function attachmentPayload(index: number, item: AttachmentInput): EmailAttachmentInput {
  const content_type = item.content_type ?? DEFAULT_CONTENT_TYPE;
  const { filename, content_id } = item;

  if (typeof filename !== "string" || filename === "") {
    throw invalidRequest(`Вложение #${index} без filename`, "invalid_attachment");
  }
  checkLength(`attachments[${index}].filename`, filename, MAX_FILENAME_LENGTH, "invalid_attachment");
  checkLength(
    `attachments[${index}].content_type`,
    content_type,
    MAX_CONTENT_TYPE_LENGTH,
    "invalid_attachment",
  );
  checkLength(
    `attachments[${index}].content_id`,
    content_id,
    MAX_CONTENT_ID_LENGTH,
    "invalid_attachment",
  );

  // Типы это запрещают, но из JS сюда прилетает что угодно, а
  // `new Uint8Array(undefined)` даёт пустой массив — письмо ушло бы с пустым
  // вложением вместо явной ошибки. Читаем через отдельную переменную: сужение
  // самого `item` схлопнуло бы union до `never`.
  const content: Uint8Array | ArrayBuffer | string | undefined | null = item.content;
  const hasBase64 = typeof item.content_base64 === "string";
  const hasContent = content !== undefined && content !== null;

  if (hasBase64 && hasContent) {
    throw invalidRequest(
      `Вложению ${filename} нужно ровно одно из content (байты/строка) или content_base64`,
      "invalid_attachment",
    );
  }
  if (!hasBase64 && !hasContent) {
    throw invalidRequest(
      `Вложению ${filename} нужен content (байты/строка) или content_base64`,
      "invalid_attachment",
    );
  }

  const content_base64 = hasBase64
    ? (item.content_base64 as string)
    : toBase64(content as Uint8Array | ArrayBuffer | string);

  // Письмо с вложениями весит до ~25 МиБ. Отправить их в сеть, чтобы
  // получить 422, — худший из возможных вариантов.
  if (content_base64.length > MAX_ATTACHMENT_BASE64_LENGTH) {
    throw invalidRequest(
      `Вложение ${filename} занимает ${content_base64.length} символов base64 при лимите ` +
        `${MAX_ATTACHMENT_BASE64_LENGTH} — API отклонит такой запрос с 422`,
      "invalid_attachment",
    );
  }

  return {
    filename,
    content_base64,
    content_type,
    ...(content_id === undefined || content_id === null ? {} : { content_id }),
  };
}

/**
 * Собирает и проверяет тело запроса на отправку.
 *
 * Лимиты спеки (50 получателей, 10 тегов, 998 символов темы, размер
 * вложения, `metadata`, диапазон `ttl`) проверяются до сетевого вызова — так
 * же, как в Python, Go и PHP SDK. Ошибка приходит как `MailInfraError` с
 * кодом `invalid_request` или `invalid_attachment`. `send_at` типа `Date`
 * уходит строкой ISO 8601 в UTC.
 *
 * Пустые значения не отправляем: `"html": null` бэкенд принял бы, но шум в
 * логах ни к чему.
 */
export function buildSendPayload(params: SendEmailParams): EmailSendRequest {
  const { to, cc, bcc, reply_to: replyTo, attachments, send_at: sendAt, ...rest } = params;

  const toList = asList(to);
  const ccList = asList(cc);
  const bccList = asList(bcc);
  const replyToList = asList(replyTo);

  if (typeof rest.from !== "string" || rest.from === "") {
    throw invalidRequest("Не задан from: адрес отправителя обязателен");
  }
  if (toList === undefined || toList.length === 0) {
    throw invalidRequest("Не задан to: нужен хотя бы один получатель");
  }

  checkCount("to", toList.length, MAX_RECIPIENTS);
  checkCount("cc", ccList?.length ?? 0, MAX_RECIPIENTS);
  checkCount("bcc", bccList?.length ?? 0, MAX_RECIPIENTS);
  checkCount("reply_to", replyToList?.length ?? 0, MAX_REPLY_TO);
  checkCount("tags", rest.tags?.length ?? 0, MAX_TAGS);
  checkCount("attachments", attachments?.length ?? 0, MAX_ATTACHMENTS);

  checkLength("subject", rest.subject, MAX_SUBJECT_LENGTH);
  checkLength("from_name", rest.from_name, MAX_FROM_NAME_LENGTH);
  checkLength("template", rest.template, MAX_TEMPLATE_LENGTH);
  checkMetadata(rest.metadata);
  checkTtl(rest.ttl);

  const payload: Record<string, unknown> = { ...rest, to: toList };
  const optional: Record<string, unknown> = {
    cc: ccList,
    bcc: bccList,
    reply_to: replyToList,
    attachments: attachments?.map((item, index) => attachmentPayload(index, item)),
    // `null` уходит как есть: спека его допускает и значит «отправить сразу».
    send_at: sendAt === undefined || sendAt === null ? sendAt : sendAtValue(sendAt),
  };

  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) {
      payload[key] = value;
    }
  }
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) {
      delete payload[key];
    }
  }

  return payload as EmailSendRequest;
}

/**
 * Проверяет и собирает одно письмо батча.
 *
 * Ключ идемпотентности внутри письма отбивается отдельно: бэкенд лишние поля
 * игнорирует молча, и письмо ушло бы без защиты от дублей и без единой
 * ошибки. Ключ у батча один на весь запрос и задаётся в опциях.
 */
function batchItemPayload(item: SendEmailParams, index: number): EmailSendRequest {
  for (const key of Object.keys(item)) {
    if (key === "idempotencyKey" || key === "idempotency_key") {
      throw invalidRequest(
        `Письмо #${index} в батче задаёт ${key}, а ключ идемпотентности у батча один на весь ` +
          "запрос: передайте его в опциях — sendBatch(emails, { idempotencyKey }).",
        "invalid_batch_item",
      );
    }
    if (!BATCH_ITEM_KEYS.has(key)) {
      throw invalidRequest(
        `Письмо #${index} в батче содержит неизвестный параметр ${key}`,
        "invalid_batch_item",
      );
    }
  }
  return buildSendPayload(item);
}

function listQuery(params: ListEmailsParams): Record<string, string | number | undefined> {
  const moment = (value: string | Date | undefined): string | undefined => {
    if (value === undefined) {
      return undefined;
    }
    return value instanceof Date ? value.toISOString() : value;
  };

  return {
    status: params.status,
    from_email: params.from_email,
    to_email: params.to_email,
    tag: params.tag,
    from: moment(params.from),
    to: moment(params.to),
    limit: params.limit,
    cursor: params.cursor,
  };
}

/**
 * Собирает страницу из ответа `GET /emails`.
 *
 * `has_more: true` без курсора — ответ не по контракту: обход `listAll()`
 * молча оборвался бы на этой странице, поэтому это ошибка, а не конец списка.
 */
function listPage(response: ApiResponse<EmailListItem[]>): EmailListPage {
  const { has_more: hasMore, next_cursor: nextCursor } = response.envelope;
  const page: EmailListPage = {
    data: response.data,
    has_more: hasMore === true,
    next_cursor: typeof nextCursor === "string" && nextCursor !== "" ? nextCursor : null,
  };
  if (page.has_more && page.next_cursor === null) {
    throw new MailInfraError("Ответ API не по контракту: has_more без next_cursor", {
      statusCode: response.status,
      code: "malformed_response",
      requestId: response.requestId,
    });
  }
  return page;
}

/**
 * Сведения об идемпотентности из ответа отправки.
 *
 * Повтор бэкенд отмечает статусом `200` вместо `202` и заголовком
 * `Idempotent-Replayed` — достаточно любого из двух.
 */
function idempotencyResult(
  response: ApiResponse<unknown>,
  idempotencyKey: string | undefined,
): IdempotencyResult {
  const replayed =
    response.status === 200 ||
    response.headers.get(IDEMPOTENT_REPLAYED_HEADER)?.toLowerCase() === "true";
  return {
    replayed,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
  };
}

/** Сигнал отмены вызова в виде опции запроса — только если он задан. */
function signalOption(options: CallOptions): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

/** Путь письма; пустой id ушёл бы в `/emails/` — на совсем другой эндпоинт. */
function emailPath(emailId: string, suffix = ""): string {
  if (typeof emailId !== "string" || emailId === "") {
    throw invalidRequest("Не задан emailId: нужен идентификатор письма");
  }
  return `${EMAILS_PATH}/${encodeURIComponent(emailId)}${suffix}`;
}

/** Письма проекта. Доступен как `client.emails`. */
export class EmailsResource {
  constructor(private readonly client: MailInfra) {}

  /**
   * Отправляет письмо — сразу или по `send_at`.
   *
   * @returns Идентификатор, статус (`SCHEDULED` у отложенного письма),
   * пропущенные получатели, флаг идемпотентного повтора и использованный
   * ключ идемпотентности.
   * @throws {MailInfraError} Ошибка API или транспорта.
   */
  async send(params: SendEmailParams, options: SendOptions = {}): Promise<SendEmailResult> {
    // Тот же набор, что у элемента батча: бэкенд лишнее молча игнорирует, и
    // `idempotencyKey` в params вместо опций уходил в никуда (аудит S1-25).
    for (const key of Object.keys(params)) {
      if (!BATCH_ITEM_KEYS.has(key)) {
        const hint = key === "idempotencyKey" ? " — ключ идемпотентности передаётся в опциях" : "";
        throw invalidRequest(`Неизвестный параметр письма ${key}${hint}`, "invalid_request");
      }
    }
    const idempotencyKey = this.resolveIdempotencyKey(
      options.idempotencyKey,
      IDEMPOTENCY_KEY_MAX_LENGTH,
    );
    return this.postIdempotent<EmailSendResponseData>(
      EMAILS_PATH,
      buildSendPayload(params),
      idempotencyKey,
      options,
    );
  }

  /**
   * Отправляет до 100 писем одним запросом.
   *
   * Батч возвращает `202`, даже если часть писем не принята: проверяйте
   * `error` у каждого элемента `results`, а не только статус ответа.
   * `Idempotency-Key` ставится на весь батч так же, как у `send()`, поэтому
   * повтор после сбоя не дублирует уже принятые письма.
   *
   * @returns Результаты по каждому письму, счётчики, флаг `replayed` (повтором
   * оказались все принятые письма) и использованный ключ идемпотентности.
   * @throws {MailInfraError} Ошибка API, транспорта, пустой список или
   *   элемент с неизвестным параметром.
   */
  async sendBatch(
    emails: SendEmailParams[],
    options: SendOptions = {},
  ): Promise<SendBatchResult> {
    if (emails.length === 0) {
      throw new MailInfraError("Пустой батч: передайте хотя бы одно письмо", {
        code: "empty_batch",
      });
    }
    if (emails.length > MAX_BATCH_SIZE) {
      throw new MailInfraError(
        `В батче ${emails.length} писем, а API принимает не больше ${MAX_BATCH_SIZE} за раз`,
        { code: "batch_too_large" },
      );
    }

    const idempotencyKey = this.resolveIdempotencyKey(
      options.idempotencyKey,
      BATCH_IDEMPOTENCY_KEY_MAX_LENGTH,
    );
    return this.postIdempotent<BatchSendResponseData>(
      BATCH_PATH,
      { emails: emails.map(batchItemPayload) },
      idempotencyKey,
      options,
    );
  }

  /** Возвращает письмо с телом, заголовками и диагностикой доставки. */
  async get(emailId: string, options: CallOptions = {}): Promise<EmailDetail> {
    const response = await this.client.request<EmailDetail>({
      method: "GET",
      path: emailPath(emailId),
      ...signalOption(options),
    });
    return response.data;
  }

  /**
   * Возвращает одну страницу писем по фильтрам, новые сначала.
   *
   * Следующая страница — тот же вызов с `cursor: page.next_cursor`, пока
   * `has_more` истинно. Обойти все страницы сразу — `listAll()`.
   *
   * @throws {MailInfraError} Ошибка API, транспорта или ответ не по контракту.
   */
  async list(params: ListEmailsParams = {}, options: CallOptions = {}): Promise<EmailListPage> {
    const response = await this.client.request<EmailListItem[]>({
      method: "GET",
      path: EMAILS_PATH,
      query: listQuery(params),
      ...signalOption(options),
    });
    return listPage(response);
  }

  /**
   * Обходит все письма по фильтрам, следуя за `next_cursor`, пока страницы
   * не кончатся.
   *
   * ```ts
   * for await (const email of client.emails.listAll({ status: "BOUNCED" })) {
   *   console.log(email.id, email.to_emails);
   * }
   * ```
   *
   * Страницы запрашиваются лениво, по мере обхода: `break` останавливает
   * загрузку. `limit` — размер одной страницы, а не всей выборки; `cursor`
   * продолжает обход с указанной страницы.
   *
   * @throws {MailInfraError} Ошибка API или транспорта на любой из страниц.
   */
  async *listAll(
    params: ListEmailsParams = {},
    options: CallOptions = {},
  ): AsyncIterableIterator<EmailListItem> {
    let cursor = params.cursor;
    do {
      const page = await this.list({ ...params, cursor }, options);
      yield* page.data;
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor !== undefined);
  }

  /** Возвращает события письма в хронологическом порядке. */
  async events(emailId: string, options: CallOptions = {}): Promise<EmailEvent[]> {
    const response = await this.client.request<EmailEvent[]>({
      method: "GET",
      path: emailPath(emailId, "/events"),
      ...signalOption(options),
    });
    return response.data;
  }

  /**
   * Отменяет запланированное письмо; резерв квоты возвращается.
   *
   * Повтор после сбоя безопасен, но если до сервера дошла и первая попытка,
   * повтор ответит `EmailNotScheduledError` с `details.status === "CANCELED"`.
   *
   * @returns Письмо в статусе `CANCELED`.
   * @throws {EmailNotScheduledError} Письмо уже не запланировано: отправлено,
   *   отправляется или отменено.
   * @throws {MailInfraError} Другая ошибка API или транспорта.
   */
  async cancel(emailId: string, options: CallOptions = {}): Promise<EmailScheduleData> {
    const response = await this.client.request<EmailScheduleData>({
      method: "POST",
      path: emailPath(emailId, "/cancel"),
      ...signalOption(options),
    });
    return response.data;
  }

  /**
   * Переносит запланированное письмо на новое время.
   *
   * ```ts
   * await client.emails.reschedule(id, { send_at: new Date(Date.now() + 3_600_000) });
   * ```
   *
   * Время в прошлом — отправить сейчас.
   *
   * @returns Письмо с новым `scheduled_at`.
   * @throws {SendAtTooFarError} `send_at` дальше 7 дней от приёма письма.
   * @throws {EmailNotScheduledError} Письмо уже не запланировано.
   * @throws {MailInfraError} Не задан `send_at`, он без часового пояса, или
   *   другая ошибка API либо транспорта.
   */
  async reschedule(
    emailId: string,
    params: RescheduleEmailParams,
    options: CallOptions = {},
  ): Promise<EmailScheduleData> {
    // Тело собирается из одного `send_at`: опечатка в имени (`sendAt`) не
    // уходит молча на бэкенд, который лишнее игнорирует, а даёт ошибку здесь.
    const sendAt: unknown = params.send_at;
    if (typeof sendAt !== "string" && !(sendAt instanceof Date)) {
      throw invalidRequest("Не задан send_at: нужна строка ISO 8601 с часовым поясом или Date");
    }
    const body: EmailRescheduleRequest = { send_at: sendAtValue(sendAt) };
    const response = await this.client.request<EmailScheduleData>({
      method: "PATCH",
      path: emailPath(emailId),
      body,
      ...signalOption(options),
    });
    return response.data;
  }

  /**
   * Отправляет `POST` с `Idempotency-Key`, если он есть, и дополняет ответ
   * сведениями об идемпотентности.
   */
  private async postIdempotent<T extends object>(
    path: string,
    body: unknown,
    idempotencyKey: string | undefined,
    options: CallOptions,
  ): Promise<T & IdempotencyResult> {
    const response = await this.client.request<T>({
      method: "POST",
      path,
      body,
      // Без `Idempotency-Key` бэкенду нечем распознать повтор
      // (`email_service.send_email` дедуплицирует только по ключу), поэтому
      // такой запрос неидемпотентен: повтор после `5xx` создал бы второе письмо.
      idempotent: idempotencyKey !== undefined,
      ...signalOption(options),
      ...(idempotencyKey === undefined
        ? {}
        : { headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } }),
    });
    return { ...response.data, ...idempotencyResult(response, idempotencyKey) };
  }

  private resolveIdempotencyKey(
    provided: string | null | undefined,
    maxLength: number,
  ): string | undefined {
    if (provided === null) {
      return undefined;
    }
    if (provided === undefined) {
      return this.client.autoIdempotency ? crypto.randomUUID() : undefined;
    }

    // Пустой ключ бэкенд не видит: дедупликация в `email_service.send_email`
    // стоит под `if payload.idempotency_key:`, и пустая строка туда не
    // проходит. Молча отправить такой запрос нельзя — он помечается
    // идемпотентным, повторяется после `5xx` и создаёт второе письмо.
    // Осознанная отправка без ключа — это `idempotencyKey: null`.
    if (provided.trim() === "") {
      throw new MailInfraError(
        "Пустой Idempotency-Key: бэкенд его игнорирует, а повтор после 5xx создал бы второе " +
          "письмо. Передайте непустой ключ или idempotencyKey: null, чтобы отправить без него.",
        { code: "invalid_idempotency_key" },
      );
    }
    // Значение заголовка уходит байтами, а бэкенд читает их как latin-1:
    // 255 кириллических символов приезжают как 510 и получают 422. До этого
    // дело даже не доходит — `Headers.set` бросает TypeError на любом
    // символе вне Latin-1 (в Python SDK httpx падает UnicodeEncodeError), а
    // голое исключение из транспорта пролетело бы мимо catch на
    // `MailInfraError`. Управляющие символы отбиваем заодно: CR и LF в
    // значении заголовка — это инъекция заголовков.
    if (!/^[\x20-\x7e]*$/.test(provided)) {
      throw new MailInfraError(
        "Idempotency-Key должен состоять из печатаемых ASCII-символов: значение заголовка " +
          "уходит байтами, и бэкенд читает его как latin-1 — кириллица и эмодзи до него не доедут.",
        { code: "invalid_idempotency_key" },
      );
    }
    if (provided.length > maxLength) {
      // Ошибка того же класса, что и остальные: README учит ловить
      // `MailInfraError`, и голый Error пролетал бы мимо такого catch.
      throw new MailInfraError(
        `Idempotency-Key длиннее ${maxLength} символов — API отклонит такой запрос с 422`,
        { code: "invalid_idempotency_key" },
      );
    }
    return provided;
  }
}
