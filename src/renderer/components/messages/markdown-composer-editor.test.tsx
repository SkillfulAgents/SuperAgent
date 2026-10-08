// @vitest-environment jsdom
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MarkdownIt from 'markdown-it'
import {
  MarkdownComposerEditor,
  demoteMultilineSetextHeadings,
  escapeLineStart,
  selectAllMarkdownComposer,
  setMarkdownComposerSelection,
} from './markdown-composer-editor'
import { useFormattingToolbar } from './formatting-toolbar'
import { findPotentialSecrets, type SecuredSecret } from '@renderer/lib/secret-detection'

function ControlledEditor({ initialValue = '', toolbar }: { initialValue?: string; toolbar?: boolean }) {
  const [value, setValue] = useState(initialValue)
  return (
    <>
      <MarkdownComposerEditor
        value={value}
        onChange={setValue}
        placeholder="Write a message"
        dataTestId="markdown-editor"
        toolbar={toolbar}
      />
      <output data-testid="markdown-value">{value}</output>
    </>
  )
}

function SecuredEditorHarness({
  initialValue,
  secrets,
  onRemove,
}: {
  initialValue: string
  secrets: SecuredSecret[]
  onRemove: (secrets: SecuredSecret[]) => void
}) {
  const [value, setValue] = useState(initialValue)
  return (
    <>
      <MarkdownComposerEditor
        value={value}
        onChange={setValue}
        placeholder="Write a message"
        dataTestId="markdown-editor"
        securedSecrets={secrets}
        onRemoveSecuredSecrets={onRemove}
      />
      <output data-testid="markdown-value">{value}</output>
    </>
  )
}

