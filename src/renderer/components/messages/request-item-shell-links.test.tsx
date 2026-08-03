// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders as render } from '@renderer/test/test-utils'
import { QuestionRequestItem } from './question-request-item'
import { BrowserInputRequestItem } from './browser-input-request-item'

// BrowserInputRequestItem mounts BrowserCredentialPicker, which calls
// apiFetch(...).then(...) in an effect. A bare vi.fn() returns undefined and
// throws inside that effect, so the double has to resolve a Response.
vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ suggestions: [] }) })
  ),
}))

// The exact prose Tim hit: an agent asking a human to finish a device login,
// with the URL sitting inline in the question body.
const CLAY_URL = 'https://app.clay.com/oauth/device?user_code=LCWW-PKKC'
const CLAY_QUESTION = [
  {
    question:
      'Clay device login is waiting. Open this URL, approve access for ' +
      `Graham/DataWizz workspace, then come back here:\n\n${CLAY_URL}`,
    header: 'Clay login',
    options: [
      { label: 'Approved — continue', description: 'You completed the Clay device login in the browser.' },
      { label: 'Need a fresh code', description: 'Code expired or login failed.' },
    ],
    multiSelect: false,
  },
]

const questionProps = {
  toolUseId: 'tu-1',
  sessionId: 's-1',
  agentSlug: 'prospecting',
  onComplete: vi.fn(),
}

describe('request card link rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders a URL in the question prose as a clickable link', () => {
    render(<QuestionRequestItem {...questionProps} questions={CLAY_QUESTION} />)

    const link = screen.getByRole('link', { name: CLAY_URL })
    expect(link).toHaveAttribute('href', CLAY_URL)
  })

  // Gate A invariant: an anchor inside the option <label> would also toggle the
  // radio when clicked, so option text stays inert no matter what the title does.
  it('never renders a link inside an option description', () => {
    const withUrlInOption = [
      {
        ...CLAY_QUESTION[0],
        question: 'Pick one',
        options: [
          { label: 'Approved — continue', description: `Approve at ${CLAY_URL} first` },
        ],
      },
    ]
    render(<QuestionRequestItem {...questionProps} questions={withUrlInOption} />)

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByText(/Approve at/)).toBeInTheDocument()
  })

  // The shell only linkifies `title`. These two surfaces render the same
  // agent-authored prose outside it, so each needs its own call site.
  it('renders a URL in a browser-input requirement as a clickable link', () => {
    render(
      <BrowserInputRequestItem
        toolUseId="tu-2"
        message="Finish these steps"
        requirements={[`Open ${CLAY_URL} and approve access`]}
        sessionId="s-1"
        agentSlug="prospecting"
        onComplete={vi.fn()}
      />
    )

    expect(screen.getByRole('link', { name: CLAY_URL })).toHaveAttribute('href', CLAY_URL)
  })

  it('renders a URL in a read-only follow-up question as a clickable link', () => {
    const twoQuestions = [
      { ...CLAY_QUESTION[0], question: 'First question' },
      { ...CLAY_QUESTION[0], question: `Then open ${CLAY_URL}` },
    ]
    render(<QuestionRequestItem {...questionProps} questions={twoQuestions} readOnly />)

    expect(screen.getByRole('link', { name: CLAY_URL })).toHaveAttribute('href', CLAY_URL)
  })
})
