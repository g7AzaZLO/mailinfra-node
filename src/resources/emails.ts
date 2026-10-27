/**
 * Ресурс писем: отправка, батч, чтение статусов и событий.
 *
 * Об идемпотентности. `POST /emails` принимает `Idempotency-Key`, и SDK
 * ставит его сам: ключ генерируется один раз на вызов и переиспользуется
 * всеми повторами внутри этого вызова, поэтому сетевой сбой или `503` не
 * превращаются в два письма. Повторный вызов `send()` — новый ключ и новое
 * письмо. Если ключа нет (`idempotencyKey: null`, `autoIdempotency: false`),
 * запрос помечается неидемпотентным: дедуплицировать повтор бэкенду нечем.
 * `POST /emails/batch` заголовок не принимает (бэкенд коммитит письма батча
 * по одному), поэтому он неидемпотентен всегда и повторяется только на `429` —
 * единственном отказе, который случается до приёма писем.
 */

import type { ApiResponse, MailInfra } from "../client.js";
import { MailInfraError } from "../errors.js";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
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
} from "../limits.js";
import type {
  AttachmentInput,
  BatchSendResponseData,
  CallOptions,
  EmailAttachmentInput,
  EmailDetail,
  EmailEvent,
  EmailListItem,
  EmailSendRequest,
  EmailSendResponseData,
  ListEmailsParams,
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
  "template",
  "variables",
  "attachments",
]);

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
  const { filename } = item;

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

  return { filename, content_base64, content_type };
}

/**
 * Собирает и проверяет тело запроса на отправку.
 *
 * Лимиты спеки (50 получателей, 10 тегов, 998 символов темы, размер
 * вложения) проверяются до сетевого вызова — так же, как в Python, Go и PHP
 * SDK. Ошибка приходит как `MailInfraError` с кодом `invalid_request` или
 * `invalid_attachment`.
 *
 * Пустые значения не отправляем: `"html": null` бэкенд принял бы, но шум в
 * логах ни к чему.
 */
export function buildSendPayload(params: SendEmailParams): EmailSendRequest {
  const { to, cc, bcc, reply_to: replyTo, attachments, ...rest } = params;

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

  const payload: Record<string, unknown> = { ...rest, to: toList };
  const optional: Record<string, unknown> = {
    cc: ccList,
    bcc: bccList,
    reply_to: replyToList,
    attachments: attachments?.map((item, index) => attachmentPayload(index, item)),
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
  };
}

/** Письма проекта. Доступен как `client.emails`. */
export class EmailsResource {
  constructor(private readonly client: MailInfra) {}

  /**
   * Отправляет письмо.
   *
   * @returns Идентификатор, статус, пропущенные получатели, флаг
   * идемпотентного повтора и использованный ключ идемпотентности.
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
    const idempotencyKey = this.resolveIdempotencyKey(options.idempotencyKey);
    const response: ApiResponse<EmailSendResponseData> = await this.client.request({
      method: "POST",
      path: EMAILS_PATH,
      body: buildSendPayload(params),
      // Без `Idempotency-Key` бэкенду нечем распознать повтор
      // (`email_service.send_email` дедуплицирует только по ключу), поэтому
      // такой запрос неидемпотентен: повтор после `5xx` создал бы второе письмо.
      idempotent: idempotencyKey !== undefined,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(idempotencyKey === undefined
        ? {}
        : { headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } }),
    });

    const replayed =
      response.status === 200 ||
      response.headers.get(IDEMPOTENT_REPLAYED_HEADER)?.toLowerCase() === "true";

    return {
      ...response.data,
      replayed,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
    };
  }

  /**
   * Отправляет до 100 писем одним запросом.
   *
   * Батч возвращает `202`, даже если часть писем не принята: проверяйте
   * `error` у каждого элемента `results`, а не только статус ответа.
   *
   * @throws {MailInfraError} Ошибка API, транспорта, пустой список или
   *   элемент с неизвестным параметром.
   */
  async sendBatch(
    emails: SendEmailParams[],
    options: CallOptions = {},
  ): Promise<BatchSendResponseData> {
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

    const payloads = emails.map((item, index) => {
      for (const key of Object.keys(item)) {
        // Эндпоинт батча заголовок Idempotency-Key не принимает вовсе, и
        // тихо выбросить ключ нельзя: он ровно для защиты от дублей и
        // добавлен. Типы кладут его в SendOptions, но из JS он приходит
        // внутри письма, а бэкенд лишние поля игнорирует молча — письмо
        // ушло бы без защиты от дублей и без единой ошибки.
        if (key === "idempotencyKey" || key === "idempotency_key") {
          throw invalidRequest(
            `Письмо #${index} в батче задаёт ${key}, а POST /emails/batch этот заголовок не ` +
              "принимает — бэкенд коммитит письма батча по одному. Отправляйте такие письма " +
              "через send().",
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
    });

    const response = await this.client.request<BatchSendResponseData>({
      method: "POST",
      path: BATCH_PATH,
      body: { emails: payloads },
      idempotent: false,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return response.data;
  }

  /** Возвращает письмо с телом, заголовками и диагностикой доставки. */
  async get(emailId: string, options: CallOptions = {}): Promise<EmailDetail> {
    const response = await this.client.request<EmailDetail>({
      method: "GET",
      path: `${EMAILS_PATH}/${encodeURIComponent(emailId)}`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return response.data;
  }

  /** Возвращает письма проекта по фильтрам. */
  async list(
    params: ListEmailsParams = {},
    options: CallOptions = {},
  ): Promise<EmailListItem[]> {
    const response = await this.client.request<EmailListItem[]>({
      method: "GET",
      path: EMAILS_PATH,
      query: listQuery(params),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return response.data;
  }

  /** Возвращает события письма в хронологическом порядке. */
  async events(emailId: string, options: CallOptions = {}): Promise<EmailEvent[]> {
    const response = await this.client.request<EmailEvent[]>({
      method: "GET",
      path: `${EMAILS_PATH}/${encodeURIComponent(emailId)}/events`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return response.data;
  }

  private resolveIdempotencyKey(provided: string | null | undefined): string | undefined {
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
    if (provided.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      // Ошибка того же класса, что и остальные: README учит ловить
      // `MailInfraError`, и голый Error пролетал бы мимо такого catch.
      throw new MailInfraError(
        `Idempotency-Key длиннее ${IDEMPOTENCY_KEY_MAX_LENGTH} символов — API отклонит такой запрос с 422`,
        { code: "invalid_idempotency_key" },
      );
    }
    return provided;
  }
}
