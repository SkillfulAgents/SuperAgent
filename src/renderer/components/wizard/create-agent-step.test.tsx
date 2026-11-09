// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CreateAgentFormProps } from '@renderer/components/agents/create-agent-form'
import type { SignupHandoff } from '@renderer/context/nav-transient-context'

const { handoff, formProps, formSubmit } = vi.hoisted(() => ({
  handoff: { current: null as SignupHandoff | null },
  formProps: { current: null as CreateAgentFormProps | null },
  formSubmit: vi.fn(async () => {}),
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
    if (props.continueRef) props.continueRef.current = async () => props.onContinue?.()
    return <div data-testid="create-agent-form">{props.header}</div>
  },
}))

import { CreateAgentContinueButton, CreateAgentStep, useCreateAgentFlow } from './create-agent-step'

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
  formSubmit.mockClear()
})

async function toAddons() {
  render(<Harness />)
  await userEvent.type(screen.getByTestId('agent-identity-name'), 'Scout{Enter}')
  await userEvent.click(screen.getByTestId('create-agent-continue'))
}

describe('CreateAgentStep', () => {
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
    expect(formProps.current?.identity).toEqual({ name: 'Scout', avatar: expect.objectContaining({ shape: 'hexagon' }) })
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
    expect(formProps.current?.identity?.name).toBe('Scouty')
  })

  it('opens on the describe step, unnamed, for a template handoff', () => {
    handoff.current = { template_slug: 'sales-assistant' }
    render(<Harness />)
    expect(screen.getByTestId('create-agent-form')).toBeVisible()
    expect(formProps.current?.identity).toBeNull()
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

  it('starts with self-improvement and memories on and the rest off', async () => {
    await toAddons()
    expect(screen.getByRole('switch', { name: /Self-Improvement/ })).toBeChecked()
    expect(screen.getByRole('switch', { name: /Memories/ })).toBeChecked()
    expect(screen.getByRole('switch', { name: /Proactivity/ })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: /Team Brain/ })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: /Inbox/ })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: /Slack/ })).not.toBeChecked()
    expect(screen.queryByTestId('addon-default-model')).toBeNull()
    // Knowledge & Context is just these two: no drive rows.
    expect(screen.queryByTestId(/^addon-drive-/)).toBeNull()
  })
})