describe('MarkdownComposerEditor', () => {
  it('renders Markdown blocks and inline marks from its controlled value', () => {
    render(<ControlledEditor initialValue={'# Heading\n\n> [docs](https://example.com) with *emphasis* and `code`\n\n**bold** and ~~gone~~\n\n- one\n- two'} />)

    const editor = screen.getByTestId('markdown-editor')
    expect(editor.querySelector('h1')).toHaveTextContent('Heading')
    expect(editor.querySelector('blockquote')).toHaveTextContent('docs with emphasis and code')
    expect(editor.querySelector('a')).toHaveAttribute('href', 'https://example.com')
    expect(editor.querySelector('em')).toHaveTextContent('emphasis')
    expect(editor.querySelector('code')).toHaveTextContent('code')
    expect(editor.querySelector('strong')).toHaveTextContent('bold')
    expect(editor.querySelector('s')).toHaveTextContent('gone')
    expect(editor.querySelectorAll('li')).toHaveLength(2)
  })

  it('lets an explicit minimum height override the row-based fallback', () => {
    render(
      <MarkdownComposerEditor
        value=""
        onChange={() => {}}
        placeholder="Write a message"
        dataTestId="markdown-editor"
        minRows={2}
        className="min-h-[50vh]"
      />
    )

    const editor = screen.getByTestId('markdown-editor')
    expect(editor.style.minHeight).toBe('')
    expect(editor.style.getPropertyValue('--composer-min-height')).toBe('40px')
    expect(editor.className).toContain('min-h-[50vh]')
    expect(editor.className).not.toContain('min-h-[var(--composer-min-height)]')
  })

  it('turns typed Markdown tokens into rich text while retaining Markdown output', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, '**important**')

    expect(editor.querySelector('strong')).toHaveTextContent('important')
    expect(editor.textContent).toBe('important')
    expect(screen.getByTestId('markdown-value').textContent).toBe('**important**')
  })

  it('keeps Cmd/Ctrl+B inside the editor while applying bold', async () => {
    const user = userEvent.setup()
    const onWindowKeyDown = vi.fn()
    window.addEventListener('keydown', onWindowKeyDown)

    try {
      render(<ControlledEditor />)
      const editor = screen.getByTestId('markdown-editor')

      fireEvent.keyDown(editor, { key: 'b', metaKey: true })
      fireEvent.keyDown(editor, { key: 'b', ctrlKey: true })

      expect(onWindowKeyDown).not.toHaveBeenCalled()
      await user.type(editor, 'bold')
      expect(editor.querySelector('strong')).toHaveTextContent('bold')
    } finally {
      window.removeEventListener('keydown', onWindowKeyDown)
    }
  })

  it('does not interpret intraword underscores inside a typed secret', async () => {
    const user = userEvent.setup()
    const token = 'github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, token)

    expect(editor.querySelector('em')).not.toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe(token)
    expect(findPotentialSecrets(token).map((candidate) => candidate.value)).toContain(token)
  })

  it('renders underscore emphasis after a CommonMark boundary', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, '_important_ ')

    expect(editor.querySelector('em')).toHaveTextContent('important')
    expect(screen.getByTestId('markdown-value').textContent).toBe('*important* ')
  })

  it('uses the first Backspace to undo an automatic Markdown transform', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, '**important**')
    await user.keyboard('{Backspace}')

    expect(editor.querySelector('strong')).not.toBeInTheDocument()
    expect(editor.textContent).toBe('**important**')
    expect(screen.getByTestId('markdown-value').textContent).toBe('\\*\\*important\\*\\*')
  })

  it('keeps Enter inside a Markdown list and creates another list item', async () => {
    const user = userEvent.setup()
    const onKeyDown = vi.fn()
    render(
      <MarkdownComposerEditor
        value=""
        onChange={() => {}}
        onKeyDown={onKeyDown}
        placeholder="Write a message"
        dataTestId="markdown-editor"
      />
    )
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, '- one')
    await user.keyboard('{Enter}')

    expect(editor.querySelectorAll('li')).toHaveLength(2)
    expect(onKeyDown).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: 'Enter' }),
      expect.anything()
    )
  })

  it('passes modified Enter to the owning composer from inside a list', async () => {
    const user = userEvent.setup()
    const onKeyDown = vi.fn((event: KeyboardEvent) => {
      if (event.key === 'Enter') event.preventDefault()
    })
    render(
      <MarkdownComposerEditor
        value="- item"
        onChange={() => {}}
        onKeyDown={onKeyDown}
        placeholder="Write a message"
        dataTestId="markdown-editor"
      />
    )
    const editor = screen.getByTestId('markdown-editor')

    await user.click(editor.querySelector('li')!)
    await user.keyboard('{Meta>}{Enter}{/Meta}')

    expect(onKeyDown).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'Enter', metaKey: true }),
      expect.anything()
    )
  })

  it('converts a code fence before an Enter-to-send owner can intercept it', async () => {
    const user = userEvent.setup()
    const onKeyDown = vi.fn((event: KeyboardEvent) => {
      if (event.key === 'Enter') event.preventDefault()
    })
    render(
      <MarkdownComposerEditor
        value=""
        onChange={() => {}}
        onKeyDown={onKeyDown}
        placeholder="Write a message"
        dataTestId="markdown-editor"
      />
    )
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, '```typescript')
    onKeyDown.mockClear()
    await user.keyboard('{Enter}')

    expect(editor.querySelector('pre')).toBeInTheDocument()
    expect(onKeyDown).not.toHaveBeenCalled()
  })

  it('inserts a literal newline with Shift+Enter inside a code block', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, '```typescript')
    await user.keyboard('{Enter}')
    await user.type(editor, 'const first = true')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(editor, 'const second = true')

    expect(editor.querySelector('pre')?.textContent).toBe('const first = true\nconst second = true')
    expect(screen.getByTestId('markdown-value').textContent).toBe(
      '```typescript\nconst first = true\nconst second = true\n```'
    )
  })

  it('starts and continues a list after soft line breaks', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, 'intro')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(editor, '- first')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(editor, '- second')

    const list = Array.from(editor.children).find((element) => element.tagName === 'UL')
    expect(list?.children).toHaveLength(2)
    expect(list).toHaveTextContent('firstsecond')
    expect(screen.getByTestId('markdown-value').textContent).toBe(
      'intro\n\n* first\n* second'
    )
  })

  it('recognizes a heading and following list entered with soft line breaks', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, 'intro')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(editor, '## Hello')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(editor, '- item')

    expect(editor.querySelector('h2')).toHaveTextContent('Hello')
    expect(editor.querySelector('li')).toHaveTextContent('item')
  })

  it('parses pasted block Markdown into rich document blocks', () => {
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) => type === 'text/plain'
          ? '## Hello\n\n- list item\n- another list item\n\n1. OOL\n2. No listd'
          : '',
        items: [],
      },
    })

    expect(editor.querySelector('h2')).toHaveTextContent('Hello')
    expect(editor.querySelectorAll('ul li')).toHaveLength(2)
    expect(editor.querySelectorAll('ol li')).toHaveLength(2)
    expect(screen.getByTestId('markdown-value').textContent).toBe(
      '## Hello\n\n* list item\n* another list item\n\n1. OOL\n2. No listd'
    )
  })

  it('leaves mixed file and text clipboard data to the attachment owner', () => {
    const onPaste = vi.fn()
    render(
      <div onPaste={onPaste}>
        <ControlledEditor />
      </div>
    )
    const editor = screen.getByTestId('markdown-editor')

    fireEvent.paste(editor, {
      clipboardData: {
        getData: () => '/tmp/copied-file.txt',
        items: [{ kind: 'file', getAsFile: () => new File(['x'], 'copied-file.txt') }],
      },
    })

    expect(onPaste).toHaveBeenCalled()
    expect(screen.getByTestId('markdown-value').textContent).toBe('')
  })

  it('does not discard an image when a block marker follows that leaf', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, 'intro')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(editor, '![[alt](https://example.com/image.png)')
    await user.type(editor, ' - item')

    expect(editor.querySelector('img')).toHaveAttribute('src', 'https://example.com/image.png')
    expect(editor.querySelector('ul')).not.toBeInTheDocument()
    expect(editor).toHaveTextContent('- item')
  })

  it('does not create a DOM link for a disallowed URL scheme', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, '[[unsafe](javascript:alert(1))')

    expect(editor.querySelector('a')).not.toBeInTheDocument()
    expect(editor).toHaveTextContent('[unsafe](javascript:alert(1))')
  })

  it('deletes the complete selection when it contains a secured pill', async () => {
    const user = userEvent.setup()
    const secret: SecuredSecret = {
      id: 'first',
      key: 'Token',
      envVar: 'TOKEN_ONE',
      displayText: '[Token | *********]',
    }
    const onRemove = vi.fn()
    render(
      <SecuredEditorHarness
        initialValue={`Before ${secret.displayText} after`}
        secrets={[secret]}
        onRemove={onRemove}
      />
    )
    const editor = screen.getByTestId('markdown-editor')

    expect(selectAllMarkdownComposer(editor)).toBe(true)
    await user.keyboard('{Backspace}')

    expect(screen.getByTestId('markdown-value').textContent).toBe('')
    expect(onRemove).toHaveBeenCalledWith([secret])
  })

  it('deletes the selected occurrence when secured pills have identical labels', async () => {
    const user = userEvent.setup()
    const displayText = '[Token | *********]'
    const first: SecuredSecret = { id: 'first', key: 'Token', envVar: 'TOKEN_ONE', displayText }
    const second: SecuredSecret = { id: 'second', key: 'Token', envVar: 'TOKEN_TWO', displayText }
    const value = `A ${displayText} B ${displayText} C`
    const onRemove = vi.fn()
    render(
      <SecuredEditorHarness
        initialValue={value}
        secrets={[first, second]}
        onRemove={onRemove}
      />
    )
    const editor = screen.getByTestId('markdown-editor')
    const secondPillEnd = 1 + value.lastIndexOf(displayText) + displayText.length

    expect(setMarkdownComposerSelection(editor, secondPillEnd)).toBe(true)
    await user.keyboard('{Backspace}')

    expect(screen.getByTestId('markdown-value').textContent).toBe(`A ${displayText} B  C`)
    expect(onRemove).toHaveBeenCalledWith([second])
  })

  it('keeps a Shift+Enter line break in the Markdown source', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, 'line one')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(editor, 'line two')

    expect(editor.querySelector('br[data-soft-break="true"]')).toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe('line one\nline two')
  })

  it('removes a trailing soft break with one Backspace', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, 'line one')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(editor.querySelector('br[data-soft-break="true"]')).toBeInTheDocument()

    await user.keyboard('{Backspace}')
    expect(editor.querySelector('br')).not.toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe('line one')
  })

  it('preserves trailing editing spaces when an external value is inserted', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <MarkdownComposerEditor
        value="/deploy "
        onChange={onChange}
        placeholder="Write a message"
        dataTestId="markdown-editor"
      />
    )
    const editor = screen.getByTestId('markdown-editor')
    expect(editor.textContent).toBe('/deploy ')

    await user.type(editor, 'production')
    expect(onChange).toHaveBeenLastCalledWith('/deploy production')
  })
})

