import { z } from 'zod'
import { splitEmailQuote } from './message-display'

const questionsSchema = z.object({ questions: z.array(z.object({
  question: z.string().min(1), header: z.string().optional(),
  options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() })).default([]),
  multiSelect: z.boolean().default(false),
})).min(1) })
export type EmailQuestion = z.infer<typeof questionsSchema>['questions'][number]

/** The questions of an AskUserQuestion request, or null for any other request (or a recovered stub). */
export function requestQuestions(request: { kind: string; payload: unknown }): EmailQuestion[] | null {
  if (request.kind !== 'question') return null
  const parsed = questionsSchema.safeParse(request.payload)
  return parsed.success ? parsed.data.questions : null
}

/** A reply's answer to one question: option numbers or labels become the labels, anything else is the person's own words. */
export function emailAnswer(question: EmailQuestion, text: string): string {
  const reply = splitEmailQuote(text).body.replace(/\n-- ?\n[\s\S]*$/, '').trim()
  const { options } = question
  const label = options.find(option => option.label.toLowerCase() === reply.replace(/[.!]$/, '').toLowerCase())?.label
  if (label) return label
  const numbers = reply.match(/^(?:options?\s*)?#?\d+(?:\s*(?:,|&|and|\s)\s*#?\d+)*\.?$/i) ? reply.match(/\d+/g)!.map(Number) : []
  const picked = numbers.map(n => options[n - 1]?.label)
  if (!numbers.length || picked.some(value => !value) || (!question.multiSelect && picked.length > 1)) return reply
  return [...new Set(picked)].join(', ')
}

function escape(text: string) {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
const lines = (text: string) => escape(text).replace(/\r?\n/g, '<br>')

// Inline styles and tables only: mail clients drop <style> and most layout CSS.
const FONT = 'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif'
const MUTED = 'color:#57606a;font-size:13px'

function questionHtml(question: EmailQuestion, number?: number) {
  const eyebrow = [number ? `Question ${number}` : 'Question', question.header].filter(Boolean).join(' · ')
  const options = question.options.map((option, index) => `<tr>
<td style="width:34px;vertical-align:top;padding:10px 0 0"><div style="width:24px;height:24px;border-radius:12px;background:#eef1f4;color:#1f2328;font-size:12px;font-weight:600;line-height:24px;text-align:center">${index + 1}</div></td>
<td style="border:1px solid #d0d7de;border-radius:8px;padding:10px 14px"><div style="font-weight:600;color:#1f2328">${escape(option.label)}</div>${option.description ? `<div style="${MUTED};margin-top:2px">${lines(option.description)}</div>` : ''}</td>
</tr>`).join('\n')
  return `<div style="font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#6e7781;margin:0 0 6px">${escape(eyebrow)}</div>
<div style="font-size:16px;line-height:1.5;color:#1f2328;margin:0 0 12px">${lines(question.question)}</div>
${options ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;border-spacing:0 8px;margin:0 0 4px">\n${options}\n</table>` : ''}`
}

function questionText(question: EmailQuestion, number?: number) {
  const title = [number ? `${number}.` : '', question.header ? `[${question.header}]` : '', question.question].filter(Boolean).join(' ')
  const options = question.options.map((option, index) => `  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`)
  return [title, ...options].join('\n')
}

function button(url: string, label: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 0"><tr><td style="border-radius:6px;background:#1f2328"><a href="${escape(url)}" style="display:inline-block;padding:10px 18px;${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px">${escape(label)}</a></td></tr></table>`
}

/**
 * The email that asks an agent user for input. One question can be answered by
 * replying; several, and every other request, only in the app.
 */
export function renderRequestEmail(request: { kind: string; payload: unknown }, appUrl: string | null): { text: string; html: string } {
  const questions = requestQuestions(request)
  const action = questions ? 'Answer in Gamut' : 'Open in Gamut'
  let hint: string
  if (questions?.length === 1) {
    const [question] = questions
    hint = !question.options.length ? 'Reply to this email with your answer.'
      : question.multiSelect ? 'Reply with one or more option numbers (such as 1, 3), or write your own answer.'
      : 'Reply with the number of your choice, or write your own answer.'
  } else if (questions) {
    hint = `An email reply can't answer more than one question; ${appUrl ? 'answer them in the app.' : 'open the Gamut app to answer them.'}`
  } else {
    hint = `This conversation needs your attention in the Gamut app. ${appUrl ? 'Open it to review.' : 'Please open the app to review it.'} Email replies cannot approve privileged actions.`
  }
  const body = questions?.map((question, index) => questionHtml(question, questions.length > 1 ? index + 1 : undefined)).join('<div style="height:16px"></div>') ?? ''
  const html = `<div style="${FONT};font-size:14px;line-height:1.5;color:#1f2328;max-width:560px">
${body}
<div style="${questions ? MUTED : 'font-size:14px'};margin:8px 0 0">${escape(hint)}</div>
${appUrl ? button(appUrl, action) : ''}
</div>`
  const text = [
    ...(questions?.map((question, index) => questionText(question, questions.length > 1 ? index + 1 : undefined)) ?? []),
    hint,
    ...(appUrl ? [`${action}: ${appUrl}`] : []),
  ].join('\n\n')
  return { text, html }
}
