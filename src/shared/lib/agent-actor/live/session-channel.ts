/**
 * A session's own event stream: what the session's viewers (the app's
 * session view, chat integrations) hear as the session runs. Each listener
 * gets every event, in order, before `emit` returns; a listener that throws
 * reaches neither the emitter nor the other listeners.
 */
export interface SessionEvent {
  type: string
  [key: string]: unknown
}

export type SessionListener = (event: SessionEvent) => void

export class SessionChannel {
  private readonly listeners = new Set<SessionListener>()

  get listenerCount(): number {
    return this.listeners.size
  }

  emit(event: SessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[SessionChannel] Listener failed:', error)
      }
    }
  }

  /** Returns the unsubscribe function. */
  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
