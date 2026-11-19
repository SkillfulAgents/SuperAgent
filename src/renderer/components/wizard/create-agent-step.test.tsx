// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CreateAgentFormProps } from '@renderer/components/agents/create-agent-form'
import type { SignupHandoff } from '@renderer/context/nav-transient-context'

const { track, handoff, formProps, formSubmit, create, rename, start, navigate } = vi.hoisted(() => ({
  track: vi.fn(),
  create: vi.fn(async ({ name }: { name: string }) => ({ name, slug: 'scout', displaySlug: 'scout-id', replayed: false })),
  rename: vi.fn(async () => ({ slug: 'scout', displaySlug: 'scouty-id' })),
  start: vi.fn(),
  navigate: vi.fn(),
  handoff: { current: null as SignupHandoff | null },
  formProps: { current: null as CreateAgentFormProps | null },
  formSubmit: vi.fn(async () => {}),
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useCreateAgent: () => ({ mutateAsync: create }),
  useUpdateAgent: () => ({ mutateAsync: rename }),
  useUpdateAgentAvatar: () => ({ mutateAsync: vi.fn() }),
  useStartAgent: () => ({ mutate: start }),
}))
vi.mock('@renderer/hooks/use-settings', () => ({ useWarmStartOnTypeEnabled: () => true }))
vi.mock('@renderer/context/analytics-context', () => ({ useAnalyticsTracking: () => ({ track }) }))
vi.mock('@tanstack/react-router', async (original) => ({
  ...await original<typeof import('@tanstack/react-router')>(), useNavigate: () => navigate,
}))
vi.mock('@renderer/components/agents/agent-addons-step', () => ({
  AgentAddonsStep: ({ header }: { header: React.ReactNode }) => <div>{header}</div>,
}))

vi.mock('@renderer/context/nav-transient-context', () => ({
  useNavTransient: () => ({ signupHandoff: handoff.current }),
}))
// The form is covered by its own tests; here only what the steps hand it.
vi.mock('@renderer/components/agents/create-agent-form', () => ({
  CreateAgentForm: (props: CreateAgentFormProps) => {
    formProps.current = props
    if (props.submitRef) props.submitRef.current = formSubmit
    // Continue from the bottom row: the form's own check is its concern.
    if (props.continueRef) props.continueRef.current = async () => props.onContinue?.('Prepare a briefing', {})
    return <div data-testid="create-agent-form">{props.header}</div>
  },
}))

import { CreateAgentContinueButton, CreateAgentStep } from './create-agent-step'
import { useCreateAgentFlow } from '@renderer/hooks/use-create-agent-flow'

/** The step plus the bottom row's Continue, as the create screen and wizard lay them out. */
function Harness() {
  const flow = useCreateAgentFlow()
  return (
    <>
      <CreateAgentStep flow={flow} />
      <CreateAgentContinueButton flow={flow} />
    </>
  )
}

beforeEach(() => {
  handoff.current = null
  formProps.current = null
  vi.clearAllMocks()
})

async function toAddons() {
  render(<Harness />)
  await userEvent.type(screen.getByTestId('agent-identity-name'), 'Scout{Enter}')
  await userEvent.click(screen.getByTestId('create-agent-continue'))
}

