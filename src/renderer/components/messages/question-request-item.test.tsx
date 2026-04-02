// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QuestionRequestItem } from './question-request-item'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

const singleQuestion = [
  {
    question: 'Which database?',
    header: 'DB',
    options: [
      { label: 'PostgreSQL', description: 'Relational database' },
      { label: 'MongoDB', description: 'Document database' },
    ],
    multiSelect: false,
  },
]

const multiQuestion = [
  {
    question: 'Which features?',
    header: 'Features',
    options: [
      { label: 'Auth', description: 'User authentication' },
      { label: 'API', description: 'REST API endpoints' },
      { label: 'WebSocket', description: 'Real-time communication' },
    ],
    multiSelect: true,
  },
]

const twoQuestions = [
  ...singleQuestion,
  {
    question: 'Which cloud provider?',
    header: 'Cloud',
    options: [
      { label: 'AWS', description: 'Amazon Web Services' },
      { label: 'GCP', description: 'Google Cloud Platform' },
    ],
    multiSelect: false,
  },
]

const defaultProps = {
  toolUseId: 'tu-1',
  sessionId: 's-1',
  agentSlug: 'my-agent',
  onComplete: vi.fn(),
}

describe('QuestionRequestItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders question text and options', () => {
    render(
      <QuestionRequestItem {...defaultProps} questions={singleQuestion} />
    )
    expect(screen.getByText('Which database?')).toBeInTheDocument()
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument()
    expect(screen.getByText('MongoDB')).toBeInTheDocument()
    // "Other" is now a textarea with placeholder instead of a visible label
    expect(screen.getByPlaceholderText('Type something else')).toBeInTheDocument()
  })

  it('renders option descriptions', () => {
    render(
      <QuestionRequestItem {...defaultProps} questions={singleQuestion} />
    )
    expect(screen.getByText('Relational database')).toBeInTheDocument()
    expect(screen.getByText('Document database')).toBeInTheDocument()
  })

  it('renders title chip with "Question"', () => {
    render(
      <QuestionRequestItem {...defaultProps} questions={singleQuestion} />
    )
    expect(screen.getByText('Question')).toBeInTheDocument()
  })

  it('submit button is disabled when nothing is selected', () => {
    render(
      <QuestionRequestItem {...defaultProps} questions={singleQuestion} />
    )
    const submitButton = screen.getByTestId('question-submit-btn')
    expect(submitButton).toBeDisabled()
  })

  it('single select: selects an option and submits', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => ({}) })

    render(
      <QuestionRequestItem {...defaultProps} questions={singleQuestion} />
    )

    // Select PostgreSQL
    await user.click(screen.getByText('PostgreSQL'))

    // Submit
    await user.click(screen.getByTestId('question-submit-btn'))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/agents/my-agent/sessions/s-1/answer-question',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('PostgreSQL'),
        })
      )
    })

    await waitFor(() => {
      expect(screen.getByText('Answered')).toBeInTheDocument()
    })
    expect(defaultProps.onComplete).toHaveBeenCalled()
  })

  it('multi select: selects multiple options', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => ({}) })

    render(
      <QuestionRequestItem {...defaultProps} questions={multiQuestion} />
    )

    // Select Auth and API
    await user.click(screen.getByText('Auth'))
    await user.click(screen.getByText('API'))

    await user.click(screen.getByTestId('question-submit-btn'))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('Auth, API'),
        })
      )
    })
  })

  it('"Other" textarea is always visible', () => {
    render(
      <QuestionRequestItem {...defaultProps} questions={singleQuestion} />
    )

    const textarea = screen.getByPlaceholderText('Type something else')
    expect(textarea).toBeInTheDocument()
  })

  it('typing in "Other" textarea auto-selects the Other option', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => ({}) })

    render(
      <QuestionRequestItem {...defaultProps} questions={singleQuestion} />
    )

    const textarea = screen.getByPlaceholderText('Type something else')
    await user.type(textarea, 'SQLite')
    await user.click(screen.getByTestId('question-submit-btn'))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('SQLite'),
        })
      )
    })
  })

  it('"Other" textarea value is submitted', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => ({}) })

    render(
      <QuestionRequestItem {...defaultProps} questions={singleQuestion} />
    )

    // Focus the textarea to auto-select "Other"
    const textarea = screen.getByPlaceholderText('Type something else')
    await user.click(textarea)
    await user.type(textarea, 'SQLite')
    await user.click(screen.getByTestId('question-submit-btn'))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('SQLite'),
        })
      )
    })
  })

  it('multi-question: requires all questions to be answered', async () => {
    const user = userEvent.setup()
    render(
      <QuestionRequestItem {...defaultProps} questions={twoQuestions} />
    )

    // Only answer first question
    await user.click(screen.getByText('PostgreSQL'))

    // With multi-question, first page shows "Next" button, not "Submit"
    const nextButton = screen.getByTestId('question-next-btn')
    expect(nextButton).not.toBeDisabled()

    // Go to next question
    await user.click(nextButton)

    // Now on second question, Submit should be disabled since it's unanswered
    const submitButton = screen.getByTestId('question-submit-btn')
    expect(submitButton).toBeDisabled()

    // Answer second question
    await user.click(screen.getByText('AWS'))
    expect(submitButton).not.toBeDisabled()
  })

  it('decline sends decline request', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => ({}) })

    render(
      <QuestionRequestItem {...defaultProps} questions={singleQuestion} />
    )

    await user.click(screen.getByTestId('question-decline-btn'))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"decline":true'),
        })
      )
    })

    await waitFor(() => {
      expect(screen.getByText('Declined')).toBeInTheDocument()
    })
  })

  it('shows error on API failure', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Server error' }),
    })

    render(
      <QuestionRequestItem {...defaultProps} questions={singleQuestion} />
    )

    await user.click(screen.getByText('PostgreSQL'))
    await user.click(screen.getByTestId('question-submit-btn'))

    await waitFor(() => {
      // RequestError prefixes "Error: " before the message
      expect(screen.getByText(/Server error/)).toBeInTheDocument()
    })
  })

  it('shows "Questions" (plural) title for multiple questions', () => {
    render(
      <QuestionRequestItem {...defaultProps} questions={twoQuestions} />
    )
    expect(screen.getByText('Questions')).toBeInTheDocument()
  })

  it('shows "Question" (singular) title for single question', () => {
    render(
      <QuestionRequestItem {...defaultProps} questions={singleQuestion} />
    )
    expect(screen.getByText('Question')).toBeInTheDocument()
  })
})
