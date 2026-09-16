/** A provider-owned message that is safe to show to the caller. */
export class VoiceProviderError extends Error {
  constructor(message: string, readonly status: 400 | 502 = 502) {
    super(message)
    this.name = 'VoiceProviderError'
  }
}
