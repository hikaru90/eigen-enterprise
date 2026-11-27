import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import type { DriveItem } from '$lib/drive/api'
import type { CompanyPresence } from '$lib/presence/company-presence.svelte'
import { companyWith, onItem } from '$lib/test/company-presence-double'
import DriveBrowser from './drive-browser.svelte'

vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn(), afterNavigate: vi.fn() }))
vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }))

const at = '2026-11-04T10:00:00.000Z'
type Listed = DriveItem & { canEdit: boolean; canManage: boolean }
const folder: Listed = {
  type: 'folder',
  id: 'x1',
  name: 'Projects',
  parentId: null,
  ownerId: 'u1',
  updatedAt: at,
  trashedAt: null,
  canEdit: true,
  canManage: true,
}
const sheet: Listed = {
  type: 'file',
  id: 'x2',
  name: 'Q4 plan.pdf',
  parentId: null,
  ownerId: 'u1',
  updatedAt: at,
  trashedAt: null,
  size: 2048,
  mime: 'application/pdf',
  canEdit: true,
  canManage: true,
}
const plain: Listed = { ...sheet, id: 'x3', name: 'notes.bin', mime: 'application/octet-stream' }

const directory = [
  { id: 'me', name: 'Alex Owner' },
  { id: 'anna', name: 'Anna Müller' },
  { id: 'ben', name: 'Ben Ode' },
]

const rowNamed = (name: string) => page.getByTestId('drive-row').elements().find((el) => el.getAttribute('data-name') === name)!
const stackIn = (row: Element) => row.querySelector('[data-testid="drive-row-presence"]')

function mount(company: CompanyPresence | null) {
  render(DriveBrowser, { props: { folderId: null, items: [folder, sheet, plain], canEdit: true, company } })
}

describe('drive-browser: who has a row open now (plan/phase-multiplayer-presence.md, in the view)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('without the presence feed the rows are as they always were', async () => {
    mount(null)
    await expect.element(page.getByTestId('drive-row').first()).toBeInTheDocument()
    expect(page.getByTestId('drive-row-presence').elements()).toHaveLength(0)
  })

  it('list: a file row shows who has that file open, a folder row who has that folder open', async () => {
    const company = await companyWith(
      'me',
      [
        { userId: 'anna', where: onItem('drive_file', 'x2', 'Q4 plan.pdf') },
        { userId: 'ben', where: onItem('drive_folder', 'x1', 'Projects') },
        { userId: 'me', where: onItem('drive_file', 'x3', 'notes.bin') },
      ],
      directory,
    )
    mount(company)
    await expect.element(page.getByTestId('drive-list')).toBeInTheDocument()
    expect(stackIn(rowNamed('Q4 plan.pdf'))?.getAttribute('aria-label')).toBe('Anna Müller has this open')
    expect(stackIn(rowNamed('Projects'))?.getAttribute('aria-label')).toBe('Ben Ode has this open')
    // Me on a file is not "someone else here".
    expect(stackIn(rowNamed('notes.bin'))).toBeNull()
  })

  it('a folder row is not a file with the same id (the kind is part of the item)', async () => {
    const company = await companyWith('me', [{ userId: 'anna', where: onItem('drive_file', 'x1', 'x1.txt') }], directory)
    mount(company)
    await expect.element(page.getByTestId('drive-list')).toBeInTheDocument()
    expect(stackIn(rowNamed('Projects'))).toBeNull()
  })

  it('grid: the card shows the same avatars', async () => {
    localStorage.setItem('drive-view', 'grid')
    const company = await companyWith('me', [{ userId: 'anna', where: onItem('drive_file', 'x2', 'Q4 plan.pdf') }], directory)
    mount(company)
    await expect.element(page.getByTestId('drive-grid')).toBeInTheDocument()
    expect(stackIn(rowNamed('Q4 plan.pdf'))?.getAttribute('aria-label')).toBe('Anna Müller has this open')
    expect(stackIn(rowNamed('Projects'))).toBeNull()
  })
})
