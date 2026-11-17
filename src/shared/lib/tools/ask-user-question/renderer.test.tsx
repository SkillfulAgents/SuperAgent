// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { askUserQuestionRenderer } from './renderer'

const ExpandedView = askUserQuestionRenderer.ExpandedView!

const input = {
  questions: [
    { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }], multiSelect: false },
  ],
}

describe('AskUserQuestion transcript view', () => {
  it('shows an answer as the answer, with its option ticked', () => {
    render(<ExpandedView input={input} result={'The user answered: "Which color?"="Blue".'} />)
    expect(screen.getByText('Blue', { selector: 'div' })).toBeInTheDocument()
    expect(screen.queryByTestId('ask-user-question-unanswered')).not.toBeInTheDocument()
    expect(screen.getByText('✓')).toBeInTheDocument()
  })

  it('shows a skipped question as skipped, with the reason the agent read, and ticks nothing', () => {
    render(
      <ExpandedView
        input={input}
        result={'The user answered: "Which color?"="Not now, thanks".'}
        unansweredQuestions={{ 'Which color?': 'skipped' }}
      />,
    )
    expect(screen.getByTestId('ask-user-question-unanswered')).toHaveTextContent('Skipped · Not now, thanks')
    expect(screen.queryByText('✓')).not.toBeInTheDocument()
  })
})
