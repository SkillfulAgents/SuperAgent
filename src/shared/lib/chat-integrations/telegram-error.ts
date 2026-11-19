import { GrammyError, HttpError } from 'grammy'

/** Telegram answered that it is rate limiting the bot or failing itself, so the same call sent another way fails too. */
export function isTelegramBusy(err: unknown): boolean {
  return err instanceof GrammyError && (err.error_code === 429 || err.error_code >= 500)
}

/** The seconds Telegram asked the bot to wait before calling again, when it asked. */
export function telegramRetryAfter(err: unknown): number | undefined {
  return err instanceof GrammyError ? err.parameters.retry_after : undefined
}

/** A Telegram call that may succeed later: Telegram was busy, or never answered with JSON. */
export function isTelegramTemporary(err: unknown): boolean {
  return isTelegramBusy(err) || err instanceof HttpError
}
