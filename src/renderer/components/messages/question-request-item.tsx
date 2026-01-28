import { apiFetch } from '@renderer/lib/api'

import { useState } from 'react'
import { HelpCircle, Check, X, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
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
  onComplete: () => void
}

type RequestStatus = 'pending' | 'submitting' | 'answered' | 'declined'

export function QuestionRequestItem({
  toolUseId,
  questions,
  sessionId,
  agentSlug,
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

  const [status, setStatus] = useState<RequestStatus>('pending')
  const [error, setError] = useState<string | null>(null)

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

  const handleOtherTextChange = (questionIndex: number, text: string) => {
    setOtherTexts({ ...otherTexts, [questionIndex]: text })
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

  const handleDecline = async () => {
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
            declineReason: 'User declined to answer',
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
      <div className="border rounded-md bg-muted/30 text-sm">
        <div className="flex items-center gap-2 px-3 py-2">
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

  // Pending/submitting state - show question form
  return (
    <div className="border rounded-md bg-blue-50 border-blue-200 text-sm">
      <div className="flex items-start gap-3 p-3">
        {/* Icon */}
        <div className="h-8 w-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
          <HelpCircle className="h-4 w-4 text-blue-600" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Header */}
          <div className="font-medium text-blue-900">
            {questions.length === 1 ? 'Question from Agent' : 'Questions from Agent'}
          </div>

          {/* Questions */}
          {questions.map((question, questionIndex) => (
            <div key={questionIndex} className="space-y-2">
              {/* Question header chip and text */}
              <div className="flex items-start gap-2">
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 shrink-0">
                  {question.header}
                </span>
                <span className="text-blue-900">{question.question}</span>
              </div>

              {/* Options */}
              <div className="space-y-1.5 ml-1">
                {question.options.map((option, optionIndex) => {
                  const isSelected = question.multiSelect
                    ? ((selections[questionIndex] as string[]) || []).includes(option.label)
                    : selections[questionIndex] === option.label

                  return (
                    <label
                      key={optionIndex}
                      className={cn(
                        'flex items-start gap-2 p-2 rounded border cursor-pointer transition-colors',
                        isSelected
                          ? 'bg-blue-100 border-blue-300'
                          : 'bg-white border-blue-200 hover:bg-blue-50'
                      )}
                    >
                      <input
                        type={question.multiSelect ? 'checkbox' : 'radio'}
                        name={`question-${questionIndex}`}
                        checked={isSelected}
                        onChange={() => handleOptionChange(questionIndex, option.label, question.multiSelect)}
                        disabled={status === 'submitting'}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-blue-900">{option.label}</div>
                        {option.description && (
                          <div className="text-xs text-blue-700">{option.description}</div>
                        )}
                      </div>
                    </label>
                  )
                })}

                {/* "Other" option */}
                <label
                  className={cn(
                    'flex items-start gap-2 p-2 rounded border cursor-pointer transition-colors',
                    otherSelected[questionIndex]
                      ? 'bg-blue-100 border-blue-300'
                      : 'bg-white border-blue-200 hover:bg-blue-50'
                  )}
                >
                  <input
                    type={question.multiSelect ? 'checkbox' : 'radio'}
                    name={`question-${questionIndex}`}
                    checked={otherSelected[questionIndex] || false}
                    onChange={() => handleOtherToggle(questionIndex, question.multiSelect)}
                    disabled={status === 'submitting'}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-blue-900">Other</div>
                    {otherSelected[questionIndex] && (
                      <Input
                        type="text"
                        placeholder="Enter your answer..."
                        value={otherTexts[questionIndex] || ''}
                        onChange={(e) => handleOtherTextChange(questionIndex, e.target.value)}
                        disabled={status === 'submitting'}
                        className="mt-1 bg-white border-blue-200 focus:border-blue-400 text-sm"
                        onClick={(e) => e.stopPropagation()}
                      />
                    )}
                  </div>
                </label>
              </div>
            </div>
          ))}

          {/* Action buttons */}
          <div className="flex gap-2">
            <Button
              onClick={handleSubmit}
              disabled={!areAllQuestionsAnswered() || status === 'submitting'}
              size="sm"
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {status === 'submitting' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              <span className="ml-1">Submit</span>
            </Button>

            <Button
              onClick={handleDecline}
              disabled={status === 'submitting'}
              variant="outline"
              size="sm"
              className="border-blue-200 text-blue-700 hover:bg-blue-100"
            >
              <X className="h-4 w-4" />
              <span className="ml-1">Decline</span>
            </Button>
          </div>

          {/* Error message */}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </div>
    </div>
  )
}
