import { describe, expect, it } from 'vitest'
import { describeVoiceInputRequest } from './voice-input-request'
import type { PendingRequestDescriptor } from './use-pending-requests'

const base = { key: 'request-1', toolUseId: 'request-1', onComplete: () => {} }

describe('voice input request context', () => {
  it.each<[PendingRequestDescriptor, string[]]>([
    [{ ...base, kind: 'question', questions: [{ question: 'Which database should we use?', header: 'Database', options: [], multiSelect: false }] }, ['question card', 'Which database should we use?']],
    [{ ...base, kind: 'browser_input', message: 'Sign in to your account.', requirements: ['login', '2FA'] }, ['browser', 'Sign in to your account.', 'login', '2FA']],
    [{ ...base, kind: 'secret', secretName: 'API_KEY', reason: 'Needed for API access.' }, ['secret card', 'API_KEY', 'Needed for API access.']],
    [{ ...base, kind: 'connected_account', toolkit: 'gmail', reason: 'Find the receipt.' }, ['connection card', 'gmail', 'Find the receipt.']],
  ])('describes the $0.kind card using its displayed request context', (request, details) => {
    const context = describeVoiceInputRequest(request)
    expect(context.id).toBe(`${request.kind}:request-1`)
    for (const detail of details) expect(context.message).toContain(detail)
  })

  it('keeps raw scripts, connection URLs, and computer parameters out of the voice context', () => {
    const requests: PendingRequestDescriptor[] = [
      { ...base, kind: 'script_run', script: 'raw-script-with-sensitive-data', explanation: 'List files.', scriptType: 'shell' },
      { ...base, kind: 'remote_mcp', url: 'https://example.test?token=private-token', name: 'Documents' },
      { ...base, kind: 'computer_use', method: 'type', params: { text: 'private-input' }, permissionLevel: 'write', appName: 'Notes' },
    ]
    const context = requests.map(describeVoiceInputRequest)
    expect(context.map(request => request.message).join(' ')).not.toMatch(/raw-script|private-token|private-input/)
  })

  it('bounds large request text before sending it to voice', () => {
    const context = describeVoiceInputRequest({ ...base, kind: 'browser_input', message: 'x'.repeat(10000), requirements: [] })
    expect(context.message).toContain('browser')
    expect(context.message.length).toBeLessThanOrEqual(2000)
  })
})
