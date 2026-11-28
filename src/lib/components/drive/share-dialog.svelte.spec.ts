import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import type { DriveItem, GrantEntry } from '$lib/drive/api'
import ShareDialog from './share-dialog.svelte'

const { api } = vi.hoisted(() => ({
  api: {
    grants: vi.fn(),
    shareTargets: vi.fn(),
    setGrants: vi.fn(),
  },
}))
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn(async () => undefined) }))
vi.mock('$lib/drive/api', () => ({ driveApi: api }))

const item = { type: 'folder', id: 'fo1', name: 'Projects' } as unknown as DriveItem
const owner: GrantEntry = { subject: { kind: 'user', userId: 'u1' }, level: 'manage' }

describe('share dialog: picking is adding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.grants.mockResolvedValue({ grants: [owner] })
    api.shareTargets.mockResolvedValue({
      people: [
        { id: 'u1', name: 'Ada Owner', email: 'ada@example.com' },
        { id: 'u2', name: 'Bea Member', email: 'bea@example.com' },
        { id: 'u3', name: 'Cy Member', email: 'cy@example.com' },
      ],
      groups: [{ id: 'g1', name: 'Design' }],
    })
    api.setGrants.mockResolvedValue({ grants: [] })
  })

  it('pick a person, then Save: the share includes them at the chosen level, with no Add step', async () => {
    const onclose = vi.fn()
    render(ShareDialog, { props: { item, onclose } })
    await expect.element(page.getByTestId('drive-share-pick')).toBeVisible()
    expect(page.getByTestId('drive-share-add').elements()).toHaveLength(0)
    await page.getByTestId('drive-share-pick-level').selectOptions('edit')
    await page.getByRole('button', { name: 'Share with Bea Member (bea@example.com)' }).click()
    // Picked = in the list, with its own level control.
    await expect.element(page.getByTestId('drive-share-row').nth(1)).toHaveTextContent('Bea Member')
    await page.getByTestId('drive-share-save').click()
    await expect.poll(() => api.setGrants.mock.calls.length).toBe(1)
    expect(api.setGrants).toHaveBeenCalledWith(item, [owner, { subject: { kind: 'user', userId: 'u2' }, level: 'edit' }])
    expect(onclose).toHaveBeenCalled()
  })

  it('the people to pick sit in their own tinted area, headed and named by it, each a focusable button (wish f3b0b4f5)', async () => {
    render(ShareDialog, { props: { item, onclose: vi.fn() } })
    const area = page.getByTestId('drive-share-candidates-area')
    await expect.element(area.getByRole('heading', { name: 'People in your company' })).toBeVisible()
    expect(area.element().className).toMatch(/\bbg-muted\b/)
    await expect.element(page.getByRole('list', { name: 'People in your company' })).toBeInTheDocument()
    const first = page.getByTestId('drive-share-candidate').first()
    ;(first.element() as HTMLButtonElement).focus()
    expect(document.activeElement).toBe(first.element())
  })

  it('the search narrows the candidates and Enter picks the first match', async () => {
    render(ShareDialog, { props: { item, onclose: vi.fn() } })
    await page.getByTestId('drive-share-pick').fill('cy@')
    await expect.element(page.getByTestId('drive-share-candidate')).toHaveTextContent('Cy Member')
    expect(page.getByTestId('drive-share-candidate').elements()).toHaveLength(1)
    // Enter in the search field itself: the dialog's open focus may land after the fill under load.
    await userEvent.type(page.getByTestId('drive-share-pick'), '{Enter}')
    await expect.element(page.getByTestId('drive-share-row').nth(1)).toHaveTextContent('Cy Member')
    // The search clears once its match is picked.
    await expect.element(page.getByTestId('drive-share-pick')).toHaveValue('')
    await page.getByTestId('drive-share-save').click()
    await expect.poll(() => api.setGrants.mock.calls.length).toBe(1)
    expect(api.setGrants.mock.calls[0]![1]).toEqual([owner, { subject: { kind: 'user', userId: 'u3' }, level: 'view' }])
  })

  it('typed but not picked blocks Save with a message instead of dropping it', async () => {
    render(ShareDialog, { props: { item, onclose: vi.fn() } })
    await page.getByTestId('drive-share-pick').fill('bea')
    await page.getByTestId('drive-share-save').click()
    await expect.element(page.getByTestId('drive-share-error')).toHaveTextContent('“bea” is typed but not picked')
    expect(api.setGrants).not.toHaveBeenCalled()
    // Picking it lets Save through.
    await page.getByRole('button', { name: 'Share with Bea Member (bea@example.com)' }).click()
    await page.getByTestId('drive-share-save').click()
    await expect.poll(() => api.setGrants.mock.calls.length).toBe(1)
  })

  it('a search that matches no one also blocks Save', async () => {
    render(ShareDialog, { props: { item, onclose: vi.fn() } })
    await page.getByTestId('drive-share-pick').fill('zed@elsewhere.com')
    await expect.element(page.getByTestId('drive-share-no-match')).toBeVisible()
    await page.getByTestId('drive-share-save').click()
    await expect.element(page.getByTestId('drive-share-error')).toHaveTextContent('“zed@elsewhere.com” is typed but not picked')
    expect(api.setGrants).not.toHaveBeenCalled()
  })

  it('someone already in the share is not offered again; removing them offers them again', async () => {
    render(ShareDialog, { props: { item, onclose: vi.fn() } })
    await expect.element(page.getByTestId('drive-share-row')).toHaveTextContent('Ada Owner')
    await expect.element(page.getByRole('button', { name: 'Share with Bea Member (bea@example.com)' })).toBeVisible()
    expect(page.getByRole('button', { name: 'Share with Ada Owner (ada@example.com)' }).elements()).toHaveLength(0)
    await page.getByRole('button', { name: 'Remove Ada Owner (ada@example.com)' }).click()
    await expect.element(page.getByRole('button', { name: 'Share with Ada Owner (ada@example.com)' })).toBeVisible()
  })
})
