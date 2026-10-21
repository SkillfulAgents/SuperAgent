import { afterEach, describe, it, expect } from 'vitest'
import {
  acknowledgeTreeValue,
  formatUnknownRef,
  lineWithoutRef,
  diffTrees,
  formatTreeDiff,
  getTreeBaseline,
  lineFromPreviousDocument,
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
    expect(d.changed.map(c => [c.line.ref, c.was])).toEqual([['e7', 'expanded: false → true'], ['e8', 'checked: false → true']])
    expect(d.removed.map(l => l.ref)).toEqual(['e3'])
  })

  it('describes flags and values: a selected option, a cleared field', () => {
    const before = parseTreeRefs('- option "Pick" [selected, ref=e14]\n- option "California" [ref=e15]\n- textbox "Name" [ref=e9]: Ada')
    const after = parseTreeRefs('- option "Pick" [ref=e14]\n- option "California" [selected, ref=e15]\n- textbox "Name" [ref=e9]')
    expect(diffTrees(before, after).changed.map(c => c.was)).toEqual(['no longer selected', 'now selected', 'value "Ada" → empty'])
    // An attribute that appears is a transition from unset.
    const appeared = diffTrees(parseTreeRefs('- button "Main menu" [ref=e6]'), parseTreeRefs('- button "Main menu" [expanded=true, ref=e6]'))
    expect(appeared.changed[0].was).toBe('expanded: unset → true')
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
    expect(treeDiffIsEmpty(diffTrees(parseTreeRefs(INTERACTIVE), parseTreeRefs(after), { excludeSubtrees: ['@e10'] }))).toBe(true)
  })

  it('leaves out only a typed-into field\'s own line: an ARIA combobox owns its suggestions, and they are the effect', () => {
    // W3C APG combobox: the listbox is the combobox's child in the tree.
    const before = parseTreeRefs('- combobox "State" [expanded=true, ref=e197]\n  - listbox "States" [ref=e232]\n    - option "Alabama" [ref=e233]\n    - option "New York" [ref=e290]')
    const after = parseTreeRefs('- combobox "State" [expanded=true, ref=e197]: New\n  - listbox "States" [ref=e232]\n    - option "New York" [ref=e290]')
    const d = diffTrees(before, after, { excludeRefs: ['@e197'] })
    expect(d.changed).toEqual([])
    expect(d.removed.map(l => l.ref)).toEqual(['e233'])
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

  it('lists changed, then added, then removed, each with its ref, under a header naming the baseline', () => {
    const after = INTERACTIVE.replace('[expanded=false, ref=e7]', '[expanded=true, ref=e7]\n- link "Menu A" [ref=e18]').replace('- button "Add to cart" [ref=e3]', '')
    expect(formatTreeDiff(diffTrees(parseTreeRefs(INTERACTIVE), parseTreeRefs(after)), opts)).toBe(
      '\nTree changes since your snapshot 4s ago (1 added, 1 changed, 1 removed):\n' +
      '~ button "Open menu" [expanded=true, ref=e7] (expanded: false → true)\n' +
      '+ link "Menu A" [ref=e18]\n' +
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

  it('keeps the acted-on control\'s change in view when a results list arrives with it (bench, toolshop filter)', () => {
    const before = '- checkbox "Hand tools" [checked=false, ref=e5]\n- link "Old" [ref=e6]'
    const results = Array.from({ length: 40 }, (_, i) => `- link "Product ${i}" [ref=e${100 + i}]`).join('\n')
    const text = formatTreeDiff(diffTrees(parseTreeRefs(before), parseTreeRefs(`- checkbox "Hand tools" [checked=true, ref=e5]\n${results}`)), opts)
    expect(text.split('\n')[2]).toBe('~ checkbox "Hand tools" [checked=true, ref=e5] (checked: false → true)')
  })

  it('collapses many removals when a menu appears with them (a modal menu hides the page), not a few', () => {
    const page = Array.from({ length: 12 }, (_, i) => `- button "B${i}" [ref=e${i + 1}]`).join('\n')
    const text = formatTreeDiff(diffTrees(parseTreeRefs(page), parseTreeRefs('- menu "Account" [ref=e50]\n  - menuitem "Sign out" [ref=e51]')), opts)
    expect(text).toContain('+ menuitem "Sign out" [ref=e51]')
    expect(text).toContain('− 12 other elements left the tree while a menu appeared')
    expect(text).not.toContain('− button')
    // The interactive view may list only the items, not the menu.
    const itemsOnly = formatTreeDiff(diffTrees(parseTreeRefs(page), parseTreeRefs('- menuitem "Profile" [ref=e51]')), opts)
    expect(itemsOnly).toContain('− 12 other elements left the tree while a menu appeared')
    // Options changing inside a list that was already open are not a menu appearing (GitHub's branch filter).
    const filtered = formatTreeDiff(diffTrees(parseTreeRefs(`- option "main" [ref=e1]\n${page}`), parseTreeRefs('- option "main" [ref=e1]\n- option "v0.3" [ref=e60]')), opts)
    expect(filtered).not.toContain('appeared')
    const few = formatTreeDiff(diffTrees(parseTreeRefs('- button "B0" [ref=e1]\n- button "B1" [ref=e2]'), parseTreeRefs('- listbox [ref=e50]\n  - option "One" [ref=e51]')), opts)
    expect(few).toContain('− button "B0" [ref=e1]')
  })

  it('shows where two long names differ', () => {
    const long = 'Add to cart: Stainless steel combination wrench set, metric, 12 pieces'
    const d = diffTrees(parseTreeRefs(`- button "${long}" [ref=e1]`), parseTreeRefs(`- button "${long.replace('12 pieces', '14 pieces')}" [ref=e1]`))
    expect(d.changed[0].was).toContain('12 pieces')
    expect(d.changed[0].was.startsWith('name was "…')).toBe(true)
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

describe('wrapper lines', () => {
  it('lists a same-named parent and child once, through the child (a calendar gridcell around its button)', () => {
    const after = parseTreeRefs('- gridcell "Wednesday, October 21" [ref=e10]\n  - button "Wednesday, October 21" [ref=e11]\n- gridcell "Thursday" [ref=e12]\n  - button "Pick" [ref=e13]')
    const text = formatTreeDiff(diffTrees(parseTreeRefs(''), after), { baselineAgeMs: 0, baselineSource: 'action' })
    expect(text).not.toContain('gridcell "Wednesday, October 21"')
    expect(text).toContain('+ button "Wednesday, October 21" [ref=e11]')
    expect(text).toContain('+ gridcell "Thursday" [ref=e12]')
  })
})

describe('re-rendered elements', () => {
  // makingcosmetics.com (bench, SUP-1265): closing a modal re-drew the page —
  // every element came back under a new ref, and the agent then clicked an
  // old one (✗ Unknown ref).
  const before = '- combobox "Enter Keyword or Item No." [expanded=false, ref=e422]\n- button "Submit search keywords" [ref=e423]\n- button "disclaimer *" [ref=e724]\n- button "disclaimer *" [ref=e725]\n- button "Close" [ref=e311]'
  const after = '- combobox "Enter Keyword or Item No." [expanded=false, ref=e526]\n- button "Submit search keywords" [ref=e527]\n- button "disclaimer *" [ref=e1185]\n- button "disclaimer *" [ref=e1186]\n- link "New arrival" [ref=e600]'

  it('pairs a removed element with an arrival of exactly the same line, in order', () => {
    const d = diffTrees(parseTreeRefs(before), parseTreeRefs(after))
    expect(d.rerendered.map(r => [r.from.ref, r.to.ref])).toEqual([['e422', 'e526'], ['e423', 'e527'], ['e724', 'e1185'], ['e725', 'e1186']])
    expect(d.added.map(l => l.ref)).toEqual(['e600'])
    expect(d.removed.map(l => l.ref)).toEqual(['e311'])
  })

  it('leads with the old → new refs, then what is genuinely new or gone', () => {
    expect(formatTreeDiff(diffTrees(parseTreeRefs(before), parseTreeRefs(after)), { baselineAgeMs: 2000, baselineSource: 'snapshot' })).toBe(
      '\nTree changes since your snapshot 2s ago (4 replaced by identical lines, 1 added, 1 removed):\n' +
      '⟳ 4 lines were replaced by identical lines in the same place, under new refs; the old refs no longer work:\n' +
      '  combobox "Enter Keyword or Item No." [expanded=false]: e422 → e526\n' +
      '  button "Submit search keywords": e423 → e527\n' +
      '  button "disclaimer *": e724 → e1185\n' +
      '  button "disclaimer *": e725 → e1186\n' +
      '+ link "New arrival" [ref=e600]\n' +
      '− button "Close" [ref=e311]',
    )
  })

  it('does not pair generic look-alikes when most of what left did not come back', () => {
    const rows = (base: number, n: number) => Array.from({ length: n }, (_, i) => `- listitem [ref=e${base + i}]`).join('\n')
    const d = diffTrees(parseTreeRefs(rows(100, 10)), parseTreeRefs(rows(200, 3)))
    expect(d.rerendered).toHaveLength(0)
    expect(d.added).toHaveLength(3)
    expect(d.removed).toHaveLength(10)
    // A named line that is unique on both sides still pairs on its own.
    const one = diffTrees(parseTreeRefs(`${rows(100, 10)}\n- button "Checkout" [ref=e9]`), parseTreeRefs(`${rows(200, 3)}\n- button "Checkout" [ref=e99]`))
    expect(one.rerendered.map(r => [r.from.ref, r.to.ref])).toEqual([['e9', 'e99']])
    // Two identical named lines on one side are not one element.
    const twice = diffTrees(parseTreeRefs('- button "Add" [ref=e1]\n- button "Add" [ref=e2]\n- link "a" [ref=e3]\n- link "b" [ref=e4]\n- link "c" [ref=e5]'),
      parseTreeRefs('- button "Add" [ref=e7]'))
    expect(twice.rerendered).toHaveLength(0)
  })

  it('does not pair look-alikes whose surroundings differ (live: a calendar month, truncated product names)', () => {
    // Next month: every day comes back as the same line under a new ref.
    const month = (name: string, base: number) => `- grid "${name}" [ref=e${base}]\n` +
      Array.from({ length: 30 }, (_, i) => `  - gridcell "${i + 1}" [ref=e${base + 1 + i}]`).join('\n')
    expect(diffTrees(parseTreeRefs(month('October 2026', 500)), parseTreeRefs(month('November 2026', 600))).rerendered).toHaveLength(0)
    // Page 2 → 3: two laptops whose names the site cut to the same 16 characters.
    const card = (price: string, name: string, base: number) => `- heading "${price}" [level=4, ref=e${base}]\n- link "${name}" [ref=e${base + 1}]\n- button "Add to cart" [ref=e${base + 2}]`
    const grid = (a: string, b: string, base: number) => `${card(a, 'Acer Aspire ES1-', base)}\n${card(b, 'Lenovo V110-15', base + 10)}`
    expect(diffTrees(parseTreeRefs(grid('$364.46', '$399.00', 700)), parseTreeRefs(grid('$391.48', '$405.00', 760))).rerendered).toHaveLength(0)
    // Days without a grid line around them: a number names nothing on its own;
    // only a complete return (everything that left came back) pairs them.
    const days = (base: number, first: string) => `- button "Previous month" [ref=e9]\n- gridcell "${first}" [ref=e${base}]\n- gridcell "2" [ref=e${base + 1}]`
    expect(diffTrees(parseTreeRefs(days(10, '1')), parseTreeRefs(days(20, '1'))).rerendered).toHaveLength(2)
    expect(diffTrees(parseTreeRefs(days(10, '1') + '\n- link "x" [ref=e30]'), parseTreeRefs(days(20, '1') + '\n- link "y" [ref=e31]')).rerendered).toHaveLength(0)
  })

  it('pairs a list re-drawn with an item appended, element by element (p5 fixture)', () => {
    const d = diffTrees(parseTreeRefs('- button "Item one" [ref=e40]\n- button "Item two" [ref=e41]\n- iframe "Inner" [ref=e33]'),
      parseTreeRefs('- button "Item one" [ref=e49]\n- button "Item two" [ref=e50]\n- button "Item three" [ref=e51]\n- iframe "Inner" [ref=e33]'))
    expect(d.rerendered.map(r => [r.from.ref, r.to.ref])).toEqual([['e40', 'e49'], ['e41', 'e50']])
    expect(d.added.map(l => l.ref)).toEqual(['e51'])
  })

  it('caps the pairs and counts the rest', () => {
    const many = (base: number) => Array.from({ length: 12 }, (_, i) => `- link "Item ${i}" [ref=e${base + i}]`).join('\n')
    const text = formatTreeDiff(diffTrees(parseTreeRefs(many(100)), parseTreeRefs(many(200))), { baselineAgeMs: 0, baselineSource: 'action' })
    expect(text.split('\n').filter(l => / → e2\d\d$/.test(l))).toHaveLength(6)
    expect(text).toContain('  … 6 more re-rendered')
  })

  it('names a line without its ref', () => {
    expect(lineWithoutRef('button "Close" [ref=e311]')).toBe('button "Close"')
    expect(lineWithoutRef('combobox "State" [expanded=false, ref=e10]: Pick')).toBe('combobox "State" [expanded=false]: Pick')
    expect(lineWithoutRef('generic [ref=e2] clickable [cursor:pointer, onclick]')).toBe('generic clickable [cursor:pointer, onclick]')
  })
})

describe('a dialog that arrived', () => {
  it('lists its own lines before other arrivals', () => {
    const late = Array.from({ length: 30 }, (_, i) => `- generic "$${500 + i} for 2 nights" [ref=e${100 + i}]`).join('\n')
    const after = `${late}\n- dialog "Type of place" [ref=e300]\n  - radio "Entire home" [checked=false, ref=e301]\n  - radio "Room" [checked=false, ref=e302]`
    const text = formatTreeDiff(diffTrees(parseTreeRefs(''), parseTreeRefs(after)), { baselineAgeMs: 0, baselineSource: 'action', dialogOpened: true })
    const lines = text.split('\n')
    expect(lines[2]).toBe('+ dialog "Type of place" [ref=e300]')
    expect(lines[3]).toBe('+ radio "Entire home" [checked=false, ref=e301]')
  })

  it('lists a few elements that came back, with their refs', () => {
    const seen = new Map([['e9', 'combobox "Search" [expanded=true, ref=e9]']])
    const text = formatTreeDiff(diffTrees(parseTreeRefs('- button "x" [ref=e1]'), parseTreeRefs('- button "x" [ref=e1]\n- combobox "Search" [expanded=true, ref=e9]'), { seen }), { baselineAgeMs: 0, baselineSource: 'action' })
    expect(text).toContain('+ combobox "Search" [expanded=true, ref=e9] (back, same ref)')
  })

  it('does not pair what a dialog hid with its own look-alikes', () => {
    const d = diffTrees(parseTreeRefs('- textbox "Departure" [ref=e79]'), parseTreeRefs('- textbox "Departure" [ref=e120]'), { overlayOpened: true })
    expect(d.rerendered).toHaveLength(0)
  })
})

describe('formatUnknownRef', () => {
  const current = parseTreeRefs('- button "Select" [ref=e1233]\n- button "disclaimer *" [ref=e1185]\n- button "disclaimer *" [ref=e1186]')
  it('says what the ref was and which current refs carry exactly that line', () => {
    expect(formatUnknownRef('e691', 'button "Select" [ref=e691]', current))
      .toBe('\ne691 was button "Select" when last read; no element in the current tree has that ref. One element in the current tree has that same role, name and state: @e1233.')
    expect(formatUnknownRef('@e724', 'button "disclaimer *" [ref=e724]', current))
      .toContain('2 elements in the current tree have that same role, name and state: @e1185, @e1186.')
    expect(formatUnknownRef('e9', 'link "Gone" [ref=e9]', current))
      .toContain('No element in the current tree has that role, name and state.')
  })

  it('says so when a fresh read brought the ref back (the CLI had reset its ref table)', () => {
    expect(formatUnknownRef('e1233', 'button "Summary" [ref=e1233]', parseTreeRefs('- button "Summary" [ref=e1233]')))
      .toBe('\ne1233 is in the current tree again (button "Summary") after a fresh read — the CLI\'s ref table had been reset. This action was not performed.')
  })
})

describe('previous document', () => {
  afterEach(() => resetTreeBaseline())
  it('keeps the last document\'s lines to explain its refs after a load', () => {
    setTreeBaseline('https://a.com/', '- button "Decline" [ref=e532]', 'snapshot', 1000, 111)
    setTreeBaseline('https://a.com/', '- button "Search" [ref=e600]', 'action', 2000, 222)
    expect(lineFromPreviousDocument('@e532')).toEqual({ text: 'button "Decline" [ref=e532]', url: 'https://a.com/' })
    expect(lineFromPreviousDocument('e600')).toBeNull()
  })
})

describe('baseline per document', () => {
  it('follows an SPA across URL changes by its load start, and drops it on a new document', () => {
    setTreeBaseline('https://hotels.example/search?d=1', INTERACTIVE, 'snapshot', 1000, 1700.5)
    expect(getTreeBaseline('https://hotels.example/search?d=2', 1700.5)).not.toBeNull()
    expect(getTreeBaseline('https://hotels.example/search?d=1', 1800.25)).toBeNull()
    // Without a load start on either side, the URL decides.
    expect(getTreeBaseline('https://hotels.example/search?d=1')).not.toBeNull()
    // Lines seen on the document carry over across its URL changes.
    setTreeBaseline('https://hotels.example/search?d=3', '- button "Close" [ref=e90]', 'action', 2000, 1700.5)
    expect(getTreeBaseline('https://hotels.example/search?d=3', 1700.5)!.seen.get('e3')).toBe('button "Add to cart" [ref=e3]')
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