function pasteText(editor: HTMLElement, text: string) {
  fireEvent.paste(editor, {
    clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : ''), items: [] },
  })
}

describe('demoteMultilineSetextHeadings', () => {
  const tokenize = (src: string) => {
    const tokens = new MarkdownIt('commonmark').parse(src, {})
    demoteMultilineSetextHeadings(tokens, src)
    return tokens
  }

  it('keeps the underline without the quote prefix inside a blockquote', () => {
    expect(tokenize('> a\n> b\n> ---')[2].content).toBe('a\nb\n---')
  })
})

describe('escapeLineStart', () => {
  it('escapes block markers at the start of a line and leaves other text alone', () => {
    const cases: [string, string][] = [
      ['- y', '\\- y'], [' - y', ' \\- y'], ['+ y', '\\+ y'], ['> q', '\\> q'], ['# x', '\\# x'],
      ['1. y', '1\\. y'], ['1) y', '1\\) y'], ['---', '\\---'], [' ===', ' \\==='],
      ['01. y', '01\\. y'], ['-- --', '\\-- --'], ['0000000001. y', '0000000001. y'],
      ['-y', '-y'], ['#x', '#x'], ['a - b', 'a - b'], ['2024.', '2024.'], ['2. y', '2. y'], ['+', '+'],
    ]
    for (const [input, expected] of cases) expect(escapeLineStart(input)).toBe(expected)
  })

  it('escapes any list, quote, heading or divider marker at a paragraph start', () => {
    const cases: [string, string][] = [
      ['- y', '\\- y'], ['-y', '\\-y'], ['---', '\\---'], ['+', '\\+'], [' > q', ' \\> q'], ['# x', '\\# x'],
      ['2. y', '2\\. y'], ['1)', '1\\)'], [' 1) step', ' 1\\) step'],
      ['+y', '+y'], ['#x', '#x'], ['2024', '2024'], ['===', '==='], ['1234567890. x', '1234567890. x'],
    ]
    for (const [input, expected] of cases) expect(escapeLineStart(input, true)).toBe(expected)
  })
})

