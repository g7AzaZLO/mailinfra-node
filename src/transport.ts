/**
 * Политика повторов, backoff и разбор `Retry-After`.
 *
 * Логика решения «повторять или нет» вынесена из клиента, чтобы тестироваться
 * без сети и совпадать один-в-один с Python SDK.
 *
 * Ключевое различие между эндпоинтами — идемпотентность:
 *
 * - `POST /emails` идемпотентен: SDK сам ставит `Idempotency-Key` и
 *   переиспользует его на повторах, поэтому ретраить `5xx` и таймауты
 *   безопасно — бэкенд отдаст тот же результат, а не отправит письмо дважды.
 * - `POST /emails/batch` **не** принимает `Idempotency-Key`, а письма внутри
 *   батча коммитятся по одному. Повтор после `5xx`, таймаута или обрыва
 *   соединения может отправить часть писем второй раз, поэтому для него
 *   повторяется единственная ситуация, в которой заведомо ничего не принято:
 *   `429` от лимитёра, который отказывает до приёма писем.
 * - Отправка без `Idempotency-Key` (`idempotencyKey: null`,
 *   `autoIdempotency: false`) тоже неидемпотентна: бэкенд дедуплицирует
 *   только по ключу.
 */

export const DEFAULT_BASE_URL = "https://app.mailinfra.ru/v1";
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Статусы, которые имеет смысл повторять.
 *
 * 429 — лимит (бэкенд присылает `Retry-After`), 408/425 — таймаут/ранние
 * данные на стороне прокси, 5xx — временные отказы. 409
 * `idempotency_in_flight` сознательно не здесь: параллельный запрос с тем же
 * ключом ещё выполняется, и корректная реакция — отдать управление
 * вызывающему, а не крутить повторы вслепую.
 */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Для неидемпотентных запросов повторяем только то, где ничего не принято. */
export const RETRYABLE_STATUSES_NON_IDEMPOTENT: ReadonlySet<number> = new Set([429]);

/** Настройки повторов. */
export interface RetryPolicy {
  /** Сколько раз повторить сверх первой попытки. `0` — повторов нет. */
  maxRetries: number;
  /** Базовая задержка первой паузы, мс. */
  initialBackoffMs: number;
  /** Множитель роста задержки между попытками. */
  backoffFactor: number;
  /** Потолок собственной задержки, мс. */
  maxBackoffMs: number;
  /**
   * Порог доверия к `Retry-After`, мс. Если сервер просит подождать дольше —
   * SDK не спит, а отдаёт `RateLimitError`, чтобы вызывающий сам решил,
   * ждать или деградировать.
   */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  initialBackoffMs: 500,
  backoffFactor: 2,
  maxBackoffMs: 8_000,
  maxRetryAfterMs: 60_000,
};

/**
 * Разбирает заголовок `Retry-After`.
 *
 * Бэкенд MailInfra присылает секунды (`app.main.registerExceptionHandlers`),
 * но HTTP допускает и дату — её умеют присылать прокси и CDN перед API,
 * поэтому поддерживаются оба формата.
 *
 * @returns Задержка в миллисекундах или `undefined`, если заголовка нет либо
 * он не разобран.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) {
    return undefined;
  }

  const raw = value.trim();
  if (!raw) {
    return undefined;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }
  return Math.max(0, timestamp - now);
}

/** Повторять ли запрос с таким статусом. */
export function shouldRetryStatus(statusCode: number, idempotent: boolean): boolean {
  const allowed = idempotent ? RETRYABLE_STATUSES : RETRYABLE_STATUSES_NON_IDEMPOTENT;
  return allowed.has(statusCode);
}

export interface NextDelayInput {
  /** Номер завершившейся попытки, начиная с 0. */
  attempt: number;
  policy: RetryPolicy;
  /** Разобранное значение `Retry-After` в мс, если было. */
  retryAfterMs?: number | undefined;
  /** Размывать ли собственную задержку. Отключается в тестах. */
  jitter?: boolean;
}

/**
 * Считает паузу перед следующей попыткой.
 *
 * `Retry-After` приоритетнее собственного backoff: сервер знает про свои окна
 * лимитов больше, чем клиент. Но доверие ограничено `maxRetryAfterMs` —
 * иначе один длинный `Retry-After` подвесил бы вызывающий код на минуты.
 *
 * @returns Задержка в мс или `undefined`, если ждать не следует (сервер
 * просит слишком долго — пусть решает вызывающий).
 */
export function nextDelay(input: NextDelayInput): number | undefined {
  const { attempt, policy, retryAfterMs, jitter = true } = input;

  if (retryAfterMs !== undefined) {
    return retryAfterMs > policy.maxRetryAfterMs ? undefined : retryAfterMs;
  }

  const base = Math.min(
    policy.maxBackoffMs,
    policy.initialBackoffMs * policy.backoffFactor ** attempt,
  );
  if (!jitter) {
    return base;
  }

  // Half jitter: половина задержки фиксированная, половина случайная. Полный
  // jitter иногда даёт почти нулевую паузу и повтор улетает в тот же
  // перегруженный сервер; фиксированная пауза без jitter собирает клиентов в
  // синхронные волны.
  return base / 2 + Math.random() * (base / 2);
}

/**
 * Пауза между повторами, прерываемая сигналом отмены.
 *
 * Без учёта сигнала отменённый вызов досыпал бы свой backoff до конца —
 * до восьми секунд на последней попытке.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason as Error);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
