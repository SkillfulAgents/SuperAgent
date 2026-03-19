// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MountChoiceDialog } from './mount-choice-dialog'

describe('MountChoiceDialog', () => {
  it('renders title with folder name when provided', () => {
    render(<MountChoiceDialog open={true} onChoice={vi.fn()} folderName="my-project" />)
    expect(screen.getByText(/attach "my-project"/)).toBeInTheDocument()
  })

  it('renders generic title when no folder name', () => {
    render(<MountChoiceDialog open={true} onChoice={vi.fn()} />)
    expect(screen.getByText(/attach this folder/)).toBeInTheDocument()
  })

  it('calls onChoice("upload") when Upload option clicked', async () => {
    const user = userEvent.setup()
    const onChoice = vi.fn()
    render(<MountChoiceDialog open={true} onChoice={onChoice} />)

    await user.click(screen.getByText('Upload a copy'))
    expect(onChoice).toHaveBeenCalledWith('upload')
  })

  it('calls onChoice("mount") when Mount option clicked', async () => {
    const user = userEvent.setup()
    const onChoice = vi.fn()
    render(<MountChoiceDialog open={true} onChoice={onChoice} />)

    await user.click(screen.getByText('Mount folder'))
    expect(onChoice).toHaveBeenCalledWith('mount')
  })

  it('calls onChoice("cancel") when Cancel clicked', async () => {
    const user = userEvent.setup()
    const onChoice = vi.fn()
    render(<MountChoiceDialog open={true} onChoice={onChoice} />)

    await user.click(screen.getByText('Cancel'))
    expect(onChoice).toHaveBeenCalledWith('cancel')
  })

  it('displays Read Only and Read & Write badges', () => {
    render(<MountChoiceDialog open={true} onChoice={vi.fn()} />)
    expect(screen.getByText('Read Only')).toBeInTheDocument()
    expect(screen.getByText('Read & Write')).toBeInTheDocument()
  })

  it('does not render content when closed', () => {
    render(<MountChoiceDialog open={false} onChoice={vi.fn()} folderName="test" />)
    expect(screen.queryByText(/attach "test"/)).not.toBeInTheDocument()
  })
})