describe('MarkdownComposerEditor block exits', () => {
  it('keeps every frontmatter line when pasted', () => {
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    pasteText(editor, '---\nid: launch-plan\nowner: jeremy\n---\n\nShip it.')

    expect(editor.textContent).toContain('id: launch-plan')
    expect(editor.textContent).toContain('owner: jeremy')
    expect(screen.getByTestId('markdown-value').textContent).toBe(
      '---\n\nid: launch-plan\nowner: jeremy\n\\---\n\nShip it.'
    )
  })

  it('keeps an equals-underlined multi-line heading that uses a hard break', () => {
    render(<ControlledEditor />)
    pasteText(screen.getByTestId('markdown-editor'), 'a  \nb\n====\n\nafter')

    expect(screen.getByTestId('markdown-value').textContent).toBe('a\\\nb\n\\====\n\nafter')
  })

  it('still reads a single-line setext heading and a block divider', () => {
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    pasteText(editor, 'Title\n---\n\na\n\n---\n\nb')

    expect(editor.querySelector('h2')).toHaveTextContent('Title')
    expect(editor.querySelector('hr')).toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe('## Title\n\na\n\n---\n\nb')
  })

  it('leaves a code block on Enter at an empty last line without reaching an Enter-to-send owner', async () => {
    const user = userEvent.setup()
    const onKeyDown = vi.fn((event: KeyboardEvent) => {
      if (event.key === 'Enter') event.preventDefault()
    })
    function Harness() {
      const [value, setValue] = useState('')
      return (
        <>
          <MarkdownComposerEditor value={value} onChange={setValue} onKeyDown={onKeyDown} placeholder="Write a message" dataTestId="markdown-editor" />
          <output data-testid="markdown-value">{value}</output>
        </>
      )
    }
    render(<Harness />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, '```')
    await user.keyboard('{Enter}')
    await user.type(editor, 'npm test')
    await user.keyboard('{Enter}')
    expect(editor.querySelector('pre')?.textContent).toBe('npm test\n')

    await user.keyboard('{Enter}')
    await user.type(editor, 'after')

    expect(editor.querySelector('pre')?.textContent).toBe('npm test')
    expect(editor.querySelector('p')).toHaveTextContent('after')
    expect(screen.getByTestId('markdown-value').textContent).toBe('```\nnpm test\n```\n\nafter')
    expect(onKeyDown).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Enter' }), expect.anything())
  })

  it('moves into the paragraph that already follows a code block', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initialValue={'```\nx\n\n```\n\nafter'} />)
    const editor = screen.getByTestId('markdown-editor')

    setMarkdownComposerSelection(editor, 3)
    fireEvent.keyDown(editor, { key: 'Enter' })
    await user.keyboard('Z')

    expect(editor.querySelectorAll('p')).toHaveLength(1)
    expect(screen.getByTestId('markdown-value').textContent).toBe('```\nx\n```\n\nZafter')
  })

  it('turns an empty code block into a paragraph on Enter', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, '```')
    await user.keyboard('{Enter}')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.keyboard('{Enter}')
    await user.type(editor, 'plain')

    expect(editor.querySelector('pre')).not.toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe('plain')
  })

  it('inserts a newline for Enter in a code block inside a list item', () => {
    render(<ControlledEditor initialValue={'- item\n\n  ```\n  code\n  ```'} />)
    const editor = screen.getByTestId('markdown-editor')

    setMarkdownComposerSelection(editor, 13)
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(editor.querySelectorAll('li')).toHaveLength(1)
    expect(editor.querySelector('li pre')?.textContent).toBe('code\n')
  })

  it('keeps a heading that ends in " #" when saving', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    await user.type(screen.getByTestId('markdown-editor'), '# C# #')

    expect(screen.getByTestId('markdown-value').textContent).toBe('# C# \\#')
  })

  it('turns a heading back into text with Backspace at its start', () => {
    render(<ControlledEditor initialValue="# Release notes" />)
    const editor = screen.getByTestId('markdown-editor')

    setMarkdownComposerSelection(editor, 1)
    fireEvent.keyDown(editor, { key: 'Backspace' })

    expect(editor.querySelector('h1')).not.toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe('Release notes')
  })

  it('keeps the heading for Backspace inside its text', () => {
    render(<ControlledEditor initialValue="# Release notes" />)
    const editor = screen.getByTestId('markdown-editor')

    setMarkdownComposerSelection(editor, 4)

    expect(fireEvent.keyDown(editor, { key: 'Backspace' })).toBe(true)
    expect(editor.querySelector('h1')).toHaveTextContent('Release notes')
  })

  it('outdents a later list item with Backspace at its start', () => {
    render(<ControlledEditor initialValue={'- one\n- two'} />)
    const editor = screen.getByTestId('markdown-editor')

    setMarkdownComposerSelection(editor, 10)
    fireEvent.keyDown(editor, { key: 'Backspace' })

    expect(screen.getByTestId('markdown-value').textContent).toBe('* one\n\ntwo')
  })

  it('returns to the end of a list item after leaving the list with Enter twice', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, '- one')
    await user.keyboard('{Enter}{Enter}{Backspace}')
    await user.type(editor, 'x')

    expect(screen.getByTestId('markdown-value').textContent).toBe('* onex')
  })

  it('escapes list markers at the start of a paragraph but not inside a heading', () => {
    render(<ControlledEditor />)
    pasteText(screen.getByTestId('markdown-editor'), '2\\. y\n\n\\- z\n\n# - heading')

    expect(screen.getByTestId('markdown-value').textContent).toBe('2\\. y\n\n\\- z\n\n# - heading')
  })

  it('keeps an autolink after a line break unchanged when saving', () => {
    render(<ControlledEditor />)
    pasteText(screen.getByTestId('markdown-editor'), 'a\n<https://site.com/~jeremy>')

    expect(screen.getByTestId('markdown-value').textContent).toBe('a\n<https://site.com/~jeremy>')
  })

  it('turns a code block into text in place on Backspace at its start, keeping each line as text', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initialValue={'- one\n- ```\n  x\n    - a\n  # b\n  ```'} />)
    const editor = screen.getByTestId('markdown-editor')

    setMarkdownComposerSelection(editor, 10)
    fireEvent.keyDown(editor, { key: 'Backspace' })
    await user.keyboard('Z')

    expect(editor.querySelector('pre')).not.toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe('* one\n* Zx\n  \\- a\n  \\# b')
  })

  it('selects and then deletes a divider with Backspace from the empty line below it', () => {
    render(<ControlledEditor initialValue={'one\n\n---\n\nx'} />)
    const editor = screen.getByTestId('markdown-editor')

    setMarkdownComposerSelection(editor, 7, 8)
    fireEvent.keyDown(editor, { key: 'Backspace' })
    fireEvent.keyDown(editor, { key: 'Backspace' })
    expect(editor.querySelector('.ProseMirror-selectednode')).toBeInTheDocument()

    fireEvent.keyDown(editor, { key: 'Backspace' })
    expect(screen.getByTestId('markdown-value').textContent).toBe('one')
  })

  it('lifts a quote that follows a list instead of pulling it into the list', () => {
    render(<ControlledEditor initialValue={'- item\n\n> quote'} />)
    const editor = screen.getByTestId('markdown-editor')

    setMarkdownComposerSelection(editor, 12)
    fireEvent.keyDown(editor, { key: 'Backspace' })

    expect(editor.querySelector('blockquote')).not.toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe('* item\n\nquote')
  })

  it('still joins a quote\'s second paragraph into its first', () => {
    render(<ControlledEditor initialValue={'> one\n>\n> two'} />)
    const editor = screen.getByTestId('markdown-editor')

    setMarkdownComposerSelection(editor, 7)
    fireEvent.keyDown(editor, { key: 'Backspace' })

    expect(screen.getByTestId('markdown-value').textContent).toBe('> onetwo')
  })

})

