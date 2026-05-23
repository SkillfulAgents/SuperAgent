import { describe, it, expect } from 'vitest'
import { taskCreateDef, taskUpdateDef, taskListDef } from './task-management'

describe('taskCreateDef', () => {
  it('has correct displayName', () => {
    expect(taskCreateDef.displayName).toBe('Create Task')
  })

  describe('parseInput', () => {
    it('parses valid input', () => {
      const result = taskCreateDef.parseInput({
        subject: 'Set up database',
        description: 'Initialize PostgreSQL',
        activeForm: 'Setting up database',
      })
      expect(result).toEqual({
        subject: 'Set up database',
        description: 'Initialize PostgreSQL',
        activeForm: 'Setting up database',
      })
    })

    it('returns empty object for non-object input', () => {
      expect(taskCreateDef.parseInput(null)).toEqual({})
      expect(taskCreateDef.parseInput(undefined)).toEqual({})
      expect(taskCreateDef.parseInput('string')).toEqual({})
    })
  })

  describe('getSummary', () => {
    it('returns subject', () => {
      expect(taskCreateDef.getSummary({ subject: 'Write tests' })).toBe('Write tests')
    })

    it('returns null when no subject', () => {
      expect(taskCreateDef.getSummary({})).toBeNull()
      expect(taskCreateDef.getSummary({ description: 'only desc' })).toBeNull()
    })
  })
})

describe('taskUpdateDef', () => {
  it('has correct displayName', () => {
    expect(taskUpdateDef.displayName).toBe('Update Task')
  })

  describe('parseInput', () => {
    it('parses valid input', () => {
      const result = taskUpdateDef.parseInput({ taskId: '3', status: 'completed' })
      expect(result).toEqual({ taskId: '3', status: 'completed' })
    })

    it('returns empty object for non-object input', () => {
      expect(taskUpdateDef.parseInput(null)).toEqual({})
    })
  })

  describe('getSummary', () => {
    it('returns task id and status', () => {
      expect(taskUpdateDef.getSummary({ taskId: '2', status: 'completed' }))
        .toBe('Task #2 completed')
    })

    it('falls back to "updated" when no status', () => {
      expect(taskUpdateDef.getSummary({ taskId: '1' })).toBe('Task #1 updated')
    })

    it('returns null when no taskId', () => {
      expect(taskUpdateDef.getSummary({})).toBeNull()
      expect(taskUpdateDef.getSummary({ status: 'completed' })).toBeNull()
    })
  })
})

describe('taskListDef', () => {
  it('has correct displayName', () => {
    expect(taskListDef.displayName).toBe('List Tasks')
  })

  it('returns fixed summary', () => {
    expect(taskListDef.getSummary({})).toBe('Listed tasks')
  })
})
