import { callHost, XAgentError } from '../agents/host-client'
import { BrainHostError, callBrainHost, getBrainCurator, textResult } from './host-client'
import { REQUEST_PROMPT } from './request-prompt'
import { persistResponseSchema } from './schemas'

function formatInvokeResult(data: {
  sessionId: string
  status: string
  lastMessage?: string | null
  error?: string
}) {
  const lines = [`session_id: ${data.sessionId}`, `status: ${data.status}`]
  if (typeof data.lastMessage === 'string') {
    lines.push('', '--- last message from agent ---', data.lastMessage)
  }
  if (data.error) {
    lines.push('', `note: ${data.error}`)
  }
  return textResult(lines.join('\n'))
}

export async function executeBrainWrite(
  args: {
    request?: string
    name?: string
    body?: string
    delete?: boolean
  },
  callerSessionId?: string,
) {
  try {
    if (args.request) {
      const curator = await getBrainCurator()
      if (!curator) return textResult('Failed to write brain page: No curator', true)
      const caller = process.env.SUPERAGENT_AGENT_SLUG ?? ''
      if (caller === curator) {
        return textResult('You are the curator. Write or delete a named page.', true)
      }
      const data = await callHost<{
        sessionId: string
        status: 'running' | 'completed'
        lastMessage?: string | null
        error?: string
      }>('invoke', {
        slug: curator,
        prompt: REQUEST_PROMPT(args.request, caller, callerSessionId ?? ''),
        sync: true,
      }, { callerSessionId })
      return formatInvokeResult(data)
    }

    const data = await callBrainHost('write', args, persistResponseSchema)
    if (data.status === 'wrote') return textResult(`Wrote ${data.name}.`)
    return textResult(`Deleted ${data.name}.`)
  } catch (error) {
    if (error instanceof XAgentError) {
      return textResult(`Failed to invoke curator: ${error.message}`, true)
    }
    const msg = error instanceof BrainHostError ? error.message : String(error)
    return textResult(`Failed to write brain page: ${msg}`, true)
  }
}