function editorWith(initialValue: string, from = 1, to = from) {
  render(<ControlledEditor initialValue={initialValue} />)
  const editor = screen.getByTestId('markdown-editor')
  setMarkdownComposerSelection(editor, from, to)
  return editor
}

const markdownValue = () => screen.getByTestId('markdown-value').textContent

describe('MarkdownComposerEditor formatting shortcuts', () => {
  // Real key values: Option changes the character, so the keymap must match on the physical key.
  const shortcut = (editor: HTMLElement, key: string, keyCode: number, modifier: 'altKey' | 'shiftKey') =>
    fireEvent.keyDown(editor, { key, keyCode, ctrlKey: true, [modifier]: true })
  const heading1 = (editor: HTMLElement) => shortcut(editor, '¡', 49, 'altKey')
  const heading2 = (editor: HTMLElement) => shortcut(editor, '™', 50, 'altKey')

  it('applies block shortcuts to every block in a select-all and keeps it selected', () => {
    const cases: [string, (editor: HTMLElement) => void, string, string][] = [
      ['a\n\nb', heading1, '# a\n\n# b', 'a\n\nb'],
      ['* one\n* two', (editor) => shortcut(editor, '*', 56, 'shiftKey'), 'one\n\ntwo', '* one\n* two'],
      ['p\n\n```ts\nx\n```', (editor) => shortcut(editor, '•', 56, 'altKey'), '```\np\n```\n\n```ts\nx\n```', 'p\n\nx'],
    ]
    for (const [initialValue, press, once, twice] of cases) {
      const editor = editorWith(initialValue)
      selectAllMarkdownComposer(editor)
      press(editor)
      expect(markdownValue()).toBe(once)
      press(editor)
      expect(markdownValue()).toBe(twice)
      // The select-all survives both presses, so Backspace clears everything.
      fireEvent.keyDown(editor, { key: 'Backspace' })
      expect(markdownValue()).toBe('')
      cleanup()
    }
  })

  it('toggles a heading and switches its level', () => {
    const editor = editorWith('title')

    heading1(editor)
    expect(markdownValue()).toBe('# title')
    heading2(editor)
    expect(markdownValue()).toBe('## title')
    heading2(editor)
    expect(markdownValue()).toBe('title')
  })

  it('makes only the cursor line of a multi-line paragraph a heading', () => {
    const cases: [string, number, number, string][] = [
      ['a\nb\nc', 3, 3, 'a\n\n# b\n\nc'],
      ['a\nb', 2, 2, '# a\n\nb'],
      ['a\nb', 1, 4, 'a\nb'],
    ]
    for (const [initialValue, from, to, expected] of cases) {
      heading1(editorWith(initialValue, from, to))
      expect(markdownValue()).toBe(expected)
      cleanup()
    }
  })

  it('keeps the cursor on the line it made a heading, including an empty line', async () => {
    const user = userEvent.setup()
    const editor = editorWith('a\nb', 2)
    heading1(editor)
    await user.keyboard('X')
    expect(markdownValue()).toBe('# aX\n\nb')
    cleanup()

    render(<ControlledEditor />)
    const blank = screen.getByTestId('markdown-editor')
    await user.type(blank, 'a')
    await user.keyboard('{Shift>}{Enter}{Enter}{/Shift}')
    await user.type(blank, 'b')
    act(() => { setMarkdownComposerSelection(blank, 3) })
    heading1(blank)
    await user.keyboard('Y')
    expect(markdownValue()).toBe('a\n\n# Y\n\nb')
  })

  it('ends a heading on Shift+Enter instead of hiding a line break after it', async () => {
    const user = userEvent.setup()
    const editor = editorWith('# Title', 6)

    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(editor, 'next')

    expect(markdownValue()).toBe('# Title\n\nnext')
  })

  it('toggles a list and switches between bullet and numbered', () => {
    const editor = editorWith('one')

    shortcut(editor, '*', 56, 'shiftKey')
    expect(markdownValue()).toBe('* one')
    shortcut(editor, '&', 55, 'shiftKey')
    expect(markdownValue()).toBe('1. one')
    shortcut(editor, '&', 55, 'shiftKey')
    expect(markdownValue()).toBe('one')
  })

  it('keeps each line when toggling a code block on and off above other text', () => {
    const editor = editorWith('a\nb\n\nnext')

    shortcut(editor, '•', 56, 'altKey')
    expect(markdownValue()).toBe('```\na\nb\n```\n\nnext')
    shortcut(editor, '•', 56, 'altKey')
    expect(markdownValue()).toBe('a\nb\n\nnext')
  })

  it('leaves a code block made from a Shift+Enter line with one Enter', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')
    await user.type(editor, 'a')
    await user.keyboard('{Shift>}{Enter}{/Shift}')

    shortcut(editor, '•', 56, 'altKey')
    await user.keyboard('{Enter}')
    await user.type(editor, 'after')

    expect(markdownValue()).toBe('```\na\n```\n\nafter')
  })

  it('keeps several code blocks selected when turning them back into text', () => {
    const editor = editorWith('```\na\n```\n\n```\nb\n```', 1, 5)

    shortcut(editor, '•', 56, 'altKey')
    expect(markdownValue()).toBe('a\n\nb')
    shortcut(editor, '•', 56, 'altKey')
    expect(markdownValue()).toBe('```\na\nb\n```')
    shortcut(editor, '•', 56, 'altKey')
    expect(markdownValue()).toBe('a\nb')
  })

  it('puts the caret after a merged code block, so typing keeps the lines', async () => {
    const user = userEvent.setup()
    const editor = editorWith('abc\n\ndef', 3, 8)

    shortcut(editor, '•', 56, 'altKey')
    await user.keyboard('X')

    expect(markdownValue()).toBe('```\nabc\ndefX\n```')
  })

  it('merges only lines that sit side by side, keeping dividers and quotes between them', () => {
    const cases: [string, string][] = [
      ['a\n\n---\n\nb', '```\na\n```\n\n---\n\n```\nb\n```'],
      ['a\n\n> q\n\nb', '```\na\n```\n\n> ```\n> q\n> ```\n\n```\nb\n```'],
    ]
    for (const [initialValue, expected] of cases) {
      const editor = editorWith(initialValue)
      selectAllMarkdownComposer(editor)
      shortcut(editor, '•', 56, 'altKey')
      expect(markdownValue()).toBe(expected)
      cleanup()
    }
  })

  it('turns autolinks into code, since their text is the address', () => {
    for (const address of ['https://example.com', 'jeremy@example.com']) {
      const editor = editorWith(`see <${address}>`)
      shortcut(editor, '•', 56, 'altKey')
      expect(markdownValue()).toBe(`\`\`\`\nsee ${address}\n\`\`\``)
      cleanup()
    }
  })

  it('leaves a line with an image or a link alone instead of dropping it', () => {
    for (const initialValue of ['a ![x](https://example.com/x.png) b', 'a [x](https://example.com) b']) {
      const editor = editorWith(initialValue)
      shortcut(editor, '•', 56, 'altKey')
      expect(markdownValue()).toBe(initialValue)
      cleanup()
    }
  })

  it('turns a heading, quote, list item or code block into normal text', () => {
    const cases: [string, number, string][] = [['# h', 1, 'h'], ['> q', 2, 'q'], ['* item', 3, 'item'], ['```\nc\n```', 1, 'c']]
    for (const [initialValue, position, expected] of cases) {
      const editor = editorWith(initialValue, position)
      shortcut(editor, 'º', 48, 'altKey')
      expect(markdownValue()).toBe(expected)
      cleanup()
    }
  })
})

