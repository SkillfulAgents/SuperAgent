import { BrainHostError, callBrainHost, textResult } from './host-client'
import { pageReadResponseSchema } from './schemas'

export async function executeBrainRead(name: string) {
  try {
    const data = await callBrainHost('read', { name }, pageReadResponseSchema)
    if (!data.found) return textResult('Page not found.')
    return textResult(data.body)
  } catch (error) {
    const msg = error instanceof BrainHostError ? error.message : String(error)
    return textResult(`Failed to read brain page: ${msg}`, true)
  }
}
