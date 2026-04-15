/**
 * Chat integration utility functions.
 */

/** Capitalize the first letter of a provider name (e.g. "telegram" → "Telegram"). */
export function formatProviderName(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}
