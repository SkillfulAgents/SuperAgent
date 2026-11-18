// @vitest-environment jsdom
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MarkdownComposerEditor } from './markdown-composer-editor'

function ControlledEditor() {
  const [value, setValue] = useState('')
  return (
    <>
      <MarkdownComposerEditor value={value} onChange={setValue} placeholder="Write a message" dataTestId="markdown-editor" />
      <output data-testid="markdown-value">{value}</output>
    </>
  )
}

function pasteClipboard(editor: HTMLElement, data: Record<string, string>) {
  fireEvent.paste(editor, {
    clipboardData: { getData: (type: string) => data[type] ?? '', types: Object.keys(data), items: [] },
  })
}

describe('MarkdownComposerEditor paste', () => {
  it('keeps bullets and bold from formatting copied out of a rendered message', () => {
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    pasteClipboard(editor, {
      'text/html': '<p>Plan for <strong>today</strong>:</p><ul><li><strong>Ship</strong> the fix</li><li>Write tests</li></ul><ol start="3"><li>Third</li></ol>',
      'text/plain': 'Plan for today:\n\nShip the fix\nWrite tests\nThird',
    })

    expect(editor.querySelectorAll('ul li')).toHaveLength(2)
    expect(editor.querySelector('li strong')).toHaveTextContent('Ship')
    expect(screen.getByTestId('markdown-value').textContent).toBe(
      'Plan for **today**:\n\n* **Ship** the fix\n* Write tests\n\n3. Third'
    )
  })

  it('keeps a list loose when its copied items are paragraphs', () => {
    render(<ControlledEditor />)
    pasteClipboard(screen.getByTestId('markdown-editor'), {
      'text/html': '<ul><li><p>one</p></li><li><p>two</p></li></ul>',
      'text/plain': 'one\ntwo',
    })

    expect(screen.getByTestId('markdown-value').textContent).toBe('* one\n\n* two')
  })

  it('still reads Markdown source when the copied HTML carries no formatting', () => {
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    pasteClipboard(editor, {
      'text/html': '<div style="font-family: Menlo"><div><span>- one</span></div><div><span>- **two**</span></div></div>',
      'text/plain': '- one\n- **two**',
    })

    expect(editor.querySelectorAll('ul li')).toHaveLength(2)
    expect(screen.getByTestId('markdown-value').textContent).toBe('* one\n* **two**')
  })
})
