// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Checkbox } from './checkbox'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './dialog'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'
import { Switch } from './switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs'

afterEach(cleanup)

// Use the actual app wrappers and Radix portals, focus scopes and form controls.
// Browser suites separately cover layout, native touch and built Electron.
describe('Radix interaction contracts', () => {
  it('keeps focus and typing in a non-modal portal inside a modal, then dismisses one layer at a time', async () => {
    const user = userEvent.setup()
    render(
      <Dialog>
        <DialogTrigger>Open settings</DialogTrigger>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Settings</DialogTitle>
          <input aria-label="Outer name" />
          <Popover>
            <PopoverTrigger>Choose value</PopoverTrigger>
            <PopoverContent aria-label="Value picker">
              <input aria-label="Search values" />
              <button>Pick result</button>
            </PopoverContent>
          </Popover>
        </DialogContent>
      </Dialog>,
    )
    await user.click(screen.getByRole('button', { name: 'Open settings' }))
    await user.click(screen.getByRole('button', { name: 'Choose value' }))
    const search = screen.getByRole('textbox', { name: 'Search values' })
    await user.type(search, 'Tokyo')
    expect(search).toHaveValue('Tokyo')
    expect(search).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Pick result' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Search values' })).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose value' })).toHaveFocus())
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeVisible()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open settings' })).toHaveFocus())
    expect(document.body.style.pointerEvents).not.toBe('none')
  })

  it.each([
    { name: 'checkbox', Control: Checkbox },
    { name: 'switch', Control: Switch },
  ])('programmatic $name updates do not click an ancestor, but user changes bubble once', async ({ name, Control }) => {
    const user = userEvent.setup()
    const onFormClick = vi.fn()
    const onCheckedChange = vi.fn()
    const view = (checked: boolean) => (
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- Observe bubbled events on the real form; the form itself is not an interactive control.
      <form onClick={onFormClick}>
        <Control name="enabled" aria-label="Enabled" checked={checked} onCheckedChange={onCheckedChange} />
      </form>
    )
    const { rerender } = render(view(false))
    rerender(view(true))
    expect(screen.getByRole(name, { name: 'Enabled' })).toBeChecked()
    expect(onFormClick).not.toHaveBeenCalled()
    expect(onCheckedChange).not.toHaveBeenCalled()
    await user.click(screen.getByRole(name, { name: 'Enabled' }))
    expect(onFormClick).toHaveBeenCalledTimes(1)
    expect(onCheckedChange).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('programmatic select updates preserve the submitted value without clicking an ancestor', () => {
    const onFormClick = vi.fn()
    const onValueChange = vi.fn()
    const view = (value: string) => (
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- Observe bubbled events on the real form; the form itself is not an interactive control.
      <form aria-label="Profile settings" onClick={onFormClick}>
        <Select name="profile" value={value} onValueChange={onValueChange}>
          <SelectTrigger aria-label="Profile"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="work">Work</SelectItem>
            <SelectItem value="personal">Personal</SelectItem>
          </SelectContent>
        </Select>
      </form>
    )
    const { rerender } = render(view('work'))
    rerender(view('personal'))
    expect(screen.getByRole('combobox', { name: 'Profile' })).toHaveTextContent('Personal')
    expect(new FormData(screen.getByRole('form') as HTMLFormElement).get('profile')).toBe('personal')
    expect(onFormClick).not.toHaveBeenCalled()
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('resets an uncontrolled switch to its form default and submitted value', async () => {
    const user = userEvent.setup()
    render(
      <form aria-label="Preference settings">
        <Switch name="enabled" aria-label="Enabled" defaultChecked />
        <button type="reset">Reset preferences</button>
      </form>,
    )
    const control = screen.getByRole('switch', { name: 'Enabled' })
    await user.click(control)
    expect(control).not.toBeChecked()
    expect(new FormData(screen.getByRole('form') as HTMLFormElement).has('enabled')).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Reset preferences' }))
    expect(control).toBeChecked()
    expect(new FormData(screen.getByRole('form') as HTMLFormElement).get('enabled')).toBe('on')
  })

  it('saves the focused input on blur before its tab content unmounts', async () => {
    const events: string[] = []
    const user = userEvent.setup()
    function SettingsTabs() {
      const [tab, setTab] = useState('general')
      return (
        <Tabs value={tab} onValueChange={(value) => { events.push(`tab:${value}`); setTab(value) }}>
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="advanced">Advanced</TabsTrigger>
          </TabsList>
          <TabsContent value="general">
            <input aria-label="Display name" defaultValue="Original" onBlur={event => events.push(`save:${event.currentTarget.value}`)} />
          </TabsContent>
          <TabsContent value="advanced">Advanced options</TabsContent>
        </Tabs>
      )
    }
    render(<SettingsTabs />)
    await user.clear(screen.getByRole('textbox', { name: 'Display name' }))
    await user.type(screen.getByRole('textbox', { name: 'Display name' }), 'Edited')
    await user.click(screen.getByRole('tab', { name: 'Advanced' }))
    // Automatic activation can report the same tab from focus and mousedown.
    // The contract is one blur save before either callback unmounts the field.
    expect(events[0]).toBe('save:Edited')
    expect(events.filter(event => event.startsWith('save:'))).toEqual(['save:Edited'])
    expect(events.slice(1).every(event => event === 'tab:advanced')).toBe(true)
    expect(events).toContain('tab:advanced')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Advanced' })).toHaveFocus()
  })
})
