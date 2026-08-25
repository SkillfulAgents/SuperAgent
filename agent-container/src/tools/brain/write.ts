import * as fs from 'fs'
import { callHost, XAgentError } from '../agents/host-client'
import { REQUEST_PROMPT } from './request-prompt'

const CURATOR_FILE = '/brains/global/CURATOR'

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) }
}

function readCuratorSlug(): string | null {
  try {
    const slug = fs.readFileSync(CURATOR_FILE, 'utf8').trim()
    return slug.length > 0 ? slug : null
  } catch {
    return null
  }
}

function formatInvokeResult(data: { sessionId: string; status: string; lastMessage?: string | null; error?: string }) {
  const lines = [`session_id: ${data.sessionId}`, `status: ${data.status}`]
  if (typeof data.lastMessage === 'string') lines.push('', '--- last message from agent ---', data.lastMessage)
  if (data.error) lines.push('', `note: ${data.error}`)
  return textResult(lines.join('\n'))
}

export async function executeBrainWrite(request: string, callerSessionId?: string) {
  if (!request.trim()) return textResult('A write request needs text.', true)
  const curator = readCuratorSlug()
  if (!curator) return textResult('Failed to write brain page: No curator', true)
  const caller = process.env.SUPERAGENT_AGENT_SLUG ?? ''
  try {
    const data = await callHost<{ sessionId: string; status: 'running' | 'completed'; lastMessage?: string | null; error?: string }>(
      'invoke',
      { slug: curator, prompt: REQUEST_PROMPT(request, caller, callerSessionId ?? ''), sync: true },
      { callerSessionId },
    )
    return formatInvokeResult(data)
  } catch (error) {
    if (error instanceof XAgentError) return textResult(`Failed to invoke curator: ${error.message}`, true)
    return textResult(`Failed to write brain page: ${String(error)}`, true)
  }
}