describe('CreateAgentStep', () => {
  it('skips the creation event when the named agent was already created by the first request', async () => {
    create.mockResolvedValueOnce({ name: 'Scout', slug: 'scout', displaySlug: 'scout-id', replayed: true })
    await toAddons()
    expect(track).not.toHaveBeenCalled()
  })

  it('asks for a name first and only continues once one is typed', async () => {
    render(<Harness />)
    expect(screen.getByRole('heading', { name: 'Name your first AI teammate' })).toBeInTheDocument()
    expect(screen.queryByTestId('create-agent-form')).toBeNull()
    expect(screen.getByTestId('agent-identity-continue')).toBeDisabled()

    await userEvent.type(screen.getByTestId('agent-identity-name'), '   ')
    expect(screen.getByTestId('agent-identity-continue')).toBeDisabled()
  })

  it('offers Continue only on the name step', async () => {
    render(<Harness />)
    await userEvent.type(screen.getByTestId('agent-identity-name'), 'Scout')
    await userEvent.click(screen.getByTestId('agent-identity-continue'))
    expect(screen.queryByTestId('agent-identity-continue')).toBeNull()
  })

  it('hands the trimmed name and the picked orb to the describe step', async () => {
    render(<Harness />)
    await userEvent.type(screen.getByTestId('agent-identity-name'), '  Scout  ')
    await userEvent.click(screen.getByRole('button', { name: 'Hexagon' }))
    await userEvent.click(screen.getByTestId('agent-identity-continue'))

    expect(screen.getByRole('heading', { name: 'What job do you want to give me?' })).toBeInTheDocument()
    expect(screen.getByTestId('agent-identity-name-label')).toHaveTextContent('Scout')
    expect(create).toHaveBeenCalledWith({ name: 'Scout', avatar: expect.objectContaining({ shape: 'hexagon' }), requestId: expect.any(String) })
  })

  it('continues on Enter in the name field', async () => {
    render(<Harness />)
    await userEvent.type(screen.getByTestId('agent-identity-name'), 'Scout{Enter}')
    expect(screen.getByTestId('create-agent-form')).toBeVisible()
  })

  it('goes back to the name step from the describe step without unmounting the form', async () => {
    render(<Harness />)
    await userEvent.type(screen.getByTestId('agent-identity-name'), 'Scout{Enter}')
    await userEvent.click(screen.getByTestId('agent-identity-edit'))

    expect(screen.getByTestId('agent-identity-name')).toHaveValue('Scout')
    // Hidden, not gone: a prompt typed there survives the trip back.
    expect(screen.getByTestId('create-agent-form')).not.toBeVisible()

    await userEvent.type(screen.getByTestId('agent-identity-name'), 'y{Enter}')
    expect(rename).toHaveBeenCalledWith({ slug: 'scout', name: 'Scouty' })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('opens on the describe step, unnamed, for a template handoff', () => {
    handoff.current = { template_slug: 'sales-assistant' }
    render(<Harness />)
    expect(screen.getByTestId('create-agent-form')).toBeVisible()
    expect(formProps.current?.existingAgent).toBeUndefined()
    expect(screen.getByRole('heading', { name: 'Describe your first AI teammate' })).toBeInTheDocument()
  })

  it('still asks for a name when the handoff carries a prompt', () => {
    handoff.current = { prompt: 'Draft my weekly update', template_slug: 'sales-assistant' }
    render(<Harness />)
    expect(screen.getByTestId('agent-identity-step')).toBeInTheDocument()
  })

  it('goes from the job step to add-ons, and creates from there', async () => {
    await toAddons()
    expect(screen.getByRole('heading', { name: 'Want to give me any add-ons? You can always modify later.' })).toBeInTheDocument()
    // The job step's form stays mounted: it holds the prompt the create sends.
    expect(screen.getByTestId('create-agent-form')).not.toBeVisible()

    await userEvent.click(screen.getByTestId('create-agent-finish'))
    expect(formSubmit).toHaveBeenCalledTimes(1)
  })

  it('starts the named agent in the background and skips straight to its empty home', async () => {
    render(<Harness />)
    await userEvent.type(screen.getByTestId('agent-identity-name'), 'Scout{Enter}')
    expect(start).toHaveBeenCalledWith({ slug: 'scout', source: 'warm-start' })
    await userEvent.click(screen.getByTestId('create-agent-skip'))
    expect(navigate).toHaveBeenCalledWith({ to: '/agents/$slug', params: { slug: 'scout-id' }, replace: true })
    expect(formSubmit).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
  })
})
