// @vitest-environment jsdom

// The real Dialog keeps its content mounted through the close animation. The
// stub below renders content unconditionally to reproduce that closing frame,
// when the parent has already cleared `template`.

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

vi.mock('@renderer/hooks/use-agent-templates', () => ({
  useInstallAgentFromSkillset: () => ({
    mutateAsync: () => new Promise(() => {}),
    reset: vi.fn(),
    isPending: false,
    error: null,
  }),
}))
vi.mock('@renderer/components/ui/dialog', () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    Dialog: Passthrough,
    DialogContent: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough,
    DialogDescription: Passthrough,
  }
})

import { TemplateInstallDialog } from './template-install-dialog'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

const template: ApiDiscoverableAgent = {
  skillsetId: 'skillset-1',
  skillsetName: 'Public',
  name: 'Research Bot',
  description: 'Does research',
  version: '1.0.0',
  path: 'agents/research-bot/',
}

describe('TemplateInstallDialog closing frame', () => {
  it('keeps the last template name while the dialog animates closed', () => {
    const { rerender } = render(
      <TemplateInstallDialog template={template} onClose={() => {}} onInstalled={() => {}} />,
    )
    expect(screen.getByText('Installing Research Bot')).toBeTruthy()

    rerender(<TemplateInstallDialog template={null} onClose={() => {}} onInstalled={() => {}} />)

    expect(screen.getByText('Installing Research Bot')).toBeTruthy()
    expect(screen.getByText('From Public')).toBeTruthy()
    expect(screen.queryByText(/undefined/)).toBeNull()
  })
})
