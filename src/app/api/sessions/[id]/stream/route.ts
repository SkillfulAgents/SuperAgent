import { NextRequest } from 'next/server'
import { messagePersister } from '@/lib/container/message-persister'

// GET /api/sessions/[id]/stream - SSE stream for real-time message updates
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  // Create a readable stream for SSE
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()

      // Subscribe FIRST to avoid missing any broadcasts
      // This prevents a race condition where:
      // 1. We check isSessionActive() → returns false
      // 2. Another request sets isActive = true and broadcasts session_active
      // 3. We miss the broadcast because we haven't subscribed yet
      // 4. We send connected with stale isActive: false
      const unsubscribe = messagePersister.addSSEClient(id, (data) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          )
        } catch (error) {
          // Stream might be closed
          console.error('Error sending SSE message:', error)
        }
      })

      // Now send the initial connection message with current state
      // Any broadcasts that happened after subscription will also be received
      const isActive = messagePersister.isSessionActive(id)
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({
          type: 'connected',
          isActive
        })}\n\n`)
      )

      // Handle client disconnect
      request.signal.addEventListener('abort', () => {
        unsubscribe()
        try {
          controller.close()
        } catch {
          // Already closed
        }
      })

      // Keep-alive ping every 30 seconds - includes isActive for state sync
      const pingInterval = setInterval(() => {
        try {
          const currentIsActive = messagePersister.isSessionActive(id)
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'ping', isActive: currentIsActive })}\n\n`)
          )
        } catch {
          clearInterval(pingInterval)
        }
      }, 30000)

      // Cleanup on close
      request.signal.addEventListener('abort', () => {
        clearInterval(pingInterval)
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
