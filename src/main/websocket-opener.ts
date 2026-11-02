import { WebSocket } from 'ws'
import type { WebSocketTarget } from '@shared/lib/agent-actor'

export type WebSocketOpener = (target: WebSocketTarget) => WebSocket

const openOverNetwork: WebSocketOpener = (target) =>
  new WebSocket(target.url, target.protocols, { headers: target.headers })

let opener: WebSocketOpener = openOverNetwork

/** Opens the socket a container's `webSocketTarget` names. */
export function openWebSocketTarget(target: WebSocketTarget): WebSocket {
  return opener(target)
}

/** For a deployment whose containers can't be reached by opening `target.url` directly. */
export function setWebSocketOpener(next: WebSocketOpener): void {
  opener = next
}