describe('MarkdownComposerEditor formatting toolbar', () => {
  const button = (name: string) => screen.getByRole('button', { name })

  it('applies a format from its button and lights the buttons that apply at the cursor', () => {
    render(<ControlledEditor initialValue="**bold** text" toolbar />)
    const editor = screen.getByTestId('markdown-editor')
    act(() => { setMarkdownComposerSelection(editor, 3) })
    expect(button('Bold')).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(button('Bullet list'))
    expect(markdownValue()).toBe('* **bold** text')
    expect(button('Bullet list')).toHaveAttribute('aria-pressed', 'true')
  })

  it('lifts only the quote or list the button reports', () => {
    render(<ControlledEditor initialValue="> # h" toolbar />)
    act(() => { setMarkdownComposerSelection(screen.getByTestId('markdown-editor'), 3) })
    expect(button('Quote')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(button('Quote'))
    expect(markdownValue()).toBe('# h')
    cleanup()

    render(<ControlledEditor initialValue="* > item" toolbar />)
    act(() => { setMarkdownComposerSelection(screen.getByTestId('markdown-editor'), 4) })
    expect(button('Bullet list')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(button('Bullet list'))
    expect(markdownValue()).toBe('> item')
  })

  it('shares one show/hide choice across mounted composers', () => {
    function Probe({ id, defaultOpen }: { id: string; defaultOpen: boolean }) {
      const [open, toggle] = useFormattingToolbar(defaultOpen)
      return <button type="button" data-testid={id} onClick={toggle}>{String(open)}</button>
    }
    localStorage.removeItem('composer.formattingToolbar')
    render(<><Probe id="home" defaultOpen /><Probe id="create" defaultOpen={false} /></>)
    expect(screen.getByTestId('home')).toHaveTextContent('true')
    expect(screen.getByTestId('create')).toHaveTextContent('false')

    fireEvent.click(screen.getByTestId('home'))
    expect(screen.getByTestId('home')).toHaveTextContent('false')
    expect(screen.getByTestId('create')).toHaveTextContent('false')
    fireEvent.click(screen.getByTestId('create'))
    expect(screen.getByTestId('home')).toHaveTextContent('true')
    expect(screen.getByTestId('create')).toHaveTextContent('true')
    localStorage.removeItem('composer.formattingToolbar')
  })

  it('lights the block buttons for a select-all the way the commands see it', () => {
    render(<ControlledEditor initialValue={'* a\n* b'} toolbar />)
    act(() => { selectAllMarkdownComposer(screen.getByTestId('markdown-editor')) })

    expect(button('Bullet list')).toHaveAttribute('aria-pressed', 'true')
  })

  it('disables a button whose format would drop content', () => {
    render(<ControlledEditor initialValue={'a ![x](https://example.com/x.png) b'} toolbar />)
    act(() => { setMarkdownComposerSelection(screen.getByTestId('markdown-editor'), 1) })

    expect(button('Code block')).toBeDisabled()
    expect(button('Bold')).toBeEnabled()
  })
})
