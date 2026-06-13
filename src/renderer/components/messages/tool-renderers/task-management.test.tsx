// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { taskCreateRenderer, taskUpdateRenderer, taskListRenderer } from './task-management'

describe('taskCreateRenderer', () => {
  describe('metadata', () => {
    it('has correct displayName', () => {
      expect(taskCreateRenderer.displayName).toBe('Create Task')
    })

    it('has an icon', () => {
      expect(taskCreateRenderer.icon).toBeDefined()
    })
  })

  describe('getSummary', () => {
    it('returns subject text', () => {
      expect(taskCreateRenderer.getSummary!({ subject: 'Set up database' }))
        .toBe('Set up database')
    })

    it('returns null for empty input', () => {
      expect(taskCreateRenderer.getSummary!({})).toBeNull()
    })
  })

  describe('ExpandedView', () => {
    const ExpandedView = taskCreateRenderer.ExpandedView!

    it('renders subject and description', () => {
      render(
        <ExpandedView
          input={{ subject: 'Set up database', description: 'Initialize PostgreSQL and run migrations' }}
        />
      )
      expect(screen.getByText('Set up database')).toBeInTheDocument()
      expect(screen.getByText('Initialize PostgreSQL and run migrations')).toBeInTheDocument()
    })

    it('renders subject only when no description', () => {
      render(<ExpandedView input={{ subject: 'Write tests' }} />)
      expect(screen.getByText('Write tests')).toBeInTheDocument()
    })

    it('handles empty input gracefully', () => {
      const { container } = render(<ExpandedView input={{}} />)
      expect(container.textContent).toBe('')
    })
  })
})

describe('taskUpdateRenderer', () => {
  describe('metadata', () => {
    it('has correct displayName', () => {
      expect(taskUpdateRenderer.displayName).toBe('Update Task')
    })

    it('has an icon', () => {
      expect(taskUpdateRenderer.icon).toBeDefined()
    })
  })

  describe('getSummary', () => {
    it('returns task id and status', () => {
      expect(taskUpdateRenderer.getSummary!({ taskId: '2', status: 'completed' }))
        .toBe('Task #2 completed')
    })

    it('returns null when no taskId', () => {
      expect(taskUpdateRenderer.getSummary!({})).toBeNull()
    })
  })

  describe('ExpandedView', () => {
    const ExpandedView = taskUpdateRenderer.ExpandedView!

    it('renders completed status with checkmark', () => {
      render(<ExpandedView input={{ taskId: '1', status: 'completed' }} />)
      expect(screen.getByText('Task #1')).toBeInTheDocument()
      expect(screen.getByText('✓')).toBeInTheDocument()
    })

    it('renders in_progress status with arrow', () => {
      render(<ExpandedView input={{ taskId: '2', status: 'in_progress' }} />)
      expect(screen.getByText('Task #2')).toBeInTheDocument()
      expect(screen.getByText('→')).toBeInTheDocument()
    })

    it('renders pending status with circle', () => {
      render(<ExpandedView input={{ taskId: '3', status: 'pending' }} />)
      expect(screen.getByText('Task #3')).toBeInTheDocument()
      expect(screen.getByText('○')).toBeInTheDocument()
    })
  })
})

describe('taskListRenderer', () => {
  it('has correct displayName', () => {
    expect(taskListRenderer.displayName).toBe('List Tasks')
  })

  it('has an icon', () => {
    expect(taskListRenderer.icon).toBeDefined()
  })
})
