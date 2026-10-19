interface ClosableEventSource {
  close(): void
}

export function createNotificationEventSourceController<T extends ClosableEventSource>(
  getBaseUrl: () => string,
  createEventSource: (url: string) => T,
) {
  let current: T | null = null

  return {
    restart(): T {
      current?.close()
      current = createEventSource(`${getBaseUrl()}/api/notifications/stream`)
      return current
    },
    stop(): void {
      current?.close()
      current = null
    },
  }
}
