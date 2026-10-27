# MailInfra SDK для Node.js и TypeScript

Официальный клиент [MailInfra](https://mailinfra.ru) — email API для разработчиков.

```bash
npm install mailinfra
```

```ts
import { MailInfra } from "mailinfra";

const client = new MailInfra(); // ключ из MAILINFRA_API_KEY

const result = await client.emails.send({
  from: "hello@mail.example.ru",
  to: "user@example.com",
  subject: "Добро пожаловать!",
  html: "<p>Привет!</p>",
});
console.log(result.id, result.status);
```

Требования: Node.js 20+ (нужны глобальные `fetch` и WebCrypto; на Node 18 второго
без флага нет). Работает также в Cloudflare Workers, Deno и Bun — внутри только `fetch`
и WebCrypto, без node-only API. Поставляется в ESM и CJS.

## Что клиент делает за вас

| Возможность | Подробности |
|---|---|
| Идемпотентность | На каждую отправку ставится `Idempotency-Key`, и он **переиспользуется при повторах** — обрыв сети не превращается в два письма |
| Повторы | `429`, `408/425`, `5xx` и сетевые сбои повторяются с экспоненциальным backoff и half-jitter |
| Rate limit | `Retry-After` уважается как есть; слишком долгий (>60 с) не блокирует поток, а приходит как `RateLimitError.retryAfter` |
| Типизированные ошибки | `DomainNotVerifiedError`, `RateLimitError`, `UnprocessableError.fields` и ещё ~20 классов |
| Локальная валидация | Лимиты спеки (получатели, теги, вложения, длина темы) проверяются до запроса — письмо на 25 МиБ не уедет в сеть ради `422` |
| Отмена | `signal: AbortSignal` у любого вызова; прерывает и паузу между повторами |
| Типы | Выведены из OpenAPI-спеки MailInfra (`openapi-typescript`), а не написаны руками |
| Вебхуки | `constructEvent()` — проверка HMAC-подписи на WebCrypto и разбор события |

## Аутентификация

```ts
new MailInfra({ apiKey: "mi_live_…" });        // явно
new MailInfra();                                // из MAILINFRA_API_KEY
new MailInfra({ requireEnvironment: "live" });  // упасть, если подсунули тестовый ключ
```

`mi_live_…` отправляет письма по-настоящему. `mi_test_…` — sandbox: письмо сохраняется
со статусом `SIMULATED`, не доставляется и не расходует месячный объём плана.
Окружение доступно как `client.environment`.

База API меняется через `baseUrl` или переменную `MAILINFRA_BASE_URL`.

## Отправка

Имена полей письма совпадают с API один в один (`from`, `reply_to`, `content_base64`) —
примеры из документации MailInfra работают в SDK без переименований.

### По шаблону

```ts
await client.emails.send({
  from: "no-reply@mail.example.ru",
  to: ["anna@example.com", "boris@example.com"],
  template: "welcome",                   // тема берётся из шаблона
  variables: { user_name: "Анна", app_name: "MyApp" },
  tags: ["onboarding"],
});
```

### С вложением

Передайте байты — SDK сам закодирует их в base64:

```ts
import { readFile } from "node:fs/promises";

await client.emails.send({
  from: "billing@mail.example.ru",
  to: "user@example.com",
  subject: "Счёт за май",
  text: "Счёт во вложении.",
  attachments: [
    {
      filename: "invoice.pdf",
      content: await readFile("invoice.pdf"),
      content_type: "application/pdf",
    },
  ],
});
```

### Свой ключ идемпотентности

```ts
const result = await client.emails.send(
  {
    from: "no-reply@mail.example.ru",
    to: "user@example.com",
    template: "order_paid",
    variables: { order_id: 4242 },
  },
  { idempotencyKey: "order_4242_paid" },
);

if (result.replayed) {
  console.log("Письмо уже было отправлено раньше");
}
```

`{ idempotencyKey: null }` отключает заголовок для одного вызова,
`new MailInfra({ autoIdempotency: false })` — для всех. Бэкенд хранит ключ 24 часа:
повтор с тем же ключом позже создаст новое письмо.

### Пакетная отправка

До 100 писем одним запросом:

```ts
const batch = await client.emails.sendBatch([
  { from: "no-reply@mail.example.ru", to: "a@example.com", template: "welcome",
    variables: { user_name: "Анна" } },
  { from: "no-reply@mail.example.ru", to: "b@example.com", template: "welcome",
    variables: { user_name: "Борис" } },
]);

console.log(batch.accepted_count, batch.failed_count);
for (const item of batch.results) {
  if (item.error) {
    console.error(item.index, item.error.code, item.error.message);
  }
}
```

> **Важно.** Батч возвращает `202`, даже если часть писем отклонена — проверяйте
> `error` у каждого элемента. `Idempotency-Key` этот эндпоинт не принимает, поэтому
> SDK **не** повторяет его после `5xx`: повтор мог бы отправить часть писем дважды.
> Повторяется только `429` — единственный отказ, который случается до приёма
> писем. Обрыв соединения и таймаут батча **не** повторяются: сервер мог уже
> закоммитить часть писем, поэтому решение о повторе за вами.

## Чтение

```ts
const email = await client.emails.get(result.id);
console.log(email.status, email.delivered_at, email.final_smtp_code);

for (const event of await client.emails.events(result.id)) {
  console.log(event.timestamp, event.type, event.data);
}

const recent = await client.emails.list({ status: "BOUNCED", tag: "onboarding", limit: 50 });
```

Фильтры `list()`: `status`, `from_email`, `to_email`, `tag`, `from`, `to` (строка ISO
или `Date`), `limit` (1..100).

## Ошибки

```ts
import {
  DomainNotVerifiedError, RateLimitError, UnprocessableError, MailInfraError,
} from "mailinfra";

try {
  await client.emails.send({ /* … */ });
} catch (error) {
  if (error instanceof DomainNotVerifiedError) {
    // домен ещё не подтверждён в DNS
  } else if (error instanceof UnprocessableError) {
    for (const field of error.fields) {
      console.error(field.field, field.message);
    }
  } else if (error instanceof RateLimitError) {
    console.error("повторить через", error.retryAfter);
  } else if (error instanceof MailInfraError) {
    console.error(error.code, error.message, error.requestId);
  } else {
    throw error;
  }
}
```

У любой ошибки есть `.code`, `.message`, `.details`, `.statusCode` и `.requestId` —
последний стоит логировать: с ним поддержка найдёт запрос в своих логах.

Конкретный класс всегда наследует класс своего HTTP-статуса: `DomainNotVerifiedError`
— это и `UnprocessableError` (422), `SandboxTrialExhaustedError` — и
`PermissionDeniedError` (403). Ловить можно на любом уровне: `MailInfraError`,
класс статуса или конкретная причина.

Неизвестный код ошибки (новый на бэкенде) приходит как класс по HTTP-статусу, а не
ломает старый SDK.

## Настройка повторов

```ts
const client = new MailInfra({
  timeoutMs: 10_000,
  maxRetries: 4,
  retryPolicy: {
    initialBackoffMs: 500,
    backoffFactor: 2,
    maxBackoffMs: 8_000,
    maxRetryAfterMs: 60_000, // выше этого не ждём, отдаём RateLimitError
  },
});
```

Политика проверяется при создании клиента: `maxRetries` — целое число >= 0,
`initialBackoffMs` — конечное неотрицательное число, `backoffFactor` >= 1, потолки
`maxBackoffMs` и `maxRetryAfterMs` — неотрицательные числа, `Infinity` значит «без
потолка». Иначе конструктор бросает `RangeError` — например, на
`Number(process.env.MAILINFRA_RETRIES)` без переменной (`NaN`). Строка вместо числа
(`maxRetries: process.env.MAILINFRA_RETRIES`) не приводится, а даёт `TypeError`.
Поле со значением `undefined` считается не заданным и берётся по умолчанию.

Свой транспорт (прокси, undici Agent, мок в тестах): `new MailInfra({ fetch: myFetch })`.

## Отмена вызова

Любой вызов принимает `signal`. Он складывается с таймаутом SDK — срабатывает тот,
что раньше — и прерывает не только сетевой запрос, но и паузу между повторами:

```ts
const controller = new AbortController();
setTimeout(() => {
  controller.abort();
}, 2_000);

await client.emails.send(
  { from: "hello@mail.example.ru", to: "user@example.com", subject: "Тема", text: "Текст" },
  { signal: controller.signal },
);
```

Отменённый вызов не повторяется, а причина доезжает до вызывающего как есть —
`AbortError`, а не `APIConnectionError`.

## Вебхуки

```ts
import express from "express";
import { constructEvent } from "mailinfra";

const app = express();

app.post(
  "/mailinfra/events",
  express.raw({ type: "application/json" }),   // именно сырые байты
  async (req, res) => {
    const event = await constructEvent({
      body: req.body,
      secret: process.env.MAILINFRA_WEBHOOK_SECRET!,
      signatureHeader: req.header("X-MailInfra-Signature")!,
    });

    if (event.type === "email.bounced") {
      await markBounced(event.data.email?.id, event.data.event);
    }

    res.json({ status: "ok" });
  },
);
```

`constructEvent` проверяет HMAC-SHA256 подпись и её возраст (по умолчанию 5 минут, как
на стороне MailInfra) и только потом разбирает JSON. Нужен просто флаг — есть
`verify(...) => Promise<boolean>`.

Тело обязательно брать **до** разбора JSON: пересериализованный JSON даст другие байты
и подпись не сойдётся.

## Что пока не покрыто

v1 покрывает публичный API писем (`/v1/emails*`) — всё, что доступно по API-ключу
проекта. Управление доменами, шаблонами, списком подавления, вебхуками и ключами — это
Management API на сессионном токене пользователя; для машинной интеграции у него пока
нет подходящего credential, поэтому в SDK этих ресурсов нет. Следите за
[CHANGELOG](CHANGELOG.md).

## Ссылки

- Документация: <https://docs.mailinfra.ru>
- Формат ошибок: <https://docs.mailinfra.ru/errors>
- Вебхуки: <https://docs.mailinfra.ru/webhooks/signature>
- OpenAPI-спека: <https://docs.mailinfra.ru/openapi/mailinfra-public.json>
- Исходный код и issues: <https://github.com/g7AzaZLO/mailinfra-node>. Репозиторий
  обновляется при каждом релизе SDK; ошибки и предложения — в issues, pull request'ы
  не принимаются: SDK разрабатывается вместе с API MailInfra.

## Лицензия

MIT
