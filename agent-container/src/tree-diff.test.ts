import { afterEach, describe, it, expect } from 'vitest'
import {
  acknowledgeTreeValue,
  diffTrees,
  formatTreeDiff,
  getTreeBaseline,
  parseTreeRefs,
  resetTreeBaseline,
  setTreeBaseline,
  treeDiffIsEmpty,
} from './tree-diff'

// Trees as agent-browser 0.39.1 prints them (copied from the container probe).
const INTERACTIVE = `- heading "Probe five" [level=1, ref=e1]
- link "Top link" [ref=e6]
- button "Open menu" [expanded=false, ref=e7]
- generic [ref=e2] clickable [cursor:pointer, onclick]
- textbox "Name" [ref=e9]
- combobox "State" [expanded=false, ref=e10]: Pick
  - option "Pick" [selected, ref=e14]
  - option "California" [ref=e15]
- checkbox "Agree" [checked=false, ref=e8]
- button "Add to cart" [ref=e3]`

const FULL = `- heading "Probe five" [level=1, ref=e1]
- navigation
  - link "Top link" [ref=e6]
  - button "Open menu" [expanded=false, ref=e7]
- generic [ref=e2] clickable [cursor:pointer, onclick]
- form
  - LabelText
    - StaticText "Name "
    - textbox "Name" [ref=e9]
  - LabelText
    - combobox "State" [expanded=false, ref=e10]: Pick
      - MenuListPopup
        - option "Pick" [selected, ref=e14]
        - option "California" [ref=e15]
  - checkbox "Agree" [checked=false, ref=e8]
- button "Add to cart" [ref=e3]`

afterEach(() => resetTreeBaseline())

describe('parseTreeRefs', () => {
  it('keeps ref lines only, with name, attributes, value and the enclosing ref', () => {
    const t = parseTreeRefs(INTERACTIVE)
    expect([...t.lines.keys()]).toEqual(['e1', 'e6', 'e7', 'e2', 'e9', 'e10', 'e14', 'e15', 'e8', 'e3'])
    expect(t.lines.get('e10')).toMatchObject({ name: 'State', attrs: ['expanded=false'], value: 'Pick', parent: null, text: 'combobox "State" [expanded=false, ref=e10]: Pick' })
    expect(t.lines.get('e14')).toMatchObject({ name: 'Pick', attrs: ['selected'], parent: 'e10' })
    expect(t.lines.get('e2')).toMatchObject({ name: '', attrs: [], value: '' })
  })

  it('reads the same line for a ref in the interactive and the full view — either is a baseline', () => {
    expect(treeDiffIsEmpty(diffTrees(parseTreeRefs(FULL), parseTreeRefs(INTERACTIVE)))).toBe(true)
    // Non-ref ancestors (MenuListPopup) do not break the nesting.
    expect(parseTreeRefs(FULL).lines.get('e15')?.parent).toBe('e10')
  })

  it('drops includeUrls attributes, which are a display choice', () => {
    const withUrl = parseTreeRefs('- link "Top link" [ref=e6, url=https://a.com/x?y=1]')
    expect(withUrl.lines.get('e6')?.text).toBe('link "Top link" [ref=e6]')
  })
})

