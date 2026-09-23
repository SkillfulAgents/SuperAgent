/** Safe configuration error for direct helper callers. */
export class HelperConfigurationError extends Error {
  constructor() { super('Choose an API-capable global summarizer in Settings → Model Providers') }
}
