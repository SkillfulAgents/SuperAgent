import { apiFetch } from '@renderer/lib/api'

import { useEffect, useRef, useState } from 'react'
import { HelpCircle, Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { useRequestHandler } from '@renderer/hooks/use-request-handler'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { DeclineButton } from './decline-button'
import { RequestItemShell } from './request-item-shell'
import { RequestItemActions } from './request-item-actions'
import { cn } from '@shared/lib/utils/cn'

interface Question {
  question: string
  header: string
  options: Array<{ label: string; description: string }>
  multiSelect: boolean
}

interface QuestionRequestItemProps {
  toolUseId: string
  questions: Question[]
  sessionId: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

export function QuestionRequestItem({
  toolUseId,
  questions,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
}: QuestionRequestItemProps) {
  // Track selected options for each question (key is question index)
  // For single select: string (selected label)
  // For multi select: string[] (selected labels)
  const [selections, setSelections] = useState<Record<number, string | string[]>>({})
  // Track "Other" text input for each question
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({})
  // Track which questions have "Other" selected
  const [otherSelected, setOtherSelected] = useState<Record<number, boolean>>({})
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0)
  const otherTextareaRef = useRef<HTMLTextAreaElement | null>(null)

  const { status, error, submit } = useRequestHandler(onComplete)

  useEffect(() => {
    const textarea = otherTextareaRef.current
    if (!textarea) return

    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [currentQuestionIndex, otherSelected, otherTexts])

  const handleOptionChange = (questionIndex: number, label: string, multiSelect: boolean) => {
    if (multiSelect) {
      // Multi-select: toggle the option
      const current = (selections[questionIndex] as string[]) || []
      const newSelection = current.includes(label)
        ? current.filter((l) => l !== label)
        : [...current, label]
      setSelections((prev) => ({ ...prev, [questionIndex]: newSelection }))
      // Clear "Other" selection if selecting a regular option
      if (label !== '__other__') {
        setOtherSelected((prev) => ({ ...prev, [questionIndex]: false }))
      }
    } else {
      // Single select: set the option
      setSelections((prev) => ({ ...prev, [questionIndex]: label }))
      // Clear "Other" selection if selecting a regular option
      if (label !== '__other__') {
        setOtherSelected((prev) => ({ ...prev, [questionIndex]: false }))
      }
    }
  }

  const handleOtherToggle = (questionIndex: number, multiSelect: boolean) => {
    const isCurrentlySelected = otherSelected[questionIndex]
    setOtherSelected((prev) => ({ ...prev, [questionIndex]: !isCurrentlySelected }))

    if (!isCurrentlySelected) {
      // Selecting "Other"
      if (!multiSelect) {
        // For single select, clear other selections
        setSelections((prev) => ({ ...prev, [questionIndex]: '__other__' }))
      }
    } else {
      // Deselecting "Other"
      if (!multiSelect) {
        setSelections((prev) => ({ ...prev, [questionIndex]: '' }))
      }
    }
  }

  const handleOtherTextChange = (questionIndex: number, text: string, multiSelect: boolean) => {
    setOtherTexts((prev) => ({ ...prev, [questionIndex]: text }))
    // Auto-select "Other" when user types something
    if (text && !otherSelected[questionIndex]) {
      setOtherSelected((prev) => ({ ...prev, [questionIndex]: true }))
      if (!multiSelect) {
        setSelections((prev) => ({ ...prev, [questionIndex]: '__other__' }))
      }
    }
  }

  const ensureOtherSelected = (questionIndex: number, multiSelect: boolean) => {
    if (otherSelected[questionIndex]) return

    setOtherSelected((prev) => ({ ...prev, [questionIndex]: true }))
    if (!multiSelect) {
      setSelections((prev) => ({ ...prev, [questionIndex]: '__other__' }))
    }
  }

  const isQuestionAnswered = (questionIndex: number, question: Question): boolean => {
    if (otherSelected[questionIndex] && otherTexts[questionIndex]?.trim()) {
      return true
    }

    const selection = selections[questionIndex]
    if (question.multiSelect) {
      return Array.isArray(selection) && selection.length > 0
    }
    return typeof selection === 'string' && selection !== '' && selection !== '__other__'
  }

  const areAllQuestionsAnswered = (): boolean => {
    return questions.every((q, i) => isQuestionAnswered(i, q))
  }

  const currentQuestion = questions[currentQuestionIndex]
  const currentQuestionAnswered = currentQuestion
    ? isQuestionAnswered(currentQuestionIndex, currentQuestion)
    : false

  const getAnswerForQuestion = (questionIndex: number, question: Question): string => {
    // If "Other" is selected and has text, use that
    if (otherSelected[questionIndex] && otherTexts[questionIndex]?.trim()) {
      return otherTexts[questionIndex].trim()
    }

    const selection = selections[questionIndex]
    if (question.multiSelect && Array.isArray(selection)) {
      return selection.join(', ')
    }
    return (selection as string) || ''
  }

  const postAnswer = async (body: Record<string, unknown>) => {
    const response = await apiFetch(
      `/api/agents/${agentSlug}/sessions/${sessionId}/answer-question`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolUseId, ...body }),
      }
    )
    if (!response.ok) {
      const data = await response.json()
      throw new Error(data.error || 'Request failed')
    }
  }

  const handleSubmit = () => {
    if (!areAllQuestionsAnswered()) return

    const answers: Record<string, string> = {}
    questions.forEach((q, i) => {
      answers[q.question] = getAnswerForQuestion(i, q)
    })

    submit(() => postAnswer({ answers }), 'answered')
  }

  const handleDecline = (reason?: string) => {
    submit(
      () => postAnswer({ decline: true, declineReason: reason || 'User declined to answer' }),
      'declined',
    )
  }

  const titleText = questions.length === 1 ? 'Question' : 'Questions'
  const titleTextWithCount = questions.length === 1 ? 'Question' : `${questions.length} Questions`

  // Build completed config
  const completedConfig = (status === 'answered' || status === 'declined')
    ? {
        icon: (
          <HelpCircle
            className={cn(
              'h-4 w-4 shrink-0',
              status === 'answered' ? 'text-green-500' : 'text-red-500'
            )}
          />
        ),
        label: titleTextWithCount,
        statusLabel: status === 'answered' ? 'Answered' : 'Declined',
        isSuccess: status === 'answered',
      }
    : null

  // Build read-only config
  const readOnlyConfig = readOnly
    ? {
        description: (
          <div className="mt-4 space-y-2">
            {questions.map((q, i) => (
              <p key={i} className="whitespace-pre-line text-sm font-medium leading-5 text-foreground">{q.question}</p>
            ))}
          </div>
        ),
      }
    : false as const

  // Pagination controls for headerRight
  const paginationControls = questions.length > 1 ? (
    <div className="inline-flex items-center gap-0.5 px-0.5 py-0.5 text-foreground">
      <button
        type="button"
        onClick={() => setCurrentQuestionIndex((i) => Math.max(0, i - 1))}
        disabled={currentQuestionIndex === 0 || status === 'submitting'}
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded transition-colors',
          currentQuestionIndex === 0 || status === 'submitting'
            ? 'cursor-not-allowed opacity-40'
            : 'hover:bg-muted'
        )}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span className="min-w-10 text-center text-xs font-medium">
        {currentQuestionIndex + 1} of {questions.length}
      </span>
      <button
        type="button"
        onClick={() => setCurrentQuestionIndex((i) => Math.min(questions.length - 1, i + 1))}
        disabled={currentQuestionIndex === questions.length - 1 || status === 'submitting'}
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded transition-colors',
          currentQuestionIndex === questions.length - 1 || status === 'submitting'
            ? 'cursor-not-allowed opacity-40'
            : 'hover:bg-muted'
        )}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  ) : undefined

  return (
    <RequestItemShell
      title={titleText}
      icon={<HelpCircle />}
      theme="blue"
      completed={completedConfig}
      readOnly={readOnlyConfig}
      waitingText="Waiting for response"
      headerRight={paginationControls}
      error={error}
      data-testid={completedConfig ? 'question-request-completed' : 'question-request'}
      data-status={completedConfig ? status : undefined}
    >
      {currentQuestion && (
        <div className="mt-6 space-y-4">
          <div className="px-2 py-1 text-sm font-medium leading-5 text-foreground">
            {currentQuestion.question}
          </div>

          <div className="space-y-2.5">
            {currentQuestion.options.map((option, optionIndex) => {
              const isSelected = currentQuestion.multiSelect
                ? ((selections[currentQuestionIndex] as string[]) || []).includes(option.label)
                : selections[currentQuestionIndex] === option.label

              return (
                <label
                  key={optionIndex}
                  className={cn(
                    'flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors',
                    isSelected
                      ? 'bg-blue-100 dark:bg-blue-900 border-blue-300 dark:border-blue-600'
                      : 'bg-white dark:bg-blue-950/30 hover:bg-blue-50 dark:hover:bg-blue-900/50'
                  )}
                >
                  <input
                  type={currentQuestion.multiSelect ? 'checkbox' : 'radio'}
                  name={`question-${currentQuestionIndex}`}
                  checked={isSelected}
                  onChange={() => handleOptionChange(currentQuestionIndex, option.label, currentQuestion.multiSelect)}
                  disabled={status === 'submitting'}
                  className="mx-2 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className={cn('text-sm text-foreground', isSelected ? 'font-medium' : 'font-normal')}>
                      {option.label}
                    </div>
                    {option.description && (
                      <div className="text-xs leading-4 text-muted-foreground whitespace-pre-line">{option.description}</div>
                    )}
                  </div>
                </label>
              )
            })}

            <label
              className={cn(
                'flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors',
                otherSelected[currentQuestionIndex]
                  ? 'bg-blue-100 dark:bg-blue-900 border-blue-300 dark:border-blue-600'
                  : 'bg-white dark:bg-blue-950/30 hover:bg-blue-50 dark:hover:bg-blue-900/50'
              )}
            >
              <input
                type={currentQuestion.multiSelect ? 'checkbox' : 'radio'}
                name={`question-${currentQuestionIndex}`}
                checked={otherSelected[currentQuestionIndex] || false}
                onChange={() => handleOtherToggle(currentQuestionIndex, currentQuestion.multiSelect)}
                disabled={status === 'submitting'}
                className="mx-2 shrink-0"
              />
              <div className="flex-1 min-w-0">
                <Textarea
                  ref={otherTextareaRef}
                  autoFocus={otherSelected[currentQuestionIndex]}
                  rows={1}
                  placeholder="Type something else"
                  value={otherTexts[currentQuestionIndex] || ''}
                  onChange={(e) => handleOtherTextChange(currentQuestionIndex, e.target.value, currentQuestion.multiSelect)}
                  onFocus={() => ensureOtherSelected(currentQuestionIndex, currentQuestion.multiSelect)}
                  disabled={status === 'submitting'}
                  className="min-h-0 resize-none overflow-hidden bg-white dark:bg-blue-950/30 border-input shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 text-sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    ensureOtherSelected(currentQuestionIndex, currentQuestion.multiSelect)
                  }}
                />
              </div>
            </label>
          </div>
        </div>
      )}

      {/* Action buttons */}
      <RequestItemActions>
        <DeclineButton
          onDecline={handleDecline}
          disabled={status === 'submitting'}
          className="border-border text-foreground hover:bg-muted"
          label="Skip"
          showIcon={false}
          data-testid="question-decline-btn"
        />

        {currentQuestionIndex < questions.length - 1 ? (
          <Button
            onClick={() => setCurrentQuestionIndex((i) => Math.min(questions.length - 1, i + 1))}
            disabled={!currentQuestionAnswered || status === 'submitting'}
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 text-white"
            data-testid="question-next-btn"
          >
            <span>Next</span>
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
        ) : (
          <Button
            onClick={handleSubmit}
            loading={status === 'submitting'}
            disabled={!areAllQuestionsAnswered()}
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 text-white"
            data-testid="question-submit-btn"
          >
            <Check className="h-4 w-4" />
            <span>Submit</span>
          </Button>
        )}
      </RequestItemActions>
    </RequestItemShell>
  )
}
