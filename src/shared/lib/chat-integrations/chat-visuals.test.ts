import { describe, it, expect } from 'vitest'
import { segments } from './chat-visuals'

const shape = (text: string, settledOnly: boolean) => {
  const split = segments(text, { settledOnly })
  return { segments: split.segments.map(({ kind, source }) => ({ kind, source })), tail: split.tail }
}

describe('segments', () => {
  it('splits a paragraph around a workspace image', () => {
    expect(shape('See ![chart](/workspace/a.png) here.\n\nNext', true)).toEqual({
      segments: [
        { kind: 'text', source: 'See ' },
        { kind: 'visual', source: '![chart](/workspace/a.png)' },
        { kind: 'text', source: ' here.\n\n' },
      ],
      tail: 'Next',
    })
  })

  it('keeps an image that ends the reply in the tail until everything is split', () => {
    const text = 'Intro\n\n![a](/workspace/a.png)'
    expect(shape(text, true)).toEqual({ segments: [{ kind: 'text', source: 'Intro\n\n' }], tail: '![a](/workspace/a.png)' })
    expect(shape(text, false).segments.at(-1)).toEqual({ kind: 'visual', source: '![a](/workspace/a.png)' })
  })

  it('has no segments for an empty reply', () => {
    expect(shape('', false)).toEqual({ segments: [], tail: '' })
  })

  it('leaves relative paths, web images, images in code and images in tables as text', () => {
    for (const text of ['a ![x](img/a.png) and ![y](https://example.com/a.png)', '```\n![a](/workspace/a.png)\n```', 'a `![a](/workspace/a.png)`', '| a |\n| - |\n| ![a](/workspace/a.png) |']) {
      expect(shape(text, false)).toEqual({ segments: [{ kind: 'text', source: text }], tail: '' })
    }
  })

  it('finds the image itself, not the same text in inline code before it', () => {
    expect(shape('Write `![a](/workspace/a.png)` to get ![a](/workspace/a.png)', false).segments).toEqual([
      { kind: 'text', source: 'Write `![a](/workspace/a.png)` to get ' },
      { kind: 'visual', source: '![a](/workspace/a.png)' },
    ])
  })

  it('takes a link whose only content is an image as the visual', () => {
    expect(shape('See [![a](/workspace/a.png)](https://example.com) here', false).segments).toEqual([
      { kind: 'text', source: 'See ' },
      { kind: 'visual', source: '[![a](/workspace/a.png)](https://example.com)' },
      { kind: 'text', source: ' here' },
    ])
  })

  it('leaves an image as text where a cut would break the markup around it', () => {
    for (const text of [
      '**See ![a](/workspace/a.png) here**',
      '[See ![a](/workspace/a.png)](https://example.com)',
      '- one\n- ![a](/workspace/a.png)\n- three',
      '> ![a](/workspace/a.png)',
      '# Title ![a](/workspace/a.png)',
      '[![a](/workspace/a.png)][docs]',
      '<span>![a](/workspace/a.png)</span>',
    ]) {
      expect(shape(text, false)).toEqual({ segments: [{ kind: 'text', source: text }], tail: '' })
    }
  })

  it('takes an image whose alt text holds another image as one visual', () => {
    const text = '![![inner](/workspace/in.png)](/workspace/out.png)'
    expect(shape(text, false).segments).toEqual([{ kind: 'visual', source: text }])
  })

  it('takes a mermaid, math or html fence in any case as a visual, not another language or a 4-space-indented fence', () => {
    const kinds = (text: string) => shape(text, false).segments.map((segment) => segment.kind)
    for (const language of ['mermaid', 'math', 'html', 'htm', 'MERMAID']) {
      expect(kinds(`Intro\n\n\`\`\`${language}\nx\n\`\`\`\n\nAfter`)).toEqual(['text', 'visual', 'text'])
    }
    expect(kinds('```ts\nx\n```')).toEqual(['text'])
    expect(kinds('    ```mermaid\n    x\n    ```')).toEqual(['text'])
  })

  it('splits a fence that follows a prose line with no blank line between', () => {
    expect(shape('Here:\n```mermaid\nA --> B\n```', false).segments).toEqual([
      { kind: 'text', source: 'Here:\n' },
      { kind: 'visual', source: '```mermaid\nA --> B\n```' },
    ])
  })

  it('splits two images in a row', () => {
    expect(shape('![a](/workspace/a.png)\n![b](file:///workspace/b.jpg)', false).segments).toEqual([
      { kind: 'visual', source: '![a](/workspace/a.png)' },
      { kind: 'text', source: '\n' },
      { kind: 'visual', source: '![b](file:///workspace/b.jpg)' },
    ])
  })
})
