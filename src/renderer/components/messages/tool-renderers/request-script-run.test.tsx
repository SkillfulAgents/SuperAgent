// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { requestScriptRunRenderer } from './request-script-run'

describe('requestScriptRunRenderer', () => {
  describe('metadata', () => {
    it('has correct displayName', () => {
      expect(requestScriptRunRenderer.displayName).toBe('Run Script')
    })

    it('has Terminal icon', () => {
      expect(requestScriptRunRenderer.icon).toBeDefined()
    })
  })

  describe('getSummary', () => {
    it('returns scriptType and truncated explanation', () => {
      const summary = requestScriptRunRenderer.getSummary!({
        scriptType: 'shell',
        explanation: 'Check macOS version',
      })
      expect(summary).toBe('Shell: Check macOS version')
    })

    it('truncates long explanations', () => {
      const longExplanation = 'A'.repeat(100)
      const summary = requestScriptRunRenderer.getSummary!({
        scriptType: 'applescript',
        explanation: longExplanation,
      })
      expect(summary).toContain('AppleScript: ')
      expect(summary!.length).toBeLessThan(80)
      expect(summary).toContain('...')
    })

    it('returns scriptType only when no explanation', () => {
      const summary = requestScriptRunRenderer.getSummary!({
        scriptType: 'powershell',
      })
      expect(summary).toBe('PowerShell')
    })

    it('returns null for empty input', () => {
      const summary = requestScriptRunRenderer.getSummary!({})
      expect(summary).toBeNull()
    })
  })

  describe('ExpandedView', () => {
    const ExpandedView = requestScriptRunRenderer.ExpandedView!

    it('renders explanation', () => {
      render(<ExpandedView input={{ explanation: 'Check macOS version' }} />)
      expect(screen.getByText('Check macOS version')).toBeInTheDocument()
    })

    it('renders script in code block', () => {
      render(<ExpandedView input={{ script: 'sw_vers' }} />)
      expect(screen.getByText('sw_vers')).toBeInTheDocument()
    })

    it('renders script type label', () => {
      render(<ExpandedView input={{ scriptType: 'applescript' }} />)
      expect(screen.getByText('AppleScript')).toBeInTheDocument()
    })

    it('renders successful output', () => {
      render(
        <ExpandedView
          input={{ script: 'sw_vers', scriptType: 'shell' }}
          result='[{"type":"text","text":"Exit code: 0\\n\\nstdout:\\nmacOS 15.0"}]'
        />
      )
      expect(screen.getByText(/Exit code: 0/)).toBeInTheDocument()
    })

    it('renders error output with error styling', () => {
      render(
        <ExpandedView
          input={{ script: 'bad-cmd', scriptType: 'shell' }}
          result='[{"type":"text","text":"command not found"}]'
          isError
        />
      )
      expect(screen.getByText('Error')).toBeInTheDocument()
      expect(screen.getByText(/command not found/)).toBeInTheDocument()
    })
  })
})
