import { describe, expect, it } from 'vitest'
import { renderRequestEmail, type EmailQuestion } from './request-email'

const question = (overrides: Partial<EmailQuestion> = {}): EmailQuestion => ({
  question: 'Which mailboxes?', options: [{ label: 'Chris' }, { label: 'Alex' }, { label: 'Both' }], multiSelect: false, ...overrides,
})

describe('renderRequestEmail', () => {
  const ask = (questions: EmailQuestion[]) => ({ kind: 'question', payload: { questions } })
  it('renders one question with numbered options, how to reply, and an escaped app link', () => {
    const { text, html } = renderRequestEmail(ask([question({ question: 'Allow <both>?', header: 'Signup', options: [{ label: 'Allow', description: 'Skips reCAPTCHA' }, { label: 'Deny' }] })]), 'https://gamut.example.com/agents/a/sessions/s?x="1"')
    expect(text).toBe('[Signup] Allow <both>?\n  1. Allow — Skips reCAPTCHA\n  2. Deny\n\nReply with the number of your choice, or write your own answer.\n\nAnswer in Gamut: https://gamut.example.com/agents/a/sessions/s?x="1"')
    expect(html).toContain('Allow &lt;both&gt;?')
    expect(html).toContain('Question · Signup')
    expect(html).toContain('href="https://gamut.example.com/agents/a/sessions/s?x=&quot;1&quot;"')
    expect(html).not.toContain('<both>')
  })
  it('says how to answer when there is no link, a multi-select, or no options', () => {
    expect(renderRequestEmail(ask([question()]), null).html).not.toContain('<a ')
    expect(renderRequestEmail(ask([question({ multiSelect: true })]), null).text).toContain('one or more option numbers')
    expect(renderRequestEmail(ask([question({ options: [] })]), null).text).toBe('Which mailboxes?\n\nReply to this email with your answer.')
  })
  it('numbers several questions and takes the answers by reply or in the app', () => {
    const { text } = renderRequestEmail(ask([question(), question({ question: 'When?', options: [] })]), null)
    expect(text).toContain('1. Which mailboxes?\n  1. Chris')
    expect(text).toContain('2. When?')
    expect(text).toContain('Reply to this email with your answers, or open the Gamut app to answer them.')
  })
  it('points every other request, and a recovered question, at the app', () => {
    for (const request of [{ kind: 'secret', payload: { secretName: 'API_KEY' } }, { kind: 'question', payload: { recovered: true } }]) {
      const { text, html } = renderRequestEmail(request, 'https://gamut.example.com/agents/a/sessions/s')
      expect(text).toBe('This conversation needs your attention in the Gamut app. Open it to review. Email replies cannot approve privileged actions, and a reply here ends the request.\n\nOpen in Gamut: https://gamut.example.com/agents/a/sessions/s')
      expect(html).toContain('>Open in Gamut</a>')
    }
  })
})
