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
    expect(screen.getByText('Other')).toBeInTheDocument()
  })

  it('renders option descriptions', () => {
    render(
      <QuestionRequestItem {...defaultProps} questions={singleQuestion} />
    )
    expect(screen.getByText('Relational database')).toBeInTheDocument()
    expect(screen.getByText('Document database')).toBeInTheDocument()
  })

  it('renders header chip', () => {
    render(
      <QuestionRequestItem {...defaultProps} questions={singleQuestion} />
    )
    expect(screen.getByText('DB')).toBeInTheDocument()
  })

  it('submit button is disabled when nothing is selected', () => {
    render(
      <QuestionRequestItem {...defaultProps} questions={singleQuestion} />
    )
    const submitButton = screen.getByText('Submit').closest('button')!
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
    await user.click(screen.getByText('Submit'))

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

    await user.click(screen.getByText('Submit'))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('Auth, API'),
        })
      )
    })
  })

  it('"Other" option shows text input when selected', async () => {
    const user = userEvent.setup()
    render(
      <QuestionRequestItem {...defaultProps} questions={singleQuestion} />
    )

    await user.click(screen.getByText('Other'))

    const input = screen.getByPlaceholderText('Enter your answer...')
    expect(input).toBeInTheDocument()
  })

  it('"Other" text input value is submitted', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => ({}) })

    render(
      <QuestionRequestItem {...defaultProps} questions={singleQuestion} />
    )

    await user.click(screen.getByText('Other'))
    const input = screen.getByPlaceholderText('Enter your answer...')
    await user.type(input, 'SQLite')
    await user.click(screen.getByText('Submit'))

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

    const submitButton = screen.getByText('Submit').closest('button')!
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

    await user.click(screen.getByText('Decline'))

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
    await user.click(screen.getByText('Submit'))

    await waitFor(() => {
      expect(screen.getByText('Server error')).toBeInTheDocument()
    })
  })

  it('shows "Questions" (plural) header for multiple questions', () => {
    render(
      <QuestionRequestItem {...defaultProps} questions={twoQuestions} />
    )
    expect(screen.getByText('Questions from Agent')).toBeInTheDocument()
  })

  it('shows "Question" (singular) header for single question', () => {
    render(
      <QuestionRequestItem {...defaultProps} questions={singleQuestion} />
    )
    expect(screen.getByText('Question from Agent')).toBeInTheDocument()
  })
})
