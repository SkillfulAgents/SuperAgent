# Plan: HTTP over IPC for Electron

## Overview

Replace the localhost HTTP server with IPC-based communication in Electron, while keeping the same HTTP semantics (paths, methods, headers, bodies). This allows:

- No port conflicts (no localhost:3001)
- Better security (no localhost exposure)
- Same Hono routing logic
- Shared API code between web and Electron (just different transport)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Renderer Process                        │
│                                                             │
│  apiFetch('/api/agents')                                    │
│         │                                                   │
│         ▼                                                   │
│  ┌─────────────────┐                                        │
│  │ Transport Layer │ ── if Electron ──► ipcRenderer.invoke  │
│  └─────────────────┘ ── if Web ──────► fetch()              │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ IPC
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       Main Process                           │
│                                                             │
│  ipcMain.handle('http', ...)                                │
│         │                                                   │
│         ▼                                                   │
│  ┌─────────────────┐                                        │
│  │   Hono Router   │  ◄── Same routing logic as web         │
│  └─────────────────┘                                        │
│         │                                                   │
│         ▼                                                   │
│  Return serialized response                                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 1: IPC HTTP Handler (Main Process)

### 1.1 Create `src/main/ipc-http.ts`

```typescript
import { ipcMain } from 'electron'
import api from '../api'

interface IPCHttpRequest {
  method: string
  path: string
  headers?: Record<string, string>
  body?: string
}

interface IPCHttpResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
}

export function setupHttpIPC(): void {
  ipcMain.handle('http', async (event, request: IPCHttpRequest): Promise<IPCHttpResponse> => {
    // Construct a standard Request object
    const req = new Request(`http://localhost${request.path}`, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    })

    // Pass to Hono router
    const response = await api.fetch(req)

    // Serialize response for IPC
    return {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    }
  })
}
```

### 1.2 Update `src/main/index.ts`

```typescript
import { setupHttpIPC } from './ipc-http'

// Remove: import { serve } from '@hono/node-server'
// Remove: serve({ fetch: api.fetch, port: API_PORT }, ...)

// Add:
setupHttpIPC()
```

---

## Phase 2: Preload Script

### 2.1 Update `src/preload/index.ts`

```typescript
import { contextBridge, ipcRenderer } from 'electron'

interface FetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
}

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  // HTTP over IPC
  fetch: async (path: string, options?: FetchOptions): Promise<{
    status: number
    statusText: string
    headers: Record<string, string>
    body: string
  }> => {
    return ipcRenderer.invoke('http', {
      method: options?.method || 'GET',
      path,
      headers: options?.headers,
      body: options?.body,
    })
  },

  // SSE over IPC (see Phase 3)
  subscribeSSE: (channel: string, callback: (data: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  startSSE: (sessionId: string) => {
    ipcRenderer.send('sse:subscribe', sessionId)
  },

  stopSSE: (sessionId: string) => {
    ipcRenderer.send('sse:unsubscribe', sessionId)
  },
})
```

### 2.2 Add TypeScript types `src/renderer/types/electron.d.ts`

```typescript
interface ElectronAPI {
  platform: string
  fetch: (path: string, options?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  }) => Promise<{
    status: number
    statusText: string
    headers: Record<string, string>
    body: string
  }>
  subscribeSSE: (channel: string, callback: (data: any) => void) => () => void
  startSSE: (sessionId: string) => void
  stopSSE: (sessionId: string) => void
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

export {}
```

---

## Phase 3: SSE over IPC

SSE (Server-Sent Events) can't work over IPC directly since it's a streaming protocol. Instead, use IPC channels.

### 3.1 Create `src/main/ipc-sse.ts`

```typescript
import { ipcMain, BrowserWindow } from 'electron'
import { messagePersister } from '../shared/lib/container/message-persister'

const sseSubscriptions = new Map<string, () => void>()

