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

      // Send initial connection message
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)
      )

      // Subscribe to message updates
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

      // Handle client disconnect
      request.signal.addEventListener('abort', () => {
        unsubscribe()
        try {
          controller.close()
        } catch {
          // Already closed
        }
      })

      // Keep-alive ping every 30 seconds
      const pingInterval = setInterval(() => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'ping' })}\n\n`)
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
