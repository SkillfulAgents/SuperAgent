import { apiFetch } from '@renderer/lib/api'

import { useEffect, useRef, useState } from 'react'
import { HelpCircle, Check, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { DeclineButton } from './decline-button'
import { RequestTitleChip } from './request-title-chip'
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

type RequestStatus = 'pending' | 'submitting' | 'answered' | 'declined'

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

  const [status, setStatus] = useState<RequestStatus>('pending')
  const [error, setError] = useState<string | null>(null)

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
      setSelections({ ...selections, [questionIndex]: newSelection })
      // Clear "Other" selection if selecting a regular option
      if (label !== '__other__') {
        setOtherSelected({ ...otherSelected, [questionIndex]: false })
      }
    } else {
      // Single select: set the option
      setSelections({ ...selections, [questionIndex]: label })
      // Clear "Other" selection if selecting a regular option
      if (label !== '__other__') {
        setOtherSelected({ ...otherSelected, [questionIndex]: false })
      }
    }
  }

  const handleOtherToggle = (questionIndex: number, multiSelect: boolean) => {
    const isCurrentlySelected = otherSelected[questionIndex]
    setOtherSelected({ ...otherSelected, [questionIndex]: !isCurrentlySelected })

    if (!isCurrentlySelected) {
      // Selecting "Other"
      if (!multiSelect) {
        // For single select, clear other selections
        setSelections({ ...selections, [questionIndex]: '__other__' })
      }
    } else {
      // Deselecting "Other"
      if (!multiSelect) {
        setSelections({ ...selections, [questionIndex]: '' })
      }
    }
  }

  const handleOtherTextChange = (questionIndex: number, text: string, multiSelect: boolean) => {
    setOtherTexts({ ...otherTexts, [questionIndex]: text })
    // Auto-select "Other" when user types something
    if (text && !otherSelected[questionIndex]) {
      setOtherSelected({ ...otherSelected, [questionIndex]: true })
      if (!multiSelect) {
        setSelections({ ...selections, [questionIndex]: '__other__' })
      }
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

  const handleSubmit = async () => {
    if (!areAllQuestionsAnswered()) return

    setStatus('submitting')
    setError(null)

    // Build answers object
    const answers: Record<string, string> = {}
    questions.forEach((q, i) => {
      answers[q.question] = getAnswerForQuestion(i, q)
    })

    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/answer-question`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toolUseId,
            answers,
          }),
        }
      )

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to submit answers')
      }

      setStatus('answered')
      onComplete()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to submit answers'
      setError(message)
      setStatus('pending')
    }
  }

  const handleDecline = async (reason?: string) => {
    setStatus('submitting')
    setError(null)

    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/answer-question`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toolUseId,
            decline: true,
            declineReason: reason || 'User declined to answer',
          }),
        }
      )

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to decline')
      }

      setStatus('declined')
      onComplete()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to decline'
      setError(message)
      setStatus('pending')
    }
  }

  // Completed state - show minimal info
  if (status === 'answered' || status === 'declined') {
    return (
      <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm" data-testid="question-request-completed" data-status={status}>
        <div className="flex items-center gap-2 p-4">
          <HelpCircle
            className={cn(
              'h-4 w-4 shrink-0',
              status === 'answered' ? 'text-green-500' : 'text-red-500'
            )}
          />
          <span className="text-sm">
            {questions.length === 1 ? 'Question' : `${questions.length} Questions`}
          </span>
          <span
            className={cn(
              'ml-auto text-xs',
              status === 'answered' ? 'text-green-600' : 'text-red-600'
            )}
          >
            {status === 'answered' ? 'Answered' : 'Declined'}
          </span>
        </div>
      </div>
    )
  }

  // Read-only state for viewers
  if (readOnly) {
    return (
      <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm">
        <div className="flex items-start gap-3 p-4">
          <div className="flex-1 min-w-0">
            <RequestTitleChip className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" icon={<HelpCircle />}>
              {questions.length === 1 ? 'Question' : `${questions.length} Questions`}
            </RequestTitleChip>
          </div>
          <span className="text-xs text-blue-600 dark:text-blue-400 shrink-0">Waiting for response</span>
        </div>
      </div>
    )
  }

  // Pending/submitting state - show question form
  return (
    <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm" data-testid="question-request">
      <div className="p-4">
        <div className="flex-1 min-w-0 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <RequestTitleChip className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" icon={<HelpCircle />}>
              {questions.length === 1 ? 'Question' : 'Questions'}
            </RequestTitleChip>

            {questions.length > 1 && (
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
            )}
          </div>

          {currentQuestion && (
            <div className="space-y-4">
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
                    {otherSelected[currentQuestionIndex] ? (
                      <Textarea
                        ref={otherTextareaRef}
                        autoFocus
                        rows={1}
                        value={otherTexts[currentQuestionIndex] || ''}
                        onChange={(e) => handleOtherTextChange(currentQuestionIndex, e.target.value, currentQuestion.multiSelect)}
                        disabled={status === 'submitting'}
                        className="min-h-0 resize-none overflow-hidden bg-white dark:bg-blue-950/30 border-input shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 text-sm"
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <>
                        <div className="text-sm font-normal text-foreground">Other</div>
                        <div className="text-xs leading-4 text-muted-foreground">
                          Enter a custom answer that is not listed above.
                        </div>
                      </>
                    )}
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex justify-end gap-2">
            <DeclineButton
              onDecline={handleDecline}
              disabled={status === 'submitting'}
              className="border-blue-200 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900"
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
                disabled={!areAllQuestionsAnswered() || status === 'submitting'}
                size="sm"
                className="bg-blue-600 hover:bg-blue-700 text-white"
                data-testid="question-submit-btn"
              >
                {status === 'submitting' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                <span className="ml-1">Submit</span>
              </Button>
            )}
          </div>

          {/* Error message */}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </div>
    </div>
  )
}