export function setupSSEIPC(): void {
  ipcMain.on('sse:subscribe', (event, sessionId: string) => {
    const channel = `sse:${sessionId}`

    // Unsubscribe from any existing subscription
    const existingUnsub = sseSubscriptions.get(channel)
    if (existingUnsub) existingUnsub()

    // Subscribe to session events
    const unsubscribe = messagePersister.addSSEClient(sessionId, (data) => {
      // Send to renderer
      event.sender.send(channel, data)
    })

    // Send initial connected event
    event.sender.send(channel, {
      type: 'connected',
      isActive: messagePersister.isSessionActive(sessionId),
    })

    // Set up ping interval
    const pingInterval = setInterval(() => {
      event.sender.send(channel, {
        type: 'ping',
        isActive: messagePersister.isSessionActive(sessionId),
      })
    }, 30000)

    // Store cleanup function
    sseSubscriptions.set(channel, () => {
      clearInterval(pingInterval)
      unsubscribe()
    })
  })

  ipcMain.on('sse:unsubscribe', (event, sessionId: string) => {
    const channel = `sse:${sessionId}`
    const unsub = sseSubscriptions.get(channel)
    if (unsub) {
      unsub()
      sseSubscriptions.delete(channel)
    }
  })
}
```

### 3.2 Update `src/main/index.ts`

```typescript
import { setupHttpIPC } from './ipc-http'
import { setupSSEIPC } from './ipc-sse'

setupHttpIPC()
setupSSEIPC()
```

---

## Phase 4: Renderer Transport Layer

### 4.1 Update `src/renderer/lib/api.ts`

```typescript
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  // Electron: use IPC
  if (window.electronAPI) {
    const result = await window.electronAPI.fetch(path, {
      method: init?.method as string,
      headers: init?.headers as Record<string, string>,
      body: init?.body as string,
    })

    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    })
  }

  // Web: use regular fetch
  return fetch(path, init)
}
```

### 4.2 Update `src/renderer/hooks/use-message-stream.ts`

Replace EventSource with IPC-based streaming:

```typescript
import { getApiBaseUrl } from '@renderer/lib/env'

function getOrCreateEventSource(
  sessionId: string,
  queryClient: QueryClient
): { cleanup: () => void } {
  // Electron: use IPC
  if (window.electronAPI) {
    const channel = `sse:${sessionId}`

    // Start SSE subscription
    window.electronAPI.startSSE(sessionId)

    // Listen for events
    const unsubscribe = window.electronAPI.subscribeSSE(channel, (data) => {
      handleSSEMessage(sessionId, data, queryClient)
    })

    return {
      cleanup: () => {
        unsubscribe()
        window.electronAPI?.stopSSE(sessionId)
      }
    }
  }

  // Web: use EventSource
  const baseUrl = getApiBaseUrl()
  const es = new EventSource(`${baseUrl}/api/sessions/${sessionId}/stream`)

  es.onmessage = (event) => {
    const data = JSON.parse(event.data)
    handleSSEMessage(sessionId, data, queryClient)
  }

  return {
    cleanup: () => es.close()
  }
}

function handleSSEMessage(sessionId: string, data: any, queryClient: QueryClient) {
  // ... existing message handling logic ...
}
```

---

## Phase 5: Cleanup

### 5.1 Remove HTTP server from main process

In `src/main/index.ts`, remove:
- `import { serve } from '@hono/node-server'`
- `serve({ fetch: api.fetch, port: API_PORT }, ...)`
- `const API_PORT = 3001`

### 5.2 Update `src/renderer/lib/env.ts`

```typescript
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI
}

// No longer needed for Electron (IPC doesn't use URLs)
export function getApiBaseUrl(): string {
  // Only used for web
  return ''
}
```

### 5.3 Remove preload apiUrl

In `src/preload/index.ts`, remove `apiUrl: 'http://localhost:3001'`

---

## Files to Modify

| File | Change |
|------|--------|
| `src/main/index.ts` | Remove HTTP server, add IPC setup |
| `src/main/ipc-http.ts` | New file - HTTP over IPC handler |
| `src/main/ipc-sse.ts` | New file - SSE over IPC handler |
| `src/preload/index.ts` | Expose IPC fetch and SSE methods |
| `src/renderer/lib/api.ts` | Use IPC fetch in Electron |
| `src/renderer/lib/env.ts` | Simplify (no apiUrl for Electron) |
| `src/renderer/hooks/use-message-stream.ts` | Use IPC SSE in Electron |
| `src/renderer/types/electron.d.ts` | New file - TypeScript types |

---

## Benefits

1. **No port conflicts** - No localhost:3001 needed
2. **Better security** - API not exposed on network
3. **Simpler packaging** - No need to handle port-in-use errors
4. **Same code paths** - Hono router handles all requests identically
5. **Web compatibility** - Web version continues using regular fetch

---

## Testing

1. `npm run dev:electron` - Test IPC communication works
2. Verify all API calls work (agents, sessions, settings)
3. Verify SSE streaming works (message updates, typing indicators)
4. `npm run dist:mac` - Verify packaged app works
5. `npm run dev` - Verify web version still works with regular HTTP