describe('diffTrees', () => {
  it('reports added, changed (with what it was) and removed refs', () => {
    const after = INTERACTIVE
      .replace('[expanded=false, ref=e7]', '[expanded=true, ref=e7]\n- link "Menu A" [ref=e18]')
      .replace('[checked=false, ref=e8]', '[checked=true, ref=e8]')
      .replace('- button "Add to cart" [ref=e3]', '')
    const d = diffTrees(parseTreeRefs(INTERACTIVE), parseTreeRefs(after))
    expect(d.added.map(l => l.text)).toEqual(['link "Menu A" [ref=e18]'])
    expect(d.changed.map(c => [c.line.ref, c.was])).toEqual([['e7', 'expanded=false'], ['e8', 'checked=false']])
    expect(d.removed.map(l => l.ref)).toEqual(['e3'])
  })

  it('describes flags and values: a selected option, a cleared field', () => {
    const before = parseTreeRefs('- option "Pick" [selected, ref=e14]\n- option "California" [ref=e15]\n- textbox "Name" [ref=e9]: Ada')
    const after = parseTreeRefs('- option "Pick" [ref=e14]\n- option "California" [selected, ref=e15]\n- textbox "Name" [ref=e9]')
    expect(diffTrees(before, after).changed.map(c => c.was)).toEqual(['selected', 'not selected', 'value "Ada"'])
  })

  it('ignores a name present on one side only (the interactive view names cursor-interactive elements by their text)', () => {
    const d = diffTrees(parseTreeRefs('- generic [ref=e2] clickable [cursor:pointer]'), parseTreeRefs('- generic "Card" [ref=e2] clickable [cursor:pointer]'))
    expect(treeDiffIsEmpty(d)).toBe(true)
  })

  it('leaves out an excluded ref and everything nested under it (a select and its options)', () => {
    const after = INTERACTIVE
      .replace('[expanded=false, ref=e10]: Pick', '[expanded=false, ref=e10]: California')
      .replace('"Pick" [selected, ref=e14]', '"Pick" [ref=e14]')
      .replace('"California" [ref=e15]', '"California" [selected, ref=e15]')
    expect(diffTrees(parseTreeRefs(INTERACTIVE), parseTreeRefs(after)).changed).toHaveLength(3)
    expect(treeDiffIsEmpty(diffTrees(parseTreeRefs(INTERACTIVE), parseTreeRefs(after), { excludeRefs: ['@e10'] }))).toBe(true)
  })

  it('does not report a value the agent was already told, but does report a different one', () => {
    const before = parseTreeRefs('- textbox "Email" [ref=e15]\n- textbox "Password" [ref=e16]\n- combobox "Size" [ref=e4]: 8\n  - option "8" [selected, ref=e5]')
    const after = parseTreeRefs('- textbox "Email" [ref=e15]: nope\n- textbox "Password" [ref=e16]: •••••\n- combobox "Size" [ref=e4]: 9\n  - option "8" [ref=e5]')
    const acknowledged = new Map<string, string | null>([['e15', 'nope'], ['e16', 'hunter'], ['e4', null]])
    expect(treeDiffIsEmpty(diffTrees(before, after, { acknowledged }))).toBe(true)
    const changedByPage = parseTreeRefs('- textbox "Email" [ref=e15]: nope@x.com')
    expect(diffTrees(parseTreeRefs('- textbox "Email" [ref=e15]'), changedByPage, { acknowledged }).changed).toHaveLength(1)
  })

  it('tells refs that are back exactly as seen from new ones', () => {
    const seen = new Map([['e3', 'button "Add to cart" [ref=e3]'], ['e8', 'checkbox "Agree" [checked=false, ref=e8]']])
    const d = diffTrees(
      parseTreeRefs('- button "Close cart" [ref=e48]'),
      parseTreeRefs('- button "Add to cart" [ref=e3]\n- checkbox "Agree" [checked=true, ref=e8]\n- link "New" [ref=e50]'),
      { seen },
    )
    expect(d.returned.map(l => l.ref)).toEqual(['e3'])
    expect(d.added.map(l => l.ref)).toEqual(['e8', 'e50'])
    expect(d.removed.map(l => l.ref)).toEqual(['e48'])
  })
})

