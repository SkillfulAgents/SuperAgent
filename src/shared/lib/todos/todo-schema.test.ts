import { describe, it, expect } from 'vitest'
import { createTodoSchema, deriveTodoTitle, todoAskFor, todoColumn, todoDisplayTitle, todoPrompt } from './todo-schema'

describe('todoColumn', () => {
  it('puts stored statuses in their own columns', () => {
    expect(todoColumn('draft', null)).toBe('drafts')
    expect(todoColumn('done', { isActive: true, isAwaitingInput: false })).toBe('done')
    expect(todoColumn('archived', null)).toBe('archived')
  })

  it('places active work by its session', () => {
    expect(todoColumn('active', { isActive: true, isAwaitingInput: false })).toBe('working')
    expect(todoColumn('active', { isActive: false, isAwaitingInput: false })).toBe('has_updates')
  })

  it('a blocked session needs the person even while its turn is open', () => {
    expect(todoColumn('active', { isActive: true, isAwaitingInput: true })).toBe('needs_input')
  })

  it('with nothing known about the session, there is something to look at', () => {
    expect(todoColumn('active', null)).toBe('has_updates')
  })
})

describe('todoPrompt', () => {
  it('heads the description with a written title', () => {
    expect(todoPrompt({ title: 'Churn', description: 'Why did it spike?' })).toBe('Churn\n\nWhy did it spike?')
  })

  it('sends whichever one there is', () => {
    expect(todoPrompt({ title: '', description: ' Why did churn spike? ' })).toBe('Why did churn spike?')
    expect(todoPrompt({ title: 'Book flights', description: '  ' })).toBe('Book flights')
  })
})

describe('titles', () => {
  it('derive from the first sentence of the description', () => {
    expect(deriveTodoTitle('- compare our pricing with Linear. Then rank them.')).toBe('Compare our pricing with Linear')
  })

  it('trim to whole words', () => {
    const title = deriveTodoTitle('Go through every one of the Granola notes from last week and pull out the requests')
    expect(title.length).toBeLessThanOrEqual(56)
    expect(title.endsWith(' ')).toBe(false)
  })

  it('show the written title first, then the derived one', () => {
    expect(todoDisplayTitle({ title: 'Mine', description: 'Other words' })).toBe('Mine')
    expect(todoDisplayTitle({ title: '', description: 'Other words' })).toBe('Other words')
    expect(todoDisplayTitle({ title: '', description: '' })).toBe('Untitled task')
  })
})

describe('createTodoSchema', () => {
  it('needs a title or a description', () => {
    expect(createTodoSchema.safeParse({ title: ' ', description: ' ' }).success).toBe(false)
    expect(createTodoSchema.safeParse({ title: 'x' }).success).toBe(true)
    expect(createTodoSchema.safeParse({ title: '', description: 'x' }).success).toBe(true)
  })
})

describe('todoAskFor', () => {
  const wait = (kind: Parameters<typeof todoAskFor>[0][number]['kind'], extra: Partial<{ blocking: boolean; autoApproved: boolean }> = {}) =>
    ({ kind, blocking: true, autoApproved: false, ...extra })

  it('groups request kinds into what the person does about them', () => {
    expect(todoAskFor([wait('question')])).toBe('answer')
    expect(todoAskFor([wait('script_run')])).toBe('permission')
    expect(todoAskFor([wait('proxy_review')])).toBe('permission')
    expect(todoAskFor([wait('account_reauth_required')])).toBe('reconnect')
    expect(todoAskFor([wait('connected_account')])).toBe('connect')
    expect(todoAskFor([wait('secret')])).toBe('info')
  })

  it('names the oldest request that actually blocks', () => {
    expect(todoAskFor([
      wait('script_run', { autoApproved: true }),
      wait('file', { blocking: false }),
      wait('account_reauth_required'),
      wait('question'),
    ])).toBe('reconnect')
  })

  it('is unknown when nothing blocks', () => {
    expect(todoAskFor([])).toBeNull()
    expect(todoAskFor([wait('question', { blocking: false })])).toBeNull()
  })
})
