
import { MessageCircleQuestion } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps } from './types'

interface QuestionOption {
  label: string
  description?: string
}

interface Question {
  question: string
  header?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

interface AskUserQuestionInput {
  questions?: Question[]
}

function parseInput(input: unknown): AskUserQuestionInput {
  if (typeof input === 'object' && input !== null) {
    return input as AskUserQuestionInput
  }
  return {}
}

function getSummary(input: unknown): string | null {
  const { questions } = parseInput(input)
  if (!questions || !Array.isArray(questions) || questions.length === 0) return null

  const first = questions[0].question
  const truncated = first.length > 50 ? first.slice(0, 47) + '...' : first
  if (questions.length > 1) {
    return `${truncated} (+ ${questions.length - 1} more)`
  }
  return truncated
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

function ExpandedView({ input, result, isError }: ToolRendererProps) {
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
          <div className="text-sm font-medium">{q.question}</div>

          {/* Answer */}
          {answers[q.question] && (
            <div className="bg-green-50 dark:bg-green-950 text-green-800 dark:text-green-200 rounded px-2 py-1 text-xs">
              {answers[q.question]}
            </div>
          )}

          {/* Options with selected indicator */}
          {q.options && q.options.length > 0 && (
            <div className="ml-2 space-y-0.5">
              {q.options.map((opt, j) => {
                const isSelected = answers[q.question] === opt.label
                return (
                  <div
                    key={j}
                    className={`text-xs flex items-start gap-1 ${isSelected ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
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
        <div className="bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200 rounded p-2 text-xs">
          {result}
        </div>
      )}
    </div>
  )
}

export const askUserQuestionRenderer: ToolRenderer = {
  displayName: 'Question',
  icon: MessageCircleQuestion,
  getSummary,
  ExpandedView,
}