describe('formatTreeDiff', () => {
  const opts = { baselineAgeMs: 4200, baselineSource: 'snapshot' as const }

  it('lists added, then changed, then removed, each with its ref, under a header naming the baseline', () => {
    const after = INTERACTIVE.replace('[expanded=false, ref=e7]', '[expanded=true, ref=e7]\n- link "Menu A" [ref=e18]').replace('- button "Add to cart" [ref=e3]', '')
    expect(formatTreeDiff(diffTrees(parseTreeRefs(INTERACTIVE), parseTreeRefs(after)), opts)).toBe(
      '\nTree changes since your snapshot 4s ago (1 added, 1 changed, 1 removed):\n' +
      '+ link "Menu A" [ref=e18]\n' +
      '~ button "Open menu" [expanded=true, ref=e7] (was expanded=false)\n' +
      '− button "Add to cart" [ref=e3]',
    )
    expect(formatTreeDiff(diffTrees(parseTreeRefs(INTERACTIVE), parseTreeRefs(INTERACTIVE)), opts)).toBe('')
    expect(formatTreeDiff(diffTrees(parseTreeRefs(INTERACTIVE), parseTreeRefs(after)), { baselineAgeMs: 300, baselineSource: 'action' }))
      .toContain("since the previous action's tree just now")
  })

  it('caps the lines and counts the rest; removed elements get a few lines', () => {
    const many = Array.from({ length: 40 }, (_, i) => `- link "Result ${i}" [ref=e${100 + i}]`).join('\n')
    const gone = Array.from({ length: 10 }, (_, i) => `- button "Old ${i}" [ref=e${10 + i}]`).join('\n')
    const text = formatTreeDiff(diffTrees(parseTreeRefs(gone), parseTreeRefs(many)), opts)
    expect(text).toContain('(40 added, 10 removed)')
    // 25 lines in all: 19 added, then 6 removed, then the counts.
    expect(text.split('\n').filter(l => l.startsWith('+ link'))).toHaveLength(19)
    expect(text.split('\n').filter(l => l.startsWith('− button'))).toHaveLength(6)
    expect(text).toContain('… 21 more added/changed not shown')
    expect(text).toContain('− 4 more no longer in the tree')

    const fewGone = formatTreeDiff(diffTrees(parseTreeRefs(gone), parseTreeRefs('- link "x" [ref=e1]')), opts)
    expect(fewGone.split('\n').filter(l => l.startsWith('− button'))).toHaveLength(6)
    expect(fewGone).toContain('− 4 more no longer in the tree')
  })

  it('reports the page behind an opened dialog as one count, and its return as one line', () => {
    const page = Array.from({ length: 19 }, (_, i) => `- button "B${i}" [ref=e${i + 1}]`).join('\n')
    const opened = diffTrees(parseTreeRefs(page), parseTreeRefs('- button "Close cart" [ref=e48]'))
    expect(formatTreeDiff(opened, { ...opts, dialogOpened: true })).toBe(
      '\nTree changes since your snapshot 4s ago (1 added, 19 removed):\n' +
      '+ button "Close cart" [ref=e48]\n' +
      '− 19 other elements are not in the tree while the dialog is open',
    )
    const seen = new Map([...parseTreeRefs(page).lines].map(([r, l]) => [r, l.text]))
    const closed = diffTrees(parseTreeRefs('- button "Close cart" [ref=e48]'), parseTreeRefs(page), { seen })
    expect(formatTreeDiff(closed, opts)).toBe(
      '\nTree changes since your snapshot 4s ago (19 back, 1 removed):\n' +
      '+ 19 elements back in the tree exactly as you last saw them, same refs\n' +
      '− button "Close cart" [ref=e48]',
    )
  })
})

describe('tree baseline', () => {
  it('is kept per page: another URL has none', () => {
    setTreeBaseline('https://a.com/', INTERACTIVE, 'snapshot', 1000)
    expect(getTreeBaseline('https://a.com/')).toMatchObject({ takenAt: 1000, source: 'snapshot' })
    expect(getTreeBaseline('https://a.com/other')).toBeNull()
    setTreeBaseline('', INTERACTIVE, 'snapshot')
    expect(getTreeBaseline('https://a.com/')).toBeNull()
  })

  it('remembers every line seen on the page across reads, and forgets it on another page', () => {
    setTreeBaseline('https://a.com/', INTERACTIVE, 'snapshot')
    setTreeBaseline('https://a.com/', '- button "Close cart" [ref=e48]', 'action')
    const b = getTreeBaseline('https://a.com/')!
    expect(b.seen.get('e3')).toBe('button "Add to cart" [ref=e3]')
    expect(b.seen.get('e48')).toBe('button "Close cart" [ref=e48]')
    setTreeBaseline('https://b.com/', '- link "x" [ref=e90]', 'snapshot')
    expect([...getTreeBaseline('https://b.com/')!.seen.keys()]).toEqual(['e90'])
  })

  it('takes read-back values until the next read replaces it', () => {
    setTreeBaseline('https://a.com/', INTERACTIVE, 'snapshot')
    acknowledgeTreeValue('https://a.com/', '@e9', 'Ada')
    acknowledgeTreeValue('https://other.com/', '@e9', 'ignored')
    expect([...getTreeBaseline('https://a.com/')!.acknowledged]).toEqual([['e9', 'Ada']])
    setTreeBaseline('https://a.com/', INTERACTIVE, 'action')
    expect(getTreeBaseline('https://a.com/')!.acknowledged.size).toBe(0)
  })
})
