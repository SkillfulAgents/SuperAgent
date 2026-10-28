import { describe, expect, it } from 'vitest'
import { emailAnswer, renderRequestEmail, type EmailQuestion } from './request-email'

const question = (overrides: Partial<EmailQuestion> = {}): EmailQuestion => ({
  question: 'Which mailboxes?', options: [{ label: 'Chris' }, { label: 'Alex' }, { label: 'Both' }], multiSelect: false, ...overrides,
})

describe('emailAnswer', () => {
  it('maps an option number or label to the option, and keeps anything else as written', () => {
    for (const [reply, answer] of [['2', 'Alex'], ['2.', 'Alex'], ['#3', 'Both'], ['Option 1', 'Chris'], ['both', 'Both'], ['Alex!', 'Alex'],
      ['4', '4'], ['1, 2', '1, 2'], ['Go with 2 please', 'Go with 2 please']]) {
      expect(emailAnswer(question(), reply)).toBe(answer)
    }
  })
  it('takes several numbers for a multi-select question', () => {
    expect(emailAnswer(question({ multiSelect: true }), '1, 3')).toBe('Chris, Both')
    expect(emailAnswer(question({ multiSelect: true }), '3 and 1')).toBe('Both, Chris')
    expect(emailAnswer(question({ multiSelect: true }), '1, 5')).toBe('1, 5')
  })
  it('answers with the reply alone, not the quoted question or the signature', () => {
    expect(emailAnswer(question(), '2\n\nOn Tue, Oct 20, 2026 at 3:27 PM Agent <agent@company.ongamut.so>\nwrote:\n\n> Which mailboxes?\n> 1. Chris')).toBe('Alex')
    expect(emailAnswer(question(), 'Both\n-- \nGraham')).toBe('Both')
    expect(emailAnswer(question({ options: [] }), 'Tuesday works\n\nOn Tue, Agent wrote:\n> Which day?')).toBe('Tuesday works')
  })
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
  it('numbers several questions and sends them to the app', () => {
    const { text } = renderRequestEmail(ask([question(), question({ question: 'When?', options: [] })]), null)
    expect(text).toContain('1. Which mailboxes?\n  1. Chris')
    expect(text).toContain('2. When?')
    expect(text).toContain("An email reply can't answer more than one question; open the Gamut app to answer them.")
  })
  it('points every other request, and a recovered question, at the app', () => {
    for (const request of [{ kind: 'secret', payload: { secretName: 'API_KEY' } }, { kind: 'question', payload: { recovered: true } }]) {
      const { text, html } = renderRequestEmail(request, 'https://gamut.example.com/agents/a/sessions/s')
      expect(text).toBe('This conversation needs your attention in the Gamut app. Open it to review. Email replies cannot approve privileged actions.\n\nOpen in Gamut: https://gamut.example.com/agents/a/sessions/s')
      expect(html).toContain('>Open in Gamut</a>')
    }
  })
})
