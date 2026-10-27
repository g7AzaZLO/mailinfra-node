/**
 * Проверка подписи вебхуков — на тех же векторах, что и Python SDK.
 *
 * Вектора собраны из бэкендовой функции подписи
 * (`backend/scripts/gen_webhook_vectors.py`), поэтому тест сверяет реализацию
 * с отправителем, а не с собственными ожиданиями.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { constructEvent, sign, SIGNATURE_HEADER, verify, WebhookSignatureError } from "../src/index.js";
import { sharedFile } from "./sharedFile.js";

interface Vector {
  name: string;
  secret: string;
  timestamp: number;
  body: string;
  signature: string;
  signature_header: string;
  valid: boolean;
}

const vectorsPath = sharedFile("webhook-signatures.json", "testdata");
const vectors = JSON.parse(readFileSync(vectorsPath, "utf-8")) as {
  algorithm: { header: string; max_age_seconds: number };
  cases: Vector[];
};

const valid = vectors.cases.filter((item) => item.valid);
const invalid = vectors.cases.filter((item) => !item.valid);

describe("вектора бэкенда", () => {
  it("файл содержит и валидные, и невалидные кейсы", () => {
    expect(valid.length).toBeGreaterThan(0);
    expect(invalid.length).toBeGreaterThan(0);
    expect(vectors.algorithm.header).toBe(SIGNATURE_HEADER);
  });

  it.each(valid.map((item) => [item.name, item] as const))("принимает %s", async (_name, item) => {
    await expect(
      verify({
        body: item.body,
        secret: item.secret,
        signatureHeader: item.signature_header,
        maxAgeSeconds: 0,
      }),
    ).resolves.toBe(true);
  });

  it.each(invalid.map((item) => [item.name, item] as const))(
    "отклоняет %s",
    async (_name, item) => {
      await expect(
        verify({
          body: item.body,
          secret: item.secret,
          signatureHeader: item.signature_header,
          maxAgeSeconds: 0,
        }),
      ).resolves.toBe(false);
    },
  );

  it.each(valid.map((item) => [item.name, item] as const))(
    "считает ту же подпись для %s",
    async (_name, item) => {
      await expect(
        sign({ body: item.body, secret: item.secret, timestamp: item.timestamp }),
      ).resolves.toBe(item.signature);
    },
  );
});

describe("разбор события", () => {
  it("возвращает типизированное событие", async () => {
    const item = valid.find((entry) => entry.name === "delivered_cyrillic_subject");
    expect(item).toBeDefined();

    const event = await constructEvent({
      body: item!.body,
      secret: item!.secret,
      signatureHeader: item!.signature_header,
      maxAgeSeconds: 0,
    });

    expect(event.type).toBe("email.delivered");
    expect(event.data.email?.subject).toBe("Ваш заказ подтверждён");
    expect(event.data.email?.id).toBe("018e1b7a-1111-7000-aaaa-111111111111");
  });

  it("работает с Uint8Array — так тело отдают Express и Fastify", async () => {
    const item = valid[0]!;
    const bytes = new TextEncoder().encode(item.body);

    const event = await constructEvent({
      body: bytes,
      secret: item.secret,
      signatureHeader: item.signature_header,
      maxAgeSeconds: 0,
    });

    expect(event.id).toBeDefined();
  });
});

describe("защита от replay", () => {
  const body = '{"id":"evt_x","type":"test.ping","created_at":"2026-05-11T20:00:00Z","data":{}}';
  const secret = "whsec_test";

  it("отклоняет старую подпись", async () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const signatureHeader = `t=${old},v1=${await sign({ body, secret, timestamp: old })}`;

    await expect(verify({ body, secret, signatureHeader })).resolves.toBe(false);
    await expect(constructEvent({ body, secret, signatureHeader })).rejects.toMatchObject({
      reason: "too_old",
    });
  });

  it("принимает свежую подпись в окне по умолчанию", async () => {
    const now = Math.floor(Date.now() / 1000);
    const signatureHeader = `t=${now},v1=${await sign({ body, secret, timestamp: now })}`;

    await expect(verify({ body, secret, signatureHeader })).resolves.toBe(true);
  });
});

describe("ошибки разбора", () => {
  it("сообщает про негодный заголовок", async () => {
    await expect(
      constructEvent({ body: "{}", secret: "whsec_test", signatureHeader: "garbage" }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it("сообщает про не-JSON тело", async () => {
    const body = "not json at all";
    const secret = "whsec_test";
    const now = Math.floor(Date.now() / 1000);
    const signatureHeader = `t=${now},v1=${await sign({ body, secret, timestamp: now })}`;

    await expect(constructEvent({ body, secret, signatureHeader })).rejects.toMatchObject({
      reason: "invalid_json",
    });
  });

  it("отклоняет t с хвостом — иначе заголовок принимается не везде одинаково", async () => {
    // `Number.parseInt` съедал хвост; бэкенд и Python SDK требуют целое
    // целиком, и такой заголовок у них не проходит.
    const now = Math.floor(Date.now() / 1000);
    const signatureHeader = `t=${now}abc,v1=deadbeef`;

    await expect(
      constructEvent({ body: "{}", secret: "whsec_test", signatureHeader }),
    ).rejects.toMatchObject({ reason: "malformed_header" });
    await expect(verify({ body: "{}", secret: "whsec_test", signatureHeader })).resolves.toBe(
      false,
    );
  });

  it("принимает пробел после запятой — так его нормализуют прокси", async () => {
    const body = '{"id":"evt_x","type":"test.ping","created_at":"2026-05-11T20:00:00Z","data":{}}';
    const secret = "whsec_test";
    const now = Math.floor(Date.now() / 1000);
    const signatureHeader = `t=${now}, v1=${await sign({ body, secret, timestamp: now })}`;

    await expect(verify({ body, secret, signatureHeader })).resolves.toBe(true);
  });
});

describe("пустой secret", () => {
  // Типовой источник — `process.env.MAILINFRA_WEBHOOK_SECRET ?? ""`: WebCrypto
  // отвергал ключ нулевой длины DOMException'ом, обработчик отвечал 500 на
  // каждую доставку, и MailInfra ретраила её бесконечно.
  const body = '{"id":"evt_x","type":"test.ping","created_at":"2026-05-11T20:00:00Z","data":{}}';

  it("verify отвечает false, а не падает", async () => {
    const now = Math.floor(Date.now() / 1000);

    await expect(
      verify({ body, secret: "", signatureHeader: `t=${now},v1=deadbeef` }),
    ).resolves.toBe(false);
  });

  it("constructEvent объясняет, что secret не задан", async () => {
    const now = Math.floor(Date.now() / 1000);

    const error = await constructEvent({
      body,
      secret: "",
      signatureHeader: `t=${now},v1=deadbeef`,
    }).catch((exc: unknown) => exc);

    expect(error).toBeInstanceOf(WebhookSignatureError);
    expect((error as WebhookSignatureError).reason).toBe("invalid_secret");
    expect((error as WebhookSignatureError).message).toMatch(/MAILINFRA_WEBHOOK_SECRET/);
  });

  it("пустой secret важнее битого заголовка и устаревшей подписи", async () => {
    // Порядок проверок: secret проверялся внутри sign(), то есть последним, и
    // обработчик с незаданным MAILINFRA_WEBHOOK_SECRET получал reason про
    // отправителя вместо конфига. Python, Go и PHP проверяют secret первым.
    for (const signatureHeader of ["мусор", "t=1,v1=deadbeef"]) {
      const error = await constructEvent({ body, secret: "", signatureHeader }).catch(
        (exc: unknown) => exc,
      );

      expect(error, signatureHeader).toBeInstanceOf(WebhookSignatureError);
      expect((error as WebhookSignatureError).reason, signatureHeader).toBe("invalid_secret");
    }
  });
});

describe("конверт события", () => {
  it("отклоняет подписанное, но неполное событие", async () => {
    // Python SDK на том же теле падал ValidationError'ом, Node молча отдавал
    // `event.type === undefined` — теперь оба отвечают `invalid_payload`.
    const body = '{"id":"evt_1","data":{}}';
    const secret = "whsec_test";
    const now = Math.floor(Date.now() / 1000);
    const signatureHeader = `t=${now},v1=${await sign({ body, secret, timestamp: now })}`;

    const error = await constructEvent({ body, secret, signatureHeader }).catch(
      (exc: unknown) => exc,
    );

    expect(error).toBeInstanceOf(WebhookSignatureError);
    expect((error as WebhookSignatureError).reason).toBe("invalid_payload");
    expect((error as WebhookSignatureError).message).toMatch(/type/);
  });
});
