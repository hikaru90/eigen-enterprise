import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import MemoryOwnerLabel from './memory-owner-label.svelte'
import MemoryPrivateSwitch from './memory-private-switch.svelte'
import MemoryScopeTabs from './memory-scope-tabs.svelte'

/** Shared Memory in the UI (plan/shared-memory-voice-agent-tools.md §1). */
describe('the Private switch', () => {
  const toggle = () => page.getByRole('switch', { name: 'Private' })

  it('is off for a shared item and says everyone sees it, read-only', async () => {
    render(MemoryPrivateSwitch, { id: 'p', kind: 'project', checked: false, onchange: () => {} })
    await expect.element(toggle()).not.toBeChecked()
    await expect.element(toggle()).toHaveAccessibleDescription(/everyone in the company sees it, its tasks and progress/i)
  })

  it('reports the person’s choice without saving anything itself', async () => {
    const onchange = vi.fn()
    render(MemoryPrivateSwitch, { id: 'n', kind: 'note', checked: false, onchange })
    await toggle().click()
    expect(onchange).toHaveBeenCalledWith(true)
  })

  it('on: says only the owner sees it — no admin, not even the owner of the company', async () => {
    const onchange = vi.fn()
    render(MemoryPrivateSwitch, { id: 'n2', kind: 'note', checked: true, onchange })
    await expect.element(toggle()).toBeChecked()
    await expect.element(toggle()).toHaveAccessibleDescription(/only you can read it — no admin, not even the owner/i)
    await toggle().click()
    expect(onchange).toHaveBeenCalledWith(false)
  })

  it('can be disabled while saving', async () => {
    render(MemoryPrivateSwitch, { id: 'p2', kind: 'project', checked: false, disabled: true, onchange: () => {} })
    await expect.element(toggle()).toBeDisabled()
  })
})

describe('a colleague’s item', () => {
  it('is labelled with its owner and as read-only', async () => {
    render(MemoryOwnerLabel, { name: 'Ana' })
    await expect.element(page.getByTestId('memory-owner-label')).toHaveTextContent('By Ana · Read-only')
  })
})

describe('Mine / Team', () => {
  it('marks the current scope and asks for the other one', async () => {
    const onselect = vi.fn()
    render(MemoryScopeTabs, { scope: 'mine', onselect })
    await expect.element(page.getByRole('tab', { name: 'Mine' })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: 'Team' }).click()
    expect(onselect).toHaveBeenCalledWith('team')
    await page.getByRole('tab', { name: 'Mine' }).click()
    expect(onselect).toHaveBeenCalledTimes(1)
  })
})
