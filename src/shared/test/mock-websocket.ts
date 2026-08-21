/**
 * Test double for the browser WebSocket. Records sent frames and lets tests
 * drive server events (open / message / close). Shared by the STT adapter tests
 * and the speech-recognition polyfill tests.
 *
 * By default the socket stays CONNECTING until `simulateOpen()` is called. For
 * code paths that assume the socket opens on its own, set the static
 * `MockWebSocket.autoOpen = true` in a `beforeEach` — it then opens on a
 * microtask after construction. Each test file should reset `instances` (and
 * `autoOpen`, if it sets it) in `beforeEach`.
 */
export class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: MockWebSocket[] = []
  static autoOpen = false

  readyState: number = MockWebSocket.CONNECTING
  sent: (string | ArrayBuffer)[] = []
  onopen: ((ev?: unknown) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null

  constructor(public url: string, public protocols?: string | string[]) {
    MockWebSocket.instances.push(this)
    if (MockWebSocket.autoOpen) {
      // Open on a microtask so it resolves within the same promise-chain tick.
      Promise.resolve().then(() => this.simulateOpen())
    }
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.({})
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) })
  }

  simulateClose(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code, reason })
  }
}
