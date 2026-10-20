// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineLook } from './define-look'
import { SendPreviewView } from './looks'

const note = defineLook('note', z.object({ text: z.string() }), ({ data }) => <p>{data.text}</p>)

describe('defineLook', () => {
  it('draws data its kind accepts, and nothing for data it rejects', () => {
    render(<>{note.render({ text: 'Pricing holds.' }, 'agent-1')}</>)
    expect(screen.getByText('Pricing holds.')).toBeTruthy()
    const { container } = render(<>{note.render({ text: 42 }, 'agent-1')}</>)
    expect(container.innerHTML).toBe('')
  })
})

describe('SendPreviewView', () => {
  it.each(['notes', 'toString', '__proto__'])('draws nothing for a look the app does not register (%s)', (look) => {
    const { container } = render(<SendPreviewView preview={{ kind: 'note', look, title: 'Allow?', data: { text: 'hi' } }} agentSlug="agent-1" />)
    expect(container.innerHTML).toBe('')
  })
})
