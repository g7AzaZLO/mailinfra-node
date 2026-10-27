/**
 * Лимиты запроса из публичной спеки.
 *
 * Значения продублированы руками, как в Go и PHP SDK: генератор
 * `openapi-typescript` отдаёт только типы, а они в рантайме стираются, и
 * проверить по ним ничего нельзя. От расхождения со спекой защищает не
 * генератор, а `spec-parity.test.ts`, который сверяет каждую константу с
 * `https://docs.mailinfra.ru/openapi/mailinfra-public.json`.
 */

/** Потолок адресов в каждом из полей `to`, `cc` и `bcc`. */
export const MAX_RECIPIENTS = 50;

/** Потолок адресов в `reply_to`. */
export const MAX_REPLY_TO = 10;

/** Потолок тегов письма. */
export const MAX_TAGS = 10;

/** Потолок длины темы. */
export const MAX_SUBJECT_LENGTH = 998;

/** Потолок длины отображаемого имени отправителя. */
export const MAX_FROM_NAME_LENGTH = 200;

/** Потолок длины слага шаблона. */
export const MAX_TEMPLATE_LENGTH = 100;

/** Потолок числа вложений. */
export const MAX_ATTACHMENTS = 10;

/**
 * Потолок длины base64 одного вложения.
 *
 * Проверяется на клиенте не ради вежливости: письмо с вложениями весит до
 * ~25 МиБ, и отправить их в сеть, чтобы получить 422, — худший вариант.
 */
export const MAX_ATTACHMENT_BASE64_LENGTH = 14348938;

/** Потолок длины имени файла вложения. */
export const MAX_FILENAME_LENGTH = 255;

/** Потолок длины MIME-типа вложения. */
export const MAX_CONTENT_TYPE_LENGTH = 255;

/**
 * `BatchSendRequest.emails` в спеке ограничен `maxItems: 100`. Ловим на
 * клиенте: иначе батч с вложениями уезжает целиком только чтобы вернуться
 * с 422.
 */
export const MAX_BATCH_SIZE = 100;

/**
 * Потолок длины `Idempotency-Key`.
 *
 * Бэкенд объявляет его как `Header(max_length=255)`, но значение заголовка
 * приходит байтами и декодируется latin-1, поэтому для неASCII лимит на
 * самом деле байтовый. SDK такие ключи не пропускает вовсе (см.
 * `resolveIdempotencyKey`), так что здесь честные 255 ASCII-символов.
 */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
