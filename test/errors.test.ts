/** Маппинг конверта ошибок API в типизированные классы. */

import { describe, expect, it } from "vitest";

import {
  AllRecipientsSuppressedError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  DomainNotAttachedError,
  DomainNotVerifiedError,
  EmailNotScheduledError,
  errorFromResponse,
  IdempotencyInFlightError,
  IPNotAllowedError,
  LegalDocumentsNotAcceptedError,
  MailInfraError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ReservedEmailHeaderError,
  SandboxRecipientNotAllowedError,
  SandboxTrialExhaustedError,
  SendAtInvalidError,
  SendAtTooFarError,
  ServerError,
  TemplateRenderError,
  TemplateVariableMissingError,
  UnprocessableError,
} from "../src/index.js";

function envelope(code: string, message = "Ошибка", details: Record<string, unknown> = {}) {
  return { error: { code, message, details }, request_id: "req-test" };
}

describe("по HTTP-статусу", () => {
  it.each([
    [401, AuthenticationError],
    [403, PermissionDeniedError],
    [404, NotFoundError],
    [409, ConflictError],
    [422, UnprocessableError],
    [429, RateLimitError],
    [500, ServerError],
    [503, ServerError],
  ])("%i", (statusCode, expected) => {
    const error = errorFromResponse({ statusCode, body: envelope("some_code") });

    expect(error).toBeInstanceOf(expected);
    expect(error.requestId).toBe("req-test");
  });

  it("неожиданный статус падает в базовый класс", () => {
    const error = errorFromResponse({ statusCode: 418, body: envelope("teapot") });

    expect(error).toBeInstanceOf(MailInfraError);
    expect(error).not.toBeInstanceOf(ServerError);
  });
});

describe("по error.code", () => {
  // Статусы — те, с которыми бэкенд реально отдаёт код (места `raise` в
  // `app.services`). Конкретный класс обязан оставаться и классом своей
  // категории: `catch (UnprocessableError)` из README ловит и
  // `DomainNotVerifiedError`.
  it.each([
    [422, "domain_not_verified", DomainNotVerifiedError, UnprocessableError],
    [422, "domain_not_attached", DomainNotAttachedError, UnprocessableError],
    [422, "all_recipients_suppressed", AllRecipientsSuppressedError, UnprocessableError],
    [422, "sandbox_recipient_not_allowed", SandboxRecipientNotAllowedError, UnprocessableError],
    [422, "template_render_error", TemplateRenderError, UnprocessableError],
    [422, "template_variable_missing", TemplateVariableMissingError, UnprocessableError],
    [422, "reserved_email_header", ReservedEmailHeaderError, UnprocessableError],
    [422, "legal_documents_not_accepted", LegalDocumentsNotAcceptedError, UnprocessableError],
    [403, "sandbox_trial_exhausted", SandboxTrialExhaustedError, PermissionDeniedError],
    [403, "ip_not_allowed", IPNotAllowedError, PermissionDeniedError],
    [409, "idempotency_in_flight", IdempotencyInFlightError, ConflictError],
    [409, "email_not_scheduled", EmailNotScheduledError, ConflictError],
    [400, "send_at_too_far", SendAtTooFarError, BadRequestError],
    [400, "send_at_invalid", SendAtInvalidError, BadRequestError],
    [429, "rps_exceeded", RateLimitError, RateLimitError],
  ])("%i %s", (statusCode, code, expected, category) => {
    // Бэкенд поднимает `details.code` в `error.code` (`app.main.translated_error`),
    // так что в реальном конверте код продублирован.
    const error = errorFromResponse({ statusCode, body: envelope(code, "Ошибка", { code }) });

    expect(error).toBeInstanceOf(expected);
    expect(error).toBeInstanceOf(category);
    expect(error.code).toBe(code);
    expect(error.statusCode).toBe(statusCode);
  });

  it("legal_documents_not_accepted несёт список документов к принятию", () => {
    const pending = [{ type: "DPA", version: "2", id: "doc-1" }];
    const error = errorFromResponse({
      statusCode: 422,
      body: envelope("legal_documents_not_accepted", "Примите документы.", {
        code: "legal_documents_not_accepted",
        pending,
      }),
    });

    expect(error).toBeInstanceOf(LegalDocumentsNotAcceptedError);
    expect(error.details["pending"]).toEqual(pending);
  });

  it.each(["toString", "constructor", "hasOwnProperty", "__proto__"])(
    "унаследованное имя %s не резолвится в конструктор с прототипа",
    (code) => {
      // Код приходит из тела ответа. У объектного литерала `CODE_ERRORS`
      // `"toString"` отдавал `Function.prototype.toString`, и `new` кидал
      // TypeError мимо всей обработки ошибок; `"constructor"` возвращал
      // String-обёртку — не Error вообще.
      const error = errorFromResponse({ statusCode: 422, body: envelope(code) });

      expect(error).toBeInstanceOf(UnprocessableError);
      expect(error.code).toBe(code);
    },
  );

  it("неизвестный код деградирует до класса по статусу", () => {
    const error = errorFromResponse({
      statusCode: 404,
      body: envelope("brand_new_code_from_the_future"),
    });

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.code).toBe("brand_new_code_from_the_future");
  });

  it("details.code важнее кода конверта", () => {
    const error = errorFromResponse({
      statusCode: 429,
      body: envelope("rate_limit_exceeded", "Превышен лимит.", { code: "rps_exceeded" }),
      retryAfter: 1,
    });

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.code).toBe("rps_exceeded");
    expect((error as RateLimitError).retryAfter).toBe(1);
  });
});

describe("устойчивость", () => {
  it("не падает на HTML от прокси", () => {
    const error = errorFromResponse({
      statusCode: 502,
      body: "<html><body>502 Bad Gateway</body></html>",
      requestId: "req-proxy",
    });

    expect(error).toBeInstanceOf(ServerError);
    expect(error.code).toBe("unknown_error");
    expect(error.requestId).toBe("req-proxy");
  });

  it("не падает на пустом теле", () => {
    const error = errorFromResponse({ statusCode: 500, body: undefined });

    expect(error).toBeInstanceOf(ServerError);
    expect(error.message).toContain("500");
  });

  it("отдаёт пер-полевые причины валидации", () => {
    const error = errorFromResponse({
      statusCode: 422,
      body: envelope("request_validation_failed", "Проверьте поля.", {
        fields: [
          { field: "to", message: "укажите корректный email", code: "value_error" },
          { nonsense: true },
        ],
      }),
    });

    expect(error).toBeInstanceOf(UnprocessableError);
    expect((error as UnprocessableError).fields).toEqual([
      { field: "to", message: "укажите корректный email", code: "value_error" },
    ]);
  });

  it("сохраняет имя класса в name — это видно в логах", () => {
    const error = errorFromResponse({ statusCode: 404, body: envelope("not_found") });

    expect(error.name).toBe("NotFoundError");
  });
});
