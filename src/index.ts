/**
 * Официальный SDK MailInfra для Node.js и TypeScript.
 *
 * ```ts
 * import { MailInfra } from "mailinfra";
 *
 * const client = new MailInfra(); // ключ из MAILINFRA_API_KEY
 *
 * const result = await client.emails.send({
 *   from: "hello@mail.example.ru",
 *   to: "user@example.com",
 *   subject: "Добро пожаловать!",
 *   html: "<p>Привет!</p>",
 * });
 * console.log(result.id, result.status);
 * ```
 *
 * Что клиент делает за вас:
 *
 * - ставит `Idempotency-Key` на каждую отправку и переиспользует его при
 *   повторах — сбой сети не превращается в два письма;
 * - повторяет `429`/`5xx`/таймауты с экспоненциальным backoff и уважает
 *   `Retry-After`;
 * - поднимает ошибки API типизированными классами (`RateLimitError`,
 *   `DomainNotVerifiedError`, …);
 * - проверяет подписи вебхуков (`verify`, `constructEvent`).
 *
 * Покрытие v1 — публичный API писем (`/v1/emails*`). Управление доменами,
 * шаблонами, вебхуками и ключами — Management API на сессионном токене, оно
 * в SDK пока не входит.
 */

export { API_KEY_ENV_VAR, BASE_URL_ENV_VAR, MailInfra, VERSION } from "./client.js";
export type { ApiResponse, Environment, MailInfraOptions, RequestOptions } from "./client.js";

export {
  AllRecipientsSuppressedError,
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  DomainNotAttachedError,
  DomainNotVerifiedError,
  errorFromResponse,
  IdempotencyInFlightError,
  LegalDocumentsNotAcceptedError,
  MailInfraError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ReservedEmailHeaderError,
  SandboxRecipientNotAllowedError,
  SandboxTrialExhaustedError,
  ServerError,
  TemplateRenderError,
  TemplateVariableMissingError,
  UnprocessableError,
} from "./errors.js";
export type { ErrorDetails, ValidationField } from "./errors.js";

export { buildSendPayload, EmailsResource } from "./resources/emails.js";

export {
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
} from "./limits.js";

export {
  DEFAULT_BASE_URL,
  DEFAULT_RETRY_POLICY,
  DEFAULT_TIMEOUT_MS,
  nextDelay,
  parseRetryAfter,
  RETRYABLE_STATUSES,
  RETRYABLE_STATUSES_NON_IDEMPOTENT,
  shouldRetryStatus,
} from "./transport.js";
export type { RetryPolicy } from "./transport.js";

export type {
  AttachmentInput,
  BatchSendError,
  BatchSendResponseData,
  BatchSendResult,
  BounceCategory,
  BounceType,
  CallOptions,
  EmailAttachmentInput,
  EmailDetail,
  EmailEvent,
  EmailEventType,
  EmailListItem,
  EmailSendRequest,
  EmailSendResponseData,
  EmailSource,
  EmailStatus,
  ErrorResponse,
  ListEmailsParams,
  SendEmailParams,
  SendEmailResult,
  SendOptions,
  SuppressionReason,
} from "./types.js";

export {
  constructEvent,
  DEFAULT_MAX_AGE_SECONDS,
  EVENT_ID_HEADER,
  sign,
  SIGNATURE_HEADER,
  verify,
  WebhookSignatureError,
} from "./webhooks.js";
export type { SignatureFailureReason, VerifyInput, WebhookBody, WebhookEvent } from "./webhooks.js";

export type { components, operations, paths } from "./generated/openapi.js";
