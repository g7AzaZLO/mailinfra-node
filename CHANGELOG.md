# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версионирование — [SemVer](https://semver.org/lang/ru/).

До `1.0.0` минорные версии могут содержать несовместимые изменения: пока не покрыт
Management API, публичная поверхность SDK ещё расширяется.

## [0.2.0] — 2026-10-28

### Добавлено

- `metadata` у письма в `send` и в каждом письме `sendBatch`: пары «ключ — строка»
  возвращаются в `metadata` у `get`/`list` и в `data.email.metadata` вебхуков. Лимиты
  проверяются до запроса: до 20 ключей, ключ — 1–40 символов `[A-Za-z0-9_.-]`, значение —
  строка до 500 символов без NUL, весь объект — до 4096 байт JSON в UTF-8 (размер
  считается так же, как на бэкенде).
- Отложенная отправка: `send_at` в `send` и `sendBatch` — `Date` (уходит через
  `toISOString()`) или строка ISO 8601 с часовым поясом; строка без пояса отбивается до
  запроса. Методы `cancel(emailId)` (`POST /v1/emails/{id}/cancel`) и
  `reschedule(emailId, { send_at })` (`PATCH /v1/emails/{id}`) возвращают
  `EmailScheduleData`.
- `ttl` — срок жизни письма в секундах (60..86 400), проверяется до запроса.
- `content_id` у вложения — inline-картинка, на которую HTML ссылается как
  `cid:<content_id>`; длина проверяется до запроса.
- `Idempotency-Key` у `sendBatch`: SDK ставит ключ сам, переиспользует его при повторах и
  повторяет батч с ключом после `5xx`, таймаута и обрыва соединения так же, как
  `send()`. Свой ключ — `sendBatch(emails, { idempotencyKey })`, до 252 символов;
  `null` отключает его. Результат — `SendBatchResult` с `replayed`, `idempotencyKey` и
  `requestId`.
- Курсорная пагинация: `list({ cursor })` и `listAll()` — асинхронный итератор, который
  сам идёт по `next_cursor` и запрашивает страницы по мере обхода. Ответ с
  `has_more: true` без курсора — ошибка `malformed_response`, а не молча оборванный обход.
- Статусы `SCHEDULED` и `CANCELED`, события `scheduled` и `canceled` (вебхуки
  `email.scheduled` и `email.canceled`), категория недоставки `delivery-expired`, поля
  `metadata`, `scheduled_at` и `expires_at` у письма — из перегенерированных типов спеки.
- Классы ошибок `EmailNotScheduledError` (`409`), `SendAtTooFarError` и
  `SendAtInvalidError` (`400`), `IPNotAllowedError` (`403` — ключ использован с IP-адреса
  вне его белого списка).
- Константы лимитов `MAX_METADATA_KEYS`, `MAX_METADATA_KEY_LENGTH`,
  `MAX_METADATA_VALUE_LENGTH`, `MAX_METADATA_BYTES`, `MIN_TTL_SECONDS`, `MAX_TTL_SECONDS`,
  `MAX_CONTENT_ID_LENGTH`, `BATCH_IDEMPOTENCY_KEY_MAX_LENGTH`.
- `spec-parity.test.ts` сверяет запрос каждого метода SDK — метод, путь, query,
  заголовки и тело — с операцией спеки и требует, чтобы каждая операция спеки была
  покрыта методом SDK.

### Изменено

- **Несовместимо:** `list()` возвращает страницу `EmailListPage` —
  `{ data, has_more, next_cursor }` — вместо массива писем. Письма теперь в `page.data`.
- **Несовместимо:** `sendBatch()` по умолчанию ставит `Idempotency-Key` и повторяет батч
  после `5xx` и сетевых сбоев. Прежнее поведение — `{ idempotencyKey: null }`.
- Проверка подписи вебхуков принимает запрос, если совпала любая из подписей `v1`: в окне
  ротации secret их две — новым и прежним. Раньше сверялась только последняя, и
  обработчик с новым secret отвергал доставки до конца окна.
- Пустой идентификатор письма в `get`, `events`, `cancel` и `reschedule` отбивается до
  запроса: иначе вызов уходил на `/v1/emails/` — другой эндпоинт.
- `ApiResponse` несёт `envelope` — тело ответа целиком, рядом с `data`.

## [0.1.0] — 2026-10-27

Первый релиз.

### Добавлено

- Клиент `MailInfra` поверх глобального `fetch`: Node 20+, Cloudflare Workers,
  Deno, Bun. Сборка ESM + CJS, без внешних зависимостей в рантайме.
- Ресурс писем: `send`, `sendBatch`, `get`, `list`, `events`.
- Автоматический `Idempotency-Key` на отправке, переиспользуемый при повторах;
  флаг `replayed` в результате для идемпотентных повторов.
- Повторы с экспоненциальным backoff и half-jitter, уважение `Retry-After`,
  раздельная политика для идемпотентных и неидемпотентных запросов. Политика
  проверяется при создании клиента: `NaN`, отрицательные и дробные `maxRetries`
  дают `RangeError`, а не бесконечные повторы; строки вместо чисел не приводятся
  и дают `TypeError`. `Infinity` допустим только для потолков `maxBackoffMs` и
  `maxRetryAfterMs`.
- Типизированные ошибки по HTTP-статусу и по `error.code`; неизвестный код
  деградирует до класса по статусу.
- Локальная валидация письма по ограничениям спеки (обязательные `from` и `to`,
  получатели, `reply_to`, теги, вложения, длины темы, имени отправителя и слага
  шаблона, размер вложения) до сетевого вызова. Ошибка — `MailInfraError` с кодом
  `invalid_request` или `invalid_attachment`. Лимиты лежат в `limits.ts` и
  сверяются со спекой в `spec-parity.test.ts`.
- Проверка элементов батча: ключ идемпотентности внутри письма и неизвестные
  параметры отбиваются кодом `invalid_batch_item`. Бэкенд лишние поля игнорирует
  молча, поэтому такое письмо ушло бы без защиты от дублей и без ошибки.
- `signal` (`AbortSignal`) у `send`, `sendBatch`, `get`, `list` и `events`:
  складывается с таймаутом SDK и прерывает в том числе паузу между повторами.
  Отмена не повторяется и доезжает до вызывающего как есть, без подмены на
  `APIConnectionError`.
- `Idempotency-Key` принимается только как печатаемый ASCII: значение
  заголовка уходит байтами, и бэкенд читает их как latin-1 — кириллица
  доехала бы до него мусором и вдвое длиннее. CR и LF отбиваются заодно.
- Типы, выведенные из <https://docs.mailinfra.ru/openapi/mailinfra-public.json> через
  `openapi-typescript` — руками интерфейсы не дублируются.
- `verify`, `constructEvent`, `sign` — проверка HMAC-подписи вебхуков на WebCrypto
  с защитой от replay.
- Определение окружения по префиксу ключа (`mi_live_` / `mi_test_`) и опция
  `requireEnvironment`.

### Не входит

- Management API (домены, шаблоны, список подавления, вебхуки, API-ключи) — у него
  нет машинной аутентификации, см. README.
