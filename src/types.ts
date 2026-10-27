/**
 * Публичные типы SDK.
 *
 * Всё, что описано OpenAPI-спекой, берётся из `generated/openapi.d.ts` —
 * интерфейсы руками не дублируются, поэтому изменение API не может
 * незаметно разойтись с типами SDK. Здесь только псевдонимы с человеческими
 * именами и те удобства, которых в спеке нет: получатель одной строкой,
 * вложение сырыми байтами, флаг идемпотентного повтора.
 *
 * Имена полей письма совпадают с API один в один (`from`, `reply_to`,
 * `content_base64`) — чтобы примеры из документации MailInfra работали в
 * SDK без переименований.
 */

import type { components } from "./generated/openapi.js";

type Schemas = components["schemas"];

/** Тело запроса на отправку, как его описывает спека. */
export type EmailSendRequest = Schemas["EmailSendRequest"];

/** Вложение в виде, который принимает API (base64). */
export type EmailAttachmentInput = Schemas["EmailAttachmentInput"];

/** Данные успешной отправки. */
export type EmailSendResponseData = Schemas["EmailSendResponseData"];

/** Письмо в списке. */
export type EmailListItem = Schemas["EmailListItem"];

/** Письмо с телом, заголовками и диагностикой доставки. */
export type EmailDetail = Schemas["EmailDetail"];

/** Событие жизненного цикла письма. */
export type EmailEvent = Schemas["EmailEventPublic"];

/** Результат пакетной отправки. */
export type BatchSendResponseData = Schemas["BatchSendResponseData"];

/** Результат одного письма внутри батча. */
export type BatchSendResult = Schemas["BatchSendResult"];

/** Ошибка одного письма внутри батча. */
export type BatchSendError = Schemas["BatchSendError"];

/** Статус письма. */
export type EmailStatus = Schemas["EmailStatus"];

/** Тип события письма. */
export type EmailEventType = Schemas["EmailEventType"];

/** Транспорт, через который письмо попало в отправку. */
export type EmailSource = Schemas["EmailSource"];

/** Категория недоставки. */
export type BounceCategory = Schemas["BounceCategory"];

/** Тип недоставки: постоянная или временная. */
export type BounceType = Schemas["BounceType"];

/** Причина попадания адреса в список подавления. */
export type SuppressionReason = Schemas["SuppressionReason"];

/** Конверт ошибки API. */
export type ErrorResponse = Schemas["ErrorResponse"];

/**
 * Вложение: либо сырые байты (SDK сам закодирует в base64), либо готовая
 * base64-строка.
 *
 * `content_type` здесь необязателен, в отличие от `EmailAttachmentInput`:
 * в спеке у него есть значение по умолчанию, поэтому openapi-typescript
 * помечает поле обязательным, а подставить `application/octet-stream` умеет
 * и сам SDK.
 */
export type AttachmentInput = Omit<EmailAttachmentInput, "content_base64" | "content_type"> & {
  /** MIME-тип; по умолчанию `application/octet-stream`. */
  content_type?: string;
} & (
    | {
        /** Сырое содержимое файла. */
        content: Uint8Array | ArrayBuffer | string;
        content_base64?: never;
      }
    | {
        content?: never;
        /** Готовая base64-строка. */
        content_base64: string;
      }
  );

/**
 * Параметры отправки письма.
 *
 * Отличия от `EmailSendRequest` из спеки — только послабления для удобства:
 * адресата можно передать строкой, а вложение — байтами.
 */
export type SendEmailParams = Omit<
  EmailSendRequest,
  "to" | "cc" | "bcc" | "reply_to" | "attachments"
> & {
  /** Получатель или получатели (до 50 вместе с cc и bcc). */
  to: string | string[];
  /** Копия. */
  cc?: string | string[];
  /** Скрытая копия. */
  bcc?: string | string[];
  /** Адреса для ответа (до 10). */
  reply_to?: string | string[];
  /** Вложения (до 10, суммарно до 25 МиБ вместе с письмом). */
  attachments?: AttachmentInput[];
};

/** Общие опции любого вызова. */
export interface CallOptions {
  /**
   * Сигнал отмены вызова. Складывается с таймаутом SDK: срабатывает тот,
   * что раньше. Прерывает и паузу между повторами, а не только сетевой
   * запрос, — иначе отменённый вызов продолжал бы спать до восьми секунд.
   */
  signal?: AbortSignal;
}

/** Дополнительные опции вызова отправки. */
export interface SendOptions extends CallOptions {
  /**
   * Свой ключ идемпотентности. По умолчанию SDK генерирует `crypto.randomUUID()`
   * на каждый вызов; `null` отключает заголовок для этого вызова.
   */
  idempotencyKey?: string | null;
}

/** Результат отправки одного письма. */
export interface SendEmailResult extends EmailSendResponseData {
  /**
   * `true`, если это идемпотентный повтор: письмо было принято предыдущим
   * запросом с тем же ключом, повторной отправки не произошло.
   */
  replayed: boolean;
  /** Ключ идемпотентности, с которым ушёл запрос. */
  idempotencyKey?: string;
  /** Идентификатор запроса для обращений в поддержку. */
  requestId?: string;
}

/** Фильтры выборки писем. */
export interface ListEmailsParams {
  status?: EmailStatus;
  from_email?: string;
  to_email?: string;
  tag?: string;
  /** Начало интервала по времени создания (ISO-8601 или Date). */
  from?: string | Date;
  /** Конец интервала. */
  to?: string | Date;
  /** Размер выборки, 1..100 (по умолчанию 25 на стороне API). */
  limit?: number;
}
