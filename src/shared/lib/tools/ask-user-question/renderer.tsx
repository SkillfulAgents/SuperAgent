import { defineToolRenderer } from '../renderer-types'
import { CircleHelp } from 'lucide-react'
import type { ToolRendererProps } from '../renderer-types'
import { askUserQuestionDef, type AskUserQuestionInput } from './definition'
import type { UnansweredReason } from '../types'

const UNANSWERED_LABELS: Record<UnansweredReason, string> = {
  skipped: 'Skipped',
  replied_in_chat: 'Replied in chat',
  dismissed: 'Dismissed',
}

// Use the shared parser, which coerces a JSON-string `questions` argument back
// into an array (some models stringify complex tool args). Casting the raw
// input here instead would let a string reach `questions.map(...)` and crash.
function parseInput(input: unknown): AskUserQuestionInput {
  return askUserQuestionDef.parseInput(input)
}

/**
 * Parse the result string which looks like:
 * 'User has answered your questions: "Which demo?"="Schedule a task"'
 */
function parseAnswers(result: string): Record<string, string> {
  const answers: Record<string, string> = {}
  const pairRegex = /"([^"]+)"="([^"]+)"/g
  let match
  while ((match = pairRegex.exec(result)) !== null) {
    answers[match[1]] = match[2]
  }
  return answers
}

function ExpandedView({ input, result, isError, unansweredQuestions }: ToolRendererProps) {
  const { questions } = parseInput(input)
  const answers = result && !isError ? parseAnswers(result) : {}

  return (
    <div className="space-y-3">
      {questions && questions.map((q, i) => (
        <div key={i} className="space-y-1">
          {/* Question header chip */}
          {q.header && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
              {q.header}
            </span>
          )}

          {/* Question text */}
          <div className="text-xs font-medium">{q.question}</div>

          {/* Answer, or how the question went unanswered. An unanswered
              question's answer text is the reason the agent read, so it is
              shown as that, muted, never as a (green) answer. */}
          {unansweredQuestions?.[q.question] ? (
            <div
              className="bg-background text-muted-foreground rounded-item px-2 py-1 text-xs"
              data-testid="ask-user-question-unanswered"
            >
              <span className="font-medium">{UNANSWERED_LABELS[unansweredQuestions[q.question]]}</span>
              {answers[q.question] && <span> · {answers[q.question]}</span>}
            </div>
          ) : answers[q.question] && (
            <div className="bg-background text-green-800 dark:text-green-200 rounded-item px-2 py-1 text-xs">
              {answers[q.question]}
            </div>
          )}

          {/* Options with selected indicator */}
          {q.options && q.options.length > 0 && (
            <div className="ml-2 space-y-0.5">
              {q.options.map((opt, j) => {
                const isSelected = !unansweredQuestions?.[q.question] && answers[q.question] === opt.label
                return (
                  <div
                    key={j}
                    className={`text-xs flex items-start gap-1 ${isSelected ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
                  >
                    <span className="shrink-0">{isSelected ? '✓' : '○'}</span>
                    <span>
                      {opt.label}
                      {opt.description && (
                        <span className="text-muted-foreground font-normal ml-1">- {opt.description}</span>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ))}

      {/* Error case */}
      {isError && result && (
        <div className="bg-background text-red-800 dark:text-red-200 rounded-item p-2 text-xs">
          {result}
        </div>
      )}
    </div>
  )
}

export const askUserQuestionRenderer = defineToolRenderer(askUserQuestionDef, {
  icon: CircleHelp,
  ExpandedView,
})
