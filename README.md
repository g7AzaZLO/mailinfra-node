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
| Идемпотентность | На каждую отправку и каждый батч ставится `Idempotency-Key`, и он **переиспользуется при повторах** — обрыв сети не превращается в два письма |
| Повторы | `429`, `408/425`, `5xx` и сетевые сбои повторяются с экспоненциальным backoff и half-jitter |
| Rate limit | `Retry-After` уважается как есть; слишком долгий (>60 с) не блокирует поток, а приходит как `RateLimitError.retryAfter` |
| Типизированные ошибки | `DomainNotVerifiedError`, `RateLimitError`, `UnprocessableError.fields` и ещё ~20 классов |
| Локальная валидация | Лимиты спеки (получатели, теги, вложения, длина темы, `metadata`, `ttl`, часовой пояс в `send_at`) проверяются до запроса — письмо на 25 МиБ не уедет в сеть ради `422` |
| Пагинация | `listAll()` сам идёт по курсору `next_cursor`, страница за страницей, по мере обхода |
| Отмена | `signal: AbortSignal` у любого вызова; прерывает и паузу между повторами |
| Типы | Выведены из OpenAPI-спеки MailInfra (`openapi-typescript`), а не написаны руками |
| Вебхуки | `constructEvent()` — проверка HMAC-подписи на WebCrypto и разбор события, в том числе в окне ротации secret |

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

### Metadata

Свои пары «ключ — значение» — номер заказа, id пользователя — чтобы связать письмо и
события по нему со своей системой. Они возвращаются в `get()`, `list()` и в
`data.email.metadata` каждого вебхука письма, на доставку не влияют:

```ts
await client.emails.send({
  from: "billing@mail.example.ru",
  to: "user@example.com",
  template: "order_paid",
  variables: { order_id: 4242 },
  metadata: { order_id: "4242", user_id: "u-17" },
});
```

Лимиты проверяются до запроса: до 20 ключей; ключ — от 1 до 40 символов из латиницы,
цифр, `_`, `-` и `.`; значение — строка до 500 символов без NUL; весь объект в JSON —
до 4096 байт UTF-8. Нарушение — `MailInfraError` с кодом `invalid_request`.

### Отложенная отправка

`send_at` — `Date` или строка ISO 8601 **с часовым поясом**, не дальше 7 дней от приёма
письма. `Date` уходит через `toISOString()`; строку без пояса (`2026-11-01T09:00:00`) SDK
не отправит — API её всё равно отклонит. Время в прошлом — отправить сразу.

```ts
const reminder = await client.emails.send({
  from: "no-reply@mail.example.ru",
  to: "user@example.com",
  template: "webinar_reminder",
  send_at: "2026-11-01T09:00:00+03:00",
});
console.log(reminder.status); // "SCHEDULED"

// Перенести — новое время, тот же горизонт в 7 дней от приёма письма:
await client.emails.reschedule(reminder.id, { send_at: new Date("2026-11-01T08:00:00Z") });

// Отменить — письмо получит статус CANCELED, резерв квоты вернётся:
await client.emails.cancel(reminder.id);
```

Оба метода возвращают `{ id, status, scheduled_at }`. Письмо, которое уже ушло в очередь,
отправлено или отменено, — это `EmailNotScheduledError` (`409`, текущий статус — в
`error.details.status`); `send_at` дальше горизонта — `SendAtTooFarError` (`400`). Отмена и
перенос требуют права на отправку.

### Срок жизни письма

`ttl` — сколько секунд письмо актуально, от 60 до 86 400, отсчёт от `send_at` или от приёма.
Не дошедшее за это время письмо не отправляется и не повторяется: статус `FAILED` с
причиной `expired` или отказ с категорией `delivery-expired`. Для кодов входа и других
писем, которые поздно уже не нужны:

