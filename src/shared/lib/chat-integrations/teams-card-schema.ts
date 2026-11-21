import { z } from 'zod'
import type { Question } from '../tools/types'

const question = z.object({
  question: z.string().min(1), header: z.string().optional(), options: z.array(z.object({
    label: z.string().min(1), description: z.string().optional(),
  })).optional(), multiSelect: z.boolean().optional(),
})
export const teamsCardPayload = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('question'), questions: z.array(question).min(1) }),
  z.object({ kind: z.literal('review'), question: z.string() }),
  z.object({
    kind: z.literal('file'), path: z.string().min(1), filename: z.string().min(1), size: z.number().int().positive(),
    sha256: z.string().length(64),
    uploaded: z.object({ uniqueId: z.string(), fileType: z.string(), contentUrl: z.string().url() }).optional(),
  }),
])
export type TeamsCard = z.infer<typeof teamsCardPayload>
export const serializeTeamsCard = (card: TeamsCard) => JSON.stringify(teamsCardPayload.parse(card))
export const adaptiveContentType = 'application/vnd.microsoft.card.adaptive'
export const executeAction = z.object({ action: z.object({
  type: z.literal('Action.Execute'), verb: z.literal('gamut.respond'), data: z.record(z.string(), z.unknown()),
}) })
export const fileConsentAction = z.object({
  action: z.enum(['accept', 'decline']), context: z.object({ token: z.string().uuid() }),
  uploadInfo: z.object({ uploadUrl: z.string(), contentUrl: z.string(), uniqueId: z.string().min(1), fileType: z.string() }).optional(),
})

export const teamsFileEvent = z.object({
  kind: z.literal('teams.file-consent'), senderId: z.string().uuid(), consent: fileConsentAction,
})
const paragraph = (text: string) => ({ type: 'TextBlock', text, wrap: true })
const button = (token: string, title: string, answer?: string) => ({
  type: 'Action.Execute', verb: 'gamut.respond', title,
  data: { token, ...(answer ? { answer } : {}) },
  fallback: { type: 'Action.Submit', title, data: { token, ...(answer ? { answer } : {}) } },
})
export const adaptiveCard = (body: unknown[], actions?: unknown[]) => ({
  type: 'AdaptiveCard', version: '1.4', body, ...(actions ? { actions } : {}),
})
export function teamsQuestionCard(token: string, card: Exclude<TeamsCard, { kind: 'file' }>) {
  if (card.kind === 'review') return adaptiveCard([paragraph(card.question)], [
    button(token, 'Allow', 'allow'), button(token, 'Deny', 'deny'),
  ])
  return adaptiveCard(card.questions.flatMap((q, i) => {
    const input = { id: 'q' + i, label: q.question, isRequired: false }
    if (!q.options?.length) return [{ type: 'Input.Text', ...input, isMultiline: true }]
    return [
      { type: 'Input.ChoiceSet', ...input, style: 'expanded', isMultiSelect: !!q.multiSelect,
        choices: q.options.map((o, index) => ({ title: o.description ? o.label + ' — ' + o.description : o.label, value: String(index) })) },
      { type: 'Input.Text', id: 'other' + i, label: 'Other answer', isMultiline: true },
    ]
  }), [button(token, 'Send answers')])
}
export function teamsQuestionAnswers(questions: Question[], data: Record<string, unknown>): Record<string, string> | undefined {
  const answers: [string, string][] = []
  for (const [i, q] of questions.entries()) {
    const selected = data['q' + i]
    const other = data['other' + i]
    if (typeof other === 'string' && other.trim()) {
      if (other.length > 8000) return
      answers.push([q.question, other.trim()])
      continue
    }
    if (typeof selected !== 'string' || !selected.trim() || selected.length > 8000) return
    if (!q.options?.length) {
      answers.push([q.question, selected.trim()])
      continue
    }
    const indices = selected.split(',')
    if (!q.multiSelect && indices.length !== 1) return
    const labels: string[] = []
    for (const index of new Set(indices)) {
      if (!/^(0|[1-9]\d*)$/.test(index) || !q.options[Number(index)]) return
      labels.push(q.options[Number(index)].label)
    }
    answers.push([q.question, labels.join(', ')])
  }
  return Object.fromEntries(answers)
}
export function adaptiveReply(status: number, message: string) {
  return { status: 200, body: status === 200
    ? { statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: message }
    : { statusCode: status, type: 'application/vnd.microsoft.error', value: { code: String(status), message } } }
}
