// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { deriveTitle, todoActions, useTodoBoard } from './todo-store'
import { renderHook, act } from '@testing-library/react'

describe('deriveTitle', () => {
  it('takes the first sentence of the first non-empty line, capitalised', () => {
    expect(deriveTitle('\n\n  summarize the calls. Then rank them.')).toBe('Summarize the calls')
  })

  it('strips leading markdown and trailing punctuation', () => {
    expect(deriveTitle('# Fix the flaky test,')).toBe('Fix the flaky test')
  })

  it('cuts long lines at a word boundary', () => {
    const title = deriveTitle('Replace every hard-coded colour on the marketing site with the new token set and keep dark mode')
    expect(title.length).toBeLessThanOrEqual(56)
    expect(title).toBe('Replace every hard-coded colour on the marketing site')
  })

  it('falls back when there is nothing to name', () => {
    expect(deriveTitle('   \n ')).toBe('Untitled task')
  })
})

describe('todoActions', () => {
  beforeEach(() => {
    localStorage.clear()
    todoActions.resetToSeed()
  })

  it('creates a draft with a generated title that follows prompt edits until renamed', () => {
    const { result } = renderHook(() => useTodoBoard())
    let id = ''
    act(() => {
      id = todoActions.createDraft('write the release notes').id
    })
    const find = () => result.current.cards.find((c) => c.id === id)!
    expect(find()).toMatchObject({ column: 'drafts', title: 'Write the release notes', titleIsGenerated: true })

    act(() => todoActions.setPrompt(id, 'draft the changelog for 0.6'))
    expect(find().title).toBe('Draft the changelog for 0.6')

    act(() => todoActions.setTitle(id, 'Changelog'))
    act(() => todoActions.setPrompt(id, 'something else entirely'))
    expect(find()).toMatchObject({ title: 'Changelog', titleIsGenerated: false })
  })

  it('walks drafts → working → attention → working → done', () => {
    const { result } = renderHook(() => useTodoBoard())
    const id = todoActions.createDraft('ship it').id
    const find = () => result.current.cards.find((c) => c.id === id)!
    const agent = { slug: 'a1', name: 'Agent One' }

    act(() => todoActions.start(id, agent))
    expect(find()).toMatchObject({ column: 'working', agents: [agent] })

    act(() => todoActions.requestAttention(id, 'question', 'Which repo?'))
    expect(find()).toMatchObject({ column: 'attention', attentionReason: 'question', lastUpdate: 'Which repo?', simStep: 1 })

    act(() => todoActions.resume(id, 'The main one'))
    expect(find()).toMatchObject({ column: 'working', attentionReason: undefined })

    act(() => todoActions.markDone(id))
    expect(find().column).toBe('done')
  })

  it('a one-click ask resolves from the card and the agent carries on', () => {
    const { result } = renderHook(() => useTodoBoard())
    const id = todoActions.createDraft('publish it').id
    const find = () => result.current.cards.find((c) => c.id === id)!
    act(() => todoActions.start(id, { slug: 'a1', name: 'Agent One' }))
    act(() => todoActions.requestAttention(id, 'action', 'Ready to publish.'))
    act(() => todoActions.move(id, 'attention'))
    expect(find().column).toBe('attention')
    act(() => todoActions.resolveRequest(id, 'Allowed once'))
    expect(find()).toMatchObject({ column: 'working', attentionReason: undefined, request: undefined })
    expect(find().lastUpdate).toBe('You: Allowed once')
  })

  it('a schedule on start makes it a recurring job', () => {
    const { result } = renderHook(() => useTodoBoard())
    const id = todoActions.createDraft('scan competitor blogs').id
    act(() => todoActions.start(id, { slug: 'a1', name: 'Agent One' }, 'Every weekday at 9:00'))
    expect(result.current.cards.find((c) => c.id === id)).toMatchObject({
      column: 'working',
      source: 'recurring',
      schedule: 'Every weekday at 9:00',
    })
  })

  it('stop sends running work back to drafts and clears any pending ask', () => {
    const { result } = renderHook(() => useTodoBoard())
    const id = todoActions.createDraft('ship it').id
    const find = () => result.current.cards.find((c) => c.id === id)!
    act(() => todoActions.start(id, { slug: 'a1', name: 'Agent One' }))
    act(() => todoActions.requestAttention(id, 'question', 'Which repo?', [{ question: 'Which repo?' }]))
    act(() => todoActions.stop(id))
    expect(find()).toMatchObject({ column: 'drafts', attentionReason: undefined, questions: undefined, lastUpdate: 'Stopped by you.' })
  })

  it('start keeps an explicit assignment instead of the routed agent', () => {
    const { result } = renderHook(() => useTodoBoard())
    const id = todoActions.createDraft('ship it').id
    act(() => todoActions.assignAgent(id, { slug: 'chosen', name: 'Chosen' }))
    act(() => todoActions.start(id, { slug: 'routed', name: 'Routed' }))
    expect(result.current.cards.find((c) => c.id === id)!.agents.map((a) => a.slug)).toEqual(['chosen'])
  })

  it('a drag into Needs Attention defaults the reason, and out of it clears the reason', () => {
    const { result } = renderHook(() => useTodoBoard())
    const id = todoActions.createDraft('ship it').id
    const find = () => result.current.cards.find((c) => c.id === id)!
    act(() => todoActions.move(id, 'attention'))
    expect(find()).toMatchObject({ column: 'attention', attentionReason: 'review' })
    act(() => todoActions.move(id, 'done'))
    expect(find()).toMatchObject({ column: 'done', attentionReason: undefined })
  })

  it('persists to localStorage in the schema shape', () => {
    todoActions.createDraft('persist me')
    const stored = JSON.parse(localStorage.getItem('superagent.todo-board.v1')!)
    expect(stored.version).toBe(1)
    expect(stored.cards.some((c: { prompt: string }) => c.prompt === 'persist me')).toBe(true)
  })
})