```ts
await client.emails.send({
  from: "auth@mail.example.ru",
  to: "user@example.com",
  subject: "Код входа: 4821",
  text: "Код действует 5 минут.",
  ttl: 300,
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

### Inline-картинки

Вложение с `content_id` встраивается в письмо, а не прикладывается файлом; HTML ссылается
на него как `cid:<content_id>`:

```ts
await client.emails.send({
  from: "hello@mail.example.ru",
  to: "user@example.com",
  subject: "Новая коллекция",
  html: '<img src="cid:logo@mail.example.ru" alt="Логотип"><p>Привет!</p>',
  attachments: [
    {
      filename: "logo.png",
      content: await readFile("logo.png"),
      content_type: "image/png",
      content_id: "logo@mail.example.ru",
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
> `error` у каждого элемента.

`Idempotency-Key` ставится на весь батч так же, как у `send()`: один ключ на вызов,
переиспользуемый при повторах. Бэкенд выводит из него ключ каждого письма, поэтому повтор
не дублирует уже принятые письма, а отклонённые пробует принять заново — и SDK
повторяет батч после `5xx`, таймаута и обрыва соединения. Если повтором оказались все
принятые письма, `batch.replayed === true`:

```ts
const batch = await client.emails.sendBatch(emails, { idempotencyKey: "import_2026_10_28" });
console.log(batch.idempotencyKey, batch.replayed);
```

Ключ батча — печатаемый ASCII до 252 символов: ещё три бэкенд дописывает под номер письма.
Ключ внутри отдельного письма батча SDK отбивает (`invalid_batch_item`) — он задаётся
только в опциях. Без ключа (`{ idempotencyKey: null }` или `autoIdempotency: false`) батч
повторяется только на `429` — единственном отказе, который случается до приёма писем:
после `5xx`, таймаута или обрыва сервер мог уже закоммитить часть писем, и решение о
повторе за вами.

## Чтение

```ts
const email = await client.emails.get(result.id);
console.log(email.status, email.delivered_at, email.final_smtp_code);

for (const event of await client.emails.events(result.id)) {
  console.log(event.timestamp, event.type, event.data);
}

let cursor: string | undefined;
do {
  const page = await client.emails.list({ status: "BOUNCED", tag: "onboarding", limit: 50, cursor });
  for (const item of page.data) {
    console.log(item.id, item.metadata);
  }
  cursor = page.next_cursor ?? undefined;
} while (cursor !== undefined);
```

`list()` возвращает одну страницу, новые письма сначала: `data`, `has_more` и `next_cursor`
— как в API. Следующая страница — тот же вызов с `cursor: page.next_cursor`; курсор
непрозрачный, передавайте его как есть. Фильтры: `status`, `from_email`, `to_email`, `tag`,
`from`, `to` (строка ISO или `Date`), `limit` (размер страницы, 1..100), `cursor`.

Обойти все страницы сразу — `listAll()`, асинхронный итератор:

```ts
for await (const email of client.emails.listAll({ status: "BOUNCED", limit: 100 })) {
  console.log(email.id, email.to_emails);
}
```

Страницы запрашиваются лениво, по мере обхода: `break` останавливает загрузку. `limit` —
размер страницы, а не всей выборки; `cursor` продолжает обход с нужной страницы.

> До 0.2.0 `list()` возвращал массив писем. Теперь это страница: письма — в `page.data`.

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

Классы отложенной отправки и доступа: `EmailNotScheduledError` (`409`) — письмо уже не
запланировано, `SendAtTooFarError` и `SendAtInvalidError` (`400`) — `send_at` дальше 7 дней
или без часового пояса, `IPNotAllowedError` (`403`) — ключ использован с IP-адреса вне его
белого списка.

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

Во время ротации secret MailInfra подписывает каждую доставку дважды — новым secret и
прежним: `t=<unix>,v1=<новым>,v1=<прежним>`. `verify` и `constructEvent` принимают запрос,
если с вашим secret совпала **любая** из подписей, поэтому обработчик можно переключить на
новый secret в любой момент окна ротации. (SDK 0.1.0 сверял только последнюю подпись —
прежним secret, — и обработчик с новым secret отвергал доставки до конца окна.)

У событий письма `type` — `email.<событие>`: в том числе `email.scheduled` при отложенной
отправке и `email.canceled` при её отмене. `data.email.metadata` — `metadata`, переданный
при отправке.

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
