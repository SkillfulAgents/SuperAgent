/** Safe configuration error for direct helper callers. */
export class HelperConfigurationError extends Error {
  constructor(message = 'Choose an API-capable global summarizer in Settings → Model Providers') { super(message) }
}
